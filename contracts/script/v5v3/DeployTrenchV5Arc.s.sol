// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";

import {HydeERC20} from "../../src/v3/HydeERC20.sol";
import {IUniswapV3Factory} from "../../src/v3/interfaces/IUniswapV3Minimal.sol";
import {TrenchV3Factory} from "../../src/v5v3/TrenchV3Factory.sol";
import {TrenchV3Graduator} from "../../src/v5v3/TrenchV3Graduator.sol";
import {TrenchV3Locker} from "../../src/v5v3/TrenchV3Locker.sol";

interface IArcV5PositionManager {
    function factory() external view returns (address);
}

interface IERC20MetadataArcV5 {
    function decimals() external view returns (uint8);
    function symbol() external view returns (string memory);
}

/// @notice Fail-closed Arc mainnet deployment driver for Hydeout V5 Trench Curve.
/// @dev Arc uses native USDC for gas and exposes the same asset as a 6-decimal ERC-20 pair token.
///      Economic boundaries remain mandatory environment inputs.
contract DeployTrenchV5Arc is Script {
    uint256 internal constant CHAIN_ID = 5_042;
    address internal constant USDC = 0x3600000000000000000000000000000000000000;
    address internal constant V3_FACTORY = 0xf0db7b58379503491d857dB50AC9ece64c653918;
    address internal constant POSITION_MANAGER = 0x39654A85A4C05127f5Fd6ED22CAeC077A0fB1377;

    bytes32 internal constant USDC_CODEHASH = 0xc9987bd3af6b26a030951faa7eacc017b68343aeedf3ce5fe68f821c4b93939d;
    bytes32 internal constant V3_FACTORY_CODEHASH = 0x621c4819f7b62d7ddb153206bc30950bcc3f5cc9d24c45661f8c2f31dcbd166d;
    bytes32 internal constant POSITION_MANAGER_CODEHASH =
        0xcad0552151ba7675afe512ebe77fcc6eed68a0cb65775d31e38d44823e6796a0;

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
        require(USDC.codehash == USDC_CODEHASH, "USDC_CODEHASH");
        require(V3_FACTORY.codehash == V3_FACTORY_CODEHASH, "V3_FACTORY_CODEHASH");
        require(POSITION_MANAGER.codehash == POSITION_MANAGER_CODEHASH, "POSITION_MANAGER_CODEHASH");
        require(IERC20MetadataArcV5(USDC).decimals() == 6, "USDC_DECIMALS");
        require(keccak256(bytes(IERC20MetadataArcV5(USDC).symbol())) == keccak256("USDC"), "USDC_SYMBOL");
        require(IUniswapV3Factory(V3_FACTORY).feeAmountTickSpacing(FEE_TIER) == TICK_SPACING, "FEE_DISABLED");
        require(IArcV5PositionManager(POSITION_MANAGER).factory() == V3_FACTORY, "NPM_FACTORY");

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
                numeraire: USDC,
                numeraireDecimals: 6,
                feeTier: FEE_TIER,
                startFdvWad: startFdvWad,
                graduationFdvWad: graduationFdvWad,
                launchFeeAsset: USDC,
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
        require(factory.NUMERAIRE() == USDC, "F_NUMERAIRE");
        require(factory.owner() == owner, "F_OWNER");
        require(factory.EXPECTED_TERMINAL_PROCEEDS() >= minimumProceeds, "F_PROCEEDS");
        require(graduator.FACTORY() == address(factory), "G_FACTORY");
        require(address(graduator.LOCKER()) == address(locker), "G_LOCKER");
        require(graduator.NUMERAIRE() == USDC, "G_NUMERAIRE");
        require(locker.graduator() == address(graduator), "L_GRADUATOR");
        require(locker.HYDE_TREASURY() == hydeTreasury, "L_TREASURY");

        console2.log("== Hydeout V5 Trench Curve / Arc 5042 ==");
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
