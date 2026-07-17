// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";

import {LiquidityAmounts} from "v4-periphery/src/libraries/LiquidityAmounts.sol";
import {Actions} from "v4-periphery/src/libraries/Actions.sol";
import {IPositionManager} from "v4-periphery/src/interfaces/IPositionManager.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";

import {IHydeVault} from "./interfaces/IHydeVault.sol";
import {IHydeHook} from "./interfaces/IHydeHook.sol";
import {HydeERC20} from "./HydeERC20.sol";

/// @notice Cross-contract slice of `HydeFeeCollector.register` the factory calls once per launch.
interface IHydeCollectorRegister {
    function register(
        address token,
        address creator,
        uint256 tokenId,
        address numeraire,
        uint256 graduationThreshold,
        int24 tickLower,
        int24 tickUpper
    ) external;
}

/// @notice Minimal split-config views for the deploy-time 90/5/5 consistency assert (INV-C7b).
interface IHydeVaultBps {
    function NET_BPS() external view returns (uint16);
}

interface IHydeCollectorBps {
    function liqBps() external view returns (uint16);
}

/// @title HydeTokenFactory — permissionless fair-launch orchestrator (CONTRACT_SPEC_L3.md §3 · V4)
/// @notice A single `launch` atomically (all-or-revert): charges the $1 USDG launch fee, EIP-1167-clones
///         `HydeERC20`, registers the token in the vault (BEFORE the init mint, INV-30), one-shot-registers
///         the exact pending LT/WETH pool in the hook, mints 1B to the factory (the exempt seeder),
///         initializes the dynamic-fee V4 pool (hook-authed init), single-sided-seeds all 1B of LT into a
///         range that holds ONLY LT (no WETH), hands the position NFT to the collector's permanent custody,
///         sweeps the measured seed dust to the collector, and records the launch. Both address-sort
///         branches (LT = currency0 / currency1) are constructor-validated per allowed preset (INV-52).
///
///         ── Authority (§5 / INV-53) ── The factory has NO power over any LIVE token, pool, fee, or claim.
///         Its ONLY owner power is `pause`/`unpause` of NEW launches, and it is RENOUNCEABLE: `owner==0`
///         makes `pause`/`unpause` revert forever ⇒ the whole stack is immutable, publicly verifiable.
///         There is NO proxy, NO delegatecall-admin, NO selfdestruct, and NO setter for any recipient /
///         bps / anti-snipe / graduation / router / fee value (INV-53 forbidden-selector set).
contract HydeTokenFactory is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @dev fair launch supply — MUST equal `HydeERC20.TOTAL_SUPPLY` (constructor drift-guarded).
    uint256 public constant SUPPLY = 1_000_000_000e18;

    /// @dev bps denominator for the deploy-time 90/5/5 split-consistency assert (INV-C7b).
    uint16 private constant BPS_DENOM_F = 10_000;

    /* ─────────────────────────── immutables ────────────────────────────────── */
    address public immutable IMPL; // HydeERC20 implementation, cloned per launch
    address public immutable COLLECTOR;
    IHydeVault public immutable VAULT;
    IHydeHook public immutable HOOK;
    IPoolManager public immutable POOL_MANAGER;
    IPositionManager public immutable POSITION_MANAGER;
    IAllowanceTransfer public immutable PERMIT2;
    IERC20 public immutable USDG; // launch-fee stablecoin (6-dec)
    uint256 public immutable launchFeeAmount; // 1e6 == $1
    address public immutable launchFeeTreasury;
    address public immutable WETH; // sole pool numéraire
    address public immutable UNIVERSAL_ROUTER; // exempt-set member (§2)
    int24 public immutable tickSpacing;
    uint256 public immutable MAX_SEED_DUST; // measured seed-residual bound (§3 step 7 / INV-52)
    uint16 public immutable maxWalletBps; // token anti-snipe cap
    uint64 public immutable maxWalletWindowSecs;
    uint256 public immutable graduationThreshold; // label-only milestone target (collector)

    /* ─────────────────────────── presets ───────────────────────────────────── */
    /// @notice A single-sided seed geometry for one address-sort branch. All fields are set ONCE in the
    ///         constructor and validated (tick alignment, single-sidedness, residual ≤ MAX_SEED_DUST);
    ///         `liquidity` is precomputed so `launch` and the validation use identical numbers.
    struct Leg {
        int24 initialTick; // pool starting tick (LT-only single-sided at this price)
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
    }

    /// @notice One launchable preset = both sort branches. `launch` picks the branch matching the clone's
    ///         actual sort (token < WETH ⇒ LT is currency0 ⇒ `c0`; else `c1`).
    struct Preset {
        Leg c0; // LT = currency0 (LT < WETH): range ENTIRELY ABOVE spot
        Leg c1; // LT = currency1 (WETH < LT): range ENTIRELY BELOW spot
    }

    /// @notice Constructor input for one preset (both branches' raw ticks; liquidity is derived).
    struct PresetInput {
        int24 initialTick0;
        int24 tickLower0;
        int24 tickUpper0; // c0 branch (above spot)
        int24 initialTick1;
        int24 tickLower1;
        int24 tickUpper1; // c1 branch (below spot)
    }

    Preset[] private _presets;

    /* ─────────────────────────── owner (pause-only, renounceable) ──────────── */
    address public owner;
    address public pendingOwner;
    bool public paused;

    /// @notice (FINDING-8) PER-LAUNCHER clone-salt nonce. A single global counter let ANY concurrent
    ///         launch increment the entropy between a user's `predictNext` preview and their `launch`,
    ///         drifting them onto a different token address than the one they explicitly confirmed. Keyed
    ///         by launcher, an unrelated sender can no longer perturb a user's predicted address (the salt
    ///         already binds `msg.sender`, so cross-launcher collision was never possible either).
    mapping(address => uint256) private _nonce;

    /* ─────────────────────────── events ────────────────────────────────────── */
    event LaunchFeePaid(address indexed payer, address indexed treasury, uint256 amount);
    event LaunchCreated(
        address indexed token, address indexed creator, PoolId indexed poolId, uint256 tokenId, uint256 presetId
    );
    event Paused();
    event Unpaused();
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    /* ─────────────────────────── construction ──────────────────────────────── */
    struct ConstructorParams {
        address impl;
        address collector;
        address vault;
        address hook;
        address poolManager;
        address positionManager;
        address permit2;
        address usdg;
        uint256 launchFeeAmount;
        address launchFeeTreasury;
        address weth;
        address universalRouter;
        int24 tickSpacing;
        uint256 maxSeedDust;
        uint16 maxWalletBps;
        uint64 maxWalletWindowSecs;
        uint256 graduationThreshold;
        address owner;
    }

    constructor(ConstructorParams memory p, PresetInput[] memory presets) {
        // Chain-gate: any zero immutable ⇒ not constructible (§3).
        require(p.impl != address(0), "ZERO_IMPL");
        require(p.collector != address(0), "ZERO_COLLECTOR");
        require(p.vault != address(0), "ZERO_VAULT");
        require(p.hook != address(0), "ZERO_HOOK");
        require(p.poolManager != address(0), "ZERO_POOL_MANAGER");
        require(p.positionManager != address(0), "ZERO_POSITION_MANAGER");
        require(p.permit2 != address(0), "ZERO_PERMIT2");
        require(p.usdg != address(0), "ZERO_USDG");
        require(p.launchFeeAmount > 0, "ZERO_FEE");
        require(p.launchFeeTreasury != address(0), "ZERO_FEE_TREASURY");
        require(p.weth != address(0), "ZERO_WETH");
        require(p.universalRouter != address(0), "ZERO_ROUTER");
        require(p.tickSpacing > 0, "ZERO_TICK_SPACING");
        require(p.maxWalletBps > 0 && p.maxWalletBps <= 300, "MAXWALLET_BPS");
        require(p.maxWalletWindowSecs > 0 && p.maxWalletWindowSecs <= 3600, "MAXWALLET_WINDOW");
        require(p.owner != address(0), "ZERO_OWNER");
        // Drift-guard: the seed supply MUST match the token implementation's constant (INV-5).
        require(SUPPLY == HydeERC20(p.impl).TOTAL_SUPPLY(), "SUPPLY_DRIFT");
        // (rev8) Cross-contract 90/5/5 consistency (INV-C7b): the vault's forwarded remainder (NET_BPS)
        // and the collector's in-kind carve (liqBps) MUST sum to 100% — else the split silently drifts.
        // Both are independent immutables set before the factory in the deploy cycle; abort on mismatch.
        require(
            IHydeVaultBps(p.vault).NET_BPS() + IHydeCollectorBps(p.collector).liqBps() == BPS_DENOM_F, "BPS_SPLIT"
        );
        // (rev8 / FINDING-1) The hook address MUST decode to EXACTLY the 4 permission bits it implements
        // and NONE of add/remove/donate/returns-delta — a stray bit routes those ops to the hook's
        // `revert HookNotImplemented()` stubs and TRAPS external LPs (honeypot-for-LPs, INV-EXT). Abort
        // the deploy on any mismatch (belt-and-suspenders over the hook's own ctor self-check; §9).
        require(
            uint160(p.hook) & Hooks.ALL_HOOK_MASK
                == uint160(
                    Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG
                        | Hooks.AFTER_SWAP_FLAG
                ),
            "HOOK_FLAGS"
        );

        IMPL = p.impl;
        COLLECTOR = p.collector;
        VAULT = IHydeVault(p.vault);
        HOOK = IHydeHook(p.hook);
        POOL_MANAGER = IPoolManager(p.poolManager);
        POSITION_MANAGER = IPositionManager(p.positionManager);
        PERMIT2 = IAllowanceTransfer(p.permit2);
        USDG = IERC20(p.usdg);
        launchFeeAmount = p.launchFeeAmount;
        launchFeeTreasury = p.launchFeeTreasury;
        WETH = p.weth;
        UNIVERSAL_ROUTER = p.universalRouter;
        tickSpacing = p.tickSpacing;
        MAX_SEED_DUST = p.maxSeedDust;
        maxWalletBps = p.maxWalletBps;
        maxWalletWindowSecs = p.maxWalletWindowSecs;
        graduationThreshold = p.graduationThreshold;
        owner = p.owner;

        require(presets.length > 0, "NO_PRESETS");
        for (uint256 i; i < presets.length; ++i) {
            _presets.push(_buildPreset(presets[i], p.tickSpacing, p.maxSeedDust));
        }

        emit OwnershipTransferred(address(0), p.owner);
    }

    /// @dev Validate + precompute both sort branches of one preset. Reverts if either branch is not a
    ///      valid single-sided LT-only position whose round-up seed residual is ≤ MAX_SEED_DUST (INV-52).
    function _buildPreset(PresetInput memory in_, int24 ts, uint256 maxDust) internal pure returns (Preset memory) {
        Leg memory c0 = _buildLeg(in_.initialTick0, in_.tickLower0, in_.tickUpper0, ts, maxDust, true);
        Leg memory c1 = _buildLeg(in_.initialTick1, in_.tickLower1, in_.tickUpper1, ts, maxDust, false);
        return Preset({c0: c0, c1: c1});
    }

    /// @dev `ltIsCurrency0 == true`  ⇒ range ENTIRELY ABOVE spot, LT sits in currency0 (getLiquidity/Amount0).
    ///      `ltIsCurrency0 == false` ⇒ range ENTIRELY BELOW spot, LT sits in currency1 (getLiquidity/Amount1).
    function _buildLeg(int24 initialTick, int24 tickLower, int24 tickUpper, int24 ts, uint256 maxDust, bool ltIsCurrency0)
        internal
        pure
        returns (Leg memory leg)
    {
        // Tick alignment + usable-range bounds (V4 requires position ticks to be tickSpacing multiples).
        require(tickLower % ts == 0 && tickUpper % ts == 0, "TICK_ALIGN");
        require(tickLower < tickUpper, "TICK_ORDER");
        require(tickLower >= TickMath.minUsableTick(ts) && tickUpper <= TickMath.maxUsableTick(ts), "TICK_RANGE");
        require(initialTick >= TickMath.MIN_TICK && initialTick <= TickMath.MAX_TICK, "INIT_TICK");

        uint160 sqrtLower = TickMath.getSqrtPriceAtTick(tickLower);
        uint160 sqrtUpper = TickMath.getSqrtPriceAtTick(tickUpper);

        uint128 liquidity;
        uint256 dep;
        if (ltIsCurrency0) {
            // single-sided in currency0 ⇒ spot strictly below the range.
            require(initialTick < tickLower, "NOT_SINGLE_SIDED_C0");
            liquidity = LiquidityAmounts.getLiquidityForAmount0(sqrtLower, sqrtUpper, SUPPLY);
            // core charges the mint principal with ROUND-UP math — MEASURE the residual, never an inverse.
            dep = SqrtPriceMath.getAmount0Delta(sqrtLower, sqrtUpper, liquidity, true);
        } else {
            // single-sided in currency1 ⇒ spot strictly above the range.
            require(tickUpper <= initialTick, "NOT_SINGLE_SIDED_C1");
            liquidity = LiquidityAmounts.getLiquidityForAmount1(sqrtLower, sqrtUpper, SUPPLY);
            dep = SqrtPriceMath.getAmount1Delta(sqrtLower, sqrtUpper, liquidity, true);
        }
        require(liquidity > 0, "ZERO_LIQUIDITY");
        require(dep <= SUPPLY, "DEP_OVER_SUPPLY");
        require(SUPPLY - dep <= maxDust, "SEED_DUST"); // residual bound (INV-52), same round-up math as launch

        leg = Leg({initialTick: initialTick, tickLower: tickLower, tickUpper: tickUpper, liquidity: liquidity});
    }

    /* ─────────────────────────── launch ────────────────────────────────────── */
    struct LaunchParams {
        string name;
        string symbol;
        uint256 presetId;
    }

    /// @notice Permissionless launch. `creator := msg.sender`; single tx, all-or-revert (§3 steps 1–9).
    ///         Requires prior USDG approval to this factory for `launchFeeAmount` (see `launch` fee step).
    function launch(LaunchParams calldata lp) external nonReentrant returns (address token, uint256 tokenId) {
        require(!paused, "PAUSED");
        require(lp.presetId < _presets.length, "BAD_PRESET");
        address creator = msg.sender;

        // 1. $1 USDG fee straight to the launch-fee treasury; exact-received (rejects fee-on-transfer short).
        uint256 balBefore = USDG.balanceOf(launchFeeTreasury);
        USDG.safeTransferFrom(msg.sender, launchFeeTreasury, launchFeeAmount);
        require(USDG.balanceOf(launchFeeTreasury) - balBefore == launchFeeAmount, "FEE_SHORTFALL");
        emit LaunchFeePaid(msg.sender, launchFeeTreasury, launchFeeAmount);

        // 2. deterministic EIP-1167 clone.
        bytes32 salt = keccak256(abi.encode(msg.sender, lp.symbol, _nonce[msg.sender]++));
        token = Clones.cloneDeterministic(IMPL, salt);

        // 3. open the vault namespace BEFORE the init mint (the mint's `sync` requires registration; INV-30).
        VAULT.register(token, creator);

        // 4. one-shot pending pool config in the hook (consumed by `beforeInitialize`).
        bool ltIsCurrency0 = token < WETH;
        PoolKey memory key = _poolKey(token);
        HOOK.registerPendingPool(key, token);

        // 5. initialize the token — mint the full 1B to the FACTORY (the exempt seeder).
        HydeERC20(token).initialize(
            HydeERC20.InitParams({
                name: lp.name,
                symbol: lp.symbol,
                poolRecipient: address(this),
                vault: address(VAULT),
                maxWalletBps: maxWalletBps,
                maxWalletWindowSecs: maxWalletWindowSecs,
                exemptAddrs: _exemptSet(token)
            })
        );

        // 6-7. init the dynamic-fee pool (hook-authed) + single-sided seed all 1B into the LT-only range.
        Leg memory leg = ltIsCurrency0 ? _presets[lp.presetId].c0 : _presets[lp.presetId].c1;
        POOL_MANAGER.initialize(key, TickMath.getSqrtPriceAtTick(leg.initialTick));
        tokenId = _seed(token, key, leg, ltIsCurrency0);

        // 8. record the launch's immutable custody facts in the collector.
        IHydeCollectorRegister(COLLECTOR).register(
            token, creator, tokenId, WETH, graduationThreshold, leg.tickLower, leg.tickUpper
        );

        // 9. done.
        emit LaunchCreated(token, creator, key.toId(), tokenId, lp.presetId);
    }

    /// @dev Single-sided (LT-only) V4 seed via Permit2 → PositionManager, position minted to the collector.
    ///      The WETH-side max is 0, so a mis-ranged (WETH-requiring) mint reverts; the position NFT must
    ///      land in the collector; the measured factory residual must be ≤ MAX_SEED_DUST and is swept to
    ///      the collector (exempt + custody-locked → reward-ineligible); factory & vault end with 0 LT (INV-15/52).
    function _seed(address token, PoolKey memory key, Leg memory leg, bool ltIsCurrency0)
        internal
        returns (uint256 tokenId)
    {
        // Approve LT to the PositionManager via Permit2 (periphery pays the mint from the caller = factory).
        IERC20(token).forceApprove(address(PERMIT2), SUPPLY);
        PERMIT2.approve(token, address(POSITION_MANAGER), uint160(SUPPLY), type(uint48).max);

        // Single-sided caps: only the LT side may be spent; the WETH side is capped at 0 (INV-52).
        uint128 amount0Max = ltIsCurrency0 ? uint128(SUPPLY) : 0;
        uint128 amount1Max = ltIsCurrency0 ? 0 : uint128(SUPPLY);

        // Capture the id PositionManager will assign BEFORE the mint (it uses nextTokenId then increments).
        tokenId = POSITION_MANAGER.nextTokenId();

        bytes memory actions = abi.encodePacked(uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE_PAIR));
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(
            key, leg.tickLower, leg.tickUpper, uint256(leg.liquidity), amount0Max, amount1Max, COLLECTOR, bytes("")
        );
        params[1] = abi.encode(key.currency0, key.currency1);
        POSITION_MANAGER.modifyLiquidities(abi.encode(actions, params), block.timestamp);

        // The seeded position must be in the collector's permanent custody.
        require(IERC721(address(POSITION_MANAGER)).ownerOf(tokenId) == COLLECTOR, "NOT_CUSTODIED");

        // Measured seed residual (round-up dust) — bounded, then swept to the exempt+locked collector.
        uint256 dust = IERC20(token).balanceOf(address(this));
        require(dust <= MAX_SEED_DUST, "SEED_DUST");
        if (dust > 0) IERC20(token).safeTransfer(COLLECTOR, dust);

        // INV-15: post-seed the factory & vault hold 0 LT (all supply is pooled + the inert collector dust).
        require(IERC20(token).balanceOf(address(this)) == 0, "FACTORY_LT");
        require(IERC20(token).balanceOf(address(VAULT)) == 0, "VAULT_LT");

        // Hygiene: drop the factory's ERC-20 allowance to Permit2 (factory now holds 0 LT anyway).
        IERC20(token).forceApprove(address(PERMIT2), 0);
    }

    /// @dev The launch's LT/WETH dynamic-fee pool key (currencies sorted, DYNAMIC_FEE_FLAG, HOOK).
    function _poolKey(address token) internal view returns (PoolKey memory) {
        (Currency c0, Currency c1) =
            token < WETH ? (Currency.wrap(token), Currency.wrap(WETH)) : (Currency.wrap(WETH), Currency.wrap(token));
        return PoolKey({
            currency0: c0,
            currency1: c1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: tickSpacing,
            hooks: IHooks(address(HOOK))
        });
    }

    /// @dev Frozen infra exempt set (§2): max-wallet exemption AND reward-ineligibility. `address(0)` is
    ///      added by the token itself.
    function _exemptSet(address token) internal view returns (address[] memory set) {
        set = new address[](6);
        set[0] = address(POOL_MANAGER);
        set[1] = address(POSITION_MANAGER);
        set[2] = address(this); // FACTORY (the seeder)
        set[3] = COLLECTOR;
        set[4] = address(VAULT);
        set[5] = UNIVERSAL_ROUTER;
        token; // silence unused (kept for signature symmetry / future per-token exemptions)
    }

    /* ─────────────────────────── views ─────────────────────────────────────── */
    function presetCount() external view returns (uint256) {
        return _presets.length;
    }

    function getPreset(uint256 i) external view returns (Preset memory) {
        return _presets[i];
    }

    /// @notice Predict the clone address for the CURRENT nonce (for UX / off-chain prep only).
    function predictNext(address launcher, string calldata symbol) external view returns (address) {
        bytes32 salt = keccak256(abi.encode(launcher, symbol, _nonce[launcher]));
        return Clones.predictDeterministicAddress(IMPL, salt, address(this));
    }

    /* ─────────────────────────── owner: pause NEW launches only ────────────── */
    modifier onlyOwner() {
        require(msg.sender == owner, "ONLY_OWNER");
        _;
    }

    /// @notice Halt NEW launches. Does NOT touch any live token/pool/fee/claim (§5). Reverts once renounced.
    function pause() external onlyOwner {
        paused = true;
        emit Paused();
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused();
    }

    /// @notice Two-step ownership handoff (multisig-safe).
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "ZERO_OWNER");
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "NOT_PENDING");
        emit OwnershipTransferred(owner, pendingOwner);
        owner = pendingOwner;
        pendingOwner = address(0);
    }

    /// @notice "Drop all keys": `owner == 0` ⇒ `pause`/`unpause` can never be called again ⇒ the factory
    ///         (and thus the whole stack's launch path) is immutable forever, publicly verifiable (INV-53).
    function renounceOwnership() external onlyOwner {
        emit OwnershipTransferred(owner, address(0));
        owner = address(0);
        pendingOwner = address(0);
    }
}
