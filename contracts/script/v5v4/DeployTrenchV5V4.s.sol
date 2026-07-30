// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPositionManager} from "v4-periphery/src/interfaces/IPositionManager.sol";
import {IStateView} from "v4-periphery/src/interfaces/IStateView.sol";
import {HookMiner} from "v4-periphery/test/shared/HookMiner.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";

import {HydeERC20} from "../../src/HydeERC20.sol";
import {HydeHook} from "../../src/HydeHook.sol";
import {IHydeHook} from "../../src/interfaces/IHydeHook.sol";
import {TrenchV4Factory} from "../../src/v5v4/TrenchV4Factory.sol";
import {TrenchV4Graduator} from "../../src/v5v4/TrenchV4Graduator.sol";
import {TrenchV4Locker} from "../../src/v5v4/TrenchV4Locker.sol";
import {ITrenchV4LockerRegister} from "../../src/v5v4/interfaces/ITrenchV4.sol";

interface IWethMetadataV5 {
    function decimals() external view returns (uint8);
    function symbol() external view returns (string memory);
}

/// @notice One-shot coordinator required by HydeHook's immutable deployer/factory binding.
/// @dev A fresh hook instance is mandatory: an already-live hook has consumed `initFactory`.
contract TrenchV4StackCoordinator {
    address public immutable OWNER;
    uint256 public immutable CHAIN_ID;
    bool public finalized;
    address public impl;
    address public hook;
    address public locker;
    address public graduator;
    address public factory;

    struct Codes {
        bytes implCode;
        bytes hookCode;
        bytes32 hookSalt;
        address expectedHook;
        bytes lockerCode;
        address expectedLocker;
        bytes graduatorCode;
        address expectedGraduator;
        bytes factoryCode;
        address expectedFactory;
    }

    constructor(address owner_, uint256 chainId_) {
        require(owner_ != address(0) && chainId_ != 0, "BAD_CONFIG");
        OWNER = owner_;
        CHAIN_ID = chainId_;
    }

    function deploy(Codes calldata c) external {
        require(msg.sender == OWNER, "ONLY_OWNER");
        require(block.chainid == CHAIN_ID, "WRONG_CHAIN");
        require(!finalized, "FINALIZED");
        finalized = true;

        impl = _create(c.implCode); // nonce 1
        hook = _create2(c.hookCode, c.hookSalt); // nonce 2
        require(hook == c.expectedHook, "HOOK_DRIFT");
        locker = _create(c.lockerCode); // nonce 3
        require(locker == c.expectedLocker && locker == _child(address(this), 3), "LOCKER_DRIFT");
        graduator = _create(c.graduatorCode); // nonce 4
        require(graduator == c.expectedGraduator && graduator == _child(address(this), 4), "GRADUATOR_DRIFT");
        TrenchV4Locker(locker).initGraduator(graduator);
        factory = _create(c.factoryCode); // nonce 5
        require(factory == c.expectedFactory && factory == _child(address(this), 5), "FACTORY_DRIFT");
        HydeHook(hook).initFactory(factory);
    }

    function _create(bytes memory code) private returns (address deployed) {
        require(code.length != 0, "EMPTY_CODE");
        assembly {
            deployed := create(0, add(code, 0x20), mload(code))
        }
        require(deployed != address(0) && deployed.code.length != 0, "CREATE_FAILED");
    }

    function _create2(bytes memory code, bytes32 salt) private returns (address deployed) {
        require(code.length != 0, "EMPTY_CODE");
        assembly {
            deployed := create2(0, add(code, 0x20), mload(code), salt)
        }
        require(deployed != address(0) && deployed.code.length != 0, "CREATE2_FAILED");
    }

    function _child(address deployer, uint8 nonce) private pure returns (address) {
        return
            address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xd6), bytes1(0x94), deployer, bytes1(nonce))))));
    }
}

