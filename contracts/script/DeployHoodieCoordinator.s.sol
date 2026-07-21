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
import {HoodieLaunchEngine} from "../src/HoodieLaunchEngine.sol";
import {HoodieMetaFactory} from "../src/HoodieMetaFactory.sol";
import {HoodieLauncher} from "../src/HoodieLauncher.sol";
import {IHydeHook} from "../src/interfaces/IHydeHook.sol";
import {IHydeVault} from "../src/interfaces/IHydeVault.sol";
import {HydeDeployConfig} from "./DeployHydeStack.s.sol";

/// @notice EIP-3860-safe, OWNER-restricted coordinator for the $HOODIE launcher-launcher stack — the SAME
///         proven calldata-initcode pattern as the WETH `HydeStackCoordinator` (kami §B), extended to 7 pieces:
///         impl · vault · collector · hook(CREATE2) · launcherImpl · engine · metaFactory. Base is $HOODIE (no
///         WETH); it stands up `HoodieLaunchEngine` (== HydeTokenFactory bound to HOODIE) + `HoodieMetaFactory`
///         with the engine↔meta prediction cycle (engine ctor takes the PREDICTED meta addr — stored, not
///         called; meta ctor takes the deployed engine + launcherImpl). One deployer, one-shot finalize.
contract HoodieStackCoordinator {
    address public immutable OWNER;
    bool public finalized;
    address public impl;
    address public vault;
    address public collector;
    address public hook;
    address public launcherImpl;
    address public engine;
    address public metaFactory;

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
        bytes launcherImplCode;
        bytes engineCode;
        bytes metaFactoryCode;
        address expectedHook;
        address expectedEngine;
        address expectedMeta;
    }

    function deploy(Codes calldata c) external returns (address engine_, address metaFactory_) {
        require(msg.sender == OWNER, "ONLY_OWNER");
        require(!finalized, "FINALIZED");
        require(block.chainid == 4663, "WRONG_CHAIN");
        finalized = true;

        impl = _create(c.implCode); // 1
        require(impl == _create1(1), "IMPL_ADDR");
        vault = _create(c.vaultCode); // 2
        require(vault == _create1(2), "VAULT_ADDR");
        collector = _create(c.collectorCode); // 3
        require(collector == _create1(3), "COLLECTOR_ADDR");
        hook = _create2(c.hookCode, c.hookSalt); // 4 (salt-derived)
        require(hook == c.expectedHook, "HOOK_ADDR");
        launcherImpl = _create(c.launcherImplCode); // 5
        require(launcherImpl == _create1(5), "LAUNCHER_ADDR");
        engine = _create(c.engineCode); // 6
        require(engine == _create1(6) && engine == c.expectedEngine, "ENGINE_ADDR");
        metaFactory = _create(c.metaFactoryCode); // 7
        require(metaFactory == _create1(7) && metaFactory == c.expectedMeta, "META_ADDR");

        // wire the audited hook/vault/collector to the ENGINE (the factory they trust)
        HydeFeeVault(vault).initFactory(engine);
        HydeFeeCollector(collector).initFactory(engine);
        HydeHook(hook).initFactory(engine);
        return (engine, metaFactory);
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

    function _create1(uint8 n) internal view returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xd6), bytes1(0x94), address(this), bytes1(n))))));
    }
}

