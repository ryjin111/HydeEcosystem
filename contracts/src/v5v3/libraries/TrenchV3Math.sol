// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TickMath} from "../../v3/libraries/TickMath.sol";

/// @notice Principal-only V3 position math used for curve progress.
/// @dev Fee growth and token donations are deliberately absent from every calculation.
library TrenchV3Math {
    uint256 internal constant Q96 = 1 << 96;

    function amountsForLiquidity(uint160 sqrtPriceX96, int24 tickLower, int24 tickUpper, uint128 liquidity)
        internal
        pure
        returns (uint256 amount0, uint256 amount1)
    {
        uint160 sqrtA = TickMath.getSqrtRatioAtTick(tickLower);
        uint160 sqrtB = TickMath.getSqrtRatioAtTick(tickUpper);

        if (sqrtPriceX96 <= sqrtA) {
            amount0 = amount0ForLiquidity(sqrtA, sqrtB, liquidity);
        } else if (sqrtPriceX96 < sqrtB) {
            amount0 = amount0ForLiquidity(sqrtPriceX96, sqrtB, liquidity);
            amount1 = amount1ForLiquidity(sqrtA, sqrtPriceX96, liquidity);
        } else {
            amount1 = amount1ForLiquidity(sqrtA, sqrtB, liquidity);
        }
    }

    function amount0ForLiquidity(uint160 sqrtA, uint160 sqrtB, uint128 liquidity) internal pure returns (uint256) {
        if (sqrtA > sqrtB) (sqrtA, sqrtB) = (sqrtB, sqrtA);
        return Math.mulDiv(uint256(liquidity) << 96, uint256(sqrtB) - sqrtA, sqrtB) / sqrtA;
    }

    function amount1ForLiquidity(uint160 sqrtA, uint160 sqrtB, uint128 liquidity) internal pure returns (uint256) {
        if (sqrtA > sqrtB) (sqrtA, sqrtB) = (sqrtB, sqrtA);
        return Math.mulDiv(liquidity, uint256(sqrtB) - sqrtA, Q96);
    }

    function liquidityForAmount0(uint160 sqrtA, uint160 sqrtB, uint256 amount0) internal pure returns (uint128) {
        if (sqrtA > sqrtB) (sqrtA, sqrtB) = (sqrtB, sqrtA);
        uint256 intermediate = Math.mulDiv(sqrtA, sqrtB, Q96);
        uint256 liquidity = Math.mulDiv(amount0, intermediate, uint256(sqrtB) - sqrtA);
        require(liquidity <= type(uint128).max, "LIQ_OVERFLOW");
        return uint128(liquidity);
    }

    function liquidityForAmount1(uint160 sqrtA, uint160 sqrtB, uint256 amount1) internal pure returns (uint128) {
        if (sqrtA > sqrtB) (sqrtA, sqrtB) = (sqrtB, sqrtA);
        uint256 liquidity = Math.mulDiv(amount1, Q96, uint256(sqrtB) - sqrtA);
        require(liquidity <= type(uint128).max, "LIQ_OVERFLOW");
        return uint128(liquidity);
    }

    function minUsableTick(int24 spacing) internal pure returns (int24) {
        return (TickMath.MIN_TICK / spacing) * spacing;
    }

    function maxUsableTick(int24 spacing) internal pure returns (int24) {
        return (TickMath.MAX_TICK / spacing) * spacing;
    }

    function floorToSpacing(int24 tick, int24 spacing) internal pure returns (int24 floorTick) {
        floorTick = (tick / spacing) * spacing;
        if (tick < 0 && tick % spacing != 0) floorTick -= spacing;
    }

    function ceilToSpacing(int24 tick, int24 spacing) internal pure returns (int24 ceilTick) {
        ceilTick = (tick / spacing) * spacing;
        if (tick > 0 && tick % spacing != 0) ceilTick += spacing;
    }
}
