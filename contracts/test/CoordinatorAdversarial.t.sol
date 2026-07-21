// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {HydeStackCoordinator} from "../script/DeployWethStack4663.s.sol";

/// @notice Adversarial unit tests for the deploy coordinator's guards (kami 23562). These need NO 4663 fork:
///         they exercise the ordered checks (owner → not-finalized → chainid → create) before any child is
///         built. Full-deploy adversarial cases (finalize-repeat, address-drift, atomic rollback) run on a
///         real 4663 fork in WethCoordinatorForkSmoke.t.sol (they require live V4 core code to reach them).
contract CoordinatorAdversarialTest is Test {
    address internal owner = makeAddr("owner");
    address internal attacker = makeAddr("attacker");

    function test_constructor_rejects_zero_owner() public {
        vm.expectRevert(bytes("OWNER_ZERO"));
        new HydeStackCoordinator(address(0));
    }

    function test_deploy_onlyOwner() public {
        HydeStackCoordinator coord = new HydeStackCoordinator(owner);
        HydeStackCoordinator.Codes memory c; // owner check is FIRST → reverts before touching the codes
        vm.prank(attacker);
        vm.expectRevert(bytes("ONLY_OWNER"));
        coord.deploy(c);
    }

    function test_deploy_wrongChain() public {
        // Default test chainid (31337) != 4663 → WRONG_CHAIN (owner passes first, chainid gate blocks).
        HydeStackCoordinator coord = new HydeStackCoordinator(owner);
        HydeStackCoordinator.Codes memory c;
        vm.prank(owner);
        vm.expectRevert(bytes("WRONG_CHAIN"));
        coord.deploy(c);
    }

    function test_deploy_rejects_empty_initcode() public {
        vm.chainId(4663); // pass the chain gate to reach the create path
        HydeStackCoordinator coord = new HydeStackCoordinator(owner);
        HydeStackCoordinator.Codes memory c; // implCode is empty → first _create reverts EMPTY_CODE
        vm.prank(owner);
        vm.expectRevert(bytes("EMPTY_CODE"));
        coord.deploy(c);
    }

    function test_deploy_rejects_garbage_initcode() public {
        vm.chainId(4663);
        HydeStackCoordinator coord = new HydeStackCoordinator(owner);
        HydeStackCoordinator.Codes memory c;
        c.implCode = hex"fe"; // INVALID opcode as initcode → create returns address(0) → CREATE_FAIL
        vm.prank(owner);
        vm.expectRevert(bytes("CREATE_FAIL"));
        coord.deploy(c);
    }
}