/// @notice MAINNET (4663) $HOODIE launcher-launcher deploy driver — EIP-3860-safe coordinator path. Fail-closed
///         chain/role/treasury/HOODIE-graduation/codehash/pre-existing-code/nonce/balance guards; simulates with
///         the REAL production sender/nonce. Dry-run: no `--broadcast`; broadcast is GATED on kami + clint.
contract DeployHoodieCoordinator is Script, HydeDeployConfig {
    // pinned 4663 V4 core (extcodehash) + $HOODIE.
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant POSITION_MANAGER = 0x58daec3116aae6D93017bAAea7749052E8a04fA7;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant UNIVERSAL_ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address internal constant STATE_VIEW = 0xF3334192D15450CdD385c8B70e03f9A6bD9E673b;
    address internal constant HOODIE = 0xC72c01AAB5f5678dc1d6f5C6d2B417d91D402Ba3;
    address internal constant DEAD = 0xdeaDDeADDEaDdeaDdEAddEADDEAdDeadDEADDEaD;
    bytes32 internal constant POOL_MANAGER_CH = 0xbd3881180b547f5fe817545743cfb4343e96b1bc6640dcd70c106b0066e95626;
    bytes32 internal constant POSITION_MANAGER_CH = 0xc873e135dc9aaec88489cfbad146b4cb49d6a32e0d80326377784b7ba17670b2;
    bytes32 internal constant PERMIT2_CH = 0x5208783f52488f7d3493e5e38311ab707c1d75457fe472a19b0b4d57d66a7fca;
    bytes32 internal constant STATE_VIEW_CH = 0x7d9c591e0956fd89d98feb4ffcfe8bf1f7a62bd485edd979fa21d104b49878a6;
    bytes32 internal constant UNIVERSAL_ROUTER_CH = 0x2ce6aaaf9f4151f5e1cbf774668772f17f532ae11b15e9284fd0a072a8b0fbde;
    bytes32 internal constant HOODIE_CH = 0xf10f86b05965a827a332e6c73086f18026fbe3917f4bffbec3f938b3b5397b56;

    address internal constant DEPLOYER = 0x800557e7882b42ee49594fa2790300A9697a0e4D;
    address internal constant OWNER = 0x800557e7882b42ee49594fa2790300A9697a0e4D;
    address internal constant HYDE_TREASURY = 0x3132c30135BC13BFbFa75523Ec96A746E5B7Ddb3;
    address internal constant LAUNCH_TREASURY = 0x3132c30135BC13BFbFa75523Ec96A746E5B7Ddb3;

    function run() external {
        require(block.chainid == 4663, "WRONG_CHAIN");
        require(_ch(POOL_MANAGER) == POOL_MANAGER_CH, "POOL_MANAGER_CH");
        require(_ch(POSITION_MANAGER) == POSITION_MANAGER_CH, "POSITION_MANAGER_CH");
        require(_ch(PERMIT2) == PERMIT2_CH, "PERMIT2_CH");
        require(_ch(STATE_VIEW) == STATE_VIEW_CH, "STATE_VIEW_CH");
        require(_ch(UNIVERSAL_ROUTER) == UNIVERSAL_ROUTER_CH, "UNIVERSAL_ROUTER_CH");
        require(_ch(HOODIE) == HOODIE_CH, "HOODIE_CH");
        // HOODIE must be a graduated Doppler token (transfer-lock released) + 18-dec, else launching a pool
        // through it hits DERC20's pre-graduation restriction.
        require(IDopplerToken(HOODIE).decimals() == 18, "HOODIE_NOT_18DEC");
        require(IDopplerToken(HOODIE).pool() == DEAD, "HOODIE_NOT_GRADUATED");
        require(HYDE_TREASURY != address(0), "HYDE_TREASURY_ZERO");
        require(LAUNCH_TREASURY != address(0) && LAUNCH_TREASURY.code.length == 0, "LAUNCH_TREASURY_NOT_EOA");
        require(OWNER != address(0), "OWNER_ZERO");

        address deployer = vm.envOr("SENDER", DEPLOYER);
        require(deployer == DEPLOYER, "SENDER_NOT_DEPLOYER");
        require(deployer.balance >= 0.004 ether, "INSUFFICIENT_BALANCE");

        uint256 dNonce = vm.getNonce(deployer);
        address coordAddr = vm.computeCreateAddress(deployer, dNonce);
        address implA = _child(coordAddr, 1);
        address vaultA = _child(coordAddr, 2);
        address collectorA = _child(coordAddr, 3);
        address launcherA = _child(coordAddr, 5);
        address engineA = _child(coordAddr, 6);
        address metaA = _child(coordAddr, 7);
        require(
            coordAddr.code.length == 0 && implA.code.length == 0 && vaultA.code.length == 0
                && collectorA.code.length == 0 && launcherA.code.length == 0 && engineA.code.length == 0
                && metaA.code.length == 0,
            "PRE_EXISTING_CODE"
        );

        bytes memory hookArgs =
            abi.encode(IPoolManager(POOL_MANAGER), vaultA, HOODIE, START_FEE, BASE_FEE, MAX_LP_FEE_CAP, ANTI_SNIPE_WINDOW, CARDINALITY);
        (address hookAddr, bytes32 hookSalt) = HookMiner.find(coordAddr, HOOK_FLAGS, type(HydeHook).creationCode, hookArgs);
        require(hookAddr.code.length == 0, "HOOK_PRE_EXISTING");

        HoodieStackCoordinator.Codes memory c = _codes(implA, vaultA, collectorA, hookAddr, hookSalt, engineA, metaA, launcherA);

        vm.startBroadcast(deployer);
        HoodieStackCoordinator coord = new HoodieStackCoordinator(OWNER);
        require(address(coord) == coordAddr, "COORD_ADDR");
        coord.deploy(c);
        vm.stopBroadcast();

        require(coord.finalized(), "NOT_FINALIZED");
        require(uint160(hookAddr) & uint160(0x3FFF) == HOOK_FLAGS, "HOOK_BITS");
        _assertManifest(implA, vaultA, collectorA, hookAddr, launcherA, engineA, metaA);

        console2.log("== HOODIE launcher-launcher (4663) coordinator dry-run ==");
        console2.log("Coordinator ", address(coord));
        console2.log("Impl        ", implA);
        console2.log("Vault       ", vaultA);
        console2.log("Collector   ", collectorA);
        console2.log("Hook        ", hookAddr);
        console2.log("LauncherImpl", launcherA);
        console2.log("Engine      ", engineA);
        console2.log("MetaFactory ", metaA);
        console2.log("codehash coord/impl/vault/collector/hook/launcher/engine/meta:");
        console2.logBytes32(address(coord).codehash);
        console2.logBytes32(implA.codehash);
        console2.logBytes32(vaultA.codehash);
        console2.logBytes32(collectorA.codehash);
        console2.logBytes32(hookAddr.codehash);
        console2.logBytes32(launcherA.codehash);
        console2.logBytes32(engineA.codehash);
        console2.logBytes32(metaA.codehash);
    }

    function _codes(
        address implA, address vaultA, address collectorA, address hookAddr, bytes32 hookSalt,
        address engineA, address metaA, address launcherA
    ) internal view returns (HoodieStackCoordinator.Codes memory c) {
        c.implCode = type(HydeERC20).creationCode;
        c.vaultCode = abi.encodePacked(
            type(HydeFeeVault).creationCode,
            abi.encode(IERC20(HOODIE), collectorA, IPoolManager(POOL_MANAGER), IHydeHook(hookAddr), TICK_SPACING, HYDE_TREASURY, HYDE_BPS, NET_BPS, MAX_SLIPPAGE, TWAP_WINDOW, MAX_SETTLE_DEV_TICKS)
        );
        c.collectorCode = abi.encodePacked(
            type(HydeFeeCollector).creationCode,
            abi.encode(IPositionManager(payable(POSITION_MANAGER)), IPoolManager(POOL_MANAGER), IHydeVault(vaultA), HOODIE, IHydeHook(hookAddr), IAllowanceTransfer(PERMIT2), IStateView(STATE_VIEW), TICK_SPACING, LIQ_BPS, NET_BPS, MIN_ADD_LIQUIDITY, MAX_ADD_DEV_TICKS, TWAP_WINDOW)
        );
        c.hookCode = abi.encodePacked(
            type(HydeHook).creationCode,
            abi.encode(IPoolManager(POOL_MANAGER), vaultA, HOODIE, START_FEE, BASE_FEE, MAX_LP_FEE_CAP, ANTI_SNIPE_WINDOW, CARDINALITY)
        );
        c.hookSalt = hookSalt;
        c.launcherImplCode = type(HoodieLauncher).creationCode;
        c.engineCode = abi.encodePacked(
            type(HoodieLaunchEngine).creationCode, abi.encode(_factoryParams(implA, vaultA, collectorA, hookAddr), _presets(), metaA)
        );
        c.metaFactoryCode = abi.encodePacked(type(HoodieMetaFactory).creationCode, abi.encode(engineA, launcherA));
        c.expectedHook = hookAddr;
        c.expectedEngine = engineA;
        c.expectedMeta = metaA;
    }

    function _assertManifest(
        address implA, address vaultA, address collectorA, address hookAddr, address launcherA, address engineA, address metaA
    ) internal view {
        // engine == HydeTokenFactory(HOODIE-based)
        HydeTokenFactory f = HydeTokenFactory(engineA);
        require(f.IMPL() == implA, "F_IMPL");
        require(f.COLLECTOR() == collectorA, "F_COLLECTOR");
        require(address(f.VAULT()) == vaultA, "F_VAULT");
        require(address(f.HOOK()) == hookAddr, "F_HOOK");
        require(address(f.POOL_MANAGER()) == POOL_MANAGER, "F_PM");
        require(address(f.POSITION_MANAGER()) == POSITION_MANAGER, "F_POSM");
        require(address(f.PERMIT2()) == PERMIT2, "F_PERMIT2");
        require(f.UNIVERSAL_ROUTER() == UNIVERSAL_ROUTER, "F_UR");
        require(f.WETH() == HOODIE, "F_HOODIE"); // base numeraire IS HOODIE
        require(f.launchFeeAmount() == LAUNCH_FEE, "F_FEE");
        require(f.launchFeeTreasury() == LAUNCH_TREASURY, "F_FEE_TRE");
        require(f.tickSpacing() == TICK_SPACING, "F_TICK");
        require(f.owner() == OWNER, "F_OWNER");
        require(!f.paused(), "F_PAUSED");
        require(f.presetCount() == 1, "F_PRESETS");
        // launcher-launcher wiring
        require(HoodieLaunchEngine(engineA).META_FACTORY() == metaA, "E_META");
        require(HoodieLaunchEngine(engineA).HOODIE() == HOODIE, "E_HOODIE");
        require(HoodieMetaFactory(metaA).ENGINE() == engineA, "M_ENGINE");
        require(HoodieMetaFactory(metaA).HOODIE() == HOODIE, "M_HOODIE");
        require(HoodieMetaFactory(metaA).LAUNCHER_IMPL() == launcherA, "M_LAUNCHER");
        // vault
        HydeFeeVault v = HydeFeeVault(vaultA);
        require(address(v.SETTLEMENT_TOKEN()) == HOODIE, "V_TOKEN");
        require(v.COLLECTOR() == collectorA, "V_COLLECTOR");
        require(address(v.HOOK()) == hookAddr, "V_HOOK");
        require(v.hydeoutTreasury() == HYDE_TREASURY, "V_TREASURY");
        require(v.hydeBps() == HYDE_BPS, "V_HYDEBPS");
        require(v.NET_BPS() == NET_BPS, "V_NETBPS");
        require(v.factory() == engineA, "V_FACTORY");
        // collector
        HydeFeeCollector col = HydeFeeCollector(collectorA);
        require(address(col.VAULT()) == vaultA, "C_VAULT");
        require(col.WETH() == HOODIE, "C_HOODIE");
        require(address(col.HOOK()) == hookAddr, "C_HOOK");
        require(address(col.STATE_VIEW()) == STATE_VIEW, "C_STATEVIEW");
        require(col.NET_BPS() == NET_BPS, "C_NETBPS");
        require(col.factory() == engineA, "C_FACTORY");
        // hook
        HydeHook h = HydeHook(hookAddr);
        require(address(h.POOL_MANAGER()) == POOL_MANAGER, "H_PM");
        require(h.VAULT() == vaultA, "H_VAULT");
        require(h.WETH() == HOODIE, "H_HOODIE");
        require(h.startFee() == START_FEE, "H_START");
        require(h.baseFee() == BASE_FEE, "H_BASE");
        require(h.cardinality() == CARDINALITY, "H_CARD");
        require(h.factory() == engineA, "H_FACTORY");
    }

    function _factoryParams(address implA, address vaultA, address collectorA, address hookAddr)
        internal
        view
        returns (HydeTokenFactory.ConstructorParams memory p)
    {
        p = HydeTokenFactory.ConstructorParams({
            impl: implA, collector: collectorA, vault: vaultA, hook: hookAddr, poolManager: POOL_MANAGER,
            positionManager: POSITION_MANAGER, permit2: PERMIT2, launchFeeAmount: LAUNCH_FEE,
            launchFeeTreasury: LAUNCH_TREASURY, weth: HOODIE, universalRouter: UNIVERSAL_ROUTER, tickSpacing: TICK_SPACING,
            maxSeedDust: MAX_SEED_DUST, maxWalletBps: MAX_WALLET_BPS, maxWalletWindowSecs: MAX_WALLET_WINDOW,
            graduationThreshold: GRAD_THRESHOLD, owner: OWNER
        });
    }

    function _presets() internal pure returns (HydeTokenFactory.PresetInput[] memory presets) {
        presets = new HydeTokenFactory.PresetInput[](1);
        presets[0] = HydeTokenFactory.PresetInput({
            initialTick0: C0_INIT, tickLower0: C0_LOWER, tickUpper0: C0_UPPER,
            initialTick1: C1_INIT, tickLower1: C1_LOWER, tickUpper1: C1_UPPER
        });
    }

    function _child(address coord, uint8 n) internal pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xd6), bytes1(0x94), coord, bytes1(n))))));
    }

    function _ch(address a) internal view returns (bytes32 h) {
        assembly {
            h := extcodehash(a)
        }
    }
}

/// @notice Doppler DERC20 surface for the HOODIE graduation precondition.
interface IDopplerToken {
    function pool() external view returns (address);
    function decimals() external view returns (uint8);
}
