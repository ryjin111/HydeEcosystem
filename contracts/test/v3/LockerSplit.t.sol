// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {HydeV3FeeLocker} from "../../src/v3/HydeV3FeeLocker.sol";
import {IV3PositionManagerCollect} from "../../src/v3/interfaces/IUniswapV3Minimal.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockPositionManager} from "./mocks/MockPositionManager.sol";

/// @notice `HydeV3FeeLocker` unit tests — gojo's §4 checklist (24161): both-leg 95/5, exact solvency /
///         round-down, immutable creator, permissionless push, custody-at-register, graduate cosmetic latch.
///         This test contract IS the factory (deploys the locker with `factory = address(this)`).
contract LockerSplitTest is Test {
    HydeV3FeeLocker internal locker;
    MockPositionManager internal pm;
    MockERC20 internal launchToken; // 18-dec
    MockERC20 internal numeraire; // 6-dec (USDT0-like)

    address internal constant CREATOR = address(0xC0FFEE);
    address internal constant HYDE = address(0x5EED); // hyde treasury
    address internal constant RANDO = address(0xBEEF);
    uint256 internal constant TOKEN_ID = 1;

    // Mirror of the locker's event, for expectEmit.
    event Graduated(address indexed token);

    function setUp() public {
        pm = new MockPositionManager();
        launchToken = new MockERC20("Hyde", "HYDE", 18);
        numeraire = new MockERC20("USDT0", "USDT0", 6);
        locker = new HydeV3FeeLocker(address(this), IV3PositionManagerCollect(address(pm)), HYDE, 500 * 1e6);

        // position custodied by the locker (the factory mints it there); token0=launchToken, token1=numeraire.
        pm.setPosition(TOKEN_ID, address(launchToken), address(numeraire), address(locker));
        locker.register(address(launchToken), CREATOR, TOKEN_ID, address(numeraire), 10000);
    }

    function _fundFees(uint256 owed0, uint256 owed1) internal {
        launchToken.mint(address(pm), owed0);
        numeraire.mint(address(pm), owed1);
        pm.setOwed(TOKEN_ID, owed0, owed1);
    }

    /// gojo INV-2 + INV-3: BOTH legs split 95/5; sums are exact.
    function test_split_95_5_bothLegs() public {
        uint256 owed0 = 1000e18; // launch-token fees
        uint256 owed1 = 500e6; // numeraire fees
        _fundFees(owed0, owed1);

        locker.collect(address(launchToken));

        // token leg
        assertEq(launchToken.balanceOf(HYDE), owed0 / 20, "hyde !=5% token");
        assertEq(launchToken.balanceOf(CREATOR), owed0 - owed0 / 20, "creator !=95% token");
        assertEq(launchToken.balanceOf(HYDE) + launchToken.balanceOf(CREATOR), owed0, "token leg not conserved");
        // numeraire leg
        assertEq(numeraire.balanceOf(HYDE), owed1 / 20, "hyde !=5% numeraire");
        assertEq(numeraire.balanceOf(CREATOR), owed1 - owed1 / 20, "creator !=95% numeraire");
        assertEq(numeraire.balanceOf(HYDE) + numeraire.balanceOf(CREATOR), owed1, "numeraire leg not conserved");
        // nothing stranded in the locker
        assertEq(launchToken.balanceOf(address(locker)), 0, "token dust stranded");
        assertEq(numeraire.balanceOf(address(locker)), 0, "numeraire dust stranded");
    }

    /// gojo INV-3: round-down, creator absorbs dust, sum == collected exactly (never over-pays).
    function test_split_roundDown_creatorAbsorbsDust() public {
        uint256 owed0 = 101; // 101*500/10000 = 5.05 → hyde 5, creator 96
        _fundFees(owed0, 0);
        locker.collect(address(launchToken));
        assertEq(launchToken.balanceOf(HYDE), 5, "hyde round-down");
        assertEq(launchToken.balanceOf(CREATOR), 96, "creator remainder");
        assertEq(launchToken.balanceOf(HYDE) + launchToken.balanceOf(CREATOR), owed0, "sum != collected");
    }

    /// gojo INV-4: permissionless crank — a random caller triggers, payout still goes to the FIXED creator.
    function test_collect_permissionless_fixedRecipients() public {
        _fundFees(200e18, 0);
        vm.prank(RANDO);
        locker.collect(address(launchToken));
        assertEq(launchToken.balanceOf(CREATOR), 190e18, "creator");
        assertEq(launchToken.balanceOf(HYDE), 10e18, "hyde");
        assertEq(launchToken.balanceOf(RANDO), 0, "cranker must receive nothing");
    }

    function test_register_onlyFactory() public {
        pm.setPosition(2, address(launchToken), address(numeraire), address(locker));
        vm.prank(RANDO);
        vm.expectRevert(HydeV3FeeLocker.OnlyFactory.selector);
        locker.register(address(0x1234), CREATOR, 2, address(numeraire), 10000);
    }

    /// gojo INV-6: register requires the NFT to already be custodied by the locker.
    function test_register_requiresCustody() public {
        pm.setPosition(3, address(launchToken), address(numeraire), RANDO); // owner != locker
        vm.expectRevert(HydeV3FeeLocker.NotCustodied.selector);
        locker.register(address(0x5678), CREATOR, 3, address(numeraire), 10000);
    }

    /// Graduation-B (clint 24201, 500 USDT0) is a COSMETIC label latch: accrues on the NUMERAIRE leg only,
    /// monotonic, permissionless, one-way, and unlocks/migrates NOTHING (LP stays perma-locked). This proves
    /// the latch mechanics; INV-1 (perma-lock) is unaffected — graduate() never touches the position NFT.
    function test_graduate_cosmeticLatch() public {
        // Start: below threshold → reverts; progress reads zeroed against the 500 USDT0 target.
        (uint256 acc0, uint256 thr, bool grad0) = locker.graduationProgress(address(launchToken));
        assertEq(acc0, 0, "accrued starts 0");
        assertEq(thr, 500 * 1e6, "threshold = 500 USDT0");
        assertFalse(grad0, "not graduated at start");
        vm.expectRevert(HydeV3FeeLocker.GraduationPending.selector);
        locker.graduate(address(launchToken));

        // Accrue 200 USDT0 on the numeraire leg; the 1000e18 TOKEN-leg fees must NOT count toward the metric.
        _fundFees(1000e18, 200e6);
        locker.collect(address(launchToken));
        (uint256 acc1,, bool grad1) = locker.graduationProgress(address(launchToken));
        assertEq(acc1, 200e6, "only the numeraire leg accrues (token-leg fees excluded)");
        assertFalse(grad1, "still below threshold");
        vm.expectRevert(HydeV3FeeLocker.GraduationPending.selector);
        locker.graduate(address(launchToken));

        // Second collect crosses the bar (monotonic): +300 → 500 USDT0 cumulative.
        _fundFees(0, 300e6);
        locker.collect(address(launchToken));
        (uint256 acc2,, bool grad2) = locker.graduationProgress(address(launchToken));
        assertEq(acc2, 500e6, "cumulative accrual is monotonic across collects");
        assertFalse(grad2, "label stays unflipped until graduate() is called");

        // Permissionless one-way flip — a random cranker latches it, emitting Graduated.
        vm.expectEmit(true, false, false, false, address(locker));
        emit Graduated(address(launchToken));
        vm.prank(RANDO);
        locker.graduate(address(launchToken));
        (,, bool grad3) = locker.graduationProgress(address(launchToken));
        assertTrue(grad3, "graduated latched true");

        // One-way latch: a second graduate() reverts.
        vm.expectRevert(HydeV3FeeLocker.AlreadyGraduated.selector);
        locker.graduate(address(launchToken));
    }
}
