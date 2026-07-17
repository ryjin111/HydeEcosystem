// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {HydeStackSetup} from "./support/HydeStackSetup.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice FINDING-6 / FINDING-7 partition-invariance regressions. Every permissionless split boundary
///         must pay out the SAME cumulative totals whether it is called ONCE or fragmented into many tiny
///         calls — otherwise a griefer (or just noisy keepers) can chunk the immutable 90/5/5 off its mark
///         by exploiting per-call floor rounding. These tests FAIL on the pre-carry code and pass after
///         the `mulmod` carry banks each sub-unit remainder.
///
///         F6: `HydeFeeVault.settle` WETH leg — settling 19 wei once vs 1 wei ×19 must both pay 18/1.
///         F7: `HydeFeeCollector.collect` in-kind carve — fragmented harvests must leave `pendingLiq`
///             equal to the exact closed-form floor of the CUMULATIVE harvested (== the single-collect /
///             "batched" result), independently for LT and WETH.
contract SplitInvarianceTest is HydeStackSetup {
    address internal creator = makeAddr("creator");
    address internal buyer = makeAddr("buyer");
    address internal keeper = makeAddr("keeper"); // settle/collect are permissionless — any caller

    /* ───────────────────────── F6: settle split (WETH leg) ─────────────────────────── */

    /// @dev Launch + accrue a healthy WETH raw-fee bucket in the vault (buys accrue WETH fees; `collect`
    ///      carves 5% and notes the 95% into `rawFees[token][WETH]`), so `settle(token, WETH, …)` has
    ///      material to reclassify. No oracle/swap on the WETH leg → deterministic, fork-independent.
    function _launchWithWethRaw(string memory s) internal returns (address token) {
        (token,) = _launch(creator, s, s);
        _buy(buyer, token, 5e18);
        vm.warp(block.timestamp + 30);
        _buy(buyer, token, 5e18);
        vm.warp(block.timestamp + 30);
        collector.collect(token);
        require(vault.rawFees(token, address(weth)) >= 100, "need >=100 wei WETH raw");
    }

    function test_settle_split_partition_invariant_WETHleg() public {
        address a = _launchWithWethRaw("SA");
        address b = _launchWithWethRaw("SB");

        // A — settle 19 wei in ONE call.
        vm.prank(keeper);
        vault.settle(a, address(weth), 19, 0, block.timestamp);

        // B — settle the SAME 19 wei as 19 × 1-wei calls (the fragmentation vector).
        for (uint256 i; i < 19; i++) {
            vm.prank(keeper);
            vault.settle(b, address(weth), 1, 0, block.timestamp);
        }

        // 90/5/5 on 19 wei is exactly 18 creator / 1 Hyde — and it must be chunk-invariant.
        // PRE-CARRY: B pays Hyde 0 / creator 19 (each 1-wei call floors hydeCut to 0) → these FAIL.
        assertEq(vault.hydeClaimable(a), 1, "A single: Hyde 1 of 19");
        assertEq(vault.creatorClaimable(a), 18, "A single: creator 18 of 19");
        assertEq(vault.hydeClaimable(b), 1, "B fragmented: Hyde still 1 (was 0 pre-carry)");
        assertEq(vault.creatorClaimable(b), 18, "B fragmented: creator still 18 (was 19 pre-carry)");
        assertEq(vault.hydeClaimable(a), vault.hydeClaimable(b), "Hyde payout is partition-invariant");
        assertEq(vault.creatorClaimable(a), vault.creatorClaimable(b), "creator payout is partition-invariant");

        // Solvency identity still holds per call: creator + Hyde == settled notional.
        assertEq(vault.hydeClaimable(b) + vault.creatorClaimable(b), 19, "creator + Hyde == 19 (conserved)");
    }

    /* ───────────────────────── F7: collect carve (LT + WETH) ───────────────────────── */

    function test_collect_carve_partition_invariant() public {
        (address t,) = _launch(creator, "Carve", "CRV");

        // Fragment the harvest: trade a segment, then `collect` — repeated. Each collect carves 5% of the
        // (arbitrary-low-order) harvested amount, so the sub-carve remainders accumulate across calls.
        for (uint256 seg; seg < 9; seg++) {
            _buy(buyer, t, 2e18 + seg * 137e15); // varied sizes → varied remainders (teeth)
            vm.warp(block.timestamp + 13);
            _sell(buyer, t, 4e17 + seg * 11e15); // LT-side fee leg
            vm.warp(block.timestamp + 13);
            collector.collect(t); // FRAGMENTED harvest
        }

        // The carry makes cumulative carve == floor(cumulative-harvested · liqBps / BPS_DENOM) EXACTLY,
        // which is precisely what a SINGLE "batched" collect of the same cumulative would produce. Since
        // (harvested == carve + noted) every call and we never settle here, `pending + noted` reconstructs
        // the cumulative harvested per asset — so this closed form IS the batched-vs-fragmented comparison,
        // immune to V4's own per-harvest fee-rounding (which would confound a two-token cadence diff).
        uint256 pendLT = collector.pendingLiqLT(t);
        uint256 pendWETH = collector.pendingLiqWETH(t);
        uint256 harvestedLT = pendLT + vault.rawFees(t, t);
        uint256 harvestedWETH = pendWETH + vault.rawFees(t, address(weth));

        // PRE-CARRY: fragmented pending < floor(cumulative·5%) (each call floored independently) → FAIL.
        assertEq(pendLT, harvestedLT * 500 / 10_000, "LT carve == floor(cumulative 5pct) after fragmentation");
        assertEq(pendWETH, harvestedWETH * 500 / 10_000, "WETH carve == floor(cumulative 5pct) after fragmentation");

        assertGt(pendLT, 0, "non-vacuous: LT actually carved");
        assertGt(pendWETH, 0, "non-vacuous: WETH actually carved");
    }
}
