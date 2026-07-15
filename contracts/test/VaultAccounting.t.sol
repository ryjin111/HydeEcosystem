// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {HydeERC20} from "../src/HydeERC20.sol";
import {HydeFeeVault} from "../src/HydeFeeVault.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHydeHook} from "../src/interfaces/IHydeHook.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// @notice DEX-AGNOSTIC accounting tests for HydeFeeVault (rev8). Exercises the WETH-leg settle path —
///         noteRaw pull-and-measure / creator-Hyde split via NET_BPS / solvency / claims / donation-proof
///         — using WETH-leg settles only (NO LT swap, NO oracle), so nothing here depends on the DEX
///         internals. Covers INV-1/13/27/32. (rev8) The holder/epoch machinery is removed — no holder
///         vesting, no `roll`, no reward index; the split is creator + Hyde only.
contract VaultAccountingTest is Test {
    HydeERC20 internal token;
    HydeFeeVault internal vault;
    MockERC20 internal weth;

    address internal constant POOL = address(0x1000);
    address internal constant CREATOR = address(0xC0FFEE);
    address internal constant TREASURY = address(0x7EA5);
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);

    uint16 internal constant HYDE_BPS = 500;
    uint16 internal constant NET_BPS = 9500;

    // The test contract plays BOTH the factory (register + initialize) and the collector (noteRaw).
    function setUp() public {
        weth = new MockERC20(18);
        vault = new HydeFeeVault(
            IERC20(address(weth)),
            address(this), // collector
            IPoolManager(address(0x1111)), // dummy — never called on the WETH leg
            IHydeHook(address(0x2222)), // dummy — never called on the WETH leg
            int24(60), // tickSpacing
            TREASURY,
            HYDE_BPS, // hydeBps
            NET_BPS, // NET_BPS (BPS_DENOM − liqBps)
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
        vm.warp(block.timestamp + 3601); // expire the max-wallet window
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
            + vault.hydeClaimable(address(token));
    }

    function _assertSolvent() internal view {
        uint256 accounted = vault.accountedBalance(address(weth));
        assertEq(accounted, _wethLiability(), "accounted == liability (creator + Hyde + rawFees)");
        assertGe(weth.balanceOf(address(vault)), accounted, "balance >= accounted (INV-27)");
    }

    /* ─────────────────── INV-1: creator/Hyde split is exact ─────────────────── */
    function testFuzz_settleSplitExact(uint256 amt) public {
        amt = bound(amt, 1, 1e30);
        _noteWeth(amt);
        vault.settle(address(token), address(weth), amt, 0, block.timestamp);

        // `amt` is the forwarded 95% remainder; Hyde = 500/9500 of it (== 5% of the original notional),
        // creator = the remainder (rounding favors the creator). No holder leg.
        uint256 hyde = amt * HYDE_BPS / NET_BPS;
        uint256 creator = amt - hyde;
        assertEq(vault.hydeClaimable(address(token)), hyde, "hyde 500/9500");
        assertEq(vault.creatorClaimable(address(token)), creator, "creator remainder");
        assertEq(hyde + creator, amt, "conservation (no dust lost)");
        assertGe(creator, hyde, "creator is the majority leg");
        _assertSolvent();
    }

    /* ───────────── INV-27: solvency across a note/settle/claim sequence ──────── */
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

        // Everything settled has been paid to the two fixed recipients; nothing left owed.
        assertEq(vault.creatorClaimable(address(token)), 0, "creator drained");
        assertEq(vault.hydeClaimable(address(token)), 0, "hyde drained");
    }

    /* ───────────── INV-13: donation-proof pull-and-measure ───────────────────── */
    function test_donationDoesNotAffectAccounting() public {
        _noteWeth(500e18);
        uint256 accountedBefore = vault.accountedBalance(address(weth));

        // A raw WETH donation straight to the vault must NOT change accounting (INV-13).
        weth.mint(address(vault), 999e18);
        assertEq(vault.accountedBalance(address(weth)), accountedBefore, "donation ignored by ledger");
        _assertSolvent(); // still solvent — the donation just sits as unaccounted surplus
    }

    /* ───────────── INV-27: WETH-leg settle is reclassify-only (net-zero) ──────── */
    function test_wethLegSettleIsReclassifyOnly() public {
        _noteWeth(1_000e18);
        uint256 accountedBefore = vault.accountedBalance(address(weth));
        vault.settle(address(token), address(weth), 1_000e18, 0, block.timestamp);
        // The WETH leg moves value from rawFees into the buckets — total accountedBalance[WETH] UNCHANGED.
        assertEq(vault.accountedBalance(address(weth)), accountedBefore, "WETH-leg settle is net-zero on the ledger");
        assertEq(vault.rawFees(address(token), address(weth)), 0, "rawFees drained into buckets");
        _assertSolvent();
    }
}
