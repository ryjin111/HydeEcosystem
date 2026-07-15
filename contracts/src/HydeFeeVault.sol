// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Multicall} from "@openzeppelin/contracts/utils/Multicall.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath as V4TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

import {IHydeVault} from "./interfaces/IHydeVault.sol";
import {IHydeHook} from "./interfaces/IHydeHook.sol";
import {OracleLib} from "./libraries/OracleLib.sol";

/// @title HydeFeeVault — WETH fee settlement + creator/Hyde pull claims (rev8: holder machinery removed)
/// @notice CONTRACT_SPEC_L3.md §4b (rev8). Shared singleton, per-token accounting. `collect` sends raw
///         V4 fees here (swap-free) AFTER the collector retains its 5% in-kind liquidity carve; the
///         permissionless `settle` converts a raw leg to WETH (the ONLY swap — TWAP-floored + oracle-
///         gated) and splits it into the creator/Hyde pull buckets via `NET_BPS` (9500): Hyde =
///         `hydeBps/NET_BPS` = 500/9500 = exactly 5% of the original notional, creator = the 90%
///         remainder. O(1), no loops. **(rev8) The holder/epoch/reward machinery + the token `sync`
///         hook are REMOVED IN FULL** — the 5% liquidity leg never reaches the vault (carved + auto-
///         compounded at the collector, §4).
///         Invariants: INV-1/2/3/13/27/31/32/34. Retired (holder/epoch/reward): INV-23/24/25/26/28/29.
///         RETAINED (not holder-specific): INV-27 (solvency), INV-30 (register-before-mint).
contract HydeFeeVault is IHydeVault, IUnlockCallback, ReentrancyGuard, Multicall {
    using SafeERC20 for IERC20;
    using BalanceDeltaLibrary for BalanceDelta;

    /* ─────────────────────────── immutables ────────────────────────────────── */
    IERC20 public immutable SETTLEMENT_TOKEN; // WETH (= wrappedNative)
    address public immutable COLLECTOR;
    IPoolManager public immutable POOL_MANAGER;
    IHydeHook public immutable HOOK;
    int24 public immutable tickSpacing; // LT/WETH dynamic-fee pool tickSpacing
    address public immutable hydeoutTreasury;
    uint16 public immutable hydeBps; // == 500
    /// @notice the collector-forwarded remainder after the 5% in-kind carve (== BPS_DENOM − liqBps).
    ///         Split denominator so `hydeBps/NET_BPS` of the forwarded 95% == exactly 5% of the
    ///         original notional (INV-C7). The factory cross-checks `NET_BPS + collector.liqBps() ==
    ///         BPS_DENOM` at deploy (INV-C7b), so silent config-drift can't break 90/5/5.
    uint16 public immutable NET_BPS; // == 9500
    uint16 public immutable MAX_SLIPPAGE_BPS; // default 300
    uint32 public immutable TWAP_WINDOW; // default 1800s

    uint16 private constant BPS_DENOM = 10_000;
    uint24 private constant DYNAMIC_FEE_FLAG = 0x800000; // LPFeeLibrary.DYNAMIC_FEE_FLAG

    /// @notice one-shot `unlockCallback` authorization: a callback is valid only during
    ///         our own `settle` unlock, matching the exact job hash, consumed once.
    bytes32 private _activeJob;
    uint256 private _jobNonce;

    /// @notice the one factory allowed to `register`. Set once (deployer fallback), then locked.
    address public factory;
    address private immutable _deployer;

    /* ─────────────────────────── per-token state ───────────────────────────── */
    mapping(address => bool) public registered;
    mapping(address => address) public creator;

    /// @notice un-settled raw V4 fees, keyed token→asset (asset ∈ {launch token (LT), WETH}).
    mapping(address => mapping(address => uint256)) public rawFees;

    /// @notice WETH owed to the creator / Hyde, claimable any time (pull-based).
    mapping(address => uint256) public creatorClaimable;
    mapping(address => uint256) public hydeClaimable;

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
        uint256 hydeCut
    );
    event CreatorClaimed(address indexed token, address indexed creator, uint256 amount);
    event HydeClaimed(address indexed token, uint256 amount);

    /* ─────────────────────────── construction ──────────────────────────────── */
    constructor(
        IERC20 settlementToken,
        address collector,
        IPoolManager poolManager,
        IHydeHook hook,
        int24 _tickSpacing,
        address _hydeoutTreasury,
        uint16 _hydeBps,
        uint16 _netBps,
        uint16 _maxSlippageBps,
        uint32 _twapWindow
    ) {
        require(address(settlementToken) != address(0), "ZERO_WETH");
        require(collector != address(0), "ZERO_COLLECTOR");
        require(address(poolManager) != address(0), "ZERO_POOL_MANAGER");
        require(address(hook) != address(0), "ZERO_HOOK");
        require(_tickSpacing > 0, "ZERO_TICK_SPACING");
        require(_hydeoutTreasury != address(0), "ZERO_TREASURY");
        require(_hydeBps == 500, "HYDE_BPS"); // hard-capped, immutable (INV-2)
        // NET_BPS is the collector-forwarded remainder; sanity bounds here, EXACT cross-check
        // (`NET_BPS + collector.liqBps() == BPS_DENOM`) is enforced in the factory constructor (INV-C7b).
        require(_netBps > _hydeBps && _netBps < BPS_DENOM, "NET_BPS");
        require(_maxSlippageBps < BPS_DENOM, "SLIPPAGE"); // floor can't be zeroed (INV-18)
        require(_twapWindow != 0, "ZERO_TWAP");

        SETTLEMENT_TOKEN = settlementToken;
        COLLECTOR = collector;
        POOL_MANAGER = poolManager;
        HOOK = hook;
        tickSpacing = _tickSpacing;
        hydeoutTreasury = _hydeoutTreasury;
        hydeBps = _hydeBps;
        NET_BPS = _netBps;
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

    /* ─────────────────────────── settle (the ONLY swap) ────────────────────── */
    /// @notice Permissionless. Converts a raw fee leg to WETH and splits it creator/Hyde via NET_BPS.
    ///         TWAP-floor + `ORACLE_NOT_READY` guarded; `minOut = max(TWAP-floor, callerMinOut)`.
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

        uint256 wethAmt;
        if (asset == address(SETTLEMENT_TOKEN)) {
            // WETH leg — PURE reclassification: move existing WETH from the rawFees component of the
            // derived liability into the buckets; total accountedBalance[WETH] UNCHANGED (INV-27).
            rawFees[token][asset] -= amountIn;
            wethAmt = amountIn;
        } else {
            // LT leg — the system's ONLY swap (direct vault→PoolManager). CEI pre-debit BEFORE the
            // external unlock so a callback revert unwinds via the tx revert.
            rawFees[token][asset] -= amountIn;
            accountedBalance[asset] -= amountIn;

            // Oracle floor — the hook TWAP (interpolated at now−TWAP_WINDOW; reverts ORACLE_NOT_READY
            // until the window is spanned). The vault converts the mean tick → WETH quote.
            int24 twapTick = HOOK.consult(_poolId(token), TWAP_WINDOW);
            uint256 twapQuote = OracleLib.getQuoteAtTick(twapTick, amountIn, token, address(SETTLEMENT_TOKEN));
            uint256 floor = Math.mulDiv(twapQuote, BPS_DENOM - MAX_SLIPPAGE_BPS, BPS_DENOM);
            uint256 minOut = floor > callerMinOut ? floor : callerMinOut; // tighten-only

            // One-shot callback authorization: bind this unlock to an exact job hash.
            bytes32 job = keccak256(abi.encode(token, amountIn, minOut, _jobNonce++));
            _activeJob = job;
            bytes memory ret = POOL_MANAGER.unlock(abi.encode(token, amountIn, minOut, job));
            wethAmt = abi.decode(ret, (uint256)); // the MEASURED WETH the callback took (≥ minOut)
            accountedBalance[address(SETTLEMENT_TOKEN)] += wethAmt; // new WETH entered the vault
        }

        // (rev8) Split creator/Hyde ONLY (no holder leg). `wethAmt` is already the post-carve 95%
        // remainder, so `hydeBps/NET_BPS` = 500/9500 makes Hyde exactly 5% of the original notional and
        // creator the 90% remainder. Rounding favors the creator (creatorCut = wethAmt − hydeCut, exact).
        uint256 hydeCut = Math.mulDiv(wethAmt, hydeBps, NET_BPS);
        uint256 creatorCut = wethAmt - hydeCut;

        creatorClaimable[token] += creatorCut;
        hydeClaimable[token] += hydeCut;

        emit Settled(token, asset, amountIn, wethAmt, creatorCut, hydeCut);
    }

    /// @notice PoolManager unlock callback — runs the LT→WETH swap for `settle` and settles every
    ///         delta. Authorized ONLY during our own `settle` unlock via the one-shot job hash:
    ///         `msg.sender == POOL_MANAGER` AND the decoded job == the active job, consumed once (an
    ///         unsolicited / replayed callback reverts — INV-48).
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(POOL_MANAGER), "NOT_POOL_MANAGER");
        (address token, uint256 amountIn, uint256 minOut, bytes32 job) =
            abi.decode(data, (address, uint256, uint256, bytes32));
        require(job != bytes32(0) && job == _activeJob, "BAD_JOB");
        _activeJob = bytes32(0); // consume once

        PoolKey memory key = _poolKey(token);
        bool zeroForOne = Currency.unwrap(key.currency0) == token; // LT is currency0?
        uint160 limit = zeroForOne ? V4TickMath.MIN_SQRT_PRICE + 1 : V4TickMath.MAX_SQRT_PRICE - 1;

        BalanceDelta d = POOL_MANAGER.swap(
            key,
            SwapParams({zeroForOne: zeroForOne, amountSpecified: -int256(amountIn), sqrtPriceLimitX96: limit}),
            ""
        );

        // Reject partial fills: the input delta must consume EXACTLY amountIn, else the
        // swap clipped on the price limit / thin liquidity → revert (no mismatched transfer/credit).
        int128 inDelta = zeroForOne ? d.amount0() : d.amount1();
        require(inDelta == -int128(int256(amountIn)), "PARTIAL_FILL");
        int128 outDelta = zeroForOne ? d.amount1() : d.amount0();
        require(outDelta > 0, "NO_OUTPUT");

        // Settle the input exactly: sync → transfer the owed LT → settle() must report `amountIn`.
        POOL_MANAGER.sync(Currency.wrap(token));
        IERC20(token).safeTransfer(address(POOL_MANAGER), amountIn);
        require(POOL_MANAGER.settle() == amountIn, "SETTLE_MISMATCH");

        // Take the output, crediting the MEASURED WETH balance increase, not the raw delta.
        uint256 beforeWeth = SETTLEMENT_TOKEN.balanceOf(address(this));
        POOL_MANAGER.take(Currency.wrap(address(SETTLEMENT_TOKEN)), address(this), uint256(uint128(outDelta)));
        uint256 wethOut = SETTLEMENT_TOKEN.balanceOf(address(this)) - beforeWeth;
        require(wethOut >= minOut, "SLIPPAGE_FLOOR");
        return abi.encode(wethOut);
    }

    /// @dev The launch's LT/WETH dynamic-fee pool key — deterministic from the token (currencies
    ///      sorted, DYNAMIC_FEE_FLAG, tickSpacing, HOOK); no per-token storage needed.
    function _poolKey(address token) internal view returns (PoolKey memory) {
        (Currency c0, Currency c1) = token < address(SETTLEMENT_TOKEN)
            ? (Currency.wrap(token), Currency.wrap(address(SETTLEMENT_TOKEN)))
            : (Currency.wrap(address(SETTLEMENT_TOKEN)), Currency.wrap(token));
        return PoolKey({
            currency0: c0,
            currency1: c1,
            fee: DYNAMIC_FEE_FLAG,
            tickSpacing: tickSpacing,
            hooks: IHooks(address(HOOK))
        });
    }

    function _poolId(address token) internal view returns (PoolId) {
        return _poolKey(token).toId();
    }

    /* ─────────────────────────── claims (pull) ─────────────────────────────── */
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
    /// @notice Derived per-token WETH liability (INV-25/27): rawFees + creator + Hyde (rev8: no holder).
    function wethLiability(address token) external view returns (uint256) {
        return rawFees[token][address(SETTLEMENT_TOKEN)] + creatorClaimable[token] + hydeClaimable[token];
    }
}
