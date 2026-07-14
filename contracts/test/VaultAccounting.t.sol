// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {HydeERC20} from "../src/HydeERC20.sol";
import {HydeFeeVault} from "../src/HydeFeeVault.sol";
import {ISwapRouter} from "../src/interfaces/ISwapRouter.sol";
import {IUniswapV3Factory} from "../src/interfaces/IUniswapV3Factory.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// @notice DEX-AGNOSTIC accounting tests for HydeFeeVault against checkpoint 04f3f66 (kami 21296:
///         "continue only DEX-agnostic tests"). Exercises the half preserved across the V3→V4 pivot —
///         noteRaw / WETH-leg settle split / cumulative-epoch vesting / holderFunded−holderClaimed
///         solvency / claims / sync — using WETH-leg settles only (NO LT swap, NO oracle), so nothing
///         here depends on Uniswap V3-vs-V4. Covers INV-1/13/25/26/27/34 (accounting portions).
contract VaultAccountingTest is Test {
    HydeERC20 internal token;
    HydeFeeVault internal vault;
    MockERC20 internal weth;

    address internal constant POOL = address(0x1000);
    address internal constant CREATOR = address(0xC0FFEE);
    address internal constant TREASURY = address(0x7EA5);
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);

    uint32 internal constant DURATION = 7 days;

    // The test contract plays BOTH the factory (register + initialize) and the collector (noteRaw).
    function setUp() public {
        weth = new MockERC20(18);
        vault = new HydeFeeVault(
            IERC20(address(weth)),
            address(this), // collector
            ISwapRouter(address(0x1111)), // dummy — never called on the WETH leg
            IUniswapV3Factory(address(0x2222)), // dummy — never called on the WETH leg
            10000, // feeTier
            TREASURY,
            500, // hydeBps
            500, // holderBps
            DURATION,
            300, // MAX_SLIPPAGE_BPS
            1800 // TWAP_WINDOW
        );
        vault.initFactory(address(this));

        token = new HydeERC20();
        vault.register(address(token), CREATOR);

        address[] memory exempt = new address[](2);
        exempt[0] = POOL;
        exempt[1] = address(vault);
        token.initialize(
            HydeERC20.InitParams({
                name: "Hyde",
                symbol: "HYDE",
                poolRecipient: POOL,
                vault: address(vault),
                maxWalletBps: 300,
                maxWalletWindowSecs: 3600,
                exemptAddrs: exempt
            })
        );
        // Expire the anti-snipe window so reward scenarios can size holders freely.
        vm.warp(block.timestamp + 3601);
    }

    /* ─────────────────────────── helpers ───────────────────────────────────── */
    function _buy(address who, uint256 amount) internal {
        vm.prank(POOL);
        token.transfer(who, amount);
    }

    /// @dev Fund raw WETH fees as the collector (pull-and-measure path).
    function _noteWeth(uint256 amount) internal {
        weth.mint(address(this), amount);
        weth.approve(address(vault), amount);
        vault.noteRaw(address(token), address(weth), amount);
    }

    function _wethLiability() internal view returns (uint256) {
        return vault.rawFees(address(token), address(weth)) + vault.creatorClaimable(address(token))
            + vault.hydeClaimable(address(token)) + (vault.holderFunded(address(token)) - vault.holderClaimed(address(token)));
    }

    function _assertSolvent() internal view {
        uint256 accounted = vault.accountedBalance(address(weth));
        assertEq(accounted, _wethLiability(), "accounted == liability");
        assertGe(weth.balanceOf(address(vault)), accounted, "balance >= accounted (INV-27)");
    }

    /* ─────────────────────────── INV-1: split ──────────────────────────────── */
    function testFuzz_settleSplitExact(uint256 amt) public {
        amt = bound(amt, 1, 1e30);
        _noteWeth(amt);
        vault.settle(address(token), address(weth), amt, 0, block.timestamp);

        uint256 hyde = amt * 500 / 10000;
        uint256 holder = amt * 500 / 10000;
        uint256 creator = amt - hyde - holder;
        assertEq(vault.hydeClaimable(address(token)), hyde, "hyde 5%");
        assertEq(vault.holderFunded(address(token)), holder, "holder 5%");
        assertEq(vault.creatorClaimable(address(token)), creator, "creator remainder");
        assertEq(hyde + holder + creator, amt, "conservation");
        assertGe(creator, hyde + holder, "creator >= 90%");
        _assertSolvent();
    }

    /* ─────────────────────────── INV-27: solvency across a sequence ─────────── */
    function test_solvencyAcrossSequence() public {
        _buy(ALICE, 100_000_000e18);
        _buy(BOB, 50_000_000e18);

        _noteWeth(1_000e18);
        vault.settle(address(token), address(weth), 400e18, 0, block.timestamp);
        _assertSolvent();

        vault.settle(address(token), address(weth), 600e18, 0, block.timestamp);
        _assertSolvent();

        vault.claimCreator(address(token));
        vault.claimHyde(address(token));
        _assertSolvent();

        vm.warp(block.timestamp + DURATION + 1);
        vault.claim(address(token), ALICE);
        vault.claim(address(token), BOB);
        _assertSolvent();
    }

    /* ─────────────── INV-25: cumulative epoch vests EXACTLY under spam ───────── */
    function test_epochVestsExactlyUnderPerSecondSpam() public {
        // Alice holds 100% of eligible supply.
        _buy(ALICE, 10_000_000e18);

        // An indivisible-by-DURATION fee → holderCut not a clean multiple of DURATION.
        uint256 fee = 12_345_678_901; // wei; holderCut = fee/20 = 617_283_945
        _noteWeth(fee);
        vault.settle(address(token), address(weth), fee, 0, block.timestamp); // rolls epoch 1
        uint256 epochAmt = vault.epochAmount(address(token));
        assertEq(epochAmt, fee * 500 / 10000, "epoch funded with holderCut");
        uint256 finish = vault.epochFinish(address(token));

        // Poke _updateReward every second via a 1-wei self-transfer (advances the index without
        // touching eligible supply or epochAmount). Per-update mulDiv flooring must NOT accumulate a
        // shortfall — the cumulative epochVested target hits epochAmount exactly at finish (rev6 pt.1).
        for (uint256 i = 0; i < 300; i++) {
            vm.warp(block.timestamp + 1);
            vm.prank(ALICE);
            token.transfer(ALICE, 1);
        }
        vm.warp(finish); // exactly at finish
        vm.prank(ALICE);
        token.transfer(ALICE, 1); // final poke → vest to the cumulative target

        assertEq(vault.epochVested(address(token)), epochAmt, "epoch vests EXACTLY epochAmount at finish (INV-25)");

        // Single holder of all eligible supply: claimable is within a bounded per-holder index dust.
        vault.claim(address(token), ALICE);
        uint256 aliceWeth = weth.balanceOf(ALICE);
        assertLe(aliceWeth, epochAmt, "never over-pays vested (INV-25)");
        assertGe(aliceWeth + 1_000, epochAmt, "dust is bounded (reserved & solvent, not lost)");
        _assertSolvent();
    }

    /* ─────────────── INV-34: non-extendable epoch under settle/roll spam ─────── */
    function test_nonExtendableEpochGrief() public {
        _buy(ALICE, 10_000_000e18);

        _noteWeth(1_000e18);
        vault.settle(address(token), address(weth), 100e18, 0, block.timestamp); // epoch 1 starts
        uint256 finish = vault.epochFinish(address(token));

        // Spam tiny settles + roll attempts every block during the active epoch.
        for (uint256 i = 0; i < 50; i++) {
            vm.warp(block.timestamp + 12);
            vault.settle(address(token), address(weth), 1e18, 0, block.timestamp); // queues nextEpoch, not extend
            vm.expectRevert(bytes("NOT_ROLLABLE"));
            vault.roll(address(token)); // active epoch → must revert
            assertEq(vault.epochFinish(address(token)), finish, "epochFinish NEVER moves (INV-34)");
        }

        // After the ORIGINAL finish, the queued funds roll into epoch 2 on demand.
        vm.warp(finish + 1);
        assertGt(vault.nextEpochAmount(address(token)), 0, "queued for next epoch");
        vault.roll(address(token));
        assertGt(vault.epochFinish(address(token)), finish, "epoch 2 started after original completed");
    }

    /* ─────────────── INV-13: donation neither bricks nor credits ─────────────── */
    function test_donationDoesNotBrickOrCredit() public {
        uint256 accBefore = vault.accountedBalance(address(weth));
        // Someone donates WETH straight to the vault (bypassing noteRaw).
        weth.mint(address(vault), 5_000e18);
        assertEq(vault.accountedBalance(address(weth)), accBefore, "donation not credited (INV-13)");

        // A legitimate noteRaw still measures its own exact delta and works.
        _noteWeth(100e18);
        assertEq(vault.accountedBalance(address(weth)), accBefore + 100e18, "exact-received only");
        assertEq(vault.rawFees(address(token), address(weth)), 100e18, "raw credited exactly");
        // Vault holds the donation too, so it stays solvent-or-better.
        assertGe(weth.balanceOf(address(vault)), vault.accountedBalance(address(weth)));
    }

    /* ─────────────── claims pay the fixed recipients, third-party trigger ───── */
    function test_claimsPayFixedRecipients() public {
        _buy(ALICE, 10_000_000e18);
        _noteWeth(1_000e18);
        vault.settle(address(token), address(weth), 1_000e18, 0, block.timestamp);

        // Anyone can trigger; funds go to the immutable recipients.
        vm.prank(BOB);
        vault.claimCreator(address(token));
        assertEq(weth.balanceOf(CREATOR), 900e18, "creator 90% to fixed recipient");

        vm.prank(BOB);
        vault.claimHyde(address(token));
        assertEq(weth.balanceOf(TREASURY), 50e18, "hyde 5% to treasury");

        vm.warp(block.timestamp + DURATION + 1);
        vm.prank(BOB);
        vault.claim(address(token), ALICE); // third party triggers, funds go to Alice
        assertGt(weth.balanceOf(ALICE), 0, "holder leg paid to holder");
        _assertSolvent();
    }

    /* ─────────────── INV-26/32: zero-eligible-supply vest re-queued, never lost ─ */
    function test_zeroSupplyVestRequeued() public {
        // No non-excluded holders yet → totalEligibleSupply == 0.
        assertEq(vault.totalEligibleSupply(address(token)), 0);
        _noteWeth(1_000e18);
        vault.settle(address(token), address(weth), 1_000e18, 0, block.timestamp); // epoch 1, supply 0
        uint256 holderLeg = 1_000e18 * 500 / 10000; // 50e18
        assertEq(vault.epochAmount(address(token)), holderLeg, "epoch 1 funded with holder leg");

        // The whole epoch elapses with zero eligible supply — the leg vests to nobody.
        vm.warp(vault.epochFinish(address(token)) + 1);
        // Per spec, roll needs the re-queue to have happened first; with no activity it hasn't yet.
        vm.expectRevert(bytes("NOT_ROLLABLE"));
        vault.roll(address(token));
        _assertSolvent(); // but the 50e18 is still fully reserved (holderFunded − holderClaimed)

        // A holder finally buys in — this pokes _updateReward: the zero-supply vest is re-queued (never
        // lost) and _maybeRoll starts epoch 2 funded with it, now that Alice is eligible.
        _buy(ALICE, 10_000_000e18);
        assertEq(vault.epochAmount(address(token)), holderLeg, "re-queued vest funds epoch 2");
        _assertSolvent();

        // Over epoch 2 the re-queued 50 WETH vests to Alice — proving it was never lost (INV-26/32).
        vm.warp(vault.epochFinish(address(token)) + 1);
        vault.claim(address(token), ALICE);
        assertApproxEqAbs(weth.balanceOf(ALICE), holderLeg, 1_000, "re-queued holder leg vests to Alice");
        _assertSolvent();
    }
}
