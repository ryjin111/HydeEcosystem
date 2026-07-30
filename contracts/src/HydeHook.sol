// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IHydeHook} from "./interfaces/IHydeHook.sol";

/// @title HydeHook — per-pool V4 hook (non-fund-bearing) for the Hydeout own-stack
/// @notice CONTRACT_SPEC_L3.md §4c. Does the four "more" things over a plain LT/WETH pool while
///         holding NO user funds and taking NO swap delta: (1) `beforeInitialize` one-shot factory
///         auth, (2) `beforeSwap` decaying anti-snipe dynamic fee, (3) `afterSwap` swap-only WETH
///         volume (graduation metric) + a real-tick time-integrated observation-ring oracle,
///         (4) `consult` TWAP read (interpolated at the exact target, idle-pool synthetic bracket,
///         signed −∞ rounding). Mined permissions: BEFORE/AFTER_INITIALIZE | BEFORE/AFTER_SWAP.
///         INV-40/42/43/44/45/46/47/48/51.
/// @dev NOTE vs spec §4c: the anti-snipe schedule is a single global immutable set, so it lives as
///      hook immutables here rather than being copied into each per-pool record — the security-
///      relevant one-shot pending→staging→active auth + per-pool `launchTime` are unchanged. Trivially
///      movable to per-pool if Reviewer prefers; flagged in the build handoff.
contract HydeHook is IHooks, IHydeHook {
    using StateLibrary for IPoolManager;
    using BalanceDeltaLibrary for BalanceDelta;

    IPoolManager public immutable POOL_MANAGER;
    address public immutable VAULT; // system settlement swaps come from here → base fee + volume-skip
    address public immutable WETH;
    // anti-snipe + oracle immutables (validated at construction)
    uint24 public immutable startFee;
    uint24 public immutable baseFee;
    uint24 public immutable maxLpFeeCap;
    uint32 public immutable antiSnipeWindow;
    uint16 public immutable cardinality;

    address public factory; // set once (deployer initFactory), then locked
    address private immutable _deployer;

    uint24 private constant OVERRIDE_FEE_FLAG = 0x400000; // LPFeeLibrary.OVERRIDE_FEE_FLAG
    uint24 private constant DYNAMIC_FEE_FLAG = 0x800000; // LPFeeLibrary.DYNAMIC_FEE_FLAG

    // one-shot init state: pending → staging → active
    struct Pending {
        bool configured;
        address token;
        PoolKey key;
    }

    struct Staging {
        bool exists;
        address token;
    }

    struct Active {
        bool exists;
        address token;
        uint64 launchTime;
    }

    mapping(PoolId => Pending) private _pending;
    mapping(PoolId => Staging) private _staging;
    mapping(PoolId => Active) public active;

    /// @inheritdoc IHydeHook
    mapping(PoolId => uint256) public swapVolume;

    // real-tick observation ring + running state
    struct Obs {
        uint32 ts;
        int56 cum;
    }

    mapping(PoolId => int24) public lastTick;
    mapping(PoolId => uint32) public lastObsTs;
    mapping(PoolId => int56) public lastCumulative;
    mapping(PoolId => uint16) public ringIndex;
    mapping(PoolId => mapping(uint16 => Obs)) public obs;

    error NotFactory();
    error NotPoolManager();
    error HookNotImplemented();
    error BadPending();
    error BadKey();
    error OracleNotReady();

    event PendingRegistered(PoolId indexed poolId, address indexed token);
    event PoolActivated(PoolId indexed poolId, address indexed token, uint64 launchTime);

    modifier onlyPoolManager() {
        if (msg.sender != address(POOL_MANAGER)) revert NotPoolManager();
        _;
    }

    constructor(
        IPoolManager poolManager,
        address vault,
        address weth,
        uint24 _startFee,
        uint24 _baseFee,
        uint24 _maxLpFeeCap,
        uint32 _antiSnipeWindow,
        uint16 _cardinality
    ) {
        // DEPLOY-TIME address-bits self-check: the deployed hook MUST carry EXACTLY
        // the four permission bits it implements and NONE of add/remove/donate/returns-delta. If the
        // CREATE2 salt were mis-mined so (e.g.) the remove bit were set, V4 would route liquidity
        // removals to this hook's `revert HookNotImplemented()` stub → external LPs would be TRAPPED
        // (a honeypot-for-LPs, violating INV-EXT). This reverts construction on ANY address-bit
        // mismatch, so a mis-mined hook can never deploy.
        Hooks.validateHookPermissions(
            IHooks(address(this)),
            Hooks.Permissions({
                beforeInitialize: true,
                afterInitialize: true,
                beforeAddLiquidity: false,
                afterAddLiquidity: false,
                beforeRemoveLiquidity: false,
                afterRemoveLiquidity: false,
                beforeSwap: true,
                afterSwap: true,
                beforeDonate: false,
                afterDonate: false,
                beforeSwapReturnDelta: false,
                afterSwapReturnDelta: false,
                afterAddLiquidityReturnDelta: false,
                afterRemoveLiquidityReturnDelta: false
            })
        );
        require(address(poolManager) != address(0) && vault != address(0) && weth != address(0), "ZERO");
        require(
            _baseFee <= _startFee && _startFee <= _maxLpFeeCap && _maxLpFeeCap <= LPFeeLibrary.MAX_LP_FEE, "FEE_BOUNDS"
        );
        require(_antiSnipeWindow > 0, "ZERO_WINDOW");
        require(_cardinality >= 2, "CARDINALITY");
        POOL_MANAGER = poolManager;
        VAULT = vault;
        WETH = weth;
        startFee = _startFee;
        baseFee = _baseFee;
        maxLpFeeCap = _maxLpFeeCap;
        antiSnipeWindow = _antiSnipeWindow;
        cardinality = _cardinality;
        _deployer = msg.sender;
    }

    /// @notice One-shot factory binding (deployer-only, once).
    function initFactory(address f) external {
        require(msg.sender == _deployer, "ONLY_DEPLOYER");
        require(factory == address(0), "SET");
        require(f != address(0), "ZERO");
        factory = f;
    }

    /* ─────────────────────── IHydeHook: factory registration ───────────────── */
    /// @inheritdoc IHydeHook
    function registerPendingPool(PoolKey calldata key, address token) external {
        if (msg.sender != factory) revert NotFactory();
        PoolId id = key.toId();
        require(!_pending[id].configured && !active[id].exists, "EXISTS");
        _pending[id] = Pending({configured: true, token: token, key: key});
        emit PendingRegistered(id, token);
    }

    /* ─────────────────────────── IHooks: initialize ────────────────────────── */
    function beforeInitialize(address sender, PoolKey calldata key, uint160)
        external
        onlyPoolManager
        returns (bytes4)
    {
        if (sender != factory) revert NotFactory();
        PoolId id = key.toId();
        Pending memory p = _pending[id];
        if (!p.configured) revert BadPending();
        if (
            !_keyEq(p.key, key) || address(key.hooks) != address(this) || key.fee != DYNAMIC_FEE_FLAG
                || !_isLtWeth(key, p.token)
        ) revert BadKey();
        _staging[id] = Staging({exists: true, token: p.token});
        delete _pending[id]; // consume the one-shot pending record (rollback restores neither → no stale auth)
        return IHooks.beforeInitialize.selector;
    }

    function afterInitialize(address, PoolKey calldata key, uint160, int24 tick)
        external
        onlyPoolManager
        returns (bytes4)
    {
        PoolId id = key.toId();
        Staging memory s = _staging[id];
        require(s.exists, "NO_STAGING");
        active[id] = Active({exists: true, token: s.token, launchTime: uint64(block.timestamp)});
        delete _staging[id]; // consume staging
        // seed the observation ring at the initial tick.
        obs[id][0] = Obs({ts: uint32(block.timestamp), cum: int56(0)});
        lastCumulative[id] = 0;
        lastTick[id] = tick;
        lastObsTs[id] = uint32(block.timestamp);
        ringIndex[id] = 0;
        emit PoolActivated(id, s.token, uint64(block.timestamp));
        return IHooks.afterInitialize.selector;
    }

    /* ─────────────────────────── IHooks: swap ──────────────────────────────── */
    function beforeSwap(address sender, PoolKey calldata key, SwapParams calldata, bytes calldata)
        external
        view
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        uint24 fee;
        if (sender == VAULT) {
            fee = baseFee; // system settlement swap → base fee (no anti-snipe surcharge)
        } else {
            uint256 elapsed = block.timestamp - active[key.toId()].launchTime;
            if (elapsed >= antiSnipeWindow) {
                fee = baseFee;
            } else {
                // baseFee + (startFee-baseFee)·(window-elapsed)/window — branch can't underflow.
                uint256 f =
                    uint256(baseFee) + uint256(startFee - baseFee) * (antiSnipeWindow - elapsed) / antiSnipeWindow;
                fee = f > maxLpFeeCap ? maxLpFeeCap : uint24(f);
            }
        }
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, fee | OVERRIDE_FEE_FLAG);
    }

    function afterSwap(address sender, PoolKey calldata key, SwapParams calldata, BalanceDelta delta, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, int128)
    {
        PoolId id = key.toId();
        // 1. Oracle — ALWAYS (incl. sender == VAULT, constraint 1). Post-swap tick from slot0.
        (, int24 tick,,) = POOL_MANAGER.getSlot0(id);
        unchecked {
            uint32 dt = uint32(block.timestamp) - lastObsTs[id];
            if (dt == 0) {
                lastTick[id] = tick; // same-block: update lastTick only; no ring slot consumed (INV-45)
            } else {
                lastCumulative[id] += int56(lastTick[id]) * int56(uint56(dt));
                uint16 idx = uint16((uint256(ringIndex[id]) + 1) % cardinality);
                ringIndex[id] = idx;
                obs[id][idx] = Obs({ts: uint32(block.timestamp), cum: lastCumulative[id]});
                lastTick[id] = tick;
                lastObsTs[id] = uint32(block.timestamp);
            }
        }
        // 2. Volume — skip system settlement swaps (sender == VAULT); int128-boundary-safe abs (INV-47).
        if (sender != VAULT) {
            int128 w = Currency.unwrap(key.currency0) == WETH ? delta.amount0() : delta.amount1();
            uint256 add = w == type(int128).min
                ? uint256(uint128(type(int128).max)) + 1
                : uint256(uint128(w < 0 ? -w : w));
            swapVolume[id] += add;
        }
        return (IHooks.afterSwap.selector, int128(0));
    }

    /* ─────────────────────────── consult (TWAP) ────────────────────────────── */
    /// @inheritdoc IHydeHook
    function consult(PoolId id, uint32 window) external view returns (int24 twapTick) {
        require(block.timestamp >= window, "ORACLE_NOT_READY"); // guard before subtraction
        uint32 target = uint32(block.timestamp - window);
        int56 lastCum = lastCumulative[id];
        int24 lTick = lastTick[id];
        uint32 lObs = lastObsTs[id];

        int56 cumNow;
        int56 cumTarget;
        unchecked {
            cumNow = lastCum + int56(lTick) * int56(uint56(uint32(block.timestamp) - lObs));
            if (target >= lObs) {
                // idle pool: target falls after the newest stored obs → extrapolate at lastTick (INV-51).
                cumTarget = lastCum + int56(lTick) * int56(uint56(target - lObs));
            }
        }
        if (target < lObs) {
            (bool ok, int56 c) = _interpolateAtTarget(id, target);
            if (!ok) revert OracleNotReady(); // window not spanned by stored observations
            cumTarget = c;
        }

        int256 dcum = int256(cumNow) - int256(cumTarget);
        int256 win = int256(uint256(window));
        twapTick = int24(dcum / win);
        if (dcum < 0 && dcum % win != 0) twapTick -= 1; // canonical OracleLibrary: round toward −∞
    }

    /// @dev BINARY-SEARCH the observation ring for the pair bracketing `target`, then linearly
    ///      interpolate the cumulative at `target`. O(log cardinality) — replaces the former
    ///      O(cardinality) linear scan (FINDING-2), so a ring sized for the whole TWAP window is
    ///      cheap to read and `settle`/`compound` can't be DoS'd by a churned ring. Returns false
    ///      if `target` predates the oldest retained observation (window not yet spanned).
    ///
    ///      Ring timestamps increase monotonically oldest→newest; the ring fills forward and slot 0
    ///      is seeded at activation, so before it wraps the oldest is slot 0, after wrap it is the
    ///      slot just past `newest`. Every slot in [oldest, newest] is initialized (no gaps).
    function _interpolateAtTarget(PoolId id, uint32 target) internal view returns (bool ok, int56 cum) {
        uint16 card = cardinality;
        uint16 newest = ringIndex[id];
        uint16 next = uint16((uint256(newest) + 1) % card);
        bool wrapped = obs[id][next].ts != 0;
        uint16 oldest = wrapped ? next : 0;
        uint256 count = wrapped ? card : (uint256(newest) + 1);

        // Window not spanned by stored history → caller reverts ORACLE_NOT_READY.
        if (target < obs[id][oldest].ts) return (false, 0);

        // Largest logical position p in [0, count-1] whose obs.ts ≤ target. The caller only reaches
        // here with target < newest.ts (idle case handled by extrapolation), so p < count-1 ⇒ the
        // newer neighbor `a` always exists — no wrap-past-newest edge.
        uint256 lo = 0;
        uint256 hi = count - 1;
        while (lo < hi) {
            uint256 mid = (lo + hi + 1) >> 1;
            if (obs[id][uint16((uint256(oldest) + mid) % card)].ts <= target) lo = mid;
            else hi = mid - 1;
        }
        Obs memory b = obs[id][uint16((uint256(oldest) + lo) % card)]; // beforeOrAt (older)
        Obs memory a = obs[id][uint16((uint256(oldest) + lo + 1) % card)]; // atOrAfter (newer)
        if (target == b.ts) return (true, b.cum);
        // Widen before multiplying. `a.cum - b.cum` is an int56 cumulative delta, but a long
        // idle gap can make `(delta * secondsIntoGap)` overflow int56 even though the final
        // interpolated cumulative is necessarily bounded by the two int56 endpoints.
        int256 span = int256(uint256(a.ts - b.ts));
        int256 into = int256(uint256(target - b.ts));
        int256 interpolated =
            int256(b.cum) + (int256(a.cum) - int256(b.cum)) * into / span;
        return (true, int56(interpolated));
    }

    /* ─────────────────────── unused hooks (mined out; revert) ───────────────── */
    function beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    /* ─────────────────────────── helpers ───────────────────────────────────── */
    function _keyEq(PoolKey memory a, PoolKey calldata b) internal pure returns (bool) {
        return Currency.unwrap(a.currency0) == Currency.unwrap(b.currency0)
            && Currency.unwrap(a.currency1) == Currency.unwrap(b.currency1) && a.fee == b.fee
            && a.tickSpacing == b.tickSpacing && address(a.hooks) == address(b.hooks);
    }

    function _isLtWeth(PoolKey calldata key, address token) internal view returns (bool) {
        address c0 = Currency.unwrap(key.currency0);
        address c1 = Currency.unwrap(key.currency1);
        return (c0 == token && c1 == WETH) || (c0 == WETH && c1 == token);
    }
}
