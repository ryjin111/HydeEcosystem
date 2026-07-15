// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

import {IPositionManager} from "v4-periphery/src/interfaces/IPositionManager.sol";
import {IStateView} from "v4-periphery/src/interfaces/IStateView.sol";
import {LiquidityAmounts} from "v4-periphery/src/libraries/LiquidityAmounts.sol";
import {Actions} from "v4-periphery/src/libraries/Actions.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";

import {IHydeVault} from "./interfaces/IHydeVault.sol";
import {IHydeHook} from "./interfaces/IHydeHook.sol";

/// @title HydeFeeCollector — permanent V4 LP custodian + swap-free fee harvest + 5% in-kind auto-compound
/// @notice CONTRACT_SPEC_L3.md §4 (rev8 · V4). Custodies each launch's v4 position ERC-721 FOREVER
///         (custody-lock BY ABSENCE: no transfer/approve/setApprovalForAll/decreaseLiquidity/burn/
///         generic-call/onERC721Received-forward/pending-sweep path exists — our NFT only; external LPs
///         on the same pool stay freely removable). `collect` is permissionless + swap-free: a zero-
///         liquidity `INCREASE_LIQUIDITY`+`TAKE_PAIR` harvests owed {LT, WETH}; the collector then
///         RETAINS 5% of EACH in-kind (`pendingLiq{LT,WETH}`) and `noteRaw`s the remaining 95% to the
///         vault. The permissionless `compound` adds the pending in-kind LT+WETH into the SAME locked
///         NFT — ADD-ONLY, TWAP-gated, sort-aware, residual-conserving, NO swap. Invariants INV-C1..C8.
contract HydeFeeCollector {
    using SafeERC20 for IERC20;

    /* ─────────────────────────── immutables ────────────────────────────────── */
    IPositionManager public immutable POSITION_MANAGER;
    IPoolManager public immutable POOL_MANAGER;
    IHydeVault public immutable VAULT;
    /// @notice WETH (= the vault's SETTLEMENT_TOKEN); the sole permitted pool numéraire (INV-34).
    address public immutable WETH;
    IHydeHook public immutable HOOK; // TWAP add-gate source (`consult`)
    IAllowanceTransfer public immutable PERMIT2; // compound pays the add via Permit2 → PositionManager
    IStateView public immutable STATE_VIEW; // V4 lens for spot slot0/tick reads
    int24 public immutable tickSpacing;
    /// @notice the in-kind carve — 5% of every harvested asset retained for liquidity (immutable, INV-2).
    uint16 public immutable liqBps; // == 500
    /// @notice the vault-forwarded remainder (== BPS_DENOM − liqBps); factory cross-checks it (INV-C7b).
    uint16 public immutable NET_BPS; // == 9500
    /// @notice min liquidityΔ per `compound` add; below → the add is skipped, pending accumulates (INV-C5).
    uint128 public immutable MIN_ADD_LIQUIDITY;
    /// @notice TWAP add-gate band: `compound` reverts if |spot − twap| exceeds this (INV-C4).
    int24 public immutable MAX_ADD_DEV_TICKS;
    uint32 public immutable TWAP_WINDOW;

    uint16 private constant BPS_DENOM = 10_000;
    uint24 private constant DYNAMIC_FEE_FLAG = 0x800000; // LPFeeLibrary.DYNAMIC_FEE_FLAG

    /// @notice the one factory allowed to `register`. Set once via `initFactory`, then locked.
    address public factory;
    address private immutable _deployer;

    /* ─────────────────────────── registry ──────────────────────────────────── */
    struct Position {
        bool registered;
        bool graduated; // one-way (set only by a future un-stubbed `graduate`)
        address creator; // immutable custody fact (the vault holds the real recipient)
        uint256 tokenId; // the v4 position held here forever
        address numeraire; // == WETH (asserted at register; INV-31/34)
        uint256 graduationThreshold; // milestone target (label only)
        int24 tickLower; // (rev8) the seed range — recorded so `compound` computes add-amounts locally
        int24 tickUpper;
    }

    mapping(address => Position) public positionOf;

    /// @notice (rev8) per-token IN-KIND liquidity pending a compound. Custody-locked exactly like the
    ///         NFT — there is NO owner sweep/drain/withdraw selector for these balances (INV-C6).
    mapping(address => uint256) public pendingLiqLT;
    mapping(address => uint256) public pendingLiqWETH;
    /// @notice lifetime added into the locked position (currency0/currency1), for the frontend meter.
    mapping(address => uint256) public totalCompounded0;
    mapping(address => uint256) public totalCompounded1;

    /* ─────────────────────────── reentrancy ────────────────────────────────── */
    uint256 private _lock = 1;

    modifier nonReentrant() {
        require(_lock == 1, "REENTRANCY");
        _lock = 2;
        _;
        _lock = 1;
    }

    modifier onlyFactory() {
        require(msg.sender == factory, "ONLY_FACTORY");
        _;
    }

    /* ─────────────────────────── events ────────────────────────────────────── */
    event PositionRegistered(address indexed token, address indexed creator, uint256 tokenId);
    event FeesCollected(address indexed token, uint256 amtLT, uint256 amtWETH);
    event LiquidityCompounded(address indexed token, uint128 liquidity, uint256 used0, uint256 used1);

    constructor(
        IPositionManager positionManager,
        IPoolManager poolManager,
        IHydeVault vault,
        address weth,
        IHydeHook hook,
        IAllowanceTransfer permit2,
        IStateView stateView,
        int24 _tickSpacing,
        uint16 _liqBps,
        uint16 _netBps,
        uint128 _minAddLiquidity,
        int24 _maxAddDevTicks,
        uint32 _twapWindow
    ) {
        require(address(positionManager) != address(0), "ZERO_PM");
        require(address(poolManager) != address(0), "ZERO_POOL_MANAGER");
        require(address(vault) != address(0), "ZERO_VAULT");
        require(weth != address(0), "ZERO_WETH");
        require(address(hook) != address(0), "ZERO_HOOK");
        require(address(permit2) != address(0), "ZERO_PERMIT2");
        require(address(stateView) != address(0), "ZERO_STATE_VIEW");
        require(_tickSpacing > 0, "ZERO_TICK_SPACING");
        require(_liqBps == 500, "LIQ_BPS"); // hard-capped, immutable (INV-2)
        require(_netBps == BPS_DENOM - _liqBps, "NET_BPS"); // liqBps + NET_BPS == 100% (INV-C7b, local)
        require(_maxAddDevTicks > 0, "ZERO_DEV_TICKS");
        require(_twapWindow != 0, "ZERO_TWAP");
        POSITION_MANAGER = positionManager;
        POOL_MANAGER = poolManager;
        VAULT = vault;
        WETH = weth;
        HOOK = hook;
        PERMIT2 = permit2;
        STATE_VIEW = stateView;
        tickSpacing = _tickSpacing;
        liqBps = _liqBps;
        NET_BPS = _netBps;
        MIN_ADD_LIQUIDITY = _minAddLiquidity;
        MAX_ADD_DEV_TICKS = _maxAddDevTicks;
        TWAP_WINDOW = _twapWindow;
        _deployer = msg.sender;
    }

    /// @notice One-shot factory binding (deployer-only, once). A 2nd call / non-deployer reverts.
    function initFactory(address factory_) external {
        require(msg.sender == _deployer, "ONLY_DEPLOYER");
        require(factory == address(0), "FACTORY_SET");
        require(factory_ != address(0), "ZERO_FACTORY");
        factory = factory_;
    }

    /* ─────────────────────────── registration ──────────────────────────────── */
    /// @notice Records a launch's immutable custody facts + the seed range. Written ONCE by the factory.
    ///         Asserts the pool numéraire is WETH — the own-stack LT/WETH lock (INV-31/34).
    function register(
        address token,
        address creator,
        uint256 tokenId,
        address numeraire,
        uint256 graduationThreshold,
        int24 tickLower,
        int24 tickUpper
    ) external onlyFactory {
        require(!positionOf[token].registered, "REGISTERED");
        require(token != address(0) && creator != address(0), "ZERO");
        require(numeraire == WETH, "NUMERAIRE"); // LT/WETH lock (INV-34)
        require(tickLower < tickUpper, "TICK_ORDER");
        positionOf[token] = Position({
            registered: true,
            graduated: false,
            creator: creator,
            tokenId: tokenId,
            numeraire: numeraire,
            graduationThreshold: graduationThreshold,
            tickLower: tickLower,
            tickUpper: tickUpper
        });
        emit PositionRegistered(token, creator, tokenId);
    }

    /* ─────────────────────────── collect (swap-free, V4) ───────────────────── */
    /// @notice Permissionless, SWAP-FREE. Harvests accrued v4 fees ({LT, WETH}), RETAINS the 5% in-kind
    ///         liquidity carve, and `noteRaw`s the remaining 95% of each to the vault. A zero-liquidity
    ///         `INCREASE_LIQUIDITY` credits the position's owed fees; `TAKE_PAIR` sweeps both currencies
    ///         here (PositionManager owns the unlock); measured deltas are carved then noted.
    function collect(address token) external nonReentrant {
        Position memory pos = positionOf[token];
        require(pos.registered, "UNKNOWN");

        (Currency c0, Currency c1) = _currencies(token);
        uint256 ltBefore = IERC20(token).balanceOf(address(this));
        uint256 wethBefore = IERC20(WETH).balanceOf(address(this));

        bytes memory actions = abi.encodePacked(uint8(Actions.INCREASE_LIQUIDITY), uint8(Actions.TAKE_PAIR));
        bytes[] memory params = new bytes[](2);
        // INCREASE_LIQUIDITY(tokenId, liquidity=0, amount0Max, amount1Max, hookData) — zero-liq fee credit.
        params[0] = abi.encode(pos.tokenId, uint256(0), type(uint128).max, type(uint128).max, bytes(""));
        // TAKE_PAIR(currency0, currency1, recipient) — sweep both currencies here.
        params[1] = abi.encode(c0, c1, address(this));
        POSITION_MANAGER.modifyLiquidities(abi.encode(actions, params), block.timestamp);

        uint256 ltIn = IERC20(token).balanceOf(address(this)) - ltBefore;
        uint256 wethIn = IERC20(WETH).balanceOf(address(this)) - wethBefore;

        // (rev8) In-kind liqBps carve — retain 5% of EACH harvested asset, note the remainder. Exact
        // conservation (INV-C7): dLT = liqLT + noted_LT, dWETH = liqWETH + noted_WETH (subtraction, not a
        // second mulDiv), so nothing is created or dropped — every wei is queued or noted.
        uint256 liqLT = Math.mulDiv(ltIn, liqBps, BPS_DENOM);
        uint256 liqWETH = Math.mulDiv(wethIn, liqBps, BPS_DENOM);
        pendingLiqLT[token] += liqLT;
        pendingLiqWETH[token] += liqWETH;

        uint256 noteLT = ltIn - liqLT;
        uint256 noteWETH = wethIn - liqWETH;
        if (noteLT > 0) _note(token, token, noteLT);
        if (noteWETH > 0) _note(token, WETH, noteWETH);
        emit FeesCollected(token, ltIn, wethIn);
    }

    /* ─────────────────────── compound (add-only, no swap) ──────────────────── */
    /// @notice Permissionless, trigger (A) continuous auto-compound. Adds the pending in-kind LT+WETH
    ///         into the collector's OWN custody-locked position — hands-off, NO swap, NO operator.
    ///         Rounds strictly in the protocol's favor: the pull is hard-capped at the pending
    ///         (`amount{0,1}Max = pending`), `getLiquidityForAmounts` floors the liquidity, and the
    ///         pending is decremented by the MEASURED consumption only — pending is never over-credited
    ///         (Bunni $8.4M rounding-drain class; here also structurally impossible — add-only). The
    ///         `deadline` is caller-supplied (never `block.timestamp`) — MEV-hygiene on the add.
    function compound(address token, uint256 deadline) external nonReentrant {
        Position memory pos = positionOf[token];
        require(pos.registered, "UNKNOWN");
        require(block.timestamp <= deadline, "DEADLINE");

        (Currency c0, Currency c1) = _currencies(token);
        PoolId poolId = _poolId(token);
        bool ltIsC0 = token < WETH;

        // (1) map pending onto currency0/1 by the same address sort as everywhere (INV-C1).
        uint256 l0 = ltIsC0 ? pendingLiqLT[token] : pendingLiqWETH[token];
        uint256 l1 = ltIsC0 ? pendingLiqWETH[token] : pendingLiqLT[token];

        // (2) TWAP add-gate (INV-C4): no add at a manipulated spot. `consult` reverts ORACLE_NOT_READY
        //     until the window is spanned. There is no swap here to sandwich; the only vector is a spot
        //     skew forcing extra residual — bounded, never value-extracting.
        (, int24 spot,,) = STATE_VIEW.getSlot0(poolId);
        int24 twap = HOOK.consult(poolId, TWAP_WINDOW);
        int24 dev = spot >= twap ? spot - twap : twap - spot;
        require(dev <= MAX_ADD_DEV_TICKS, "TWAP_DEVIATION");

        // (3) addable liquidity (INV-C1/C3, all three range states). One V4 library call returns the max
        //     liquidity supportable without exceeding EITHER pending side — inherently handles below-
        //     range (token0-only), above-range (token1-only) and in-range (min-binding). Wrong-side-only
        //     pending ⇒ liq = 0.
        uint160 sqrtP = TickMath.getSqrtPriceAtTick(spot);
        uint160 sqrtA = TickMath.getSqrtPriceAtTick(pos.tickLower);
        uint160 sqrtB = TickMath.getSqrtPriceAtTick(pos.tickUpper);
        uint128 liq = LiquidityAmounts.getLiquidityForAmounts(sqrtP, sqrtA, sqrtB, l0, l1);

        // (4) min-add / dust gate (INV-C5). Reverts BEFORE any state change / approval, so a skip leaves
        //     pendingLiq* untouched (honest liveness: conserved + locked, NOT yet liquidity).
        require(liq >= MIN_ADD_LIQUIDITY, "DUST_ACCUMULATE");

        // (5) approve EXACTLY the pending caps via Permit2 → PositionManager, then add into the SAME NFT.
        //     amount{0,1}Max = l{0,1} hard-caps the pull to the pending (INV-C3) — the position can NEVER
        //     consume more than what's queued, so the inert seed dust (INV-15) is never pulled.
        _permit2Approve(Currency.unwrap(c0), l0);
        _permit2Approve(Currency.unwrap(c1), l1);

        uint256 balBefore0 = IERC20(Currency.unwrap(c0)).balanceOf(address(this));
        uint256 balBefore1 = IERC20(Currency.unwrap(c1)).balanceOf(address(this));

        bytes memory actions = abi.encodePacked(uint8(Actions.INCREASE_LIQUIDITY), uint8(Actions.SETTLE_PAIR));
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(pos.tokenId, uint256(liq), uint128(l0), uint128(l1), bytes(""));
        params[1] = abi.encode(c0, c1);
        POSITION_MANAGER.modifyLiquidities(abi.encode(actions, params), deadline);

        // (6) measure actual consumption + conserve residual (INV-C2). used ≤ pending (amountMax cap), so
        //     the decrement can't underflow and pending is never over-credited; the un-consumed remainder
        //     STAYS queued (add-only, locked, re-attempted next compound).
        uint256 used0 = balBefore0 - IERC20(Currency.unwrap(c0)).balanceOf(address(this));
        uint256 used1 = balBefore1 - IERC20(Currency.unwrap(c1)).balanceOf(address(this));
        if (ltIsC0) {
            pendingLiqLT[token] -= used0;
            pendingLiqWETH[token] -= used1;
        } else {
            pendingLiqWETH[token] -= used0;
            pendingLiqLT[token] -= used1;
        }
        totalCompounded0[token] += used0;
        totalCompounded1[token] += used1;

        // reset Permit2 allowances to 0 (hygiene; collector retains only the un-consumed pending + dust).
        _permit2Approve(Currency.unwrap(c0), 0);
        _permit2Approve(Currency.unwrap(c1), 0);

        emit LiquidityCompounded(token, liq, used0, used1);
    }

    /* ─────────────────────────── internals ─────────────────────────────────── */
    /// @dev Hand one harvested asset to the vault: approve exact → vault pulls+measures → reset to 0.
    function _note(address token, address asset, uint256 amount) private {
        IERC20(asset).forceApprove(address(VAULT), amount);
        VAULT.noteRaw(token, asset, amount);
        IERC20(asset).forceApprove(address(VAULT), 0);
    }

    /// @dev Approve `amt` of `asset` to the PositionManager via Permit2 (0 resets). The periphery pulls
    ///      the owed currency from the collector for the `SETTLE_PAIR` leg.
    function _permit2Approve(address asset, uint256 amt) private {
        IERC20(asset).forceApprove(address(PERMIT2), amt);
        PERMIT2.approve(asset, address(POSITION_MANAGER), uint160(amt), amt == 0 ? 0 : type(uint48).max);
    }

    function _currencies(address token) internal view returns (Currency c0, Currency c1) {
        (c0, c1) =
            token < WETH ? (Currency.wrap(token), Currency.wrap(WETH)) : (Currency.wrap(WETH), Currency.wrap(token));
    }

    /// @dev The launch's LT/WETH dynamic-fee pool key (currencies sorted, DYNAMIC_FEE_FLAG, tickSpacing,
    ///      HOOK) — deterministic from the token; matches the vault + factory keys.
    function _poolKey(address token) internal view returns (PoolKey memory) {
        (Currency c0, Currency c1) = _currencies(token);
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

    /* ─────────────────────────── graduate (STUBBED) ────────────────────────── */
    /// @notice DISABLED pending the configured threshold + policy on the (label-only) hook
    ///         `swapVolume` milestone. No liquidity ever moves.
    function graduate(address /*token*/ ) external pure {
        revert("GRADUATION_PENDING");
    }

    /* ─────────────────────────── NFT custody ───────────────────────────────── */
    /// @notice Accept the position NFT. Returns the selector but NEVER forwards or acts — the NFT has
    ///         no way out of this contract (no transfer/approve/withdraw/decrease/burn selector exists).
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}
