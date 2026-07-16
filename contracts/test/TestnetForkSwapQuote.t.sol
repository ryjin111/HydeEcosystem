// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IMintable {
    function mint(address, uint256) external;
}

/// @notice Fork test that executes REAL exact-in swaps against the live HYDE1 own-stack pool on 46630 and
///         logs the actual token-out — the ground truth to compare kuro's off-chain quoteOwnStackExactIn against.
///   forge test --match-contract TestnetForkSwapQuote --fork-url https://rpc.testnet.chain.robinhood.com -vv
contract TestnetForkSwapQuote is Test {
    address constant PM = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant WETH = 0x7943e237c7F95DA44E0301572D358911207852Fa;
    address constant HYDE1 = 0xE2c7316e8115D1c682fb0a4b6b128A8821AffF33;
    address constant HOOK = 0xFF312EA049522790357Aa9072c03DCaa1319b0c0;

    function test_forkSwapOutputs() external {
        PoolSwapTest router = new PoolSwapTest(IPoolManager(PM));
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(WETH),
            currency1: Currency.wrap(HYDE1),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 60,
            hooks: IHooks(HOOK)
        });

        deal(WETH, address(this), 100 ether); // real testnet WETH proxy — mint is restricted, override balance
        IERC20(WETH).approve(address(router), type(uint256).max);

        uint256[3] memory amts = [uint256(1e15), 1e16, 1e17]; // 0.001, 0.01, 0.1 WETH

        for (uint256 i; i < amts.length; i++) {
            uint256 snap = vm.snapshotState();
            BalanceDelta d = router.swap(
                key,
                SwapParams({zeroForOne: true, amountSpecified: -int256(amts[i]), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1}),
                PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
                ""
            );
            console2.log("=== amountIn WETH ===", amts[i]);
            console2.log("WETH delta (spent, neg):");
            console2.logInt(int256(d.amount0()));
            console2.log("HYDE1 out (recv, pos):");
            console2.logInt(int256(d.amount1()));
            vm.revertToState(snap);
        }
    }
}
