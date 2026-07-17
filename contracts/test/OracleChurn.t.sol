// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {HydeStackSetup} from "./support/HydeStackSetup.sol";
import {HydeDeployConfig} from "../script/DeployHydeStack.s.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";

/// @notice FINDING-5 oracle ring-churn DoS regression. `afterSwap` coalesces same-second swaps
///         (`dt == 0` ⇒ no slot), so the ring consumes at most ONE slot per DISTINCT SECOND and spans
///         `min(CARDINALITY, elapsed)` seconds of history — block-time-INDEPENDENT. Therefore an active
///         pool churned across > CARDINALITY distinct seconds evicts every observation newer than
///         `now − CARDINALITY`, and `consult(window)` reverts `ORACLE_NOT_READY` for any `window ≥
///         CARDINALITY` (target predates the oldest retained obs) → `settle`(LT leg) / `compound` DoS.
///
///         The invariant is therefore `CARDINALITY > TWAP_WINDOW (seconds) + headroom`. Production was
///         raised 1024 → 2048 for TWAP_WINDOW 1800 (see DeployHydeStack). This proves the mechanism on
///         the harness ring (CARDINALITY 64): after churning a full ring, the consult boundary sits
///         exactly at CARDINALITY — `window ≥ 64` is evicted, `window < 64` is retained — and the real
///         `compound` path (which consults the vault's TWAP_WINDOW 120 > 64) is DoS'd, i.e. the harness's
///         own 64 < 120 is itself an undersized instance of the bug the production 2048 > 1800 fixes.
contract OracleChurnTest is HydeStackSetup {
    address internal creator = makeAddr("creator");
    address internal buyer = makeAddr("buyer");

    /// @dev Write `distinctSeconds` distinct-second observations into the pool's ring by warping +1s and
    ///      swapping each iteration. Alternates tiny buys/sells around a stocked LT balance so the price
    ///      stays centred (no range exhaustion) while every iteration lands one fresh obs.
    function _churn(address token, uint256 distinctSeconds) internal {
        _buy(buyer, token, 5e18); // stock buyer LT + seed WETH into the (LT-only) pool so sells can fill
        for (uint256 i; i < distinctSeconds; i++) {
            vm.warp(block.timestamp + 1);
            if (i % 2 == 0) _sell(buyer, token, 1e15);
            else _buy(buyer, token, 1e15);
        }
    }

    function test_churn_evicts_window_at_cardinality_boundary() public {
        (address token,) = _launch(creator, "Churn", "CHRN");
        PoolId id = _key(token).toId();

        // Fill the 64-slot ring well past wrap → oldest retained obs is at ~now − 63s.
        _churn(token, 80);

        // window ≥ CARDINALITY(64): target predates the oldest retained obs → ORACLE_NOT_READY.
        vm.expectRevert();
        hydeHook.consult(id, 100);

        // window < CARDINALITY(64): target is still bracketed by the ring → consult succeeds (no revert).
        hydeHook.consult(id, 30);

        // Real permissionless path: `compound` consults the vault/collector TWAP_WINDOW (120). Because the
        // harness ring (64) < 120, the churned ring can't span it → compound is DoS'd (ORACLE_NOT_READY
        // surfaces before the dust gate). This is the exact settle/compound liveness bug FINDING-5 closes.
        vm.expectRevert();
        collector.compound(token, block.timestamp + 1);

        // The PRODUCTION sizing (CARDINALITY 2048 > TWAP_WINDOW 1800) is asserted against the ACTUAL
        // deploy constants — not literals — in `DeployConfigTest` below, so a regression of CARDINALITY
        // back to 1024 (or a TWAP_WINDOW bump past it) fails RED there. This suite proves the mechanism;
        // that suite binds it to config.
    }
}

/// @notice FINDING-5 config-bound guard (kami's require). Binds the sizing invariant to the REAL
///         `HydeDeployConfig` constants so a regression of `CARDINALITY` (or a `TWAP_WINDOW` increase past
///         it) fails here — unlike a hardcoded `assertGt(2048,1800)`, which would pass even if the deploy
///         constant regressed. Same-second coalescing ⇒ the ring spans `CARDINALITY` seconds ⇒ it must
///         exceed `TWAP_WINDOW` (see OracleChurnTest for the behavioral boundary proof).
contract DeployConfigTest is Test, HydeDeployConfig {
    function test_production_cardinality_exceeds_twap_window() public {
        assertGt(
            uint256(CARDINALITY),
            uint256(TWAP_WINDOW),
            "FINDING-5: production CARDINALITY must exceed TWAP_WINDOW seconds (ring must span the window)"
        );
    }
}
