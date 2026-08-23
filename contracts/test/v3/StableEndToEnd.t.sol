// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, console2} from "forge-std/Test.sol";

import {HydeERC20} from "../../src/v3/HydeERC20.sol";
import {HydeV3FeeLocker} from "../../src/v3/HydeV3FeeLocker.sol";
import {HydeV3Pad} from "../../src/v3/HydeV3Pad.sol";
import {IUniswapV3Factory} from "../../src/v3/interfaces/IUniswapV3Minimal.sol";

interface IERC20SwapMinimal {
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IStableSwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

/// @notice Stable-mainnet fork release gate for the complete V3 economic path:
///         deploy -> launch -> buy -> sell -> permissionless collect -> exact 95/5 split.
contract StableEndToEndTest is Test {
    address internal constant USDT0 = 0x779Ded0c9e1022225f8E0630b35a9b54bE713736;
    address internal constant V3_FACTORY = 0x88F0a512eF09175D456bc9547f914f48C013E4aA;
    address internal constant POSITION_MANAGER = 0x3BdC3437405f7D801b6036532713fc1F179136a6;
    address internal constant SWAP_ROUTER_02 = 0x32eaf9B5d5F2CD7361c5012890C943D7de84C22a;

    uint24 internal constant FEE_TIER = 10_000;
    uint256 internal constant BUY_AMOUNT = 10e6;

    address internal constant CREATOR = address(0xC0FFEE);
    address internal constant TRADER = address(0xB0B);
    address internal constant HYDE_TREASURY = address(0x7EA);
    address internal constant LAUNCH_TREASURY = address(0x1A0C);
    address internal constant CRANKER = address(0xC011EC7);

    HydeV3Pad internal pad;
    HydeV3FeeLocker internal locker;

    function setUp() public {
        vm.createSelectFork("https://rpc.stable.xyz");

        HydeERC20 impl = new HydeERC20();
        pad = new HydeV3Pad(
            HydeV3Pad.Config({
                impl: address(impl),
                v3Factory: V3_FACTORY,
                positionManager: POSITION_MANAGER,
                hydeTreasury: HYDE_TREASURY,
                numeraire: USDT0,
                numeraireDecimals: 6,
                feeTier: FEE_TIER,
                slipstream: false,
                tickSpacing: 0,
                startFdvWad: 5_000e18,
                topFdvWad: 50_000e18,
                launchFeeAsset: USDT0,
                launchFeeAmount: 1e6,
                launchFeeNative: false,
                launchFeeTreasury: LAUNCH_TREASURY,
                maxWalletBps: 200,
                maxWalletWindowSecs: 10 minutes,
                graduationThreshold: 500e6
            })
        );
        locker = pad.LOCKER();

        deal(USDT0, CREATOR, 1e6);
        deal(USDT0, TRADER, BUY_AMOUNT);

        vm.prank(CREATOR);
        IERC20SwapMinimal(USDT0).approve(address(pad), type(uint256).max);

        vm.prank(TRADER);
        IERC20SwapMinimal(USDT0).approve(SWAP_ROUTER_02, type(uint256).max);
    }

    function test_fork_launch_buy_sell_collects_exact_95_5() public {
        vm.prank(CREATOR);
        (address token,) = pad.launch("Hyde Stable Canary", "HYDEC", keccak256("stable-canary"));

        address pool = IUniswapV3Factory(V3_FACTORY).getPool(token, USDT0, FEE_TIER);
        assertTrue(pool != address(0), "pool missing");
        assertEq(IERC20SwapMinimal(USDT0).balanceOf(LAUNCH_TREASURY), 1e6, "launch fee mismatch");

        vm.prank(TRADER);
        uint256 tokensBought = IStableSwapRouter02(SWAP_ROUTER_02)
            .exactInputSingle(
                IStableSwapRouter02.ExactInputSingleParams({
                    tokenIn: USDT0,
                    tokenOut: token,
                    fee: FEE_TIER,
                    recipient: TRADER,
                    amountIn: BUY_AMOUNT,
                    amountOutMinimum: 0,
                    sqrtPriceLimitX96: 0
                })
            );
        assertGt(tokensBought, 0, "buy returned no token");
        assertEq(IERC20SwapMinimal(token).balanceOf(TRADER), tokensBought, "buy balance mismatch");
        assertLe(tokensBought, HydeERC20(token).maxWallet(), "anti-snipe cap exceeded");

        vm.prank(TRADER);
        IERC20SwapMinimal(token).approve(SWAP_ROUTER_02, type(uint256).max);

        vm.prank(TRADER);
        uint256 usdtReturned = IStableSwapRouter02(SWAP_ROUTER_02)
            .exactInputSingle(
                IStableSwapRouter02.ExactInputSingleParams({
                    tokenIn: token,
                    tokenOut: USDT0,
                    fee: FEE_TIER,
                    recipient: TRADER,
                    amountIn: tokensBought,
                    amountOutMinimum: 0,
                    sqrtPriceLimitX96: 0
                })
            );
        assertGt(usdtReturned, 0, "sell returned no USDT0");
        assertEq(IERC20SwapMinimal(token).balanceOf(TRADER), 0, "sell left token balance");

        (, address token0, address token1,,,,,, bool registered) = locker.positionOf(token);
        assertTrue(registered, "position not registered");

        uint256 creator0Before = IERC20SwapMinimal(token0).balanceOf(CREATOR);
        uint256 creator1Before = IERC20SwapMinimal(token1).balanceOf(CREATOR);
        uint256 hyde0Before = IERC20SwapMinimal(token0).balanceOf(HYDE_TREASURY);
        uint256 hyde1Before = IERC20SwapMinimal(token1).balanceOf(HYDE_TREASURY);

        vm.prank(CRANKER);
        (uint256 amount0, uint256 amount1) = locker.collect(token);
        assertGt(amount0, 0, "no token0 fees");
        assertGt(amount1, 0, "no token1 fees");

        _assertSplit(token0, amount0, creator0Before, hyde0Before);
        _assertSplit(token1, amount1, creator1Before, hyde1Before);

        (uint256 accrued, uint256 threshold, bool graduated) = locker.graduationProgress(token);
        uint256 numeraireFees = token0 == USDT0 ? amount0 : amount1;
        assertEq(accrued, numeraireFees, "numeraire accrual mismatch");
        assertEq(threshold, 500e6, "graduation threshold mismatch");
        assertFalse(graduated, "canary should not graduate");

        vm.prank(CRANKER);
        (uint256 empty0, uint256 empty1) = locker.collect(token);
        assertEq(empty0, 0, "second collect token0 not empty");
        assertEq(empty1, 0, "second collect token1 not empty");

        console2.log("launched token", token);
        console2.log("pool", pool);
        console2.log("tokens bought", tokensBought);
        console2.log("USDT0 returned", usdtReturned);
        console2.log("collected amount0", amount0);
        console2.log("collected amount1", amount1);
    }

    function _assertSplit(address asset, uint256 collected, uint256 creatorBefore, uint256 hydeBefore) internal view {
        uint256 expectedHyde = (collected * 500) / 10_000;
        uint256 expectedCreator = collected - expectedHyde;
        assertEq(
            IERC20SwapMinimal(asset).balanceOf(CREATOR) - creatorBefore,
            expectedCreator,
            "creator split is not 95% plus dust"
        );
        assertEq(IERC20SwapMinimal(asset).balanceOf(HYDE_TREASURY) - hydeBefore, expectedHyde, "Hyde split is not 5%");
        assertEq(expectedCreator + expectedHyde, collected, "split does not conserve fees");
    }
}
