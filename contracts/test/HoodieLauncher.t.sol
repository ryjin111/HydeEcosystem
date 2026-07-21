// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

import {HoodieStackSetup} from "./support/HoodieStackSetup.sol";
import {HoodieLauncher} from "../src/HoodieLauncher.sol";
import {HoodieLaunchEngine} from "../src/HoodieLaunchEngine.sol";
import {HydeTokenFactory} from "../src/HydeTokenFactory.sol";

/// @notice Bounty gate for the $HOODIE "launcher-launcher" (Option C shared-engine). Proves the five bounty
///         invariants, the 90%-fee-routing-critical HUMAN creator attribution (gojo 23389: a forwarding
///         wrapper would route 90% to the wrapper — this proves the engine records the human), launcher
///         registry auth, and the `(launcher, creator)`-domained clone-salt prediction + no-drift property.
///
///         The UNCHANGED WETH `HydeTokenFactory.launch()` path is regression-covered by the pre-existing
///         lifecycle/factory suites (they exercise the same `_launch` core via the public entrypoint); a
///         plain `forge test` green run over BOTH is the byte-identical-behavior proof kami gated.
contract HoodieLauncherTest is HoodieStackSetup {
    // Re-declared for `vm.expectEmit` topic matching.
    event PositionRegistered(address indexed token, address indexed creator, uint256 tokenId);
    event HoodieLaunchCreated(
        address indexed launcher, address indexed creator, address indexed token, PoolId poolId, uint256 tokenId
    );
    event LauncherRegistered(address indexed launcher);

    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    /* ─────────────────────── wiring / INV-1 (base is HOODIE, no setter) ─────── */

    function test_engineIsHoodieBased() public view {
        assertEq(engine.WETH(), HOODIE, "engine base != HOODIE");
        assertEq(metaFactory.HOODIE(), HOODIE, "meta HOODIE const drift");
        assertEq(metaFactory.ENGINE(), address(engine), "meta engine wiring");
        assertEq(engine.META_FACTORY(), address(metaFactory), "engine META_FACTORY wiring");
    }

    /* ─────────────────────── meta-factory mints + registers launchers ───────── */

    function test_metaFactoryMintsAndRegistersLauncher() public {
        vm.prank(alice);
        address launcher = metaFactory.createLauncher(bytes32("m"));

        assertTrue(engine.isLauncher(launcher), "launcher not registered in engine");
        assertEq(metaFactory.launcherOwner(launcher), alice, "launcher owner");
        assertEq(HoodieLauncher(launcher).engine(), address(engine), "launcher engine wiring");
        assertEq(metaFactory.launcherCount(), 1, "launcher count");
    }

    /* ─────────────────────── INV-2/3: every child is HOODIE-paired ──────────── */

    function test_launchProducesHoodiePairedPool() public {
        HoodieLauncher launcher = _newLauncher(alice);
        (address token, uint256 tokenId) = _hoodieLaunch(alice, launcher, "Shrimp", "SHRIMP");

        assertTrue(token != address(0), "no token");

        // A pool exists at the HOODIE-paired key (spot price set). Since the engine's `_poolKey` derives the
        // counter-currency SOLELY from its base (== HOODIE), a non-zero slot0 at THIS key is the INV-2/3
        // proof: the launch created a HOODIE-paired pool, no alternate pair is reachable.
        PoolKey memory key = _hoodieKey(token);
        (uint160 sqrtPriceX96,,,) = stateView.getSlot0(key.toId());
        assertTrue(sqrtPriceX96 != 0, "pool not initialized at HOODIE pair");

        // seeded position NFT sits in the collector's permanent custody (audited custody fact).
        assertEq(IERC721(address(lpm)).ownerOf(tokenId), address(collector), "position not custodied");
    }

    function test_multipleLaunchersAllHoodiePaired() public {
        HoodieLauncher la = _newLauncher(alice);
        HoodieLauncher lb = _newLauncher(bob);
        (address ta,) = _hoodieLaunch(alice, la, "A", "AAA");
        (address tb,) = _hoodieLaunch(bob, lb, "B", "BBB");

        (uint160 sa,,,) = stateView.getSlot0(_hoodieKey(ta).toId());
        (uint160 sb,,,) = stateView.getSlot0(_hoodieKey(tb).toId());
        assertTrue(sa != 0 && sb != 0, "both pools must be HOODIE-initialized");
        assertTrue(ta != tb, "distinct tokens");
    }

    /* ─────────────────────── 90%-routing-critical HUMAN attribution ─────────── */

    function test_creatorIsHumanNotClone() public {
        HoodieLauncher launcher = _newLauncher(alice);

        // The token address the next launch will deploy (current (launcher, creator) nonce).
        address predicted = engine.predictNextFor(address(launcher), alice, "SHRIMP");

        // Collector MUST record the HUMAN (alice), not the launcher clone — this is the fee-routing gate.
        vm.expectEmit(true, true, false, false, address(collector));
        emit PositionRegistered(predicted, alice, 0);
        // Engine's dual-identity event carries both the launcher and the human (poolId/tokenId unchecked).
        vm.expectEmit(true, true, true, false, address(engine));
        emit HoodieLaunchCreated(address(launcher), alice, predicted, PoolId.wrap(bytes32(0)), 0);

        (address token,) = _hoodieLaunch(alice, launcher, "Shrimp", "SHRIMP");
        assertEq(token, predicted, "predicted != deployed");
        // The matched `PositionRegistered(token, creator=alice)` above proves the collector recorded the
        // HUMAN (alice != the launcher clone) as creator ⇒ the 90% fee share routes to the human (gojo 23389).
    }

    /* ─────────────────────── registry / access-control gates ────────────────── */

    function test_launchForRejectsNonRegisteredCaller() public {
        vm.deal(alice, LAUNCH_FEE);
        vm.prank(alice); // alice is not a registered launcher clone
        vm.expectRevert(bytes("NOT_LAUNCHER"));
        engine.launchFor{value: LAUNCH_FEE}(
            HydeTokenFactory.LaunchParams({name: "X", symbol: "XXX", presetId: 0}), alice
        );
    }

    function test_registerLauncherOnlyMetaFactory() public {
        vm.prank(alice);
        vm.expectRevert(bytes("ONLY_META_FACTORY"));
        engine.registerLauncher(address(0xBEEF));
    }

    function test_launchForRejectsZeroCreator() public {
        // A registered launcher passing creator = 0 must revert (defense over the honest clone's msg.sender).
        address rogue = address(0xDEAD);
        vm.prank(address(metaFactory));
        engine.registerLauncher(rogue);

        vm.deal(rogue, LAUNCH_FEE);
        vm.prank(rogue);
        vm.expectRevert(bytes("ZERO_CREATOR"));
        engine.launchFor{value: LAUNCH_FEE}(
            HydeTokenFactory.LaunchParams({name: "X", symbol: "XXX", presetId: 0}), address(0)
        );
    }

    function test_launcherDoubleInitReverts() public {
        HoodieLauncher launcher = _newLauncher(alice);
        vm.expectRevert(bytes("INITIALIZED"));
        launcher.initialize(address(engine), bob);
    }

    /* ─────────────────────── prediction: equals-deployed + no-drift ─────────── */

    function test_predictNextForEqualsDeployed() public {
        HoodieLauncher launcher = _newLauncher(alice);
        address predicted = engine.predictNextFor(address(launcher), alice, "PRED");
        (address token,) = _hoodieLaunch(alice, launcher, "Pred", "PRED");
        assertEq(token, predicted, "prediction must equal deployed address");
    }

    /// @notice FINDING-8 analogue: an UNRELATED creator (or launcher) cannot drift a user's predicted address.
    function test_predictNextForNoDriftAcrossCreatorsAndLaunchers() public {
        HoodieLauncher la = _newLauncher(alice);
        HoodieLauncher lb = _newLauncher(bob);

        // alice's predicted token on launcher `la`.
        address alicePredicted = engine.predictNextFor(address(la), alice, "SAME");

        // bob launches through his OWN launcher — different (launcher, creator) nonce key.
        _hoodieLaunch(bob, lb, "BobToken", "BOB");
        assertEq(engine.predictNextFor(address(la), alice, "SAME"), alicePredicted, "bob drifted alice (cross-launcher)");

        // bob ALSO launches through alice's launcher `la` — shared launcher, different creator key.
        // (HoodieLauncher.launch is open: any caller is that call's creator; here bob → (la, bob) nonce key.)
        _hoodieLaunch(bob, la, "BobOnAlice", "BOA");
        assertEq(
            engine.predictNextFor(address(la), alice, "SAME"), alicePredicted, "bob drifted alice (shared launcher)"
        );

        // alice now launches — lands EXACTLY on her long-standing prediction.
        (address aliceToken,) = _hoodieLaunch(alice, la, "AliceSame", "SAME");
        assertEq(aliceToken, alicePredicted, "alice's address drifted");
    }

    /* ─────────────────────── fee forwarding through the thin clone ──────────── */

    function test_launcherForwardsFeeToTreasury() public {
        HoodieLauncher launcher = _newLauncher(alice);
        uint256 before = LAUNCH_TREASURY.balance;
        _hoodieLaunch(alice, launcher, "Fee", "FEE");
        assertEq(LAUNCH_TREASURY.balance - before, LAUNCH_FEE, "flat fee must reach treasury");
    }

    /* ─────────────────── blocker-4: the 90% fee ROUTES to the human ──────────── */

    /// @notice kami 23405 #4 — not event-only. The vault RECORDS the human as creator, and a real
    ///         accrue→settle→claim actually PAYS that human the creator share. A forwarding wrapper (gojo 23389)
    ///         would have recorded the launcher clone here and routed the 90% away from the human.
    function test_creatorFeesRouteToHuman() public {
        HoodieLauncher launcher = _newLauncher(alice);
        (address token,) = _hoodieLaunch(alice, launcher, "Fee", "FEE");

        // (a) The vault's immutable creator IS the human — not the launcher clone.
        assertEq(vault.creator(token), alice, "vault creator must be the human");
        assertTrue(vault.creator(token) != address(launcher), "creator must not be the clone");

        // (b) Accrue real HOODIE (settlement-token) fees through the audited collector→vault path, settle the
        //     WETH leg (permissionless, pure reclassify → creator/Hyde split), then claim: alice is PAID.
        uint256 fee = 1_000e18;
        weth.mint(address(collector), fee); // solmate mock etched at HOODIE; mint writes its storage
        vm.prank(address(collector));
        weth.approve(address(vault), fee);
        vm.prank(address(collector));
        vault.noteRaw(token, address(weth), fee);
        vault.settle(token, address(weth), fee, 0, block.timestamp);

        uint256 owed = vault.creatorClaimable(token);
        assertGt(owed, 0, "creator share must have accrued");
        uint256 balBefore = weth.balanceOf(alice);
        vault.claimCreator(token); // permissionless; pays the recorded creator
        assertEq(weth.balanceOf(alice) - balBefore, owed, "human creator must receive the creator share");
    }

    /* ─────────────────── blocker-5: CREATE2 replay/collision + predict ───────── */

    /// @notice A reused (creator, userSalt) reverts on the deterministic clone create — the replay/collision gate.
    function test_duplicateUserSaltReverts() public {
        vm.prank(alice);
        metaFactory.createLauncher(bytes32("dup"));
        vm.prank(alice);
        vm.expectRevert(); // OZ Clones: FailedDeployment on the colliding CREATE2 address
        metaFactory.createLauncher(bytes32("dup"));
    }

    /// @notice The salt binds msg.sender, so two DIFFERENT creators may reuse the same userSalt with no collision.
    function test_sameUserSaltDistinctCreatorsOk() public {
        vm.prank(alice);
        address la = metaFactory.createLauncher(bytes32("same"));
        vm.prank(bob);
        address lb = metaFactory.createLauncher(bytes32("same"));
        assertTrue(la != lb, "creator-namespaced salts must not collide");
        assertTrue(engine.isLauncher(la) && engine.isLauncher(lb), "both registered");
    }

    /// @notice `predictLauncher` equals the address `createLauncher` deploys for the same (creator, userSalt).
    function test_predictLauncherEqualsDeployed() public {
        address predicted = metaFactory.predictLauncher(alice, bytes32("p"));
        vm.prank(alice);
        address launcher = metaFactory.createLauncher(bytes32("p"));
        assertEq(launcher, predicted, "predictLauncher must equal deployed");
    }

    /* ─────────────────── blocker-5: uninitialized-clone rejection ────────────── */

    /// @notice An uninitialized launcher (raw clone target, never wired by the meta-factory) refuses to launch.
    function test_uninitializedLauncherReverts() public {
        HoodieLauncher raw = new HoodieLauncher(); // never initialize()d
        vm.deal(alice, LAUNCH_FEE);
        vm.prank(alice);
        vm.expectRevert(bytes("NOT_INITIALIZED"));
        raw.launch{value: LAUNCH_FEE}("X", "XXX", 0);
    }

    /* ─────────────────── blocker-5: alternate-pair init rejection (INV-4) ────── */

    /// @notice Defense-in-depth: the ONLY way a pool exists on the Hyde hook is the engine registering it
    ///         (always HOODIE-paired). An attacker cannot stand up an ALTERNATE-pair pool on the hook directly —
    ///         `beforeInitialize` is factory-gated (sender != engine) with no pending record ⇒ revert.
    function test_alternatePairInitializationRejected() public {
        HoodieLauncher launcher = _newLauncher(alice);
        (address token,) = _hoodieLaunch(alice, launcher, "Alt", "ALT");

        address rogue = address(0xBEEF); // a NON-HOODIE numeraire
        (Currency c0, Currency c1) = token < rogue
            ? (Currency.wrap(token), Currency.wrap(rogue))
            : (Currency.wrap(rogue), Currency.wrap(token));
        PoolKey memory altKey = PoolKey({
            currency0: c0,
            currency1: c1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(hydeHook))
        });

        vm.prank(address(0xA77AC)); // any non-factory sender
        vm.expectRevert(); // hook.beforeInitialize: NotFactory (sender != engine) — no alternate pair reachable
        manager.initialize(altKey, TickMath.getSqrtPriceAtTick(0));
    }

    /* ─────────────────── blocker-5: HOODIE currency-order BOTH sort branches ─── */

    /// @notice Whether the launched token sorts BELOW or ABOVE HOODIE, the pool is HOODIE-paired and the
    ///         currencies are correctly ordered. Exercises BOTH sort branches deterministically (the symbol is
    ///         part of the clone salt ⇒ pick symbols whose predicted token lands on each side).
    function test_currencyOrderBothSortBranches() public {
        HoodieLauncher launcher = _newLauncher(alice);
        _launchOnSide(launcher, true); // token < HOODIE  → currency0 == token
        _launchOnSide(launcher, false); // token > HOODIE  → currency0 == HOODIE
    }

    function _launchOnSide(HoodieLauncher launcher, bool wantTokenLower) internal {
        for (uint256 i = 0; i < 256; i++) {
            string memory sym = string(abi.encodePacked("S", vm.toString(i)));
            address predicted = engine.predictNextFor(address(launcher), alice, sym);
            if ((predicted < HOODIE) == wantTokenLower) {
                (address token,) = _hoodieLaunch(alice, launcher, "T", sym);
                assertEq(token, predicted, "predicted must equal deployed on this branch");

                PoolKey memory key = _hoodieKey(token);
                if (wantTokenLower) {
                    assertEq(Currency.unwrap(key.currency0), token, "token must be currency0");
                    assertEq(Currency.unwrap(key.currency1), HOODIE, "HOODIE must be currency1");
                } else {
                    assertEq(Currency.unwrap(key.currency0), HOODIE, "HOODIE must be currency0");
                    assertEq(Currency.unwrap(key.currency1), token, "token must be currency1");
                }
                (uint160 sp,,,) = stateView.getSlot0(key.toId());
                assertTrue(sp != 0, "pool must be HOODIE-paired + initialized");
                return;
            }
        }
        revert("no symbol found for requested sort side");
    }
}
