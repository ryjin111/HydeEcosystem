// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {HydeStackSetup} from "./support/HydeStackSetup.sol";

/// @notice FINDING-8 launch address-drift regression. The clone salt binds `msg.sender`, so cross-launcher
///         collision was never possible — but the nonce was a single GLOBAL counter, so ANY concurrent
///         launch between a user's `predictNext` preview and their `launch` incremented the shared entropy
///         and drifted them onto a DIFFERENT token address than the one the UI had them confirm. The fix
///         makes the nonce PER-LAUNCHER (`mapping(address=>uint256)`), so an unrelated sender can no longer
///         perturb a user's prediction. No fund theft either way — this restores the confirmation invariant.
contract NonceDriftTest is HydeStackSetup {
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    /// @notice The core drift case: Alice previews → Bob launches in between → Alice's actual token MUST
    ///         still equal her confirmed preview. FAILS on the global-nonce code (Bob's launch shifts the
    ///         shared counter); passes with the per-launcher nonce.
    function test_predictNext_unperturbed_by_other_launcher() public {
        address predicted = factory.predictNext(alice, "ALICE");

        // Bob launches (different launcher) between Alice's preview and her execution.
        _launch(bob, "BobToken", "BOB");

        (address aliceToken,) = _launch(alice, "AliceToken", "ALICE");
        assertEq(aliceToken, predicted, "Alice's launch address is unperturbed by Bob's concurrent launch");
    }

    /// @notice Baseline: a launcher's `predictNext(symbol)` equals the address her own immediate `launch`
    ///         of that symbol produces (the per-launcher nonce is folded with the symbol into the salt).
    function test_predictNext_matches_launcher_own_execution() public {
        address predicted = factory.predictNext(alice, "AONE");
        (address t,) = _launch(alice, "AliceOne", "AONE");
        assertEq(t, predicted, "predictNext(alice) equals Alice's own next launch address");
    }

    /// @notice Same launcher + same symbol launched twice → distinct tokens (the per-launcher nonce still
    ///         advances, so no self-collision / redeploy-to-same-address).
    function test_same_launcher_same_symbol_distinct_tokens() public {
        (address t1,) = _launch(alice, "Dup", "DUP");
        (address t2,) = _launch(alice, "Dup", "DUP");
        assertTrue(t1 != t2, "same launcher+symbol twice yields distinct tokens (nonce advances)");
    }

    /// @notice Different launchers, same symbol, same (fresh) per-launcher nonce → distinct predictions:
    ///         the salt binds `msg.sender`, so two users can never be routed to the same clone address.
    function test_cross_launcher_same_symbol_no_collision() public {
        address pa = factory.predictNext(alice, "SAME");
        address pb = factory.predictNext(bob, "SAME");
        assertTrue(pa != pb, "distinct launchers with the same symbol predict distinct addresses");
    }
}
