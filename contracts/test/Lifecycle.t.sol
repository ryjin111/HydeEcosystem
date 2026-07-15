// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {HydeStackSetup} from "./support/HydeStackSetup.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {HydeERC20} from "../src/HydeERC20.sol";

/// @notice End-to-end lifecycle on a REAL Uniswap V4 stack: launch → seed/custody → trade → collect
///         (5% in-kind carve) → settle (WETH leg) → creator/Hyde claims. Proves the factory + hook +
///         collector + vault work together against the actual PoolManager/PositionManager, and asserts
///         the seed invariants (custody, single-sided, measured dust, factory/vault 0 LT — INV-15/52) +
///         the rev8 90/5 split + the 5% liquidity carve (INV-C7).
contract LifecycleTest is HydeStackSetup {
    address internal creator = makeAddr("creator");
    address internal buyer = makeAddr("buyer");

    function test_launch_seeds_locked_single_sided_position() public {
        (address token, uint256 tokenId) = _launch(creator, "Pawmie", "PAWM");

        // $1 USDG fee landed in the launch treasury.
        assertEq(usdg.balanceOf(LAUNCH_TREASURY), LAUNCH_FEE, "launch fee");

        // Position NFT is in the collector's PERMANENT custody (INV-4/52).
        assertEq(IERC721(address(lpm)).ownerOf(tokenId), address(collector), "custody");

        // Supply is the fixed 1B; the factory & vault hold 0 LT post-seed (INV-15).
        assertEq(HydeERC20(token).totalSupply(), 1_000_000_000e18, "supply");
        assertEq(IERC20(token).balanceOf(address(factory)), 0, "factory 0 LT");
        assertEq(IERC20(token).balanceOf(address(vault)), 0, "vault 0 LT");

        // The seed residual swept to the collector is bounded + inert (INV-15/52).
        assertLe(IERC20(token).balanceOf(address(collector)), MAX_SEED_DUST, "dust bound");

        // Essentially all supply is now pooled inside the singleton PoolManager (single-sided, no WETH).
        assertGe(IERC20(token).balanceOf(address(manager)), 1_000_000_000e18 - MAX_SEED_DUST, "pooled LT");
        assertEq(weth.balanceOf(address(manager)), 0, "no WETH seeded");

        // Registrations wired across the stack.
        assertEq(vault.creator(token), creator, "vault creator");
        assertTrue(vault.registered(token), "vault registered");
        (bool reg,, address col,,,,,) = collector.positionOf(token);
        assertTrue(reg, "collector registered");
        assertEq(col, creator, "collector creator");
        (bool hookActive,,) = hydeHook.active(_key(token).toId());
        assertTrue(hookActive, "hook active");
    }

    function test_full_flow_trade_collect_settle_claim() public {
        (address token,) = _launch(creator, "Pawmie", "PAWM");
        PoolId poolId = _key(token).toId();

        // A buyer trades WETH → LT; the hook meters volume + the pool accrues a WETH fee.
        _buy(buyer, token, 5e18);
        assertGt(IERC20(token).balanceOf(buyer), 0, "buyer got LT");
        assertGt(hydeHook.swapVolume(poolId), 0, "volume metered");

        // Permissionless collect harvests the accrued (mostly WETH) fees into the vault (swap-free).
        collector.collect(token);
        uint256 rawWeth = vault.rawFees(token, address(weth));
        assertGt(rawWeth, 0, "raw WETH fees harvested");

        // The collector RETAINED the 5% in-kind carve (WETH side) before noting the 95% to the vault.
        assertGt(collector.pendingLiqWETH(token), 0, "5% WETH carve retained for liquidity");

        // Permissionless settle of the WETH leg — reclassify-only, splits creator/Hyde via NET_BPS.
        vault.settle(token, address(weth), rawWeth, 0, block.timestamp);
        uint256 creatorCut = vault.creatorClaimable(token);
        uint256 hydeCut = vault.hydeClaimable(token);
        assertEq(creatorCut + hydeCut, rawWeth, "split conserves (creator + Hyde, no holder)");
        // rawWeth is the forwarded 95% remainder, so Hyde = 500/9500 of it = 5% of the original notional.
        assertEq(hydeCut, rawWeth * 500 / 9500, "hyde 500/9500 of forwarded");
        assertEq(creatorCut, rawWeth - hydeCut, "creator remainder ~90% of notional");

        // Creator + Hyde pull-claims pay the fixed recipients (rev8: no holder claim — that leg is gone).
        vault.claimCreator(token);
        assertEq(weth.balanceOf(creator), creatorCut, "creator paid WETH");
        vault.claimHyde(token);
        assertEq(weth.balanceOf(HYDE_TREASURY), hydeCut, "hyde treasury paid WETH");
    }
}
