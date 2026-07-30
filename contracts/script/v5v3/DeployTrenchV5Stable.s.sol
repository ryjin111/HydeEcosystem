// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";

import {HydeERC20} from "../../src/v3/HydeERC20.sol";
import {IUniswapV3Factory} from "../../src/v3/interfaces/IUniswapV3Minimal.sol";
import {TrenchV3Factory} from "../../src/v5v3/TrenchV3Factory.sol";
import {TrenchV3Graduator} from "../../src/v5v3/TrenchV3Graduator.sol";
import {TrenchV3Locker} from "../../src/v5v3/TrenchV3Locker.sol";

interface IStableV5PositionManager {
    function factory() external view returns (address);
}

interface IERC20MetadataV5 {
    function decimals() external view returns (uint8);
    function symbol() external view returns (string memory);
}

/// @notice Fail-closed Stable mainnet deployment driver for Hydeout V5 Trench Curve.
/// @dev This script never contains a private key and does not broadcast unless the operator adds
///      `--broadcast`. Economic boundaries are mandatory environment inputs so a deploy cannot
///      silently inherit test values.
contract DeployTrenchV5Stable is Script {
    uint256 internal constant CHAIN_ID = 988;
    address internal constant USDT0 = 0x779Ded0c9e1022225f8E0630b35a9b54bE713736;
    address internal constant V3_FACTORY = 0x88F0a512eF09175D456bc9547f914f48C013E4aA;
    address internal constant POSITION_MANAGER = 0x3BdC3437405f7D801b6036532713fc1F179136a6;

    bytes32 internal constant USDT0_CODEHASH = 0x4d9be648c5bf39973670d9f8b481d5d0b971e6a2db2deccc6b98cde21c5dd83e;
    bytes32 internal constant V3_FACTORY_CODEHASH = 0x2616b5c05e19fc8931cdf2f08bf47e05a7db6859c23add2c32d226092409e939;
    bytes32 internal constant POSITION_MANAGER_CODEHASH =
        0x553e7df57c6a17f6d65f05f5c3a3fa41ddaebeca6cf90a0b2b59da3152c41371;

    uint24 internal constant FEE_TIER = 10_000;
    int24 internal constant TICK_SPACING = 200;
    uint16 internal constant OBSERVATION_CARDINALITY = 512;
    uint32 internal constant GRADUATION_DELAY = 300;
    uint256 internal constant LAUNCH_FEE = 1e6;
    uint256 internal constant MAX_CURVE_DUST = 10e18;
    uint256 internal constant MAX_PERMANENT_TOKEN_DUST = 10e18;
    uint256 internal constant MAX_PERMANENT_QUOTE_DUST = 10;
    uint256 internal constant MAX_WALLET_BPS = 200;
    uint64 internal constant MAX_WALLET_WINDOW = 300;

    function run() external {
        require(block.chainid == CHAIN_ID, "WRONG_CHAIN");
        require(USDT0.codehash == USDT0_CODEHASH, "USDT0_CODEHASH");
        require(V3_FACTORY.codehash == V3_FACTORY_CODEHASH, "V3_FACTORY_CODEHASH");
        require(POSITION_MANAGER.codehash == POSITION_MANAGER_CODEHASH, "POSITION_MANAGER_CODEHASH");
        require(IERC20MetadataV5(USDT0).decimals() == 6, "USDT0_DECIMALS");
        require(keccak256(bytes(IERC20MetadataV5(USDT0).symbol())) == keccak256("USDT0"), "USDT0_SYMBOL");
        require(IUniswapV3Factory(V3_FACTORY).feeAmountTickSpacing(FEE_TIER) == TICK_SPACING, "FEE_DISABLED");
        require(IStableV5PositionManager(POSITION_MANAGER).factory() == V3_FACTORY, "NPM_FACTORY");

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
        require(launchTreasury != address(0), "LAUNCH_TREASURY_ZERO");
        require(startFdvWad > 0 && graduationFdvWad > startFdvWad, "FDV_RANGE");
        require(minimumProceeds > 0, "MIN_PROCEEDS_ZERO");
        require(deployer.balance >= 0.5 ether, "INSUFFICIENT_GAS");

        uint256 nonce = vm.getNonce(deployer);
        address expectedImpl = vm.computeCreateAddress(deployer, nonce);
        address expectedFactory = vm.computeCreateAddress(deployer, nonce + 1);
        address expectedLocker = _child(expectedFactory, 1);
        address expectedGraduator = _child(expectedFactory, 2);
        require(
            expectedImpl.code.length == 0 && expectedFactory.code.length == 0 && expectedLocker.code.length == 0
                && expectedGraduator.code.length == 0,
            "PRE_EXISTING_CODE"
        );

        vm.startBroadcast(deployer);
        HydeERC20 impl = new HydeERC20();
        TrenchV3Factory factory = new TrenchV3Factory(
            TrenchV3Factory.Config({
                impl: address(impl),
                v3Factory: V3_FACTORY,
                positionManager: POSITION_MANAGER,
                hydeTreasury: hydeTreasury,
                numeraire: USDT0,
                numeraireDecimals: 6,
                feeTier: FEE_TIER,
                startFdvWad: startFdvWad,
                graduationFdvWad: graduationFdvWad,
                launchFeeAsset: USDT0,
                launchFeeAmount: LAUNCH_FEE,
                launchFeeNative: false,
                launchFeeTreasury: launchTreasury,
                maxWalletBps: MAX_WALLET_BPS,
                maxWalletWindowSecs: MAX_WALLET_WINDOW,
                observationCardinality: OBSERVATION_CARDINALITY,
                graduationDelay: GRADUATION_DELAY,
                twapTickTolerance: TICK_SPACING,
                minimumProceeds: minimumProceeds,
                maxCurveDust: MAX_CURVE_DUST,
                maxPermanentTokenDust: MAX_PERMANENT_TOKEN_DUST,
                maxPermanentQuoteDust: MAX_PERMANENT_QUOTE_DUST,
                owner: owner
            })
        );
        vm.stopBroadcast();

        TrenchV3Locker locker = factory.LOCKER();
        TrenchV3Graduator graduator = factory.GRADUATOR();
        require(address(impl) == expectedImpl, "IMPL_DRIFT");
        require(address(factory) == expectedFactory, "FACTORY_DRIFT");
        require(address(locker) == expectedLocker, "LOCKER_DRIFT");
        require(address(graduator) == expectedGraduator, "GRADUATOR_DRIFT");
        require(factory.IMPL() == address(impl), "F_IMPL");
        require(address(factory.LOCKER()) == address(locker), "F_LOCKER");
        require(address(factory.GRADUATOR()) == address(graduator), "F_GRADUATOR");
        require(address(factory.V3_FACTORY()) == V3_FACTORY, "F_V3_FACTORY");
        require(address(factory.POSITION_MANAGER()) == POSITION_MANAGER, "F_NPM");
        require(factory.NUMERAIRE() == USDT0, "F_NUMERAIRE");
        require(factory.owner() == owner, "F_OWNER");
        require(factory.EXPECTED_TERMINAL_PROCEEDS() >= minimumProceeds, "F_PROCEEDS");
        require(graduator.FACTORY() == address(factory), "G_FACTORY");
        require(address(graduator.LOCKER()) == address(locker), "G_LOCKER");
        require(graduator.NUMERAIRE() == USDT0, "G_NUMERAIRE");
        require(locker.graduator() == address(graduator), "L_GRADUATOR");
        require(locker.HYDE_TREASURY() == hydeTreasury, "L_TREASURY");

        console2.log("== Hydeout V5 Trench Curve / Stable 988 ==");
        console2.log("Impl      ", address(impl));
        console2.log("Factory   ", address(factory));
        console2.log("Graduator ", address(graduator));
        console2.log("Locker    ", address(locker));
        console2.log("Actual opening/graduation FDV raw:");
        console2.log(factory.ACTUAL_START_FDV_RAW(), factory.ACTUAL_GRADUATION_FDV_RAW());
        console2.log("Expected terminal proceeds", factory.EXPECTED_TERMINAL_PROCEEDS());
        console2.log("Runtime codehashes (factory / graduator / locker / impl):");
        console2.logBytes32(address(factory).codehash);
        console2.logBytes32(address(graduator).codehash);
        console2.logBytes32(address(locker).codehash);
        console2.logBytes32(address(impl).codehash);
    }

    function _child(address deployer, uint8 nonce) private pure returns (address) {
        return
            address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xd6), bytes1(0x94), deployer, bytes1(nonce))))));
    }
}
