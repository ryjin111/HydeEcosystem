// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";

import {HydeERC20} from "../../src/v3/HydeERC20.sol";
import {HydeV3Pad} from "../../src/v3/HydeV3Pad.sol";
import {HydeV3FeeLocker} from "../../src/v3/HydeV3FeeLocker.sol";
import {ISlipstreamFactory, IV3PositionManagerMint} from "../../src/v3/interfaces/IUniswapV3Minimal.sol";

contract HydeV3InkForkTest is Test {
    address internal constant WETH = 0x4200000000000000000000000000000000000006;
    address internal constant SLIPSTREAM_FACTORY = 0x718E46d0962A66942E233760a8bd6038Ce54EdCD;
    address internal constant POSITION_MANAGER = 0xefD0f78F93f578036AE34D52A813a4BE7D8D2D52;
    address internal constant TREASURY = 0x3132c30135BC13BFbFa75523Ec96A746E5B7Ddb3;
    address internal constant CREATOR = address(0xC0FFEE);
    uint24 internal constant FEE_TIER = 3_000;
    int24 internal constant TICK_SPACING = 200;

    function setUp() public {
        vm.createSelectFork(vm.envOr("V3_INK_FORK_RPC", string("https://rpc-gel.inkonchain.com")));
    }

    function testFork_inkStableStyleV3LaunchAgainstLiveSlipstream() public {
        assertEq(block.chainid, 57_073);
        assertEq(ISlipstreamFactory(SLIPSTREAM_FACTORY).tickSpacingToFee(TICK_SPACING), FEE_TIER);

        HydeERC20 impl = new HydeERC20();
        HydeV3Pad pad = new HydeV3Pad(
            HydeV3Pad.Config({
                impl: address(impl),
                v3Factory: SLIPSTREAM_FACTORY,
                positionManager: POSITION_MANAGER,
                hydeTreasury: TREASURY,
                numeraire: WETH,
                numeraireDecimals: 18,
                feeTier: FEE_TIER,
                slipstream: true,
                tickSpacing: TICK_SPACING,
                startFdvWad: 1e18,
                topFdvWad: 16e18,
                launchFeeAsset: address(0),
                launchFeeAmount: 0.0004 ether,
                launchFeeNative: true,
                launchFeeTreasury: TREASURY,
                maxWalletBps: 200,
                maxWalletWindowSecs: 600,
                graduationThreshold: 0.1 ether
            })
        );

        uint256 treasuryBefore = TREASURY.balance;
        vm.deal(CREATOR, 1 ether);
        vm.prank(CREATOR);
        (address token, uint256 tokenId) =
            pad.launch{value: 0.0004 ether}("Hyde Ink Fork", "HINK", bytes32("INK_STABLE_STYLE"));

        HydeV3FeeLocker locker = pad.LOCKER();
        address pool = ISlipstreamFactory(SLIPSTREAM_FACTORY).getPool(token, WETH, TICK_SPACING);
        assertTrue(pool != address(0));
        assertEq(IV3PositionManagerMint(POSITION_MANAGER).ownerOf(tokenId), address(locker));
        assertEq(HydeERC20(token).totalSupply(), 1_000_000_000e18);
        assertEq(TREASURY.balance - treasuryBefore, 0.0004 ether);
        assertEq(pad.FEE_TIER(), FEE_TIER);
        assertEq(pad.POSITION_KEY(), uint24(uint256(int256(TICK_SPACING))));
        assertEq(pad.TICK_SPACING(), TICK_SPACING);
        assertTrue(pad.SLIPSTREAM());

        (,, address token0, address token1, uint24 positionKey,,,,,,,) =
            IV3PositionManagerMint(POSITION_MANAGER).positions(tokenId);
        assertEq(token0, token < WETH ? token : WETH);
        assertEq(token1, token < WETH ? WETH : token);
        assertEq(positionKey, uint24(uint256(int256(TICK_SPACING))));
    }
}
