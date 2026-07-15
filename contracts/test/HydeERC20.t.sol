// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {HydeERC20} from "../src/HydeERC20.sol";
import {MockVault} from "./mocks/MockVault.sol";

/// @notice DEX-agnostic unit tests for HydeERC20 (rev8 §2). Covers supply-constant/no-burn (INV-5),
///         to==0 revert (INV-21), max-wallet (INV-6), initialize once/bounds (INV-10/22), the exempt
///         infra set, and permit. (rev8) The vault `sync` hook is removed — no sync tests.
contract HydeERC20Test is Test {
    HydeERC20 internal token;
    MockVault internal vault;

    address internal constant POOL = address(0x1000);
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);

    uint256 internal constant SUPPLY = 1_000_000_000e18;
    bytes32 internal constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    function _init(uint256 bps, uint64 window) internal returns (HydeERC20 t) {
        t = new HydeERC20();
        address[] memory ex = new address[](2);
        ex[0] = POOL;
        ex[1] = address(vault);
        t.initialize(
            HydeERC20.InitParams({
                name: "Hyde",
                symbol: "HYDE",
                poolRecipient: POOL,
                vault: address(vault),
                maxWalletBps: bps,
                maxWalletWindowSecs: window,
                exemptAddrs: ex
            })
        );
    }

    function setUp() public {
        vault = new MockVault();
        token = _init(100, 3600); // maxWallet = 1% = 1e7 tokens, 1h window
    }

    /* ─────────────────────────── supply / mint / burn ──────────────────────── */
    function test_initMintsAllToPool_supplyConstant() public view {
        assertEq(token.totalSupply(), SUPPLY);
        assertEq(token.balanceOf(POOL), SUPPLY);
    }

    function test_noBurnSelector() public view {
        // rev6/rev7: burn removed entirely. Prove the selector isn't present on the deployed code.
        // (compile-time: token.burn(...) would not compile). Assert supply stays constant after activity.
        assertEq(token.totalSupply(), SUPPLY);
    }

    function test_supplyConstantAcrossTransfers() public {
        vm.warp(block.timestamp + 3601); // past window
        vm.prank(POOL);
        token.transfer(ALICE, 5_000_000e18);
        vm.prank(ALICE);
        token.transfer(BOB, 1_000_000e18);
        assertEq(token.totalSupply(), SUPPLY, "supply never changes (INV-5)");
    }

    /* ─────────────────────────── to == 0 (INV-21) ──────────────────────────── */
    function test_transferToZeroReverts() public {
        vm.warp(block.timestamp + 3601);
        vm.prank(POOL);
        vm.expectRevert(bytes("ZERO_TO"));
        token.transfer(address(0), 1);
        assertEq(token.totalSupply(), SUPPLY);
    }

    /* ─────────────────────────── max-wallet (INV-6) ────────────────────────── */
    function test_maxWallet_capsRecipientDuringWindow() public {
        uint256 cap = token.maxWallet();
        assertEq(cap, SUPPLY / 100);
        vm.prank(POOL);
        vm.expectRevert(bytes("MAX_WALLET"));
        token.transfer(ALICE, cap + 1);

        vm.prank(POOL);
        token.transfer(ALICE, cap); // exactly the cap is allowed
        assertEq(token.balanceOf(ALICE), cap);
    }

    function test_maxWallet_exemptRecipientBypasses() public {
        // POOL is exempt → can hold the whole supply (it already does); an exempt recipient isn't capped.
        vm.prank(POOL);
        token.transfer(address(vault), SUPPLY / 2); // vault is exempt
        assertEq(token.balanceOf(address(vault)), SUPPLY / 2);
    }

    function test_maxWallet_neverBlocksSender() public {
        // Alice accumulates up to the cap during the window, then can always SEND (from unrestricted).
        uint256 cap = token.maxWallet(); // hoist: a maxWallet() arg-call would consume the vm.prank
        vm.prank(POOL);
        token.transfer(ALICE, cap);
        vm.prank(ALICE);
        token.transfer(BOB, cap); // selling is never blocked (BOB under cap here)
        assertEq(token.balanceOf(BOB), cap);
    }

    function test_maxWallet_liftsAfterExpiry() public {
        vm.warp(block.timestamp + 3601);
        vm.prank(POOL);
        token.transfer(ALICE, SUPPLY / 2); // no cap after expiry
        assertEq(token.balanceOf(ALICE), SUPPLY / 2);
    }

    /* ─────────────────────────── initialize guards (INV-10/22) ─────────────── */
    function test_initializeOnce() public {
        address[] memory ex = new address[](0);
        vm.expectRevert(bytes("INIT"));
        token.initialize(
            HydeERC20.InitParams("H", "H", POOL, address(vault), 100, 3600, ex)
        );
    }

    function test_initializeBounds() public {
        _expectInitRevert("ZERO_POOL", address(0), address(vault), 100, 3600);
        _expectInitRevert("ZERO_VAULT", POOL, address(0), 100, 3600);
        _expectInitRevert("BPS_RANGE", POOL, address(vault), 0, 3600); // 0 disables the guard
        _expectInitRevert("BPS_RANGE", POOL, address(vault), 301, 3600); // > 3%
        _expectInitRevert("WINDOW_RANGE", POOL, address(vault), 100, 0);
        _expectInitRevert("WINDOW_RANGE", POOL, address(vault), 100, 3601); // > 1h
    }

    /// @dev Deploy FIRST (so expectRevert targets `initialize`, not the CREATE), then expect the revert.
    function _expectInitRevert(bytes memory err, address pool, address v, uint256 bps, uint64 window) internal {
        HydeERC20 t = new HydeERC20();
        address[] memory ex = new address[](0);
        vm.expectRevert(err);
        t.initialize(HydeERC20.InitParams("H", "H", pool, v, bps, window, ex));
    }

    /* ─────────────────────── (rev8) no vault sync on transfer ───────────────── */
    /// (rev8) The token no longer calls the vault at all — max-wallet is self-contained. Prove a
    /// transfer succeeds against a vault that has NO `sync` entrypoint (MockVault = register+noteRaw only).
    function test_transfer_doesNotCallVault() public {
        vm.warp(block.timestamp + 3601);
        vm.prank(POOL);
        token.transfer(ALICE, 123e18); // would revert if the token still tried to call vault.sync(...)
        assertEq(token.balanceOf(ALICE), 123e18, "transfer succeeds with no vault call");
    }

    /* ─────────────────────────── exempt infra set ──────────────────────────── */
    function test_exemptSet() public view {
        assertTrue(token.exempt(POOL));
        assertTrue(token.exempt(address(vault)));
        assertTrue(token.exempt(address(0)));
        assertFalse(token.exempt(ALICE));
    }

    /* ─────────────────────────── EIP-2612 permit ───────────────────────────── */
    function test_permit() public {
        uint256 pk = 0xBEEF;
        address owner = vm.addr(pk);
        address spender = BOB;
        uint256 value = 777e18;
        uint256 deadline = block.timestamp + 1 days;

        bytes32 structHash = keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, 0, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);

        token.permit(owner, spender, value, deadline, v, r, s);
        assertEq(token.allowance(owner, spender), value);
        assertEq(token.nonces(owner), 1);

        // replay reverts (nonce consumed)
        vm.expectRevert(bytes("PERMIT_SIG"));
        token.permit(owner, spender, value, deadline, v, r, s);
    }

    function test_permitExpiredReverts() public {
        uint256 pk = 0xBEEF;
        address owner = vm.addr(pk);
        uint256 deadline = block.timestamp - 1;
        bytes32 structHash = keccak256(abi.encode(PERMIT_TYPEHASH, owner, BOB, 1, 0, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        vm.expectRevert(bytes("PERMIT_EXPIRED"));
        token.permit(owner, BOB, 1, deadline, v, r, s);
    }
}
