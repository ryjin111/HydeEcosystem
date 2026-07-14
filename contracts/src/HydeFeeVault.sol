// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Multicall} from "@openzeppelin/contracts/utils/Multicall.sol";

import {IHydeVault} from "./interfaces/IHydeVault.sol";
import {IHydeToken} from "./interfaces/IHydeToken.sol";
import {ISwapRouter} from "./interfaces/ISwapRouter.sol";
import {IUniswapV3Factory} from "./interfaces/IUniswapV3Factory.sol";
import {OracleLib} from "./libraries/OracleLib.sol";

/// @title HydeFeeVault — WETH fee settlement + pull claims + NON-EXTENDABLE-EPOCH holder vesting
/// @notice CONTRACT_SPEC_L3.md §4b (rev6). Shared singleton, per-token accounting. `collect` sends
///         raw V3 fees here (swap-free); permissionless `settle` converts them to WETH (the ONLY
///         swap — TWAP-floored + oracle-gated) and splits 90/5/5 into the creator/Hyde pull buckets
///         and the holder epoch. Holders vest over non-extendable fixed epochs of length `DURATION`
///         against a cumulative `epochVested` target (exact 100% at finish); holder reserve is
///         tracked directly as `holderFunded − holderClaimed`. O(1), no holder loops.
///         Invariants: INV-2/3/13/18/23/24/25/26/27/28/29/31/32/34.
contract HydeFeeVault is IHydeVault, ReentrancyGuard, Multicall {
    using SafeERC20 for IERC20;

    /* ─────────────────────────── immutables ────────────────────────────────── */
    IERC20 public immutable SETTLEMENT_TOKEN; // WETH (= wrappedNative)
    address public immutable COLLECTOR;
    ISwapRouter public immutable SWAP_ROUTER;
    IUniswapV3Factory public immutable UNIV3_FACTORY;
    uint24 public immutable feeTier; // the LT/WETH pool tier
    address public immutable hydeoutTreasury;
    uint16 public immutable hydeBps; // == 500
    uint16 public immutable holderBps; // == 500
    uint32 public immutable DURATION; // epoch length (default 7 days)
    uint16 public immutable MAX_SLIPPAGE_BPS; // default 300
    uint32 public immutable TWAP_WINDOW; // default 1800s

    uint256 private constant PRECISION = 1e30;
    uint16 private constant BPS_DENOM = 10_000;

    /// @notice the one factory allowed to `register`. Set once (deployer fallback), then locked.
    address public factory;
    address private immutable _deployer;

    /* ─────────────────────────── per-token state ───────────────────────────── */
    mapping(address => bool) public registered;
    mapping(address => address) public creator;

    /// @notice un-settled raw V3 fees, keyed token→asset (asset ∈ {launch token (LT), WETH}).
    mapping(address => mapping(address => uint256)) public rawFees;

    /// @notice WETH owed to the creator / Hyde, claimable any time (pull-based).
    mapping(address => uint256) public creatorClaimable;
    mapping(address => uint256) public hydeClaimable;

    /// @notice the current holder epoch (epochFinish = epochStart + DURATION).
    mapping(address => uint256) public epochAmount;
    mapping(address => uint256) public epochStart;
    mapping(address => uint256) public epochFinish;
    mapping(address => uint256) public epochVested; // cumulative WETH vested from this epoch (rev6 pt.1)
    /// @notice WETH queued for the NEXT epoch (active-epoch settles + zero-supply re-queue + index dust).
    mapping(address => uint256) public nextEpochAmount;

    /// @notice holder claim-index checkpoint.
    mapping(address => uint256) public lastUpdateTime;
    mapping(address => uint256) public rewardPerTokenStored;
    mapping(address => uint256) public totalEligibleSupply;
    mapping(address => mapping(address => uint256)) public userRewardPerTokenPaid;
    mapping(address => mapping(address => uint256)) public rewards;

    /// @notice DIRECT holder reserve (rev6 pt.2): holder WETH liability = holderFunded − holderClaimed.
    mapping(address => uint256) public holderFunded;
    mapping(address => uint256) public holderClaimed;

    /// @notice the sole explicitly-tracked custody ledger, keyed by asset (global across tokens).
    mapping(address => uint256) public accountedBalance;

    /* ─────────────────────────── events ────────────────────────────────────── */
    event Registered(address indexed token, address indexed creator);
    event RawNoted(address indexed token, address indexed asset, uint256 amount);
    event Settled(
        address indexed token,
        address indexed asset,
        uint256 amountIn,
        uint256 wethAmt,
        uint256 creatorCut,
        uint256 hydeCut,
        uint256 holderCut
    );
    event EpochRolled(address indexed token, uint256 amount, uint256 start, uint256 finish);
    event HolderClaimed(address indexed token, address indexed holder, uint256 amount);
    event CreatorClaimed(address indexed token, address indexed creator, uint256 amount);
    event HydeClaimed(address indexed token, uint256 amount);

    /* ─────────────────────────── construction ──────────────────────────────── */
    constructor(
        IERC20 settlementToken,
        address collector,
        ISwapRouter swapRouter,
        IUniswapV3Factory univ3Factory,
        uint24 _feeTier,
        address _hydeoutTreasury,
        uint16 _hydeBps,
        uint16 _holderBps,
        uint32 _duration,
        uint16 _maxSlippageBps,
        uint32 _twapWindow
    ) {
        require(address(settlementToken) != address(0), "ZERO_WETH");
        require(collector != address(0), "ZERO_COLLECTOR");
        require(address(swapRouter) != address(0), "ZERO_ROUTER");
        require(address(univ3Factory) != address(0), "ZERO_FACTORY_ADDR");
        require(_feeTier != 0, "ZERO_FEE_TIER");
        require(_hydeoutTreasury != address(0), "ZERO_TREASURY");
        require(_hydeBps == 500 && _holderBps == 500, "BPS"); // hard-capped, immutable (INV-2)
        require(_hydeBps + _holderBps < BPS_DENOM, "BPS_SUM"); // creator remainder stays majority
        require(_duration != 0, "ZERO_DURATION");
        require(_maxSlippageBps < BPS_DENOM, "SLIPPAGE"); // floor can't be zeroed (INV-18)
        require(_twapWindow != 0, "ZERO_TWAP");

        SETTLEMENT_TOKEN = settlementToken;
        COLLECTOR = collector;
        SWAP_ROUTER = swapRouter;
        UNIV3_FACTORY = univ3Factory;
        feeTier = _feeTier;
        hydeoutTreasury = _hydeoutTreasury;
        hydeBps = _hydeBps;
        holderBps = _holderBps;
        DURATION = _duration;
        MAX_SLIPPAGE_BPS = _maxSlippageBps;
        TWAP_WINDOW = _twapWindow;
        _deployer = msg.sender;
    }

    /// @notice One-shot factory binding (deployer-only, once) — matches the collector's deploy cycle
    ///         (§4). A 2nd call / non-deployer reverts (no init-seizure).
    function initFactory(address factory_) external {
        require(msg.sender == _deployer, "ONLY_DEPLOYER");
        require(factory == address(0), "FACTORY_SET");
        require(factory_ != address(0), "ZERO_FACTORY");
        factory = factory_;
    }

    modifier onlyFactory() {
        require(msg.sender == factory, "ONLY_FACTORY");
        _;
    }

    modifier onlyCollector() {
        require(msg.sender == COLLECTOR, "ONLY_COLLECTOR");
        _;
    }

    /* ─────────────────────────── registration ──────────────────────────────── */
    /// @inheritdoc IHydeVault
    function register(address token, address creator_) external onlyFactory {
        require(!registered[token], "REGISTERED");
        require(token != address(0) && creator_ != address(0), "ZERO");
        registered[token] = true;
        creator[token] = creator_;
        emit Registered(token, creator_);
    }

    /* ─────────────────────── raw custody (donation-proof) ──────────────────── */
    /// @inheritdoc IHydeVault
    /// @dev PULL-and-MEASURE: measure the actual received delta so a donation can't brick it and a
    ///      fee-on-transfer shortfall reverts. `accountedBalance` is never gated on ambient balance.
    function noteRaw(address token, address asset, uint256 amount) external onlyCollector {
        require(registered[token], "UNKNOWN");
        uint256 before = IERC20(asset).balanceOf(address(this));
        IERC20(asset).safeTransferFrom(COLLECTOR, address(this), amount);
        uint256 received = IERC20(asset).balanceOf(address(this)) - before;
        require(received == amount, "FOT_SHORTFALL"); // exact-received (INV-13)
        accountedBalance[asset] += received;
        rawFees[token][asset] += received;
        emit RawNoted(token, asset, received);
    }

    /* ─────────────────────────── token-driven sync ─────────────────────────── */
    /// @inheritdoc IHydeVault
    /// @dev `onlyToken` (registered caller). Pure arithmetic, no external calls, non-reverting on the
    ///      normal path (INV-23). Crystallizes both accounts at the pre-change index/balances, then
    ///      applies the eligible-supply delta.
    function sync(
        address from,
        address to,
        uint256 balFrom,
        uint256 balTo,
        uint256 amount,
        bool fromExcl,
        bool toExcl
    ) external {
        address token = msg.sender;
        require(registered[token], "NOT_REGISTERED"); // anti-invariant: only for a rogue caller

        // First call advances the global index; the second sees lastUpdateTime==now → advances 0
        // (no double vest), and each crystallizes its own account at the shared index.
        _updateReward(token, from, balFrom, fromExcl);
        _updateReward(token, to, balTo, toExcl);

        // Eligible supply = Σ non-excluded balances. `from`'s whole balance is eligible iff !fromExcl,
        // so it can never underflow (totalEligibleSupply ≥ balFrom ≥ amount when !fromExcl).
        if (!fromExcl && from != address(0)) totalEligibleSupply[token] -= amount;
        if (!toExcl && to != address(0)) totalEligibleSupply[token] += amount;
    }

    /* ─────────────────────────── settle (the ONLY swap) ────────────────────── */
    /// @notice Permissionless. Converts a raw fee leg to WETH and splits it 90/5/5. TWAP-floor +
    ///         `ORACLE_NOT_READY` guarded; `minOut = max(TWAP-floor, callerMinOut)` (tighten-only).
    /// @param asset the raw leg to settle: WETH (no swap) or the launch token itself (LT→WETH swap).
    function settle(address token, address asset, uint256 amountIn, uint256 callerMinOut, uint256 deadline)
        external
        nonReentrant
    {
        require(registered[token], "UNKNOWN");
        require(amountIn > 0, "ZERO_IN");
        require(amountIn <= rawFees[token][asset], "OVER_RAW");
        require(asset == address(SETTLEMENT_TOKEN) || asset == token, "BAD_ASSET"); // {WETH, LT}
        require(block.timestamp <= deadline, "DEADLINE");

        _updateReward(token, address(0), 0, false); // advance index before mutating

        uint256 wethAmt;
        if (asset == address(SETTLEMENT_TOKEN)) {
            // WETH leg — PURE reclassification (rev6 pt.2): move existing WETH from the rawFees
            // component of the derived liability into the buckets; total accountedBalance[WETH]
            // and liability[WETH] UNCHANGED.
            rawFees[token][asset] -= amountIn;
            wethAmt = amountIn;
        } else {
            // LT leg — the system's ONLY swap. LT leaves for the router.
            rawFees[token][asset] -= amountIn;
            accountedBalance[asset] -= amountIn;

            address pool = UNIV3_FACTORY.getPool(token, address(SETTLEMENT_TOKEN), feeTier);
            require(pool != address(0), "NO_POOL");
            // Oracle-ready gate: the pool's oldest observation must be ≥ a full TWAP_WINDOW old
            // (cardinality is allocated-not-backfilled at seed).
            require(OracleLib.getOldestObservationSecondsAgo(pool) >= TWAP_WINDOW, "ORACLE_NOT_READY");

            int24 meanTick = OracleLib.consult(pool, TWAP_WINDOW);
            uint256 twapQuote = OracleLib.getQuoteAtTick(meanTick, amountIn, token, address(SETTLEMENT_TOKEN));
            uint256 floor = Math.mulDiv(twapQuote, BPS_DENOM - MAX_SLIPPAGE_BPS, BPS_DENOM);
            uint256 minOut = floor > callerMinOut ? floor : callerMinOut; // tighten-only

            IERC20(token).forceApprove(address(SWAP_ROUTER), amountIn);
            uint256 beforeWeth = SETTLEMENT_TOKEN.balanceOf(address(this));
            SWAP_ROUTER.exactInputSingle(
                ISwapRouter.ExactInputSingleParams({
                    tokenIn: token,
                    tokenOut: address(SETTLEMENT_TOKEN),
                    fee: feeTier,
                    recipient: address(this),
                    amountIn: amountIn,
                    amountOutMinimum: minOut,
                    sqrtPriceLimitX96: 0
                })
            );
            // Re-measure the received WETH (donation-proof; ignores the router's return value).
            wethAmt = SETTLEMENT_TOKEN.balanceOf(address(this)) - beforeWeth;
            require(wethAmt >= minOut, "SLIPPAGE_FLOOR");
            IERC20(token).forceApprove(address(SWAP_ROUTER), 0);
            accountedBalance[address(SETTLEMENT_TOKEN)] += wethAmt;
        }

        // Split wethAmt 90/5/5 — creator = remainder (exact 5% legs, all rounding to creator ≥ 90%).
        uint256 hydeCut = Math.mulDiv(wethAmt, hydeBps, BPS_DENOM);
        uint256 holderCut = Math.mulDiv(wethAmt, holderBps, BPS_DENOM);
        uint256 creatorCut = wethAmt - hydeCut - holderCut;

        creatorClaimable[token] += creatorCut;
        hydeClaimable[token] += hydeCut;
        holderFunded[token] += holderCut; // ONLY here — keeps (holderFunded − holderClaimed) exact
        _queueReward(token, holderCut);

        emit Settled(token, asset, amountIn, wethAmt, creatorCut, hydeCut, holderCut);
    }

    /* ─────────────────────────── epoch machinery ───────────────────────────── */
    /// @dev CHECKPOINT ONLY (no roll): vest the current epoch against a CUMULATIVE target so per-update
    ///      flooring can't accumulate a shortfall (rev6 pt.1); carry the global index-allocation
    ///      remainder / the zero-supply vest into nextEpochAmount (pt.3 / INV-26). Separated from the
    ///      roll so `roll()` can checkpoint-then-decide in the exact order kami 21300 requires.
    function _checkpoint(address token) internal {
        uint256 finish = epochFinish[token];
        uint256 t1 = block.timestamp < finish ? block.timestamp : finish;
        uint256 start = epochStart[token];

        if (t1 > start) {
            uint256 vestedTarget = Math.mulDiv(epochAmount[token], t1 - start, DURATION); // cumulative
            uint256 newlyVested = vestedTarget - epochVested[token];
            epochVested[token] = vestedTarget;

            if (newlyVested > 0) {
                uint256 supply = totalEligibleSupply[token];
                if (supply > 0) {
                    uint256 indexDelta = Math.mulDiv(newlyVested, PRECISION, supply);
                    rewardPerTokenStored[token] += indexDelta;
                    uint256 allocated = Math.mulDiv(indexDelta, supply, PRECISION);
                    if (newlyVested > allocated) nextEpochAmount[token] += (newlyVested - allocated); // dust carry
                } else {
                    nextEpochAmount[token] += newlyVested; // zero-supply vest re-queued, never lost
                }
            }
            lastUpdateTime[token] = t1;
        }
    }

    /// @dev Full update: checkpoint → roll (if the current epoch ended + a queue exists) → crystallize
    ///      `acct`'s rewards at the resulting index. Called before every balance change + claim/settle.
    function _updateReward(address token, address acct, uint256 bal, bool excl) internal {
        _checkpoint(token);
        _maybeRoll(token);

        if (acct != address(0)) {
            if (!excl) {
                rewards[token][acct] +=
                    Math.mulDiv(bal, rewardPerTokenStored[token] - userRewardPerTokenPaid[token][acct], PRECISION);
            }
            userRewardPerTokenPaid[token][acct] = rewardPerTokenStored[token];
        }
    }

    /// @dev Rolls a fresh epoch ONLY after the current one ends (never resets an active clock).
    function _maybeRoll(address token) internal {
        if (block.timestamp >= epochFinish[token] && nextEpochAmount[token] > 0) {
            uint256 amt = nextEpochAmount[token];
            nextEpochAmount[token] = 0;
            epochAmount[token] = amt;
            epochStart[token] = block.timestamp;
            uint256 finish = block.timestamp + DURATION;
            epochFinish[token] = finish;
            epochVested[token] = 0;
            lastUpdateTime[token] = block.timestamp;
            emit EpochRolled(token, amt, block.timestamp, finish);
        }
    }

    /// @dev From settle: an active-epoch settle just accumulates nextEpochAmount (never moves
    ///      epochFinish); the FIRST settle (no active epoch) rolls immediately and starts epoch 1.
    function _queueReward(address token, uint256 amt) internal {
        nextEpochAmount[token] += amt;
        _maybeRoll(token);
    }

    /// @notice Permissionless. Start the next epoch once the current ends. Order (kami 21300): (1)
    ///         checkpoint — vest the ended epoch + re-queue any zero-supply vest into nextEpochAmount,
    ///         so a fully-elapsed zero-supply epoch's funds are visible to this same call (no unrelated
    ///         poke needed); (2) require the current epoch ended (no active-epoch reset); (3) require
    ///         the resulting queue is non-empty (no empty-epoch spin); (4) open the next fixed epoch.
    function roll(address token) external {
        _checkpoint(token); // 1
        require(block.timestamp >= epochFinish[token], "ACTIVE_EPOCH"); // 2
        require(nextEpochAmount[token] > 0, "EMPTY_QUEUE"); // 3
        _maybeRoll(token); // 4
    }

    /* ─────────────────────────── claims (pull) ─────────────────────────────── */
    /// @notice Holder vested WETH. Third party may trigger; funds go to `holder`. CEI, O(1).
    function claim(address token, address holder) external nonReentrant {
        _claim(token, holder);
    }

    function claim(address token) external nonReentrant {
        _claim(token, msg.sender);
    }

    function _claim(address token, address holder) internal {
        require(registered[token], "UNKNOWN");
        _updateReward(token, holder, IHydeToken(token).balanceOf(holder), IHydeToken(token).isRewardExcluded(holder));
        uint256 owed = rewards[token][holder];
        require(owed > 0, "NOTHING");
        rewards[token][holder] = 0;
        holderClaimed[token] += owed; // keeps (holderFunded − holderClaimed) exact (INV-27)
        accountedBalance[address(SETTLEMENT_TOKEN)] -= owed;
        SETTLEMENT_TOKEN.safeTransfer(holder, owed);
        emit HolderClaimed(token, holder, owed);
    }

    /// @notice WETH to the immutable creator. Anyone triggers; funds go to the fixed recipient.
    function claimCreator(address token) external nonReentrant {
        uint256 owed = creatorClaimable[token];
        require(owed > 0, "NOTHING");
        creatorClaimable[token] = 0;
        accountedBalance[address(SETTLEMENT_TOKEN)] -= owed;
        SETTLEMENT_TOKEN.safeTransfer(creator[token], owed);
        emit CreatorClaimed(token, creator[token], owed);
    }

    /// @notice WETH to the immutable hydeoutTreasury. Batch across tokens via inherited `Multicall`.
    function claimHyde(address token) external nonReentrant {
        uint256 owed = hydeClaimable[token];
        require(owed > 0, "NOTHING");
        hydeClaimable[token] = 0;
        accountedBalance[address(SETTLEMENT_TOKEN)] -= owed;
        SETTLEMENT_TOKEN.safeTransfer(hydeoutTreasury, owed);
        emit HydeClaimed(token, owed);
    }

    /* ─────────────────────────── views ─────────────────────────────────────── */
    /// @notice Derived per-token WETH liability (INV-25/27): rawFees + creator + Hyde + holder reserve.
    function wethLiability(address token) external view returns (uint256) {
        return rawFees[token][address(SETTLEMENT_TOKEN)] + creatorClaimable[token] + hydeClaimable[token]
            + (holderFunded[token] - holderClaimed[token]);
    }
}
