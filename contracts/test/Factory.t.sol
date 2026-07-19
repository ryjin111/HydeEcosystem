// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {HydeStackSetup} from "./support/HydeStackSetup.sol";
import {HydeTokenFactory} from "../src/HydeTokenFactory.sol";
import {HydeERC20} from "../src/HydeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/// @notice Factory-focused tests (§3, fee-model-independent): seed correctness on BOTH address-sort
///         branches (INV-52), constructor preset validation, the flat native-ETH fee, exempt set, and the
///         register-before-mint ordering (INV-30). Forces the LT/WETH sort by placing the WETH mock at a
///         very low / very high address so every clone lands above / below it.
contract FactoryTest is HydeStackSetup {
    address internal constant WETH_LOW = address(0x1234); // clones > WETH ⇒ LT currency1 ⇒ c1 branch
    address internal constant WETH_HIGH = address(type(uint160).max); // clones < WETH ⇒ LT currency0 ⇒ c0 branch

    address internal creator = makeAddr("creator");

    // ── seed on both sort branches ──────────────────────────────────────────

    function test_seed_c0_branch_lt_below_weth() public {
        _deployHydeStackWithWeth(WETH_HIGH); // WETH high ⇒ token < WETH ⇒ LT is currency0
        (address token, uint256 tokenId) = _launch(creator, "C0", "C0T");
        assertTrue(token < address(weth), "sort: LT is currency0");
        _assertSeedInvariants(token, tokenId);
    }

    function test_seed_c1_branch_lt_above_weth() public {
        _deployHydeStackWithWeth(WETH_LOW); // WETH low ⇒ token > WETH ⇒ LT is currency1
        (address token, uint256 tokenId) = _launch(creator, "C1", "C1T");
        assertTrue(token > address(weth), "sort: LT is currency1");
        _assertSeedInvariants(token, tokenId);
    }

    /// INV-15/52: post-seed the position is custodied, the seed is single-sided (no WETH), the residual is
    /// bounded + swept to the collector, and the factory & vault hold 0 LT.
    function _assertSeedInvariants(address token, uint256 tokenId) internal view {
        assertEq(IERC721(address(lpm)).ownerOf(tokenId), address(collector), "custody");
        assertEq(weth.balanceOf(address(manager)), 0, "single-sided: no WETH seeded");
        assertEq(IERC20(token).balanceOf(address(factory)), 0, "factory 0 LT");
        assertEq(IERC20(token).balanceOf(address(vault)), 0, "vault 0 LT");
        assertLe(IERC20(token).balanceOf(address(collector)), MAX_SEED_DUST, "dust bound");
        assertGe(IERC20(token).balanceOf(address(manager)), 1_000_000_000e18 - MAX_SEED_DUST, "pooled LT");
    }

    // ── flat native-ETH launch fee ───────────────────────────────────────────

    function test_launch_fee_charged_to_treasury() public {
        uint256 before = LAUNCH_TREASURY.balance;
        _launch(creator, "Fee", "FEE");
        assertEq(LAUNCH_TREASURY.balance - before, LAUNCH_FEE, "fee to treasury");
    }

    function test_launch_reverts_on_wrong_fee_value() public {
        // Exact value required — too little OR too much reverts BAD_FEE (no refund, no stuck excess).
        vm.deal(creator, 1 ether);
        vm.prank(creator);
        vm.expectRevert(bytes("BAD_FEE"));
        factory.launch{value: LAUNCH_FEE - 1}(HydeTokenFactory.LaunchParams({name: "No", symbol: "NO", presetId: 0}));
        vm.prank(creator);
        vm.expectRevert(bytes("BAD_FEE"));
        factory.launch{value: LAUNCH_FEE + 1}(HydeTokenFactory.LaunchParams({name: "No", symbol: "NO", presetId: 0}));
    }

    function test_launch_reverts_when_treasury_rejects_eth() public {
        // The fee is forwarded at step 1 (before any vault/mint), so an UNWIRED factory whose treasury
        // reverts on receive still exercises the guard: the launch reverts FEE_XFER_FAIL.
        HydeTokenFactory.ConstructorParams memory p = _ctorParams();
        p.launchFeeTreasury = address(new RejectEth());
        HydeTokenFactory f = new HydeTokenFactory(p, _validPresets());
        vm.deal(creator, LAUNCH_FEE);
        vm.prank(creator);
        vm.expectRevert(bytes("FEE_XFER_FAIL"));
        f.launch{value: LAUNCH_FEE}(HydeTokenFactory.LaunchParams({name: "X", symbol: "X", presetId: 0}));
    }

    // ── exempt set (§2) ─────────────────────────────────────────────────────

    function test_exempt_set_is_the_frozen_infra_set() public {
        (address token,) = _launch(creator, "Ex", "EX");
        HydeERC20 t = HydeERC20(token);
        assertTrue(t.exempt(address(manager)), "pool/PoolManager exempt");
        assertTrue(t.exempt(address(lpm)), "positionManager exempt");
        assertTrue(t.exempt(address(factory)), "factory exempt");
        assertTrue(t.exempt(address(collector)), "collector exempt");
        assertTrue(t.exempt(address(vault)), "vault exempt");
        assertTrue(t.exempt(address(swapRouter)), "router exempt");
        assertTrue(t.exempt(address(0)), "zero exempt");
        assertFalse(t.exempt(creator), "creator NOT exempt");
    }

    // ── constructor preset validation (INV-52) ──────────────────────────────

    /// A preset whose c0 range is NOT strictly above spot (not single-sided) is rejected at construction.
    function test_constructor_rejects_non_single_sided_preset() public {
        HydeTokenFactory.ConstructorParams memory p = _ctorParams();
        HydeTokenFactory.PresetInput[] memory bad = new HydeTokenFactory.PresetInput[](1);
        // c0: initialTick (60) is NOT below tickLower (0) ⇒ NOT single-sided in currency0.
        bad[0] = HydeTokenFactory.PresetInput({
            initialTick0: 60,
            tickLower0: 0,
            tickUpper0: 60_000,
            initialTick1: C1_INIT,
            tickLower1: C1_LOWER,
            tickUpper1: C1_UPPER
        });
        vm.expectRevert(bytes("NOT_SINGLE_SIDED_C0"));
        new HydeTokenFactory(p, bad);
    }

    /// A preset with misaligned ticks (not tickSpacing multiples) is rejected at construction.
    function test_constructor_rejects_misaligned_ticks() public {
        HydeTokenFactory.ConstructorParams memory p = _ctorParams();
        HydeTokenFactory.PresetInput[] memory bad = new HydeTokenFactory.PresetInput[](1);
        bad[0] = HydeTokenFactory.PresetInput({
            initialTick0: C0_INIT,
            tickLower0: 7, // not a multiple of tickSpacing (60)
            tickUpper0: 60_000,
            initialTick1: C1_INIT,
            tickLower1: C1_LOWER,
            tickUpper1: C1_UPPER
        });
        vm.expectRevert(bytes("TICK_ALIGN"));
        new HydeTokenFactory(p, bad);
    }

    /// @dev Rebuild the current stack's constructor params (for constructor-revert tests). The factory it
    ///      would create is unwired + unused; we only exercise constructor validation.
    function _ctorParams() internal view returns (HydeTokenFactory.ConstructorParams memory) {
        return HydeTokenFactory.ConstructorParams({
            impl: address(impl),
            collector: address(collector),
            vault: address(vault),
            hook: address(hydeHook),
            poolManager: address(manager),
            positionManager: address(lpm),
            permit2: address(permit2),
            launchFeeAmount: LAUNCH_FEE,
            launchFeeTreasury: LAUNCH_TREASURY,
            weth: address(weth),
            universalRouter: address(swapRouter),
            tickSpacing: TICK_SPACING,
            maxSeedDust: MAX_SEED_DUST,
            maxWalletBps: MAX_WALLET_BPS,
            maxWalletWindowSecs: MAX_WALLET_WINDOW,
            graduationThreshold: GRAD_THRESHOLD,
            owner: FACTORY_OWNER
        });
    }

    /// @dev The single valid preset (both sort branches), reused for constructor tests.
    function _validPresets() internal pure returns (HydeTokenFactory.PresetInput[] memory presets) {
        presets = new HydeTokenFactory.PresetInput[](1);
        presets[0] = HydeTokenFactory.PresetInput({
            initialTick0: C0_INIT, tickLower0: C0_LOWER, tickUpper0: C0_UPPER,
            initialTick1: C1_INIT, tickLower1: C1_LOWER, tickUpper1: C1_UPPER
        });
    }
}

/// @dev A treasury that rejects ETH on receive — forces the factory's FEE_XFER_FAIL guard.
contract RejectEth {
    receive() external payable {
        revert("REJECT");
    }
}
