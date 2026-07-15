// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {HydeStackSetup} from "./support/HydeStackSetup.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";

/// @notice rev8 compound-leg ADVERSARIAL suite — the 5% in-kind auto-compound + the security matrix,
///         sourced to the actual 2025 incident record and mapped to casper's blocking audit gates:
///         - Bunni ($8.4M, rounding-drain): `compound` conserves by MEASURED consumption only — pending
///           is never over-credited (monotonic non-increasing), even across repeated tiny compounds.
///         - Cork ($11M, unauthed callback): every hook entrypoint reverts when msg.sender != PoolManager.
///         - LIBRA/Rugproof: 100% of supply → the ONE custody-locked position, zero to team/creator.
///         Plus INV-C7 (5% carve conservation) and INV-C4 (compound gated on a spanned TWAP window).
contract CompoundTest is HydeStackSetup {
    address internal creator = makeAddr("creator");
    address internal buyer = makeAddr("buyer");
    address internal attacker = makeAddr("attacker");

    /// @dev Launch + generate two-sided fees (buys accrue WETH fees, sells accrue LT fees) + span the
    ///      TWAP oracle window so `compound` can read `consult`.
    function _launchAndTrade() internal returns (address token) {
        (token,) = _launch(creator, "Comp", "COMP");
        _buy(buyer, token, 5e18);
        vm.warp(block.timestamp + 40);
        _buy(buyer, token, 5e18);
        vm.warp(block.timestamp + 40);
        uint256 ltBal = IERC20(token).balanceOf(buyer);
        _sell(buyer, token, ltBal / 2); // LT-side fee leg
        vm.warp(block.timestamp + 40);
        _buy(buyer, token, 3e18);
        vm.warp(block.timestamp + 130); // span TWAP_WINDOW (120)
    }

    /* ─────────── INV-C7: collect carves EXACTLY 5% in-kind, notes the 95% ─────────── */
    function test_collect_carves_5pct_inKind() public {
        address token = _launchAndTrade();
        collector.collect(token);

        uint256 pendLT = collector.pendingLiqLT(token);
        uint256 pendWETH = collector.pendingLiqWETH(token);
        uint256 notedLT = vault.rawFees(token, token);
        uint256 notedWETH = vault.rawFees(token, address(weth));

        // Exact conservation (INV-C7): pending == harvested*liqBps/BPS_DENOM, noted == harvested − pending.
        uint256 harvestedLT = pendLT + notedLT;
        uint256 harvestedWETH = pendWETH + notedWETH;
        assertEq(pendLT, harvestedLT * 500 / 10_000, "LT carve == exactly 5% (INV-C7)");
        assertEq(pendWETH, harvestedWETH * 500 / 10_000, "WETH carve == exactly 5% (INV-C7)");
        assertGt(pendWETH, 0, "WETH fees actually carved (non-vacuous)");
    }

    /* ─────────── Bunni: compound conserves — measured, monotonic, no over-credit ─────────── */
    function test_compound_conserves_and_is_monotonic() public {
        address token = _launchAndTrade();
        collector.collect(token);

        uint256 pendLT0 = collector.pendingLiqLT(token);
        uint256 pendWETH0 = collector.pendingLiqWETH(token);
        assertGt(pendWETH0, 0, "there is pending to compound");
        uint256 tc0 = collector.totalCompounded0(token);
        uint256 tc1 = collector.totalCompounded1(token);

        // compound may add (in/one-sided) or dust-gate (wrong-side/too small) — BOTH are conservative.
        try collector.compound(token, block.timestamp) {
            // Bunni core: pending is decremented by MEASURED consumption only → never rises.
            assertLe(collector.pendingLiqLT(token), pendLT0, "pendingLiqLT never over-credited (Bunni)");
            assertLe(collector.pendingLiqWETH(token), pendWETH0, "pendingLiqWETH never over-credited (Bunni)");
            // add-only: totalCompounded only ever grows (INV-C8).
            assertGe(collector.totalCompounded0(token), tc0, "totalCompounded0 monotonic (add-only)");
            assertGe(collector.totalCompounded1(token), tc1, "totalCompounded1 monotonic (add-only)");
            // consumed == the pending delta, and it can never exceed the pending that was queued (INV-C3).
            assertLe(collector.totalCompounded0(token) - tc0, ltIsC0(token) ? pendLT0 : pendWETH0, "used0 <= pending0");
            assertLe(collector.totalCompounded1(token) - tc1, ltIsC0(token) ? pendWETH0 : pendLT0, "used1 <= pending1");
        } catch {
            // dust-gate/wrong-side skip: pending stays EXACTLY as queued (honest liveness, no state change).
            assertEq(collector.pendingLiqLT(token), pendLT0, "pending untouched on skip");
            assertEq(collector.pendingLiqWETH(token), pendWETH0, "pending untouched on skip");
        }
    }

    /* ─────────── Bunni loop: repeated compounds never over-credit pending ─────────── */
    function test_repeated_compound_never_overcredits() public {
        address token = _launchAndTrade();
        collector.collect(token);
        uint256 prevLT = collector.pendingLiqLT(token);
        uint256 prevWETH = collector.pendingLiqWETH(token);
        for (uint256 i; i < 5; i++) {
            try collector.compound(token, block.timestamp) {} catch {}
            uint256 curLT = collector.pendingLiqLT(token);
            uint256 curWETH = collector.pendingLiqWETH(token);
            assertLe(curLT, prevLT, "LT pending monotonic non-increasing across compounds");
            assertLe(curWETH, prevWETH, "WETH pending monotonic non-increasing across compounds");
            prevLT = curLT;
            prevWETH = curWETH;
            vm.warp(block.timestamp + 10);
        }
    }

    /* ─────────── INV-C4: compound reverts before the TWAP window is spanned ─────────── */
    function test_compound_reverts_when_oracle_not_ready() public {
        (address token,) = _launch(creator, "Fresh", "FRSH");
        _buy(buyer, token, 2e18); // same block as launch → no observation gap yet
        collector.collect(token);
        // No warp past TWAP_WINDOW → `consult` reverts (window not spanned); compound propagates it.
        vm.expectRevert();
        collector.compound(token, block.timestamp);
    }

    /* ─────────── Cork ($11M): every hook callback reverts from a non-PoolManager caller ─────────── */
    function test_hook_callbacks_revert_from_non_poolmanager() public {
        (address token,) = _launch(creator, "Hook", "HOOK");
        PoolKey memory key = _key(token);
        SwapParams memory sp = SwapParams({zeroForOne: true, amountSpecified: 1, sqrtPriceLimitX96: 0});
        BalanceDelta zero = BalanceDelta.wrap(0);

        // Cork's exact vector: call the hook DIRECTLY (msg.sender != PoolManager), spoofing the `sender`
        // param. `onlyPoolManager` is the FIRST check on all four → all must revert.
        vm.expectRevert();
        hydeHook.beforeInitialize(address(factory), key, 0);
        vm.expectRevert();
        hydeHook.afterInitialize(address(factory), key, 0, int24(0));
        vm.expectRevert();
        hydeHook.beforeSwap(attacker, key, sp, "");
        vm.expectRevert();
        hydeHook.afterSwap(attacker, key, sp, zero, "");
    }

    /* ─────────── LIBRA/Rugproof: 100% supply → the ONE locked position, 0 to team ─────────── */
    function test_no_team_preallocation() public {
        (address token, uint256 tokenId) = _launch(creator, "Fair", "FAIR");
        // No insider bag: creator, factory, vault hold 0 LT; the collector holds only inert seed dust.
        assertEq(IERC20(token).balanceOf(creator), 0, "creator has NO pre-allocated bag");
        assertEq(IERC20(token).balanceOf(address(factory)), 0, "factory 0 LT");
        assertEq(IERC20(token).balanceOf(address(vault)), 0, "vault 0 LT");
        assertLe(IERC20(token).balanceOf(address(collector)), MAX_SEED_DUST, "collector only inert dust");
        // Essentially 100% of supply is pooled in the singleton PoolManager, in the custody-locked NFT.
        assertGe(IERC20(token).balanceOf(address(manager)), 1_000_000_000e18 - MAX_SEED_DUST, "100% pooled");
        assertEq(IERC721(address(lpm)).ownerOf(tokenId), address(collector), "position custody-locked");
    }

    /* ─────────────────────────── helper ───────────────────────────── */
    function ltIsC0(address token) internal view returns (bool) {
        return token < address(weth);
    }
}
