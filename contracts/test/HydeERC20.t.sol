// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {HydeERC20} from "../src/HydeERC20.sol";

/// @notice HydeERC20 — the "non-seizable trust token" invariants (spec §2, INV-5/6/10/16/17).
///         This test contract plays the role of the factory (first & only caller of `initialize`).
contract HydeERC20Test is Test {
    HydeERC20 internal token;

    address internal pool = address(0xdead01);
    address internal positionManager = address(0xdead02);
    address internal collector = address(0xC011);
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);
    address internal creator = address(0xCEA1);

    uint256 internal constant SUPPLY = 1_000_000_000e18;
    uint256 internal constant BPS = 100; // 1% max wallet
    uint64 internal constant WINDOW = 3600;
    uint256 internal maxWallet;

    function setUp() public {
        token = new HydeERC20();
        address[] memory exempt = new address[](4);
        exempt[0] = pool;
        exempt[1] = positionManager;
        exempt[2] = address(this); // factory
        exempt[3] = collector;

        token.initialize(
            HydeERC20.InitParams({
                name: "Hyde Token",
                symbol: "HYDE",
                poolRecipient: pool,
                collector: collector,
                maxWalletBps: BPS,
                maxWalletWindowSecs: WINDOW,
                exemptAddrs: exempt
            })
        );
        maxWallet = (SUPPLY * BPS) / 1e4;
    }

    /* ─────────────────────── INV-5: supply / mint-once ─────────────────────── */
    function test_initialize_mints_full_supply_to_pool() public view {
        assertEq(token.totalSupply(), SUPPLY);
        assertEq(token.balanceOf(pool), SUPPLY);
        assertEq(token.TOTAL_SUPPLY(), SUPPLY);
    }

    /* ─────────────────────── INV-10: init once/onlyFactory ─────────────────── */
    function test_initialize_reverts_on_second_call() public {
        address[] memory none = new address[](0);
        vm.expectRevert(bytes("INIT"));
        token.initialize(HydeERC20.InitParams("X", "X", pool, collector, BPS, WINDOW, none));
    }

    function test_initialize_reverts_from_non_factory_after_init() public {
        address[] memory none = new address[](0);
        vm.prank(bob);
        vm.expectRevert(bytes("INIT"));
        token.initialize(HydeERC20.InitParams("X", "X", pool, collector, BPS, WINDOW, none));
    }

    /* ─────────────────────── INV-6: max-wallet window ──────────────────────── */
    function test_maxWallet_caps_recipient_during_window() public {
        vm.prank(pool);
        token.transfer(alice, maxWallet); // exactly at cap — ok
        assertEq(token.balanceOf(alice), maxWallet);

        vm.prank(pool);
        vm.expectRevert(bytes("MAX_WALLET")); // one wei over — blocked
        token.transfer(alice, 1);
    }

    function test_maxWallet_never_blocks_selling() public {
        vm.prank(pool);
        token.transfer(alice, maxWallet); // alice at cap
        // Alice can always exit — `from` is never restricted. Send to an exempt sink (pool).
        vm.prank(alice);
        token.transfer(pool, maxWallet);
        assertEq(token.balanceOf(alice), 0);
    }

    function test_maxWallet_lifts_after_expiry() public {
        vm.prank(pool);
        token.transfer(alice, maxWallet);
        vm.warp(block.timestamp + WINDOW + 1); // window over, permanently
        vm.prank(pool);
        token.transfer(alice, SUPPLY / 2); // way over old cap — now fine
        assertEq(token.balanceOf(alice), maxWallet + SUPPLY / 2);
    }

    function test_exempt_recipient_uncapped() public {
        // positionManager is exempt → can hold more than maxWallet during the window
        vm.prank(pool);
        token.transfer(positionManager, maxWallet * 5);
        assertEq(token.balanceOf(positionManager), maxWallet * 5);
    }

    /* ─────────────────────── INV-17: collector sender bypass ───────────────── */
    function test_collector_sender_bypasses_cap() public {
        // Fund the collector (exempt recipient), then have it pay a non-exempt creator OVER the cap.
        vm.prank(pool);
        token.transfer(collector, maxWallet * 3);

        // Creator already sitting at the cap from a normal buy.
        vm.prank(pool);
        token.transfer(creator, maxWallet);

        // A fee payout from the collector must NOT revert even though it pushes creator over cap.
        vm.prank(collector);
        token.transfer(creator, maxWallet * 2);
        assertEq(token.balanceOf(creator), maxWallet * 3);
    }

    /* ─────────────────────── EIP-2612 permit ───────────────────────────────── */
    function test_permit_sets_allowance() public {
        uint256 pk = 0xA11CE5EED;
        address owner = vm.addr(pk);
        uint256 value = 123e18;
        uint256 deadline = block.timestamp + 1000;

        bytes32 digest = _permitDigest(owner, bob, value, 0, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);

        token.permit(owner, bob, value, deadline, v, r, s);
        assertEq(token.allowance(owner, bob), value);
        assertEq(token.nonces(owner), 1);
    }

    function test_permit_expired_reverts() public {
        uint256 pk = 0xBEEF;
        address owner = vm.addr(pk);
        uint256 deadline = block.timestamp - 1;
        bytes32 digest = _permitDigest(owner, bob, 1e18, 0, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        vm.expectRevert(bytes("PERMIT_EXPIRED"));
        token.permit(owner, bob, 1e18, deadline, v, r, s);
    }

    function _permitDigest(address owner, address spender, uint256 value, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                owner,
                spender,
                value,
                nonce,
                deadline
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
    }

    /* ─────────────────────── INV-5/19: burn + zero-transfer ────────────────── */
    function test_transfer_to_zero_reverts() public {
        vm.prank(pool);
        vm.expectRevert(bytes("ZERO_TO")); // no trapping tokens without reducing supply (kami 21162.2)
        token.transfer(address(0), 1e18);
    }

    function test_burn_only_collector_reduces_supply() public {
        // collector is an exempt recipient — fund it, then it burns its own balance.
        vm.prank(pool);
        token.transfer(collector, 1_000e18);

        vm.prank(collector);
        token.burn(400e18);

        assertEq(token.balanceOf(collector), 600e18);
        assertEq(token.totalSupply(), SUPPLY - 400e18); // monotonically non-increasing (INV-5)
    }

    function test_burn_reverts_for_non_collector() public {
        vm.prank(pool);
        token.transfer(bob, 10e18);
        vm.prank(bob);
        vm.expectRevert(bytes("ONLY_COLLECTOR")); // can't burn a third party / re-arm supply (INV-19)
        token.burn(10e18);
    }

    function test_burn_reverts_over_balance() public {
        vm.prank(collector);
        vm.expectRevert(bytes("BALANCE"));
        token.burn(1); // collector holds nothing
    }

    /* ─────────────────────── INV: initialize config bounds ─────────────────── */
    function _params(address poolR, address coll, uint256 bps, uint64 window)
        internal
        pure
        returns (HydeERC20.InitParams memory)
    {
        address[] memory none = new address[](0);
        return HydeERC20.InitParams("N", "N", poolR, coll, bps, window, none);
    }

    function test_initialize_rejects_bad_config() public {
        HydeERC20 t = new HydeERC20();
        vm.expectRevert(bytes("ZERO_POOL"));
        t.initialize(_params(address(0), collector, BPS, WINDOW));

        t = new HydeERC20();
        vm.expectRevert(bytes("ZERO_COLLECTOR"));
        t.initialize(_params(pool, address(0), BPS, WINDOW));

        t = new HydeERC20();
        vm.expectRevert(bytes("BPS_RANGE"));
        t.initialize(_params(pool, collector, 0, WINDOW));

        t = new HydeERC20();
        vm.expectRevert(bytes("BPS_RANGE"));
        t.initialize(_params(pool, collector, 301, WINDOW)); // just over the locked 3% cap

        t = new HydeERC20();
        vm.expectRevert(bytes("WINDOW_RANGE"));
        t.initialize(_params(pool, collector, BPS, 0));

        t = new HydeERC20();
        vm.expectRevert(bytes("WINDOW_RANGE"));
        t.initialize(_params(pool, collector, BPS, 3601)); // just over the locked 1h window
    }

    /* ─────────────────────── INV-6 fuzz: cap property ──────────────────────── */
    function testFuzz_maxWallet_recipient_cap(uint256 amount) public {
        amount = bound(amount, 1, SUPPLY);
        vm.prank(pool);
        if (amount <= maxWallet) {
            token.transfer(bob, amount);
            assertEq(token.balanceOf(bob), amount);
        } else {
            vm.expectRevert(bytes("MAX_WALLET"));
            token.transfer(bob, amount);
        }
    }
}
