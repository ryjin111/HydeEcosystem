// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {HydeV3Pad} from "../../src/v3/HydeV3Pad.sol";
import {MockV3Factory} from "./mocks/MockV3Factory.sol";

/// @notice AUDIT ITEM #1 — the decimals-parameterized FDV→tick derivation (the V3 twin of the $1.9T WETH
///         preset bug). DRIFT-PROOF per gojo (24166): asserts against INDEPENDENT anchors, not the pad's
///         own `_sqrtPriceX96FromFdv`:
///           (A) 10^12 GAP — for the SAME numeraire-unit FDV, the 6-dec and 18-dec launch ticks must
///               differ by exactly `log_1.0001(10^12) ≈ 276,325` (the decimal scale trap, as a fixed tick
///               offset). Independent of any Hyde math — it's pure Uniswap tick arithmetic.
///           (B) KNOWN 4663 ANCHOR — the 18-dec $5k case must reproduce gojo's on-chain-verified WETH
///               preset seed: `1.0001^(−197700) = 2.5967e-9 WETH/token → ~$5k FDV`. External reference.
///         The pad's own `ACTUAL_START_FDV_RAW` round-trip is a consistency layer on top, not the proof.
contract DecimalsPresetTest is Test {
    // log_1.0001(10^12) = 12·ln(10)/ln(1.0001) = 27.63102 / 0.000099995 ≈ 276,325. Nearest tickSpacing-200
    // multiples: 276,200 / 276,400. Independent of Hyde code (pure tick math).
    int24 internal constant DECIMAL_GAP_TICKS = 276325;
    // gojo's on-chain-verified 4663 WETH preset seed tick (2.5967e-9 WETH/token, $5k @ WETH$1918).
    int24 internal constant ANCHOR_4663_TICK = -197700;
    int24 internal constant SPACING = 200;
    uint24 internal constant FEE = 10000;

    address internal constant DUMMY_PM = address(0xB0B);
    address internal constant DUMMY_TREASURY = address(0x7); // hyde treasury / launch-fee treasury
    address internal constant DUMMY_NUMERAIRE = address(0x9);
    address internal constant DUMMY_IMPL = address(0x11);
    address internal constant DUMMY_FEE_ASSET = address(0x12);

    // FDV is DECIMALS-INDEPENDENT (× 1e18); the contract scales it by NUMERAIRE_DECIMALS on-chain — so both
    // the 6-dec and 18-dec pads below take the SAME `5000e18` for "5000 numeraire-unit FDV" (gojo hardening).
    function _deployPad(uint8 numeraireDecimals, uint256 startFdvWad, uint256 topFdvWad)
        internal
        returns (HydeV3Pad pad)
    {
        return _deployPadG(numeraireDecimals, startFdvWad, topFdvWad, 500 * 1e6);
    }

    function _deployPadG(uint8 numeraireDecimals, uint256 startFdvWad, uint256 topFdvWad, uint256 graduationThreshold)
        internal
        returns (HydeV3Pad pad)
    {
        MockV3Factory f = new MockV3Factory();
        f.setTickSpacing(FEE, SPACING);
        pad = new HydeV3Pad(
            HydeV3Pad.Config({
                impl: DUMMY_IMPL,
                v3Factory: address(f),
                positionManager: DUMMY_PM,
                hydeTreasury: DUMMY_TREASURY,
                numeraire: DUMMY_NUMERAIRE,
                numeraireDecimals: numeraireDecimals,
                feeTier: FEE,
                startFdvWad: startFdvWad,
                topFdvWad: topFdvWad,
                launchFeeAsset: DUMMY_FEE_ASSET,
                launchFeeAmount: 1_000000,
                launchFeeNative: false,
                launchFeeTreasury: DUMMY_TREASURY,
                maxWalletBps: 200,
                maxWalletWindowSecs: 600,
                graduationThreshold: graduationThreshold
            })
        );
    }

    /// gojo 24238 note 1: a 0 graduationThreshold would auto-graduate every token → rejected at deploy (fail-closed).
    /// NB: build the factory BEFORE `expectRevert` so it wraps only the reverting `new HydeV3Pad`.
    function test_zeroGraduationThreshold_reverts() public {
        MockV3Factory f = new MockV3Factory();
        f.setTickSpacing(FEE, SPACING);
        HydeV3Pad.Config memory c = HydeV3Pad.Config({
            impl: DUMMY_IMPL,
            v3Factory: address(f),
            positionManager: DUMMY_PM,
            hydeTreasury: DUMMY_TREASURY,
            numeraire: DUMMY_NUMERAIRE,
            numeraireDecimals: 6,
            feeTier: FEE,
            startFdvWad: 5000 * 1e18,
            topFdvWad: 50000 * 1e18,
            launchFeeAsset: DUMMY_FEE_ASSET,
            launchFeeAmount: 1_000000,
            launchFeeNative: false,
            launchFeeTreasury: DUMMY_TREASURY,
            maxWalletBps: 200,
            maxWalletWindowSecs: 600,
            graduationThreshold: 0
        });
        vm.expectRevert(HydeV3Pad.InvalidConfig.selector);
        new HydeV3Pad(c);
    }

    function _abs(int24 x) internal pure returns (int256) {
        return x < 0 ? int256(-int256(x)) : int256(x);
    }

    /// (A) The 10^12 decimal gap → a fixed tick offset (independent of Hyde math).
    function test_decimalGap_6dec_vs_18dec() public {
        // SAME numeraire-unit FDV (5000 units) at 6-dec vs 18-dec. FDV wad is decimals-INDEPENDENT
        // (units × 1e18) — the pad scales it by NUMERAIRE_DECIMALS on-chain, so both pads take 5000e18.
        HydeV3Pad p6 = _deployPad(6, 5000 * 1e18, 50000 * 1e18);
        HydeV3Pad p18 = _deployPad(18, 5000 * 1e18, 50000 * 1e18);

        int24 t6 = p6.TICK_FLOOR();
        int24 t18 = p18.TICK_FLOOR();
        console2.log("TICK_FLOOR 6-dec :", int256(t6));
        console2.log("TICK_FLOOR 18-dec:", int256(t18));

        // 18-dec price is 10^12 HIGHER (raw) → its tick is 10^12-in-ticks ABOVE the 6-dec tick.
        int256 gap = int256(t18) - int256(t6);
        console2.log("gap (t18 - t6)   :", gap);
        int256 diff = gap - int256(DECIMAL_GAP_TICKS);
        assertLe(diff < 0 ? -diff : diff, int256(SPACING), "decimal gap != log_1.0001(10^12) within a spacing");
    }

    /// (B) Reproduce gojo's on-chain-verified 4663 anchor for the 18-dec $5k case.
    function test_anchor_4663_18dec_5k() public {
        // $5k at WETH$1918 = 2.5967 WETH → 2.5967e18 raw (18-dec numeraire).
        HydeV3Pad p = _deployPad(18, 2596700000000000000, 25967000000000000000);
        int24 t = p.TICK_FLOOR();
        console2.log("TICK_FLOOR 18-dec $5k anchor:", int256(t));
        int256 d = int256(t) - int256(ANCHOR_4663_TICK);
        assertLe(d < 0 ? -d : d, int256(SPACING), "18-dec $5k tick did not reproduce the 4663 anchor -197700");
    }

    /// Consistency: the pad's own realized FDV round-trips to within one spacing (~2%) of target — for
    /// BOTH decimals. (Not the drift-proof anchor; that's (A)/(B). This catches a self-inconsistency.)
    function test_roundTrip_realizedFdv_bothDecimals() public {
        HydeV3Pad p6 = _deployPad(6, 5000 * 1e18, 50000 * 1e18);
        HydeV3Pad p18 = _deployPad(18, 2596700000000000000, 25967000000000000000);

        _assertWithin2pct(p6.ACTUAL_START_FDV_RAW(), 5000 * 1e6, "6-dec realized FDV off target");
        _assertWithin2pct(p18.ACTUAL_START_FDV_RAW(), 2596700000000000000, "18-dec realized FDV off target");
    }

    function _assertWithin2pct(uint256 got, uint256 want, string memory reason) internal pure {
        uint256 diff = got > want ? got - want : want - got;
        // one tickSpacing of price ≈ 1.0001^200 - 1 ≈ 2.02%; allow 3% headroom for alignment rounding.
        assertLe(diff * 100, want * 3, reason);
    }
}
