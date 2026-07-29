// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IPositionManager} from "v4-periphery/src/interfaces/IPositionManager.sol";
import {IStateView} from "v4-periphery/src/interfaces/IStateView.sol";
import {HookMiner} from "v4-periphery/test/shared/HookMiner.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {HydeERC20} from "../src/HydeERC20.sol";
import {HydeFeeVault} from "../src/HydeFeeVault.sol";
import {HydeFeeCollector} from "../src/HydeFeeCollector.sol";
import {HydeHook} from "../src/HydeHook.sol";
import {HydeTokenFactory} from "../src/HydeTokenFactory.sol";
import {IHydeHook} from "../src/interfaces/IHydeHook.sol";
import {IHydeVault} from "../src/interfaces/IHydeVault.sol";
import {HydeDeployConfig} from "./DeployHydeStack.s.sol";
import {WethRedeployPreset} from "./WethRedeployPreset.sol";

/// @notice EIP-3860-safe, OWNER-restricted deploy coordinator (kami 23543 §B). Its OWN creation bytecode is
///         tiny — it embeds NO child bytecode; the child initcodes arrive via `deploy()` CALLDATA and are
///         raised with `create`/`create2` in assembly (each child is individually < 49,152 B — largest is
///         HydeHook ~25 KB). It is the single `_deployer`/`initFactory` caller (the constraint that mandates
///         one coordinator, gojo §②). `onlyOwner` + one-shot `finalized` prevent nonce-grief / front-running /
///         reuse. `block.chainid==4663` and predicted==deployed are asserted here; the SCRIPT asserts roles,
///         treasuries, pinned V4 core address+codehash, pre-existing-code, nonce, and balance headroom.
///
///         Nonce map (coordinator nonce starts at 1, ctor does NO create): impl(1) vault(2) collector(3)
///         hook CREATE2(4) factory(5). The script bakes predicted vault/collector into the child initcodes.
contract HydeStackCoordinator {
    address public immutable OWNER;
    bool public finalized;
    address public impl;
    address public vault;
    address public collector;
    address public hook;
    address public factory;

    constructor(address owner_) {
        require(owner_ != address(0), "OWNER_ZERO");
        OWNER = owner_;
    }

    struct Codes {
        bytes implCode;
        bytes vaultCode;
        bytes collectorCode;
        bytes hookCode;
        bytes32 hookSalt;
        bytes factoryCode;
        address expectedHook;
        address expectedFactory;
    }

    /// @notice One-shot deploy of the 4 stack pieces from calldata initcode, then wire them. OWNER-only.
    function deploy(Codes calldata c) external returns (address vault_, address collector_, address hook_, address factory_) {
        require(msg.sender == OWNER, "ONLY_OWNER");
        require(!finalized, "FINALIZED");
        require(block.chainid == _expectedChainId(), "WRONG_CHAIN");
        finalized = true;

        impl = _create(c.implCode); // nonce 1
        require(impl == _create1(1), "IMPL_ADDR");
        vault = _create(c.vaultCode); // nonce 2
        require(vault == _create1(2), "VAULT_ADDR");
        collector = _create(c.collectorCode); // nonce 3
        require(collector == _create1(3), "COLLECTOR_ADDR");
        hook = _create2(c.hookCode, c.hookSalt); // nonce 4 (address is salt-derived)
        require(hook == c.expectedHook, "HOOK_ADDR");
        factory = _create(c.factoryCode); // nonce 5
        require(factory == _create1(5) && factory == c.expectedFactory, "FACTORY_ADDR");

        HydeFeeVault(vault).initFactory(factory);
        HydeFeeCollector(collector).initFactory(factory);
        HydeHook(hook).initFactory(factory);
        return (vault, collector, hook, factory);
    }

    function _create(bytes memory code) internal returns (address a) {
        require(code.length > 0, "EMPTY_CODE");
        assembly {
            a := create(0, add(code, 0x20), mload(code))
        }
        require(a != address(0) && a.code.length > 0, "CREATE_FAIL");
    }

    function _create2(bytes memory code, bytes32 salt) internal returns (address a) {
        require(code.length > 0, "EMPTY_CODE");
        assembly {
            a := create2(0, add(code, 0x20), mload(code), salt)
        }
        require(a != address(0) && a.code.length > 0, "CREATE2_FAIL");
    }

    /// @dev CREATE address of THIS coordinator's nonce `n` (n in [1,0x7f]).
    function _create1(uint8 n) internal view returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xd6), bytes1(0x94), address(this), bytes1(n))))));
    }

    /// @dev Virtual only so chain-specific coordinators can reuse the audited
    /// deployment/one-shot/address guards without weakening the 4663 default.
    function _expectedChainId() internal pure virtual returns (uint256) {
        return 4663;
    }
}

