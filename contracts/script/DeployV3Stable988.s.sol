// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";

import {HydeERC20} from "../src/v3/HydeERC20.sol";
import {HydeV3FeeLocker} from "../src/v3/HydeV3FeeLocker.sol";
import {HydeV3Pad} from "../src/v3/HydeV3Pad.sol";
import {IUniswapV3Factory} from "../src/v3/interfaces/IUniswapV3Minimal.sol";

interface IStablePositionManager {
    function factory() external view returns (address);
}

interface IERC20MetadataMinimal {
    function decimals() external view returns (uint8);
    function symbol() external view returns (string memory);
}

/// @notice Fail-closed Stable mainnet deployment driver for the Hyde V3 reach line.
///
/// Dry-run:
///   $env:FOUNDRY_PROFILE="v3"
///   $env:EXPECTED_DEPLOYER="<deployer>"
///   $env:HYDE_TREASURY="<5%-fee recipient>"
///   $env:LAUNCH_TREASURY="<1-USDT0 launch-fee recipient>"
///   forge script script/DeployV3Stable988.s.sol:DeployV3Stable988 \
///     --rpc-url https://rpc.stable.xyz --sender $env:EXPECTED_DEPLOYER -vvvv
///
/// Broadcast is intentionally a separate operator decision: append `--broadcast --private-key ...`
/// only after the dry-run addresses and full immutable manifest have been reviewed.
contract DeployV3Stable988 is Script {
    uint256 internal constant STABLE_CHAIN_ID = 988;

    address internal constant USDT0 = 0x779Ded0c9e1022225f8E0630b35a9b54bE713736;
    address internal constant V3_FACTORY = 0x88F0a512eF09175D456bc9547f914f48C013E4aA;
    address internal constant POSITION_MANAGER = 0x3BdC3437405f7D801b6036532713fc1F179136a6;

    bytes32 internal constant USDT0_CODEHASH = 0x4d9be648c5bf39973670d9f8b481d5d0b971e6a2db2deccc6b98cde21c5dd83e;
    bytes32 internal constant V3_FACTORY_CODEHASH = 0x2616b5c05e19fc8931cdf2f08bf47e05a7db6859c23add2c32d226092409e939;
    bytes32 internal constant POSITION_MANAGER_CODEHASH =
        0x553e7df57c6a17f6d65f05f5c3a3fa41ddaebeca6cf90a0b2b59da3152c41371;

    uint8 internal constant NUMERAIRE_DECIMALS = 6;
    uint24 internal constant FEE_TIER = 10_000; // fixed 1% V3 fee
    int24 internal constant EXPECTED_TICK_SPACING = 200;

    uint256 internal constant START_FDV_WAD = 5_000e18;
    uint256 internal constant TOP_FDV_WAD = 50_000e18;
    uint256 internal constant LAUNCH_FEE_AMOUNT = 1e6; // 1 USDT0 at 6 decimals
    uint256 internal constant MAX_WALLET_BPS = 200; // 2%
    uint64 internal constant MAX_WALLET_WINDOW = 10 minutes;
    uint256 internal constant GRADUATION_THRESHOLD = 500e6; // cosmetic label only

    int24 internal constant EXPECTED_TICK_FLOOR = -398_400;
    int24 internal constant EXPECTED_TICK_CEIL = -375_400;

    function run() external {
        require(block.chainid == STABLE_CHAIN_ID, "WRONG_CHAIN");
        require(USDT0.codehash == USDT0_CODEHASH, "USDT0_CODEHASH");
        require(V3_FACTORY.codehash == V3_FACTORY_CODEHASH, "V3_FACTORY_CODEHASH");
        require(POSITION_MANAGER.codehash == POSITION_MANAGER_CODEHASH, "POSITION_MANAGER_CODEHASH");
        require(IERC20MetadataMinimal(USDT0).decimals() == NUMERAIRE_DECIMALS, "USDT0_DECIMALS");
        require(keccak256(bytes(IERC20MetadataMinimal(USDT0).symbol())) == keccak256("USDT0"), "USDT0_SYMBOL");
        require(
            IUniswapV3Factory(V3_FACTORY).feeAmountTickSpacing(FEE_TIER) == EXPECTED_TICK_SPACING, "FEE_TIER_DISABLED"
        );
        require(IStablePositionManager(POSITION_MANAGER).factory() == V3_FACTORY, "NPM_FACTORY_BINDING");

        address expectedDeployer = vm.envAddress("EXPECTED_DEPLOYER");
        address deployer = vm.envOr("SENDER", expectedDeployer);
        address hydeTreasury = vm.envAddress("HYDE_TREASURY");
        address launchTreasury = vm.envAddress("LAUNCH_TREASURY");
        require(deployer == expectedDeployer, "SENDER_NOT_DEPLOYER");
        require(hydeTreasury != address(0), "HYDE_TREASURY_ZERO");
        require(launchTreasury != address(0), "LAUNCH_TREASURY_ZERO");
        require(deployer.balance >= 0.5 ether, "INSUFFICIENT_GAS_BALANCE");

        uint256 deployerNonce = vm.getNonce(deployer);
        address expectedImpl = vm.computeCreateAddress(deployer, deployerNonce);
        address expectedPad = vm.computeCreateAddress(deployer, deployerNonce + 1);
        address expectedLocker = vm.computeCreateAddress(expectedPad, 1);
        require(
            expectedImpl.code.length == 0 && expectedPad.code.length == 0 && expectedLocker.code.length == 0,
            "PRE_EXISTING_CODE"
        );

        vm.startBroadcast(deployer);
        HydeERC20 impl = new HydeERC20();
        HydeV3Pad pad = new HydeV3Pad(
            HydeV3Pad.Config({
                impl: address(impl),
                v3Factory: V3_FACTORY,
                positionManager: POSITION_MANAGER,
                hydeTreasury: hydeTreasury,
                numeraire: USDT0,
                numeraireDecimals: NUMERAIRE_DECIMALS,
                feeTier: FEE_TIER,
                slipstream: false,
                tickSpacing: 0,
                startFdvWad: START_FDV_WAD,
                topFdvWad: TOP_FDV_WAD,
                launchFeeAsset: USDT0,
                launchFeeAmount: LAUNCH_FEE_AMOUNT,
                launchFeeNative: false,
                launchFeeTreasury: launchTreasury,
                maxWalletBps: MAX_WALLET_BPS,
                maxWalletWindowSecs: MAX_WALLET_WINDOW,
                graduationThreshold: GRADUATION_THRESHOLD
            })
        );
        vm.stopBroadcast();

        HydeV3FeeLocker locker = pad.LOCKER();
        require(address(impl) == expectedImpl, "IMPL_ADDRESS_DRIFT");
        require(address(pad) == expectedPad, "PAD_ADDRESS_DRIFT");
        require(address(locker) == expectedLocker, "LOCKER_ADDRESS_DRIFT");
        _assertManifest(impl, pad, locker, hydeTreasury, launchTreasury);

        console2.log("== Hyde V3 Stable/988 deployment dry-run ==");
        console2.log("Deployer ", deployer);
        console2.log("Impl     ", address(impl));
        console2.log("Pad      ", address(pad));
        console2.log("Locker   ", address(locker));
        console2.log("Hyde fee ", hydeTreasury);
        console2.log("Launch fee", launchTreasury);
        console2.log("Runtime codehashes (impl / pad / locker):");
        console2.logBytes32(address(impl).codehash);
        console2.logBytes32(address(pad).codehash);
        console2.logBytes32(address(locker).codehash);
    }

    function _assertManifest(
        HydeERC20 impl,
        HydeV3Pad pad,
        HydeV3FeeLocker locker,
        address hydeTreasury,
        address launchTreasury
    ) internal view {
        require(address(impl).code.length > 0, "IMPL_MISSING_RUNTIME");
        require(address(pad).code.length > 0, "PAD_MISSING_RUNTIME");
        require(address(locker).code.length > 0, "LOCKER_MISSING_RUNTIME");

        require(pad.IMPL() == address(impl), "PAD_IMPL");
        require(address(pad.LOCKER()) == address(locker), "PAD_LOCKER");
        require(address(pad.V3_FACTORY()) == V3_FACTORY, "PAD_FACTORY");
        require(address(pad.POSITION_MANAGER()) == POSITION_MANAGER, "PAD_NPM");
        require(pad.NUMERAIRE() == USDT0, "PAD_NUMERAIRE");
        require(pad.NUMERAIRE_DECIMALS() == NUMERAIRE_DECIMALS, "PAD_DECIMALS");
        require(pad.FEE_TIER() == FEE_TIER, "PAD_FEE_TIER");
        require(pad.TICK_SPACING() == EXPECTED_TICK_SPACING, "PAD_TICK_SPACING");
        require(pad.TICK_FLOOR() == EXPECTED_TICK_FLOOR, "PAD_TICK_FLOOR");
        require(pad.TICK_CEIL() == EXPECTED_TICK_CEIL, "PAD_TICK_CEIL");
        require(pad.LAUNCH_FEE_ASSET() == USDT0, "PAD_LAUNCH_ASSET");
        require(pad.LAUNCH_FEE_AMOUNT() == LAUNCH_FEE_AMOUNT, "PAD_LAUNCH_AMOUNT");
        require(!pad.LAUNCH_FEE_NATIVE(), "PAD_LAUNCH_NATIVE");
        require(pad.LAUNCH_FEE_TREASURY() == launchTreasury, "PAD_LAUNCH_TREASURY");
        require(pad.MAX_WALLET_BPS() == MAX_WALLET_BPS, "PAD_MAX_WALLET_BPS");
        require(pad.MAX_WALLET_WINDOW_SECS() == MAX_WALLET_WINDOW, "PAD_MAX_WALLET_WINDOW");

        require(locker.FACTORY() == address(pad), "LOCKER_FACTORY");
        require(address(locker.POSITION_MANAGER()) == POSITION_MANAGER, "LOCKER_NPM");
        require(locker.HYDE_TREASURY() == hydeTreasury, "LOCKER_TREASURY");
        require(locker.HYDE_BPS() == 500, "LOCKER_HYDE_BPS");
        require(locker.GRADUATION_THRESHOLD() == GRADUATION_THRESHOLD, "LOCKER_GRADUATION");
    }
}
