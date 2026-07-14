// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TickMath} from "./TickMath.sol";
import {IUniswapV3Pool} from "../interfaces/IUniswapV3Pool.sol";

/// @title OracleLib — TWAP readiness + arithmetic-mean-tick quote (Uniswap OracleLibrary, 0.8 port)
/// @notice Backs the `settle` TWAP floor + `ORACLE_NOT_READY` gate (CONTRACT_SPEC_L3.md §4b, INV-18).
///         `consult` and `getQuoteAtTick` mirror Uniswap/v3-periphery `OracleLibrary`, using OZ's
///         audited full-precision `Math.mulDiv` in place of Uniswap `FullMath`.
library OracleLib {
    /// @notice Seconds since the OLDEST recorded observation. A fresh pool (cardinality thin, ring
    ///         not filled) returns a small value → `settle` reverts `ORACLE_NOT_READY` until a full
    ///         `TWAP_WINDOW` has accrued (cardinality is allocated-not-backfilled at seed).
    function getOldestObservationSecondsAgo(address pool) internal view returns (uint32 secondsAgo) {
        (,, uint16 observationIndex, uint16 observationCardinality,,,) = IUniswapV3Pool(pool).slot0();
        require(observationCardinality > 0, "NO_OBS");

        (uint32 observationTimestamp,,, bool initialized) =
            IUniswapV3Pool(pool).observations((observationIndex + 1) % observationCardinality);

        // The next index after the current one is the oldest observation IFF the ring has wrapped
        // (initialized). If it has not yet wrapped, index 0 is the oldest.
        if (!initialized) {
            (observationTimestamp,,,) = IUniswapV3Pool(pool).observations(0);
        }

        unchecked {
            secondsAgo = uint32(block.timestamp) - observationTimestamp;
        }
    }

    /// @notice Time-weighted average tick over the trailing `secondsAgo` window (must be > 0).
    ///         Reverts inside `pool.observe` ("OLD") if the pool lacks that much history — a second
    ///         line of defence behind the explicit readiness gate above.
    function consult(address pool, uint32 secondsAgo) internal view returns (int24 arithmeticMeanTick) {
        require(secondsAgo != 0, "BP");

        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = secondsAgo;
        secondsAgos[1] = 0;

        (int56[] memory tickCumulatives,) = IUniswapV3Pool(pool).observe(secondsAgos);
        int56 tickCumulativesDelta = tickCumulatives[1] - tickCumulatives[0];

        arithmeticMeanTick = int24(tickCumulativesDelta / int56(uint56(secondsAgo)));
        // Always round to negative infinity (matches Uniswap OracleLibrary).
        if (tickCumulativesDelta < 0 && (tickCumulativesDelta % int56(uint56(secondsAgo)) != 0)) {
            arithmeticMeanTick--;
        }
    }

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
