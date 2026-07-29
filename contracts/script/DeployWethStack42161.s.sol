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
import {HydeStackCoordinator} from "./DeployWethStack4663.s.sol";
import {WethRedeployPreset} from "./WethRedeployPreset.sol";

/// @notice Arbitrum-specific coordinator. It reuses the audited one-shot,
/// owner, nonce, CREATE/CREATE2, predicted-address and initialization guards;
/// only the mandatory chain id differs from the 4663 coordinator.
contract HydeStackCoordinator42161 is HydeStackCoordinator {
    constructor(address owner_) HydeStackCoordinator(owner_) {}

    function _expectedChainId() internal pure override returns (uint256) {
        return 42161;
    }
}

/// @notice Arbitrum One (42161) WETH launchpad deployment driver.
///
/// Canonical Arbitrum WETH is referenced directly; this script never deploys or
/// forks a wrapped-native token. Every Uniswap and WETH address/codehash is
/// pinned from `scripts/arbitrumDeployProbe.mjs`.
///
/// Dry-run (never broadcasts):
///   SENDER=0x800557e7882b42ee49594fa2790300A9697a0e4D \
///   forge script script/DeployWethStack42161.s.sol:DeployWethStack42161 \
///     --rpc-url $ARBITRUM_RPC_URL \
///     --sender 0x800557e7882b42ee49594fa2790300A9697a0e4D
///
/// Broadcast remains a separate, explicit release action after audit, funding,
/// dry-run manifest review, and a final user confirmation.
contract DeployWethStack42161 is Script, HydeDeployConfig {
    uint256 internal constant ARBITRUM_CHAIN_ID = 42161;

    address internal constant POOL_MANAGER = 0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32;
    address internal constant POSITION_MANAGER = 0xd88F38F930b7952f2DB2432Cb002E7abbF3dD869;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant UNIVERSAL_ROUTER = 0xA51afAFe0263b40EdaEf0Df8781eA9aa03E381a3;
    address internal constant STATE_VIEW = 0x76Fd297e2D437cd7f76d50F01AfE6160f86e9990;
    address internal constant WETH = 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1;

    bytes32 internal constant POOL_MANAGER_CH = 0xe4b2759e456c9c4ef763e3b4e257c5105e1ba283d7de8b131dd321197de794a4;
    bytes32 internal constant POSITION_MANAGER_CH = 0x6156ddaa1c8cd2c26d37455a5dc57b1761dc2848856426c0ac261ae0c7fecd68;
    bytes32 internal constant PERMIT2_CH = 0x9e51dcb64cf56fc09a82cb41edbc17c6a2250f18dbd1b91e884c0aca02acd57c;
    bytes32 internal constant STATE_VIEW_CH = 0x4c0e823a0cd44b6b2d9485e774c421cf929db3996096d9b84ee6b23525184b9e;
    bytes32 internal constant UNIVERSAL_ROUTER_CH = 0xc15e8e18812f640245cac34716a18270e3d3288e99b328a410401888ff484720;
    bytes32 internal constant WETH_CH = 0x2d240bb4510ed1acfeaba905eb4bcc4524d63c8ae66e48fcccac55ea714db7a7;

    // Same owner and protocol treasuries as the existing Hydeout mainnets.
    address internal constant DEPLOYER = 0x800557e7882b42ee49594fa2790300A9697a0e4D;
    address internal constant OWNER = 0x800557e7882b42ee49594fa2790300A9697a0e4D;
    address internal constant HYDE_TREASURY = 0x3132c30135BC13BFbFa75523Ec96A746E5B7Ddb3;
    address internal constant LAUNCH_TREASURY = 0x3132c30135BC13BFbFa75523Ec96A746E5B7Ddb3;

    function run() external {
        require(block.chainid == ARBITRUM_CHAIN_ID, "WRONG_CHAIN");
        require(_ch(POOL_MANAGER) == POOL_MANAGER_CH, "POOL_MANAGER_CH");
        require(_ch(POSITION_MANAGER) == POSITION_MANAGER_CH, "POSITION_MANAGER_CH");
        require(_ch(PERMIT2) == PERMIT2_CH, "PERMIT2_CH");
        require(_ch(STATE_VIEW) == STATE_VIEW_CH, "STATE_VIEW_CH");
        require(_ch(UNIVERSAL_ROUTER) == UNIVERSAL_ROUTER_CH, "UNIVERSAL_ROUTER_CH");
        require(_ch(WETH) == WETH_CH, "WETH_CH");
        require(keccak256(bytes(IWethMeta42161(WETH).symbol())) == keccak256("WETH"), "WETH_SYMBOL");
        require(IWethMeta42161(WETH).decimals() == 18, "WETH_DECIMALS");
        require(HYDE_TREASURY != address(0), "HYDE_TREASURY_ZERO");
        require(LAUNCH_TREASURY != address(0) && LAUNCH_TREASURY.code.length == 0, "LAUNCH_TREASURY_NOT_EOA");
        require(OWNER != address(0), "OWNER_ZERO");

        address deployer = _sender();
        require(deployer == DEPLOYER, "SENDER_NOT_DEPLOYER");
        // Includes deployment, one live launch, L1 calldata component and margin.
        require(deployer.balance >= 0.004 ether, "INSUFFICIENT_BALANCE");

        uint256 deployerNonce = vm.getNonce(deployer);
        address coordinatorAddress = vm.computeCreateAddress(deployer, deployerNonce);
        address implAddress = _child(coordinatorAddress, 1);
        address vaultAddress = _child(coordinatorAddress, 2);
        address collectorAddress = _child(coordinatorAddress, 3);
        address factoryAddress = _child(coordinatorAddress, 5);
        require(
            coordinatorAddress.code.length == 0 && implAddress.code.length == 0 && vaultAddress.code.length == 0
                && collectorAddress.code.length == 0 && factoryAddress.code.length == 0,
            "PRE_EXISTING_CODE"
        );

        bytes memory hookArgs = abi.encode(
            IPoolManager(POOL_MANAGER),
            vaultAddress,
            WETH,
            START_FEE,
            BASE_FEE,
            MAX_LP_FEE_CAP,
            ANTI_SNIPE_WINDOW,
            CARDINALITY
        );
        (address hookAddress, bytes32 hookSalt) =
            HookMiner.find(coordinatorAddress, HOOK_FLAGS, type(HydeHook).creationCode, hookArgs);
        require(hookAddress.code.length == 0, "HOOK_PRE_EXISTING");

        HydeStackCoordinator.Codes memory codes;
        codes.implCode = type(HydeERC20).creationCode;
        codes.vaultCode = abi.encodePacked(
            type(HydeFeeVault).creationCode,
            abi.encode(
                IERC20(WETH),
                collectorAddress,
                IPoolManager(POOL_MANAGER),
                IHydeHook(hookAddress),
                TICK_SPACING,
                HYDE_TREASURY,
                HYDE_BPS,
                NET_BPS,
                MAX_SLIPPAGE,
                TWAP_WINDOW,
                MAX_SETTLE_DEV_TICKS
            )
        );
        codes.collectorCode = abi.encodePacked(
            type(HydeFeeCollector).creationCode,
            abi.encode(
                IPositionManager(payable(POSITION_MANAGER)),
                IPoolManager(POOL_MANAGER),
                IHydeVault(vaultAddress),
                WETH,
                IHydeHook(hookAddress),
                IAllowanceTransfer(PERMIT2),
                IStateView(STATE_VIEW),
                TICK_SPACING,
                LIQ_BPS,
                NET_BPS,
                MIN_ADD_LIQUIDITY,
                MAX_ADD_DEV_TICKS,
                TWAP_WINDOW
            )
        );
        codes.hookCode = abi.encodePacked(type(HydeHook).creationCode, hookArgs);
        codes.hookSalt = hookSalt;
        codes.factoryCode = abi.encodePacked(
            type(HydeTokenFactory).creationCode,
            abi.encode(
                _factoryParams(implAddress, vaultAddress, collectorAddress, hookAddress),
                _presets()
            )
        );
        codes.expectedHook = hookAddress;
        codes.expectedFactory = factoryAddress;

        vm.startBroadcast(deployer);
        HydeStackCoordinator42161 coordinator = new HydeStackCoordinator42161(OWNER);
        require(address(coordinator) == coordinatorAddress, "COORD_ADDR");
        coordinator.deploy(codes);
        vm.stopBroadcast();

        require(coordinator.finalized(), "NOT_FINALIZED");
        require(
            coordinator.impl() == implAddress && coordinator.vault() == vaultAddress
                && coordinator.collector() == collectorAddress && coordinator.hook() == hookAddress
                && coordinator.factory() == factoryAddress,
            "ADDR_DRIFT"
        );
        require(
            implAddress.code.length > 0 && vaultAddress.code.length > 0 && collectorAddress.code.length > 0
                && hookAddress.code.length > 0 && factoryAddress.code.length > 0,
            "MISSING_RUNTIME"
        );
        require(uint160(hookAddress) & uint160(0x3FFF) == HOOK_FLAGS, "HOOK_BITS");
        _assertManifest(implAddress, vaultAddress, collectorAddress, hookAddress, factoryAddress);

        console2.log("== WETH launchpad (Arbitrum 42161) dry-run ==");
        console2.log("Coordinator", address(coordinator));
        console2.log("Impl       ", implAddress);
        console2.log("Vault      ", vaultAddress);
        console2.log("Collector  ", collectorAddress);
        console2.log("Hook       ", hookAddress);
        console2.log("Factory    ", factoryAddress);
        console2.log("codehash coord/impl/vault/collector/hook/factory:");
        console2.logBytes32(address(coordinator).codehash);
        console2.logBytes32(implAddress.codehash);
        console2.logBytes32(vaultAddress.codehash);
        console2.logBytes32(collectorAddress.codehash);
        console2.logBytes32(hookAddress.codehash);
        console2.logBytes32(factoryAddress.codehash);
    }

    function _assertManifest(
        address implAddress,
        address vaultAddress,
        address collectorAddress,
        address hookAddress,
        address factoryAddress
    ) internal view {
        HydeTokenFactory factory = HydeTokenFactory(factoryAddress);
        require(factory.IMPL() == implAddress, "F_IMPL");
        require(factory.COLLECTOR() == collectorAddress, "F_COLLECTOR");
        require(address(factory.VAULT()) == vaultAddress, "F_VAULT");
        require(address(factory.HOOK()) == hookAddress, "F_HOOK");
        require(address(factory.POOL_MANAGER()) == POOL_MANAGER, "F_PM");
        require(address(factory.POSITION_MANAGER()) == POSITION_MANAGER, "F_POSM");
        require(address(factory.PERMIT2()) == PERMIT2, "F_PERMIT2");
        require(factory.UNIVERSAL_ROUTER() == UNIVERSAL_ROUTER, "F_UR");
        require(factory.WETH() == WETH, "F_WETH");
        require(factory.launchFeeAmount() == LAUNCH_FEE, "F_FEE");
        require(factory.launchFeeTreasury() == LAUNCH_TREASURY, "F_FEE_TRE");
        require(factory.tickSpacing() == TICK_SPACING, "F_TICK");
        require(factory.MAX_SEED_DUST() == MAX_SEED_DUST, "F_DUST");
        require(factory.maxWalletBps() == MAX_WALLET_BPS, "F_MWBPS");
        require(factory.maxWalletWindowSecs() == MAX_WALLET_WINDOW, "F_MWWIN");
        require(factory.graduationThreshold() == GRAD_THRESHOLD, "F_GRAD");
        require(factory.owner() == OWNER, "F_OWNER");
        require(!factory.paused(), "F_PAUSED");
        require(factory.presetCount() == 1, "F_PRESETS");

        HydeTokenFactory.Preset memory preset = factory.getPreset(0);
        require(
            preset.c0.initialTick == WethRedeployPreset.C0_INIT
                && preset.c0.tickLower == WethRedeployPreset.C0_LOWER
                && preset.c0.tickUpper == WethRedeployPreset.C0_UPPER,
            "F_PRESET_C0"
        );
        require(
            preset.c1.initialTick == WethRedeployPreset.C1_INIT
                && preset.c1.tickLower == WethRedeployPreset.C1_LOWER
                && preset.c1.tickUpper == WethRedeployPreset.C1_UPPER,
            "F_PRESET_C1"
        );
        require(preset.c0.liquidity == preset.c1.liquidity, "F_PRESET_LIQ_MIRROR");
        require(preset.c0.liquidity == WethRedeployPreset.EXPECTED_LIQUIDITY, "F_PRESET_LIQ_EXACT");

        HydeFeeVault vault = HydeFeeVault(vaultAddress);
        require(address(vault.SETTLEMENT_TOKEN()) == WETH, "V_TOKEN");
        require(vault.COLLECTOR() == collectorAddress, "V_COLLECTOR");
        require(address(vault.POOL_MANAGER()) == POOL_MANAGER, "V_PM");
        require(address(vault.HOOK()) == hookAddress, "V_HOOK");
        require(vault.hydeoutTreasury() == HYDE_TREASURY, "V_TREASURY");
        require(vault.hydeBps() == HYDE_BPS, "V_HYDEBPS");
        require(vault.factory() == factoryAddress, "V_FACTORY");

        HydeFeeCollector collector = HydeFeeCollector(collectorAddress);
        require(address(collector.POSITION_MANAGER()) == POSITION_MANAGER, "C_POSM");
        require(address(collector.POOL_MANAGER()) == POOL_MANAGER, "C_PM");
        require(address(collector.VAULT()) == vaultAddress, "C_VAULT");
        require(collector.WETH() == WETH, "C_WETH");
        require(address(collector.HOOK()) == hookAddress, "C_HOOK");
        require(address(collector.PERMIT2()) == PERMIT2, "C_PERMIT2");
        require(address(collector.STATE_VIEW()) == STATE_VIEW, "C_STATEVIEW");
        require(collector.factory() == factoryAddress, "C_FACTORY");

        HydeHook hook = HydeHook(hookAddress);
        require(address(hook.POOL_MANAGER()) == POOL_MANAGER, "H_PM");
        require(hook.VAULT() == vaultAddress, "H_VAULT");
        require(hook.WETH() == WETH, "H_WETH");
        require(hook.startFee() == START_FEE, "H_START");
        require(hook.baseFee() == BASE_FEE, "H_BASE");
        require(hook.maxLpFeeCap() == MAX_LP_FEE_CAP, "H_CAP");
        require(hook.antiSnipeWindow() == ANTI_SNIPE_WINDOW, "H_ANTISNIPE");
        require(hook.cardinality() == CARDINALITY, "H_CARD");
        require(hook.factory() == factoryAddress, "H_FACTORY");
    }

    function _factoryParams(
        address implAddress,
        address vaultAddress,
        address collectorAddress,
        address hookAddress
    ) internal view returns (HydeTokenFactory.ConstructorParams memory params) {
        params = HydeTokenFactory.ConstructorParams({
            impl: implAddress,
            collector: collectorAddress,
            vault: vaultAddress,
            hook: hookAddress,
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

    function _presets() internal pure returns (HydeTokenFactory.PresetInput[] memory presets) {
        presets = new HydeTokenFactory.PresetInput[](1);
        presets[0] = WethRedeployPreset.preset();
    }

    function _child(address coordinator, uint8 nonce) internal pure returns (address) {
        return address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(bytes1(0xd6), bytes1(0x94), coordinator, bytes1(nonce))
                    )
                )
            )
        );
    }

    function _sender() internal view returns (address) {
        return vm.envOr("SENDER", DEPLOYER);
    }

    function _ch(address account) internal view returns (bytes32 codehash) {
        assembly {
            codehash := extcodehash(account)
        }
    }
}

interface IWethMeta42161 {
    function symbol() external view returns (string memory);
    function decimals() external view returns (uint8);
}