/// @notice MAINNET (Robinhood 4663) WETH launchpad deploy driver — EIP-3860-safe coordinator path (kami §B).
///         Fail-closed: chain/role/treasury/core-codehash/pre-existing-code/nonce/balance guards ALL enforced
///         before/around the broadcast. Dry-run simulates with the REAL production sender/nonce.
///
///   Dry-run (NO broadcast, real sender): SENDER=0x8005… forge script script/DeployWethStack4663.s.sol \
///       --rpc-url https://rpc.mainnet.chain.robinhood.com --sender 0x800557e7882b42ee49594fa2790300A9697a0e4D
///   Broadcast (GATED): add --broadcast + the key — ONLY after kami's audit + clint's recorded go.
contract DeployWethStack4663 is Script, HydeDeployConfig {
    // gojo 23403 pinned 4663 V4 core — address + extcodehash (fail loud on drift).
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant POSITION_MANAGER = 0x58daec3116aae6D93017bAAea7749052E8a04fA7;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant UNIVERSAL_ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address internal constant STATE_VIEW = 0xF3334192D15450CdD385c8B70e03f9A6bD9E673b;
    address internal constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    bytes32 internal constant POOL_MANAGER_CH = 0xbd3881180b547f5fe817545743cfb4343e96b1bc6640dcd70c106b0066e95626;
    bytes32 internal constant POSITION_MANAGER_CH = 0xc873e135dc9aaec88489cfbad146b4cb49d6a32e0d80326377784b7ba17670b2;
    bytes32 internal constant PERMIT2_CH = 0x5208783f52488f7d3493e5e38311ab707c1d75457fe472a19b0b4d57d66a7fca;
    bytes32 internal constant STATE_VIEW_CH = 0x7d9c591e0956fd89d98feb4ffcfe8bf1f7a62bd485edd979fa21d104b49878a6;
    bytes32 internal constant UNIVERSAL_ROUTER_CH = 0x2ce6aaaf9f4151f5e1cbf774668772f17f532ae11b15e9284fd0a072a8b0fbde;
    bytes32 internal constant WETH_CH = 0x5706be52f64875fee65a2cec0d80e47a23d8793cbe85d214b48445e2d05f5353;

    // Locked roles/treasuries (kami 23532/23534). OWNER==DEPLOYER by clint's choice; kept separate params.
    address internal constant DEPLOYER = 0x800557e7882b42ee49594fa2790300A9697a0e4D;
    address internal constant OWNER = 0x800557e7882b42ee49594fa2790300A9697a0e4D;
    address internal constant HYDE_TREASURY = 0x3132c30135BC13BFbFa75523Ec96A746E5B7Ddb3;
    address internal constant LAUNCH_TREASURY = 0x3132c30135BC13BFbFa75523Ec96A746E5B7Ddb3;

    // WETH-SPECIFIC preset lives in the SINGLE SOURCE OF TRUTH `WethRedeployPreset` (kami 24054): this deploy
    // and test/WethPresetRegression.t.sol both consume it, so the regression can never validate ticks that
    // drift from what deploys. It OVERRIDES the shared HydeDeployConfig C0_*/C1_* for the WETH deploy ONLY
    // (kami 24030 #2) — the shared constants still seed the HOODIE engine (untouched, fine at ~$4k). Full
    // economics + incident RCA are documented on the library. Deterministic regression: WethPresetRegression.t.sol.

    function run() external {
        // ── chain + core-codehash + role/treasury guards (fail loud, pre-broadcast) ──
        require(block.chainid == 4663, "WRONG_CHAIN");
        require(_ch(POOL_MANAGER) == POOL_MANAGER_CH, "POOL_MANAGER_CH");
        require(_ch(POSITION_MANAGER) == POSITION_MANAGER_CH, "POSITION_MANAGER_CH");
        require(_ch(PERMIT2) == PERMIT2_CH, "PERMIT2_CH");
        require(_ch(STATE_VIEW) == STATE_VIEW_CH, "STATE_VIEW_CH");
        require(_ch(UNIVERSAL_ROUTER) == UNIVERSAL_ROUTER_CH, "UNIVERSAL_ROUTER_CH");
        require(_ch(WETH) == WETH_CH, "WETH_CH");
        require(keccak256(bytes(IWethMeta(WETH).symbol())) == keccak256("WETH"), "WETH_SYMBOL");
        require(IWethMeta(WETH).decimals() == 18, "WETH_DECIMALS");
        require(HYDE_TREASURY != address(0), "HYDE_TREASURY_ZERO");
        require(LAUNCH_TREASURY != address(0) && LAUNCH_TREASURY.code.length == 0, "LAUNCH_TREASURY_NOT_EOA");
        require(OWNER != address(0), "OWNER_ZERO");

        address deployer = _sender();
        require(deployer == DEPLOYER, "SENDER_NOT_DEPLOYER");
        // Balance headroom: deploy (~0.0018 ETH) + a live-launch tx + margin, comfortably under the 0.009 fund.
        require(deployer.balance >= 0.004 ether, "INSUFFICIENT_BALANCE");

        // Predict the coordinator (CREATE from the EOA) + its children; mine the hook vs the coordinator.
        uint256 dNonce = vm.getNonce(deployer);
        address coordAddr = vm.computeCreateAddress(deployer, dNonce);
        address implA = _child(coordAddr, 1);
        address vaultA = _child(coordAddr, 2);
        address collectorA = _child(coordAddr, 3);
        address factoryA = _child(coordAddr, 5);
        require(
            coordAddr.code.length == 0 && implA.code.length == 0 && vaultA.code.length == 0
                && collectorA.code.length == 0 && factoryA.code.length == 0,
            "PRE_EXISTING_CODE"
        );

        bytes memory hookArgs =
            abi.encode(IPoolManager(POOL_MANAGER), vaultA, WETH, START_FEE, BASE_FEE, MAX_LP_FEE_CAP, ANTI_SNIPE_WINDOW, CARDINALITY);
        (address hookAddr, bytes32 hookSalt) = HookMiner.find(coordAddr, HOOK_FLAGS, type(HydeHook).creationCode, hookArgs);
        require(hookAddr.code.length == 0, "HOOK_PRE_EXISTING");

        // Build the child initcodes (creationCode ++ encoded args) with the predicted addresses baked in.
        HydeStackCoordinator.Codes memory c;
        c.implCode = type(HydeERC20).creationCode;
        c.vaultCode = abi.encodePacked(
            type(HydeFeeVault).creationCode,
            abi.encode(IERC20(WETH), collectorA, IPoolManager(POOL_MANAGER), IHydeHook(hookAddr), TICK_SPACING, HYDE_TREASURY, HYDE_BPS, NET_BPS, MAX_SLIPPAGE, TWAP_WINDOW, MAX_SETTLE_DEV_TICKS)
        );
        c.collectorCode = abi.encodePacked(
            type(HydeFeeCollector).creationCode,
            abi.encode(IPositionManager(payable(POSITION_MANAGER)), IPoolManager(POOL_MANAGER), IHydeVault(vaultA), WETH, IHydeHook(hookAddr), IAllowanceTransfer(PERMIT2), IStateView(STATE_VIEW), TICK_SPACING, LIQ_BPS, NET_BPS, MIN_ADD_LIQUIDITY, MAX_ADD_DEV_TICKS, TWAP_WINDOW)
        );
        c.hookCode = abi.encodePacked(type(HydeHook).creationCode, hookArgs);
        c.hookSalt = hookSalt;
        c.factoryCode = abi.encodePacked(type(HydeTokenFactory).creationCode, abi.encode(_factoryParams(implA, vaultA, collectorA, hookAddr), _presets()));
        c.expectedHook = hookAddr;
        c.expectedFactory = factoryA;

        vm.startBroadcast(deployer);
        HydeStackCoordinator coord = new HydeStackCoordinator(OWNER);
        require(address(coord) == coordAddr, "COORD_ADDR");
        coord.deploy(c);
        vm.stopBroadcast();

        // ── full immutable + runtime manifest (kami 23562) ──
        require(coord.finalized(), "NOT_FINALIZED");
        require(
            coord.impl() == implA && coord.vault() == vaultA && coord.collector() == collectorA
                && coord.hook() == hookAddr && coord.factory() == factoryA,
            "ADDR_DRIFT"
        );
        require(
            implA.code.length > 0 && vaultA.code.length > 0 && collectorA.code.length > 0 && hookAddr.code.length > 0
                && factoryA.code.length > 0,
            "MISSING_RUNTIME"
        );
        // hook address encodes EXACTLY the 4 permission flags in its low 14 bits (defense over HydeHook's ctor).
        require(uint160(hookAddr) & uint160(0x3FFF) == HOOK_FLAGS, "HOOK_BITS");
        // FULL immutable manifest — every deployed contract holds the exact locked config (kami 23587).
        _assertManifest(implA, vaultA, collectorA, hookAddr, factoryA);

        console2.log("== WETH launchpad (4663) coordinator dry-run ==");
        console2.log("Coordinator", address(coord));
        console2.log("Impl       ", implA);
        console2.log("Vault      ", vaultA);
        console2.log("Collector  ", collectorA);
        console2.log("Hook       ", hookAddr);
        console2.log("Factory    ", factoryA);
        // runtime-codehash manifest (verify vs compiled + immutable-set bytecode)
        console2.log("codehash coord/impl/vault/collector/hook/factory:");
        console2.logBytes32(address(coord).codehash);
        console2.logBytes32(implA.codehash);
        console2.logBytes32(vaultA.codehash);
        console2.logBytes32(collectorA.codehash);
        console2.logBytes32(hookAddr.codehash);
        console2.logBytes32(factoryA.codehash);
    }

    /// @notice Fail-closed read of EVERY immutable on all 4 deployed contracts vs the locked config (kami 23587).
    function _assertManifest(address implA, address vaultA, address collectorA, address hookAddr, address factoryA)
        internal
        view
    {
        HydeTokenFactory f = HydeTokenFactory(factoryA);
        require(f.IMPL() == implA, "F_IMPL");
        require(f.COLLECTOR() == collectorA, "F_COLLECTOR");
        require(address(f.VAULT()) == vaultA, "F_VAULT");
        require(address(f.HOOK()) == hookAddr, "F_HOOK");
        require(address(f.POOL_MANAGER()) == POOL_MANAGER, "F_PM");
        require(address(f.POSITION_MANAGER()) == POSITION_MANAGER, "F_POSM");
        require(address(f.PERMIT2()) == PERMIT2, "F_PERMIT2");
        require(f.UNIVERSAL_ROUTER() == UNIVERSAL_ROUTER, "F_UR");
        require(f.WETH() == WETH, "F_WETH");
        require(f.launchFeeAmount() == LAUNCH_FEE, "F_FEE");
        require(f.launchFeeTreasury() == LAUNCH_TREASURY, "F_FEE_TRE");
        require(f.tickSpacing() == TICK_SPACING, "F_TICK");
        require(f.MAX_SEED_DUST() == MAX_SEED_DUST, "F_DUST");
        require(f.maxWalletBps() == MAX_WALLET_BPS, "F_MWBPS");
        require(f.maxWalletWindowSecs() == MAX_WALLET_WINDOW, "F_MWWIN");
        require(f.graduationThreshold() == GRAD_THRESHOLD, "F_GRAD");
        require(f.owner() == OWNER, "F_OWNER");
        require(!f.paused(), "F_PAUSED");
        require(f.presetCount() == 1, "F_PRESETS");
        // FULL preset manifest (kami 24031 #3): assert the deployed factory holds EXACTLY the WETH economics —
        // both sort branches' raw ticks match the WETH-specific preset, and each leg's derived liquidity is
        // non-zero (single-sided seed built). Guards against a silent economics drift in the redeploy.
        HydeTokenFactory.Preset memory p0 = f.getPreset(0);
        require(
            p0.c0.initialTick == WethRedeployPreset.C0_INIT && p0.c0.tickLower == WethRedeployPreset.C0_LOWER
                && p0.c0.tickUpper == WethRedeployPreset.C0_UPPER,
            "F_PRESET_C0"
        );
        require(
            p0.c1.initialTick == WethRedeployPreset.C1_INIT && p0.c1.tickLower == WethRedeployPreset.C1_LOWER
                && p0.c1.tickUpper == WethRedeployPreset.C1_UPPER,
            "F_PRESET_C1"
        );
        require(p0.c0.liquidity == p0.c1.liquidity, "F_PRESET_LIQ_MIRROR");
        require(p0.c0.liquidity == WethRedeployPreset.EXPECTED_LIQUIDITY, "F_PRESET_LIQ_EXACT"); // exact ⇒ also > 0

        HydeFeeVault v = HydeFeeVault(vaultA);
        require(address(v.SETTLEMENT_TOKEN()) == WETH, "V_TOKEN");
        require(v.COLLECTOR() == collectorA, "V_COLLECTOR");
        require(address(v.POOL_MANAGER()) == POOL_MANAGER, "V_PM");
        require(address(v.HOOK()) == hookAddr, "V_HOOK");
        require(v.tickSpacing() == TICK_SPACING, "V_TICK");
        require(v.hydeoutTreasury() == HYDE_TREASURY, "V_TREASURY");
        require(v.hydeBps() == HYDE_BPS, "V_HYDEBPS");
        require(v.NET_BPS() == NET_BPS, "V_NETBPS");
        require(v.MAX_SLIPPAGE_BPS() == MAX_SLIPPAGE, "V_SLIP");
        require(v.TWAP_WINDOW() == TWAP_WINDOW, "V_TWAP");
        require(v.MAX_SETTLE_DEV_TICKS() == MAX_SETTLE_DEV_TICKS, "V_SETTLEDEV");
        require(v.factory() == factoryA, "V_FACTORY");

        HydeFeeCollector col = HydeFeeCollector(collectorA);
        require(address(col.POSITION_MANAGER()) == POSITION_MANAGER, "C_POSM");
        require(address(col.POOL_MANAGER()) == POOL_MANAGER, "C_PM");
        require(address(col.VAULT()) == vaultA, "C_VAULT");
        require(col.WETH() == WETH, "C_WETH");
        require(address(col.HOOK()) == hookAddr, "C_HOOK");
        require(address(col.PERMIT2()) == PERMIT2, "C_PERMIT2");
        require(address(col.STATE_VIEW()) == STATE_VIEW, "C_STATEVIEW");
        require(col.tickSpacing() == TICK_SPACING, "C_TICK");
        require(col.liqBps() == LIQ_BPS, "C_LIQBPS");
        require(col.NET_BPS() == NET_BPS, "C_NETBPS");
        require(col.MIN_ADD_LIQUIDITY() == MIN_ADD_LIQUIDITY, "C_MINLIQ");
        require(col.MAX_ADD_DEV_TICKS() == MAX_ADD_DEV_TICKS, "C_ADDDEV");
        require(col.TWAP_WINDOW() == TWAP_WINDOW, "C_TWAP");
        require(col.factory() == factoryA, "C_FACTORY");

        HydeHook h = HydeHook(hookAddr);
        require(address(h.POOL_MANAGER()) == POOL_MANAGER, "H_PM");
        require(h.VAULT() == vaultA, "H_VAULT");
        require(h.WETH() == WETH, "H_WETH");
        require(h.startFee() == START_FEE, "H_START");
        require(h.baseFee() == BASE_FEE, "H_BASE");
        require(h.maxLpFeeCap() == MAX_LP_FEE_CAP, "H_CAP");
        require(h.antiSnipeWindow() == ANTI_SNIPE_WINDOW, "H_ANTISNIPE");
        require(h.cardinality() == CARDINALITY, "H_CARD");
        require(h.factory() == factoryA, "H_FACTORY");
    }

    function _factoryParams(address implA, address vaultA, address collectorA, address hookAddr)
        internal
        view
        returns (HydeTokenFactory.ConstructorParams memory p)
    {
        p = HydeTokenFactory.ConstructorParams({
            impl: implA,
            collector: collectorA,
            vault: vaultA,
            hook: hookAddr,
            poolManager: POOL_MANAGER,
            positionManager: POSITION_MANAGER,
            permit2: PERMIT2,
            launchFeeAmount: LAUNCH_FEE,
            launchFeeTreasury: LAUNCH_TREASURY,
            weth: WETH,
            universalRouter: UNIVERSAL_ROUTER,
            tickSpacing: TICK_SPACING,
            maxSeedDust: MAX_SEED_DUST,
            maxWalletBps: MAX_WALLET_BPS,
            maxWalletWindowSecs: MAX_WALLET_WINDOW,
            graduationThreshold: GRAD_THRESHOLD,
            owner: OWNER
        });
    }

    // WETH deploy consumes the shared-source WETH preset (kami 24030 #2 / 24054) — NOT the HydeDeployConfig
    // C0_*/C1_*, which remain the HOODIE economics.
    function _presets() internal pure returns (HydeTokenFactory.PresetInput[] memory presets) {
        presets = new HydeTokenFactory.PresetInput[](1);
        presets[0] = WethRedeployPreset.preset();
    }

    function _child(address coord, uint8 n) internal pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xd6), bytes1(0x94), coord, bytes1(n))))));
    }

    function _sender() internal view returns (address) {
        return vm.envOr("SENDER", DEPLOYER);
    }

    function _ch(address a) internal view returns (bytes32 h) {
        assembly {
            h := extcodehash(a)
        }
    }
}

/// @notice Minimal WETH metadata surface for the symbol/decimals guard.
interface IWethMeta {
    function symbol() external view returns (string memory);
    function decimals() external view returns (uint8);
}
