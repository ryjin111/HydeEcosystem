// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";

import {HydeERC20} from "../src/v3/HydeERC20.sol";
import {HydeV3FeeLocker} from "../src/v3/HydeV3FeeLocker.sol";
import {HydeV3Pad} from "../src/v3/HydeV3Pad.sol";
import {ISlipstreamFactory} from "../src/v3/interfaces/IUniswapV3Minimal.sol";

interface IInkPositionManagerV3Deploy {
    function factory() external view returns (address);
    function WETH9() external view returns (address);
}

interface IERC20MetadataInkV3Deploy {
    function decimals() external view returns (uint8);
    function symbol() external view returns (string memory);
}

/// @notice Deploys the standalone Stable-style V3 pad on Ink Slipstream.
/// @dev Reuses the pinned HydeERC20 implementation already deployed by the same signer.
contract DeployV3Ink57073 is Script {
    uint256 internal constant CHAIN_ID = 57_073;
    address internal constant WETH = 0x4200000000000000000000000000000000000006;
    address internal constant SLIPSTREAM_FACTORY = 0x718E46d0962A66942E233760a8bd6038Ce54EdCD;
    address internal constant POSITION_MANAGER = 0xefD0f78F93f578036AE34D52A813a4BE7D8D2D52;
    address internal constant IMPLEMENTATION = 0x83D7306e1d6B07a10AE070CD16e8F6320EFaDD98;

    bytes32 internal constant WETH_CODEHASH = 0xd0f1614c5dacfbd34f1c6f500f397009e4c9a8bfd4e02db353edb2253d9a8012;
    bytes32 internal constant FACTORY_CODEHASH = 0x47300e75187cc255355659bf86873d6adfbfe60ad2000e0f6e1274e02917b701;
    bytes32 internal constant POSITION_MANAGER_CODEHASH =
        0x068cdd1c2f2c7c4f78730b56ffe01cace7ef93ca815698cd85c3855ea6b10380;
    bytes32 internal constant IMPLEMENTATION_CODEHASH =
        0x77499acdd5512646139cd69d341ce6bc0296ea5d0cd1da36fa6f1230b853a575;

    uint24 internal constant FEE_TIER = 3_000;
    int24 internal constant TICK_SPACING = 200;
    uint256 internal constant START_FDV_WAD = 1e18;
    uint256 internal constant TOP_FDV_WAD = 16e18;
    uint256 internal constant LAUNCH_FEE = 0.0004 ether;
    uint256 internal constant MAX_WALLET_BPS = 200;
    uint64 internal constant MAX_WALLET_WINDOW = 10 minutes;
    uint256 internal constant GRADUATION_THRESHOLD = 0.1 ether;

    function run() external {
        require(block.chainid == CHAIN_ID, "WRONG_CHAIN");
        require(WETH.codehash == WETH_CODEHASH, "WETH_CODEHASH");
        require(SLIPSTREAM_FACTORY.codehash == FACTORY_CODEHASH, "FACTORY_CODEHASH");
        require(POSITION_MANAGER.codehash == POSITION_MANAGER_CODEHASH, "POSITION_MANAGER_CODEHASH");
        require(IMPLEMENTATION.codehash == IMPLEMENTATION_CODEHASH, "IMPLEMENTATION_CODEHASH");
        require(HydeERC20(IMPLEMENTATION).TOTAL_SUPPLY() == 1_000_000_000e18, "IMPLEMENTATION_SUPPLY");
        require(IERC20MetadataInkV3Deploy(WETH).decimals() == 18, "WETH_DECIMALS");
        require(keccak256(bytes(IERC20MetadataInkV3Deploy(WETH).symbol())) == keccak256("WETH"), "WETH_SYMBOL");
        require(ISlipstreamFactory(SLIPSTREAM_FACTORY).tickSpacingToFee(TICK_SPACING) == FEE_TIER, "FEE_MAPPING");
        require(IInkPositionManagerV3Deploy(POSITION_MANAGER).factory() == SLIPSTREAM_FACTORY, "NPM_FACTORY");
        require(IInkPositionManagerV3Deploy(POSITION_MANAGER).WETH9() == WETH, "NPM_WETH");

        address expectedDeployer = vm.envAddress("EXPECTED_DEPLOYER");
        address deployer = vm.envOr("SENDER", expectedDeployer);
        address hydeTreasury = vm.envAddress("HYDE_TREASURY");
        address launchTreasury = vm.envAddress("LAUNCH_TREASURY");
        require(deployer == expectedDeployer, "SENDER_NOT_DEPLOYER");
        require(hydeTreasury != address(0) && launchTreasury != address(0), "TREASURY_ZERO");
        require(deployer.balance >= 0.0001 ether, "INSUFFICIENT_GAS");

        uint256 nonce = vm.getNonce(deployer);
        address expectedPad = vm.computeCreateAddress(deployer, nonce);
        address expectedLocker = _child(expectedPad, 1);
        require(expectedPad.code.length == 0 && expectedLocker.code.length == 0, "PRE_EXISTING_CODE");

        vm.startBroadcast(deployer);
        HydeV3Pad pad = new HydeV3Pad(
            HydeV3Pad.Config({
                impl: IMPLEMENTATION,
                v3Factory: SLIPSTREAM_FACTORY,
                positionManager: POSITION_MANAGER,
                hydeTreasury: hydeTreasury,
                numeraire: WETH,
                numeraireDecimals: 18,
                feeTier: FEE_TIER,
                slipstream: true,
                tickSpacing: TICK_SPACING,
                startFdvWad: START_FDV_WAD,
                topFdvWad: TOP_FDV_WAD,
                launchFeeAsset: address(0),
                launchFeeAmount: LAUNCH_FEE,
                launchFeeNative: true,
                launchFeeTreasury: launchTreasury,
                maxWalletBps: MAX_WALLET_BPS,
                maxWalletWindowSecs: MAX_WALLET_WINDOW,
                graduationThreshold: GRADUATION_THRESHOLD
            })
        );
        vm.stopBroadcast();

        HydeV3FeeLocker locker = pad.LOCKER();
        require(address(pad) == expectedPad, "PAD_DRIFT");
        require(address(locker) == expectedLocker, "LOCKER_DRIFT");
        require(pad.IMPL() == IMPLEMENTATION, "PAD_IMPL");
        require(address(pad.LOCKER()) == address(locker), "PAD_LOCKER");
        require(address(pad.V3_FACTORY()) == SLIPSTREAM_FACTORY, "PAD_FACTORY");
        require(address(pad.POSITION_MANAGER()) == POSITION_MANAGER, "PAD_NPM");
        require(pad.NUMERAIRE() == WETH, "PAD_NUMERAIRE");
        require(pad.FEE_TIER() == FEE_TIER, "PAD_FEE");
        require(pad.POSITION_KEY() == uint24(uint256(int256(TICK_SPACING))), "PAD_POSITION_KEY");
        require(pad.TICK_SPACING() == TICK_SPACING && pad.SLIPSTREAM(), "PAD_SLIPSTREAM");
        require(pad.LAUNCH_FEE_NATIVE() && pad.LAUNCH_FEE_AMOUNT() == LAUNCH_FEE, "PAD_LAUNCH_FEE");
        require(pad.LAUNCH_FEE_TREASURY() == launchTreasury, "PAD_LAUNCH_TREASURY");
        require(locker.FACTORY() == address(pad), "LOCKER_FACTORY");
        require(address(locker.POSITION_MANAGER()) == POSITION_MANAGER, "LOCKER_NPM");
        require(locker.HYDE_TREASURY() == hydeTreasury, "LOCKER_TREASURY");
        require(locker.HYDE_BPS() == 500, "LOCKER_SPLIT");

        console2.log("== Hyde standalone V3 / Ink 57073 ==");
        console2.log("Implementation", IMPLEMENTATION);
        console2.log("Pad           ", address(pad));
        console2.log("Locker        ", address(locker));
        console2.log("Actual opening/top FDV raw:");
        console2.log(pad.ACTUAL_START_FDV_RAW(), pad.ACTUAL_TOP_FDV_RAW());
        console2.log("Runtime codehashes (pad / locker):");
        console2.logBytes32(address(pad).codehash);
        console2.logBytes32(address(locker).codehash);
    }

    function _child(address deployer, uint8 nonce) private pure returns (address) {
        return
            address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xd6), bytes1(0x94), deployer, bytes1(nonce))))));
    }
}
