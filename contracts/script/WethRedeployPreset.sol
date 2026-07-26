// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {HydeTokenFactory} from "../src/HydeTokenFactory.sol";

/// @notice SINGLE SOURCE OF TRUTH for the WETH-stack redeploy preset (kami 24054: the deploy AND the
///         regression MUST consume the same definition — never duplicated ticks that can silently drift).
///         Consumed by DeployWethStack4663 (its `_presets()` + on-chain manifest asserts) and by
///         test/WethPresetRegression.t.sol (the deterministic local regression). WETH-stack ONLY — this does
///         NOT touch the shared HydeDeployConfig C0_*/C1_* that seed the HOODIE engine.
///
///   Economics — ~$5k starting FDV for HOODIE-parity (gojo 24039 / kami 24040; clint 24036 picked $5k to match
///   HOODIE's ~$4k). Range width 90000 ticks; seed TARGET 2.6069e-9 WETH/token; the tick-implied REALIZED seed
///   at tickLower0=-197700 (after tickSpacing-60 rounding) is 2.5967334014e-9 WETH/token = ~$0.000005/token,
///   FDV ~$4,980.53 @ WETH=$1,918 (USD drifts with WETH — kami 24028, expected). Both legs mirror-consistent.
///
///   Incident RCA (kami 24031): the OLD ±60000 preset SEEDS ~0.00248 WETH/token (≈ $4.76B FDV at the WETH
///   price); its misaligned WIDE range let early swaps walk price to the ~1 WETH/token wall (~$1.9T). The seed
///   itself was NOT ~1 WETH/token.
///
///   On-chain `_buildLeg` requires hold: c0 initialTick(-197760) < tickLower(-197700); c1 tickUpper(197700) <=
///   initialTick(197760); all ticks % tickSpacing(60) == 0. gojo's validator ACCEPTED.
library WethRedeployPreset {
    int24 internal constant C0_INIT = -197_760;
    int24 internal constant C0_LOWER = -197_700;
    int24 internal constant C0_UPPER = -107_700;
    int24 internal constant C1_INIT = 197_760;
    int24 internal constant C1_LOWER = 107_700;
    int24 internal constant C1_UPPER = 197_700;
    // Exact per-leg liquidity the preset derives — captured from the built preset (kami 24040 ≈ 5.1530737e22).
    // The economic anchor: any tick drift changes this, so consumers pinning it catch drift.
    uint128 internal constant EXPECTED_LIQUIDITY = 51_530_737_021_716_978_227_746;

    function preset() internal pure returns (HydeTokenFactory.PresetInput memory) {
        return HydeTokenFactory.PresetInput({
            initialTick0: C0_INIT, tickLower0: C0_LOWER, tickUpper0: C0_UPPER,
            initialTick1: C1_INIT, tickLower1: C1_LOWER, tickUpper1: C1_UPPER
        });
    }
}
