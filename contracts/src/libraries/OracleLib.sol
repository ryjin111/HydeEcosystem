// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TickMath} from "./TickMath.sol";

/// @title OracleLib — arithmetic-mean-tick → quote helper (Uniswap OracleLibrary, 0.8 port)
/// @notice Backs the `settle` TWAP floor: `getQuoteAtTick` converts the hook-derived TWAP tick to a
///         WETH quote using OZ's audited full-precision `Math.mulDiv` in place of Uniswap `FullMath`.
///         NOTE (FINDING-4): the V4 TWAP itself is `HydeHook.consult`; the former V3-pool
///         `consult`/`getOldestObservationSecondsAgo` helpers (which referenced `IUniswapV3Pool` in a
///         V4-only system and were never called) were removed as dead code / latent footgun.
library OracleLib {
    /// @notice Amount of `quoteToken` equal in value to `baseAmount` of `baseToken` at `tick`.
    ///         Verbatim Uniswap `OracleLibrary.getQuoteAtTick`, `FullMath.mulDiv` → OZ `Math.mulDiv`.
    function getQuoteAtTick(int24 tick, uint256 baseAmount, address baseToken, address quoteToken)
        internal
        pure
        returns (uint256 quoteAmount)
    {
        uint160 sqrtRatioX96 = TickMath.getSqrtRatioAtTick(tick);

        if (sqrtRatioX96 <= type(uint128).max) {
            uint256 ratioX192 = uint256(sqrtRatioX96) * sqrtRatioX96;
            quoteAmount = baseToken < quoteToken
                ? Math.mulDiv(ratioX192, baseAmount, 1 << 192)
                : Math.mulDiv(1 << 192, baseAmount, ratioX192);
        } else {
            uint256 ratioX128 = Math.mulDiv(sqrtRatioX96, sqrtRatioX96, 1 << 64);
            quoteAmount = baseToken < quoteToken
                ? Math.mulDiv(ratioX128, baseAmount, 1 << 128)
                : Math.mulDiv(1 << 128, baseAmount, ratioX128);
        }
    }
}
