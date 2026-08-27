// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";

import {
    ITrenchSlipstreamFactory,
    ITrenchV3CollectOnly,
    ITrenchV3LockerRegister,
    ITrenchV3PositionManager
} from "../../src/v5v3/interfaces/ITrenchV3.sol";
import {TrenchV3Factory} from "../../src/v5v3/TrenchV3Factory.sol";
import {TrenchV3Graduator} from "../../src/v5v3/TrenchV3Graduator.sol";
import {TrenchV3Locker} from "../../src/v5v3/TrenchV3Locker.sol";

interface IInkV5PositionManager {
    function factory() external view returns (address);
}

/// @notice Fail-closed Ink mainnet deployment driver for Hydeout V5 Trench Curve on Slipstream.
/// @dev Ink is intentionally configured for normal launches only. Flywheel can be introduced in a
///      separate audited deployment; no legacy Flywheel factory is trusted by this script.
contract DeployTrenchV5Ink is Script {
    uint256 internal constant CHAIN_ID = 57_073;
    address internal constant WETH = 0x4200000000000000000000000000000000000006;
    address internal constant CL_FACTORY = 0x718E46d0962A66942E233760a8bd6038Ce54EdCD;
    address internal constant POSITION_MANAGER = 0xefD0f78F93f578036AE34D52A813a4BE7D8D2D52;
    address internal constant TOKEN_IMPL = 0x144Ee4A0B605B038F085518231A414b0BD00ef23;

    bytes32 internal constant WETH_CODEHASH = 0xd0f1614c5dacfbd34f1c6f500f397009e4c9a8bfd4e02db353edb2253d9a8012;
    bytes32 internal constant FACTORY_CODEHASH = 0x47300e75187cc255355659bf86873d6adfbfe60ad2000e0f6e1274e02917b701;
    bytes32 internal constant POSITION_MANAGER_CODEHASH =
        0x068cdd1c2f2c7c4f78730b56ffe01cace7ef93ca815698cd85c3855ea6b10380;
    bytes32 internal constant TOKEN_IMPL_CODEHASH = 0xce745b5eba4a683f85e250477ced81eb3f04e5ba9a7ed705ef117e2acad6f012;

    uint24 internal constant FEE_TIER = 3_000;
    int24 internal constant TICK_SPACING = 200;
    uint16 internal constant OBSERVATION_CARDINALITY = 512;
    uint32 internal constant GRADUATION_DELAY = 300;
    uint256 internal constant LAUNCH_FEE = 0.0004 ether;
    uint256 internal constant START_FDV_WAD = 1 ether;
    uint256 internal constant GRADUATION_FDV_WAD = 16 ether;
    uint256 internal constant MINIMUM_PROCEEDS = 1 ether;
    uint256 internal constant MAX_CURVE_DUST = 10e18;
    uint256 internal constant MAX_PERMANENT_TOKEN_DUST = 10e18;
    uint256 internal constant MAX_PERMANENT_QUOTE_DUST = 1e10;
    uint256 internal constant MAX_WALLET_BPS = 200;
    uint64 internal constant MAX_WALLET_WINDOW = 300;

    function run() external {
        require(block.chainid == CHAIN_ID, "WRONG_CHAIN");
        require(WETH.codehash == WETH_CODEHASH, "WETH_CODEHASH");
        require(CL_FACTORY.codehash == FACTORY_CODEHASH, "FACTORY_CODEHASH");
        require(POSITION_MANAGER.codehash == POSITION_MANAGER_CODEHASH, "POSITION_MANAGER_CODEHASH");
        require(TOKEN_IMPL.codehash == TOKEN_IMPL_CODEHASH, "TOKEN_IMPL_CODEHASH");
        require(ITrenchSlipstreamFactory(CL_FACTORY).tickSpacingToFee(TICK_SPACING) == FEE_TIER, "SPACING_DISABLED");
        require(IInkV5PositionManager(POSITION_MANAGER).factory() == CL_FACTORY, "NPM_FACTORY");

        address expectedDeployer = vm.envAddress("EXPECTED_DEPLOYER");
        address deployer = vm.envOr("SENDER", expectedDeployer);
        address owner = vm.envAddress("V5_FACTORY_OWNER");
        address hydeTreasury = vm.envAddress("HYDE_TREASURY");
        address launchTreasury = vm.envAddress("LAUNCH_TREASURY");

        require(deployer == expectedDeployer, "SENDER_NOT_DEPLOYER");
        require(owner != address(0), "OWNER_ZERO");
        require(hydeTreasury != address(0), "HYDE_TREASURY_ZERO");
        require(launchTreasury != address(0), "LAUNCH_TREASURY_ZERO");

        uint256 nonce = vm.getNonce(deployer);
        address expectedLocker = vm.computeCreateAddress(deployer, nonce);
        address expectedGraduator = vm.computeCreateAddress(deployer, nonce + 1);
        address expectedFactory = vm.computeCreateAddress(deployer, nonce + 2);
        require(
            expectedFactory.code.length == 0 && expectedLocker.code.length == 0 && expectedGraduator.code.length == 0,
            "PRE_EXISTING_CODE"
        );

        vm.startBroadcast(deployer);
        TrenchV3Locker locker =
            new TrenchV3Locker(ITrenchV3CollectOnly(POSITION_MANAGER), hydeTreasury, expectedGraduator);
        TrenchV3Graduator graduator = new TrenchV3Graduator(
            TrenchV3Graduator.Config({
                factory: expectedFactory,
                positionManager: ITrenchV3PositionManager(POSITION_MANAGER),
                locker: ITrenchV3LockerRegister(address(locker)),
                numeraire: WETH,
                feeTier: uint24(uint256(int256(TICK_SPACING))),
                tickSpacing: TICK_SPACING,
                slipstream: true,
                graduationDelay: GRADUATION_DELAY,
                twapTickTolerance: TICK_SPACING,
                minimumProceeds: MINIMUM_PROCEEDS,
                maxCurveDust: MAX_CURVE_DUST,
                maxPermanentTokenDust: MAX_PERMANENT_TOKEN_DUST,
                maxPermanentQuoteDust: MAX_PERMANENT_QUOTE_DUST
            })
        );
        TrenchV3Factory factory = new TrenchV3Factory(
            TrenchV3Factory.Config({
                impl: TOKEN_IMPL,
                v3Factory: CL_FACTORY,
                positionManager: POSITION_MANAGER,
                locker: address(locker),
                graduator: address(graduator),
                flywheelVaultFactory: address(0),
                hydeTreasury: hydeTreasury,
                numeraire: WETH,
                numeraireDecimals: 18,
                feeTier: FEE_TIER,
                slipstream: true,
                tickSpacing: TICK_SPACING,
                startFdvWad: START_FDV_WAD,
                graduationFdvWad: GRADUATION_FDV_WAD,
                launchFeeAsset: address(0),
                launchFeeAmount: LAUNCH_FEE,
                launchFeeNative: true,
                launchFeeTreasury: launchTreasury,
                maxWalletBps: MAX_WALLET_BPS,
                maxWalletWindowSecs: MAX_WALLET_WINDOW,
                observationCardinality: OBSERVATION_CARDINALITY,
                graduationDelay: GRADUATION_DELAY,
                twapTickTolerance: TICK_SPACING,
                minimumProceeds: MINIMUM_PROCEEDS,
                maxCurveDust: MAX_CURVE_DUST,
                maxPermanentTokenDust: MAX_PERMANENT_TOKEN_DUST,
                maxPermanentQuoteDust: MAX_PERMANENT_QUOTE_DUST,
                owner: owner
            })
        );
        vm.stopBroadcast();

        require(address(factory) == expectedFactory, "FACTORY_DRIFT");
        require(address(locker) == expectedLocker, "LOCKER_DRIFT");
        require(address(graduator) == expectedGraduator, "GRADUATOR_DRIFT");
        require(factory.IMPL() == TOKEN_IMPL, "F_IMPL");
        require(address(factory.LOCKER()) == address(locker), "F_LOCKER");
        require(address(factory.GRADUATOR()) == address(graduator), "F_GRADUATOR");
        require(address(factory.V3_FACTORY()) == CL_FACTORY, "F_V3_FACTORY");
        require(address(factory.POSITION_MANAGER()) == POSITION_MANAGER, "F_NPM");
        require(factory.NUMERAIRE() == WETH, "F_NUMERAIRE");
        require(address(factory.FLYWHEEL_VAULT_FACTORY()) == address(0), "F_FLYWHEEL_ENABLED");
        require(factory.SLIPSTREAM(), "F_NOT_SLIPSTREAM");
        require(factory.POSITION_KEY() == uint24(uint256(int256(TICK_SPACING))), "F_POSITION_KEY");
        require(factory.owner() == owner, "F_OWNER");
        require(factory.EXPECTED_TERMINAL_PROCEEDS() >= MINIMUM_PROCEEDS, "F_PROCEEDS");
        require(graduator.FACTORY() == address(factory), "G_FACTORY");
        require(address(graduator.LOCKER()) == address(locker), "G_LOCKER");
        require(graduator.NUMERAIRE() == WETH, "G_NUMERAIRE");
        require(locker.graduator() == address(graduator), "L_GRADUATOR");
        require(locker.HYDE_TREASURY() == hydeTreasury, "L_TREASURY");

        console2.log("== Hydeout V5 Trench Curve / Ink 57073 ==");
        console2.log("Impl      ", TOKEN_IMPL);
        console2.log("Factory   ", address(factory));
        console2.log("Graduator ", address(graduator));
        console2.log("Locker    ", address(locker));
        console2.log("Expected terminal proceeds", factory.EXPECTED_TERMINAL_PROCEEDS());
        console2.log("Runtime codehashes (factory / graduator / locker / impl):");
        console2.logBytes32(address(factory).codehash);
        console2.logBytes32(address(graduator).codehash);
        console2.logBytes32(address(locker).codehash);
        console2.logBytes32(TOKEN_IMPL.codehash);
    }
}
