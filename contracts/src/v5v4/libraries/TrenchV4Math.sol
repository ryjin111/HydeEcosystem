// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

library TrenchV4Math {
    function amountsForLiquidity(uint160 sqrtPriceX96, int24 tickLower, int24 tickUpper, uint128 liquidity)
        internal
        pure
        returns (uint256 amount0, uint256 amount1)
    {
        uint160 sqrtA = TickMath.getSqrtPriceAtTick(tickLower);
        uint160 sqrtB = TickMath.getSqrtPriceAtTick(tickUpper);
        if (sqrtPriceX96 <= sqrtA) {
            amount0 = SqrtPriceMath.getAmount0Delta(sqrtA, sqrtB, liquidity, false);
        } else if (sqrtPriceX96 < sqrtB) {
            amount0 = SqrtPriceMath.getAmount0Delta(sqrtPriceX96, sqrtB, liquidity, false);
            amount1 = SqrtPriceMath.getAmount1Delta(sqrtA, sqrtPriceX96, liquidity, false);
        } else {
            amount1 = SqrtPriceMath.getAmount1Delta(sqrtA, sqrtB, liquidity, false);
        }
    }

    function minUsableTick(int24 spacing) internal pure returns (int24) {
        return TickMath.minUsableTick(spacing);
    }

    function maxUsableTick(int24 spacing) internal pure returns (int24) {
        return TickMath.maxUsableTick(spacing);
    }

    function floorToSpacing(int24 tick, int24 spacing) internal pure returns (int24) {
        int24 compressed = tick / spacing;
        if (tick < 0 && tick % spacing != 0) --compressed;
        return compressed * spacing;
    }

    function ceilToSpacing(int24 tick, int24 spacing) internal pure returns (int24) {
        int24 floored = floorToSpacing(tick, spacing);
        return floored == tick ? tick : floored + spacing;
    }
}
