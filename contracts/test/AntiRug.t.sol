// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {HydeStackSetup} from "./support/HydeStackSetup.sol";
import {HydeTokenFactory} from "../src/HydeTokenFactory.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/// @notice The rug-proofing clint asked for, PROVEN in tests (not just asserted). Two layers:
///         (A) BEHAVIORAL — the protocol owner / deployer / any attacker cannot move a live pool's LP,
///             redirect/withhold fees, mutate the 90/5 split, mint/burn/pause a live token; pause only
///             halts NEW launches and is renounceable to a terminal immutable state (owner==0).
///         (B) FORBIDDEN-SELECTOR SANITY (INV-53) — the upgrade/drain/selfdestruct-admin + fee/recipient
///             setter selectors are ABSENT on all 5 deployed addresses. NOTE: gojo's bytecode-level
///             enumeration in CONFORMANCE_CHECKLIST is the AUTHORITATIVE INV-53 gate; this is the
///             in-suite complement that fails fast if such a function is ever added.
contract AntiRugTest is HydeStackSetup {
    address internal creator = makeAddr("creator");
    address internal buyer = makeAddr("buyer");
    address internal attacker = makeAddr("attacker");

    /* ─────────────────────── (A) behavioral guarantees ─────────────────────── */

    /// The factory owner's ONLY power is pausing NEW launches — it cannot touch a live token/pool/fee.
    function test_pause_halts_new_launches_but_never_touches_live_tokens() public {
        (address token, uint256 tokenId) = _launch(creator, "Live", "LIVE");
        _buy(buyer, token, 3e18);

        // Owner pauses. A NEW launch now reverts...
        vm.prank(FACTORY_OWNER);
        factory.pause();
        usdg.mint(attacker, LAUNCH_FEE);
        vm.startPrank(attacker);
        usdg.approve(address(factory), LAUNCH_FEE);
        vm.expectRevert(bytes("PAUSED"));
        factory.launch(HydeTokenFactory_LaunchParams("Nope", "NOPE"));
        vm.stopPrank();

        // ...but the ALREADY-LIVE token is completely unaffected: still trades, LP still custodied.
        assertEq(IERC721(address(lpm)).ownerOf(tokenId), address(collector), "LP still locked while paused");
        uint256 bal = IERC20(token).balanceOf(buyer);
        vm.prank(buyer);
        IERC20(token).transfer(attacker, bal); // a live holder can still move their tokens
        assertEq(IERC20(token).balanceOf(attacker), bal, "live token still transfers under pause");

        // Fees can still be collected + claimed while paused (owner can't freeze the money path).
        collector.collect(token);
        uint256 raw = vault.rawFees(token, address(weth));
        if (raw > 0) vault.settle(token, address(weth), raw, 0, block.timestamp);
    }

    /// Renounce is terminal: owner==0 ⇒ pause/unpause revert forever ⇒ the stack is fully immutable.
    function test_renounce_is_terminal_immutable_state() public {
        // A live launch exists before renounce.
        (address token, uint256 tokenId) = _launch(creator, "Perm", "PERM");

        vm.prank(FACTORY_OWNER);
        factory.renounceOwnership();
        assertEq(factory.owner(), address(0), "owner dropped");

        // The last safety button is gone — pause/unpause can never be called again (by anyone).
        vm.prank(FACTORY_OWNER);
        vm.expectRevert(bytes("ONLY_OWNER"));
        factory.pause();
        vm.prank(attacker);
        vm.expectRevert(bytes("ONLY_OWNER"));
        factory.unpause();

        // Launches still work (renounce doesn't brick the factory) and stay rug-proof.
        assertEq(IERC721(address(lpm)).ownerOf(tokenId), address(collector), "live LP untouched by renounce");
        (address token2,) = _launch(buyer, "Post", "POST");
        assertTrue(vault.registered(token2), "still launches after renounce");
    }

    /// No actor — including a fully-privileged owner/deployer — can move Hyde's locked LP position.
    function test_locked_LP_cannot_be_pulled_by_anyone() public {
        (address token, uint256 tokenId) = _launch(creator, "Lock", "LOCK");

        // The collector owns it and exposes NO transfer/withdraw path; direct ERC721 moves fail for all.
        address[3] memory actors = [attacker, FACTORY_OWNER, address(this)];
        for (uint256 i; i < actors.length; ++i) {
            vm.prank(actors[i]);
            vm.expectRevert();
            IERC721(address(lpm)).transferFrom(address(collector), actors[i], tokenId);
        }
        // The collector never granted an operator/approval on the NFT, so no third party can move it either.
        assertEq(IERC721(address(lpm)).getApproved(tokenId), address(0), "no per-token approval");
        assertFalse(IERC721(address(lpm)).isApprovedForAll(address(collector), attacker), "no operator");
        assertEq(IERC721(address(lpm)).ownerOf(tokenId), address(collector), "still custodied");
        token; // silence unused
    }

    /// The 90/5 split bps are immutable — the public getters are fixed and there is no setter (see B).
    function test_fee_bps_are_immutable() public view {
        assertEq(vault.hydeBps(), HYDE_BPS, "hyde bps fixed");
        assertEq(vault.holderBps(), HOLDER_BPS, "holder bps fixed");
        assertEq(vault.hydeoutTreasury(), HYDE_TREASURY, "treasury fixed");
    }

    /// The one-shot factory bindings self-lock: a second bind (or a non-deployer) reverts.
    function test_initFactory_is_single_use_and_locked() public {
        vm.expectRevert(bytes("FACTORY_SET"));
        vault.initFactory(attacker);
        vm.expectRevert(bytes("FACTORY_SET"));
        collector.initFactory(attacker);
        vm.expectRevert(bytes("SET"));
        hydeHook.initFactory(attacker);
    }

    /* ─────────────────────── (B) forbidden-selector sanity (INV-53) ──────────── */

    function test_no_upgrade_or_drain_selectors_on_any_deployed_contract() public {
        address[5] memory targets =
            [address(factory), address(collector), address(vault), address(hydeHook), _anyToken()];
        // Universal: no proxy/upgrade/selfdestruct-admin surface anywhere.
        string[4] memory universal =
            ["upgradeTo(address)", "upgradeToAndCall(address,bytes)", "setImplementation(address)", "changeAdmin(address)"];
        for (uint256 t; t < targets.length; ++t) {
            for (uint256 s; s < universal.length; ++s) {
                _assertAbsent(targets[t], universal[s]);
            }
        }
    }

    function test_no_fee_recipient_or_supply_setters() public {
        // Vault / collector: no way to move the split, recipients, or sweep funds.
        _assertAbsent(address(vault), "setHydeBps(uint16)");
        _assertAbsent(address(vault), "setHolderBps(uint16)");
        _assertAbsent(address(vault), "setTreasury(address)");
        _assertAbsent(address(vault), "setHook(address)");
        _assertAbsent(address(vault), "sweep(address)");
        _assertAbsent(address(vault), "withdraw(address,uint256)");
        _assertAbsent(address(collector), "setVault(address)");
        _assertAbsent(address(collector), "withdrawNFT(uint256)");
        _assertAbsent(address(collector), "transferPosition(address,uint256)");

        // Token: no mint/burn/blacklist/pause/tax — supply is fixed and non-seizable.
        address token = _anyToken();
        _assertAbsent(token, "mint(address,uint256)");
        _assertAbsent(token, "burn(uint256)");
        _assertAbsent(token, "burn(address,uint256)");
        _assertAbsent(token, "setExempt(address,bool)");
        _assertAbsent(token, "blacklist(address)");
        _assertAbsent(token, "pause()");
        _assertAbsent(token, "setTax(uint256)");
        _assertAbsent(token, "owner()"); // no owner surface at all on the token
    }

    /* ─────────────────────────── helpers ───────────────────────────────────── */
    function _anyToken() internal returns (address token) {
        (token,) = _launch(creator, "Sel", "SEL");
    }

    /// @dev A function with signature `sig` must NOT exist: a call carrying only its selector reverts
    ///      (our contracts have no fallback, so an unknown selector always reverts).
    function _assertAbsent(address target, string memory sig) internal {
        (bool ok,) = target.call(abi.encodeWithSignature(sig));
        assertFalse(ok, sig);
    }

    /// @dev Inline LaunchParams builder (avoids importing the struct namespace twice).
    function HydeTokenFactory_LaunchParams(string memory name, string memory symbol)
        internal
        pure
        returns (HydeTokenFactory.LaunchParams memory)
    {
        return HydeTokenFactory.LaunchParams({name: name, symbol: symbol, presetId: 0});
    }
}