/// @notice Fail-closed V5 deployment driver shared by Robinhood Chain and Arbitrum One.
/// @dev Economic boundaries are mandatory environment inputs. This script performs no launch and
///      never broadcasts unless the operator explicitly adds `--broadcast`.
contract DeployTrenchV5V4 is Script {
    uint160 internal constant HOOK_FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
    );
    int24 internal constant TICK_SPACING = 60;
    uint24 internal constant START_FEE = 30_000;
    uint24 internal constant BASE_FEE = 10_000;
    uint24 internal constant MAX_FEE = 50_000;
    uint32 internal constant ANTI_SNIPE_WINDOW = 300;
    uint16 internal constant ORACLE_CARDINALITY = 2_048;
    uint256 internal constant LAUNCH_FEE = 0.0004 ether;
    uint256 internal constant MAX_WALLET_BPS = 100;
    uint64 internal constant MAX_WALLET_WINDOW = 300;
    uint32 internal constant GRADUATION_DELAY = 300;
    uint256 internal constant MAX_CURVE_DUST = 10e18;
    uint256 internal constant MAX_PERMANENT_TOKEN_DUST = 10e18;
    uint256 internal constant MAX_PERMANENT_QUOTE_DUST = 1e12;
    uint32 internal constant COMPOUND_TWAP_WINDOW = 300;
    int24 internal constant MAX_COMPOUND_DEVIATION = 200;
    uint128 internal constant MIN_COMPOUND_LIQUIDITY = 1e6;
    uint256 internal constant DEPLOY_GAS_RESERVE_UNITS = 30_000_000;
    uint256 internal constant MIN_DEPLOY_GAS_RESERVE = 0.001 ether;

    struct ChainConfig {
        address poolManager;
        address positionManager;
        address permit2;
        address universalRouter;
        address stateView;
        address weth;
        bytes32 poolManagerHash;
        bytes32 positionManagerHash;
        bytes32 permit2Hash;
        bytes32 universalRouterHash;
        bytes32 stateViewHash;
        bytes32 wethHash;
    }

    function run() external {
        ChainConfig memory chain = _chainConfig();
        _assertDependencies(chain);

        address expectedDeployer = vm.envAddress("EXPECTED_DEPLOYER");
        address deployer = vm.envOr("SENDER", expectedDeployer);
        address owner = vm.envAddress("V5_FACTORY_OWNER");
        address hydeTreasury = vm.envAddress("HYDE_TREASURY");
        address launchTreasury = vm.envAddress("LAUNCH_TREASURY");
        uint256 startFdvWad = vm.envUint("V5_START_FDV_WAD");
        uint256 graduationFdvWad = vm.envUint("V5_GRADUATION_FDV_WAD");
        uint256 minimumProceeds = vm.envUint("V5_MINIMUM_PROCEEDS");

        require(deployer == expectedDeployer, "SENDER_NOT_DEPLOYER");
        require(owner != address(0), "OWNER_ZERO");
        require(hydeTreasury != address(0), "HYDE_TREASURY_ZERO");
        require(launchTreasury != address(0) && launchTreasury.code.length == 0, "LAUNCH_TREASURY_NOT_EOA");
        require(startFdvWad > 0 && graduationFdvWad > startFdvWad, "FDV_RANGE");
        require(minimumProceeds > 0, "MIN_PROCEEDS_ZERO");
        uint256 deployGasReserve = tx.gasprice * DEPLOY_GAS_RESERVE_UNITS;
        if (deployGasReserve < MIN_DEPLOY_GAS_RESERVE) deployGasReserve = MIN_DEPLOY_GAS_RESERVE;
        require(deployer.balance >= deployGasReserve, "INSUFFICIENT_GAS");

        uint256 nonce = vm.getNonce(deployer);
        address coordinatorAddress = vm.computeCreateAddress(deployer, nonce);
        address implAddress = _child(coordinatorAddress, 1);
        address lockerAddress = _child(coordinatorAddress, 3);
        address graduatorAddress = _child(coordinatorAddress, 4);
        address factoryAddress = _child(coordinatorAddress, 5);
        require(
            coordinatorAddress.code.length == 0 && implAddress.code.length == 0 && factoryAddress.code.length == 0
                && lockerAddress.code.length == 0 && graduatorAddress.code.length == 0,
            "PRE_EXISTING_CODE"
        );

        bytes memory hookArgs = abi.encode(
            IPoolManager(chain.poolManager),
            coordinatorAddress,
            chain.weth,
            START_FEE,
            BASE_FEE,
            MAX_FEE,
            ANTI_SNIPE_WINDOW,
            ORACLE_CARDINALITY
        );
        (address hookAddress, bytes32 hookSalt) =
            HookMiner.find(coordinatorAddress, HOOK_FLAGS, type(HydeHook).creationCode, hookArgs);
        require(hookAddress.code.length == 0, "HOOK_PRE_EXISTING");

        TrenchV4Factory.Config memory config = TrenchV4Factory.Config({
            impl: implAddress,
            poolManager: IPoolManager(chain.poolManager),
            positionManager: IPositionManager(payable(chain.positionManager)),
            permit2: IAllowanceTransfer(chain.permit2),
            stateView: IStateView(chain.stateView),
            hook: IHydeHook(hookAddress),
            locker: TrenchV4Locker(lockerAddress),
            graduator: TrenchV4Graduator(graduatorAddress),
            hydeTreasury: hydeTreasury,
            numeraire: chain.weth,
            numeraireDecimals: 18,
            tickSpacing: TICK_SPACING,
            universalRouter: chain.universalRouter,
            startFdvWad: startFdvWad,
            graduationFdvWad: graduationFdvWad,
            launchFeeAmount: LAUNCH_FEE,
            launchFeeTreasury: launchTreasury,
            maxWalletBps: MAX_WALLET_BPS,
            maxWalletWindowSecs: MAX_WALLET_WINDOW,
            graduationDelay: GRADUATION_DELAY,
            twapTickTolerance: TICK_SPACING,
            minimumProceeds: minimumProceeds,
            maxCurveDust: MAX_CURVE_DUST,
            maxPermanentTokenDust: MAX_PERMANENT_TOKEN_DUST,
            maxPermanentQuoteDust: MAX_PERMANENT_QUOTE_DUST,
            compoundTwapWindow: COMPOUND_TWAP_WINDOW,
            maxCompoundDeviation: MAX_COMPOUND_DEVIATION,
            minCompoundLiquidity: MIN_COMPOUND_LIQUIDITY,
            owner: owner
        });
        TrenchV4StackCoordinator.Codes memory codes = TrenchV4StackCoordinator.Codes({
            implCode: type(HydeERC20).creationCode,
            hookCode: abi.encodePacked(type(HydeHook).creationCode, hookArgs),
            hookSalt: hookSalt,
            expectedHook: hookAddress,
            lockerCode: abi.encodePacked(
                type(TrenchV4Locker).creationCode,
                abi.encode(
                    IPositionManager(payable(chain.positionManager)),
                    IAllowanceTransfer(chain.permit2),
                    IStateView(chain.stateView),
                    IHydeHook(hookAddress),
                    chain.weth,
                    hydeTreasury,
                    TICK_SPACING,
                    COMPOUND_TWAP_WINDOW,
                    MAX_COMPOUND_DEVIATION,
                    MIN_COMPOUND_LIQUIDITY
                )
            ),
            expectedLocker: lockerAddress,
            graduatorCode: abi.encodePacked(
                type(TrenchV4Graduator).creationCode,
                abi.encode(
                    TrenchV4Graduator.Config({
                        factory: factoryAddress,
                        positionManager: IPositionManager(payable(chain.positionManager)),
                        permit2: IAllowanceTransfer(chain.permit2),
                        stateView: IStateView(chain.stateView),
                        hook: IHydeHook(hookAddress),
                        locker: ITrenchV4LockerRegister(lockerAddress),
                        numeraire: chain.weth,
                        tickSpacing: TICK_SPACING,
                        graduationDelay: GRADUATION_DELAY,
                        twapTickTolerance: TICK_SPACING,
                        minimumProceeds: minimumProceeds,
                        maxCurveDust: MAX_CURVE_DUST,
                        maxPermanentTokenDust: MAX_PERMANENT_TOKEN_DUST,
                        maxPermanentQuoteDust: MAX_PERMANENT_QUOTE_DUST
                    })
                )
            ),
            expectedGraduator: graduatorAddress,
            factoryCode: abi.encodePacked(type(TrenchV4Factory).creationCode, abi.encode(config)),
            expectedFactory: factoryAddress
        });

        vm.startBroadcast(deployer);
        TrenchV4StackCoordinator coordinator = new TrenchV4StackCoordinator(deployer, block.chainid);
        require(address(coordinator) == coordinatorAddress, "COORDINATOR_DRIFT");
        coordinator.deploy(codes);
        vm.stopBroadcast();

        TrenchV4Factory factory = TrenchV4Factory(factoryAddress);
        TrenchV4Locker locker = factory.LOCKER();
        TrenchV4Graduator graduator = factory.GRADUATOR();
        require(coordinator.finalized(), "NOT_FINALIZED");
        require(coordinator.impl() == implAddress, "IMPL_DRIFT");
        require(coordinator.hook() == hookAddress, "HOOK_DRIFT");
        require(coordinator.locker() == lockerAddress, "COORD_LOCKER_DRIFT");
        require(coordinator.graduator() == graduatorAddress, "COORD_GRADUATOR_DRIFT");
        require(address(locker) == lockerAddress, "LOCKER_DRIFT");
        require(address(graduator) == graduatorAddress, "GRADUATOR_DRIFT");
        require(uint160(hookAddress) & uint160(0x3FFF) == HOOK_FLAGS, "HOOK_BITS");
        require(HydeHook(hookAddress).factory() == factoryAddress, "HOOK_FACTORY");
        require(address(HydeHook(hookAddress).POOL_MANAGER()) == chain.poolManager, "HOOK_PM");
        require(HydeHook(hookAddress).WETH() == chain.weth, "HOOK_WETH");
        require(factory.IMPL() == implAddress, "F_IMPL");
        require(address(factory.HOOK()) == hookAddress, "F_HOOK");
        require(address(factory.POOL_MANAGER()) == chain.poolManager, "F_PM");
        require(address(factory.POSITION_MANAGER()) == chain.positionManager, "F_POSM");
        require(address(factory.PERMIT2()) == chain.permit2, "F_PERMIT2");
        require(address(factory.STATE_VIEW()) == chain.stateView, "F_STATE_VIEW");
        require(factory.NUMERAIRE() == chain.weth, "F_NUMERAIRE");
        require(factory.UNIVERSAL_ROUTER() == chain.universalRouter, "F_ROUTER");
        require(factory.owner() == owner, "F_OWNER");
        require(factory.EXPECTED_TERMINAL_PROCEEDS() >= minimumProceeds, "F_PROCEEDS");
        require(graduator.FACTORY() == factoryAddress, "G_FACTORY");
        require(address(graduator.LOCKER()) == address(locker), "G_LOCKER");
        require(locker.graduator() == address(graduator), "L_GRADUATOR");
        require(locker.HYDE_TREASURY() == hydeTreasury, "L_TREASURY");

        console2.log("== Hydeout V5 Trench Curve / V4 ==");
        console2.log("Chain      ", block.chainid);
        console2.log("Coordinator", address(coordinator));
        console2.log("Impl       ", implAddress);
        console2.log("Hook       ", hookAddress);
        console2.log("Factory    ", factoryAddress);
        console2.log("Graduator ", address(graduator));
        console2.log("Locker     ", address(locker));
        console2.log("Actual opening/graduation FDV raw:");
        console2.log(factory.ACTUAL_START_FDV_RAW(), factory.ACTUAL_GRADUATION_FDV_RAW());
        console2.log("Expected terminal proceeds", factory.EXPECTED_TERMINAL_PROCEEDS());
        console2.log("Runtime codehashes (factory / graduator / locker / hook / impl):");
        console2.logBytes32(factoryAddress.codehash);
        console2.logBytes32(address(graduator).codehash);
        console2.logBytes32(address(locker).codehash);
        console2.logBytes32(hookAddress.codehash);
        console2.logBytes32(implAddress.codehash);
    }

    function _assertDependencies(ChainConfig memory chain) private view {
        require(_codehash(chain.poolManager) == chain.poolManagerHash, "POOL_MANAGER_HASH");
        require(_codehash(chain.positionManager) == chain.positionManagerHash, "POSITION_MANAGER_HASH");
        require(_codehash(chain.permit2) == chain.permit2Hash, "PERMIT2_HASH");
        require(_codehash(chain.universalRouter) == chain.universalRouterHash, "UNIVERSAL_ROUTER_HASH");
        require(_codehash(chain.stateView) == chain.stateViewHash, "STATE_VIEW_HASH");
        require(_codehash(chain.weth) == chain.wethHash, "WETH_HASH");
        require(IWethMetadataV5(chain.weth).decimals() == 18, "WETH_DECIMALS");
        require(keccak256(bytes(IWethMetadataV5(chain.weth).symbol())) == keccak256("WETH"), "WETH_SYMBOL");
    }

    function _chainConfig() private view returns (ChainConfig memory c) {
        if (block.chainid == 4663) {
            return ChainConfig({
                poolManager: 0x8366a39CC670B4001A1121B8F6A443A643e40951,
                positionManager: 0x58daec3116aae6D93017bAAea7749052E8a04fA7,
                permit2: 0x000000000022D473030F116dDEE9F6B43aC78BA3,
                universalRouter: 0x8876789976dEcBfCbBbe364623C63652db8C0904,
                stateView: 0xF3334192D15450CdD385c8B70e03f9A6bD9E673b,
                weth: 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73,
                poolManagerHash: 0xbd3881180b547f5fe817545743cfb4343e96b1bc6640dcd70c106b0066e95626,
                positionManagerHash: 0xc873e135dc9aaec88489cfbad146b4cb49d6a32e0d80326377784b7ba17670b2,
                permit2Hash: 0x5208783f52488f7d3493e5e38311ab707c1d75457fe472a19b0b4d57d66a7fca,
                universalRouterHash: 0x2ce6aaaf9f4151f5e1cbf774668772f17f532ae11b15e9284fd0a072a8b0fbde,
                stateViewHash: 0x7d9c591e0956fd89d98feb4ffcfe8bf1f7a62bd485edd979fa21d104b49878a6,
                wethHash: 0x5706be52f64875fee65a2cec0d80e47a23d8793cbe85d214b48445e2d05f5353
            });
        }
        if (block.chainid == 42161) {
            return ChainConfig({
                poolManager: 0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32,
                positionManager: 0xd88F38F930b7952f2DB2432Cb002E7abbF3dD869,
                permit2: 0x000000000022D473030F116dDEE9F6B43aC78BA3,
                universalRouter: 0xA51afAFe0263b40EdaEf0Df8781eA9aa03E381a3,
                stateView: 0x76Fd297e2D437cd7f76d50F01AfE6160f86e9990,
                weth: 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1,
                poolManagerHash: 0xe4b2759e456c9c4ef763e3b4e257c5105e1ba283d7de8b131dd321197de794a4,
                positionManagerHash: 0x6156ddaa1c8cd2c26d37455a5dc57b1761dc2848856426c0ac261ae0c7fecd68,
                permit2Hash: 0x9e51dcb64cf56fc09a82cb41edbc17c6a2250f18dbd1b91e884c0aca02acd57c,
                universalRouterHash: 0xc15e8e18812f640245cac34716a18270e3d3288e99b328a410401888ff484720,
                stateViewHash: 0x4c0e823a0cd44b6b2d9485e774c421cf929db3996096d9b84ee6b23525184b9e,
                wethHash: 0x2d240bb4510ed1acfeaba905eb4bcc4524d63c8ae66e48fcccac55ea714db7a7
            });
        }
        revert("UNSUPPORTED_CHAIN");
    }

    function _child(address deployer, uint8 nonce) private pure returns (address) {
        return
            address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xd6), bytes1(0x94), deployer, bytes1(nonce))))));
    }

    function _codehash(address target) private view returns (bytes32 result) {
        assembly {
            result := extcodehash(target)
        }
    }
}
