// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { HydeFeeSplitter, HydeSplitterFactory } from "../src/HydeFeeSplitter.sol";

contract MockERC20 {
    string public name;
    mapping(address => uint256) public balanceOf;

    constructor(string memory name_) {
        name = name_;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract HydeFeeSplitterTest is Test {
    HydeSplitterFactory factory;
    MockERC20 weth;
    MockERC20 token;

    address treasury = address(0x7EA);
    address creator = address(0xC0FFEE);
    uint256 constant HYDE_BPS = 100; // 1%

    function setUp() public {
        factory = new HydeSplitterFactory(treasury, HYDE_BPS);
        weth = new MockERC20("WETH");
        token = new MockERC20("TOKEN");
    }

    /* ─── factory ──────────────────────────────────────────────────────────── */

    function test_constructor_guards() public {
        vm.expectRevert(HydeSplitterFactory.InvalidTreasury.selector);
        new HydeSplitterFactory(address(0), HYDE_BPS);

        vm.expectRevert(HydeSplitterFactory.InvalidBps.selector);
        new HydeSplitterFactory(treasury, 0);

        vm.expectRevert(HydeSplitterFactory.InvalidBps.selector);
        new HydeSplitterFactory(treasury, 1_001); // > 10% hard cap
    }

    function test_predictClone_matches_deployment() public {
        address predicted = factory.predictClone(creator);
        address deployed = factory.cloneFor(creator);
        assertEq(deployed, predicted, "CREATE2 prediction must match deployment");
        assertEq(HydeFeeSplitter(payable(deployed)).creator(), creator);
    }

    function test_cloneFor_idempotent() public {
        address first = factory.cloneFor(creator);
        address second = factory.cloneFor(creator);
        assertEq(first, second);
    }

    function test_cloneFor_zero_creator_reverts() public {
        vm.expectRevert(HydeSplitterFactory.ZeroCreator.selector);
        factory.cloneFor(address(0));
    }

    function test_distinct_creators_get_distinct_clones() public {
        assertTrue(factory.predictClone(creator) != factory.predictClone(address(0xB0B)));
    }

    function test_initialize_cannot_rerun() public {
        address clone = factory.cloneFor(creator);
        vm.expectRevert(HydeFeeSplitter.AlreadyInitialized.selector);
        HydeFeeSplitter(payable(clone)).initialize(address(0xBAD));
    }

    /* ─── the core property: fees sent BEFORE deployment are never stranded ── */

    function test_fees_before_deployment_then_split() public {
        address predicted = factory.predictClone(creator);

        // Doppler migrator pushes fees to buybackDst before anyone deployed it
        weth.mint(predicted, 10 ether);
        token.mint(predicted, 1_000_000 ether);

        // anyone materializes the clone and splits
        factory.cloneFor(creator);
        address[] memory tokens = new address[](2);
        tokens[0] = address(weth);
        tokens[1] = address(token);
        HydeFeeSplitter(payable(predicted)).split(tokens);

        assertEq(weth.balanceOf(treasury), 0.1 ether, "treasury 1% WETH");
        assertEq(weth.balanceOf(creator), 9.9 ether, "creator 99% WETH");
        assertEq(token.balanceOf(treasury), 10_000 ether, "treasury 1% token");
        assertEq(token.balanceOf(creator), 990_000 ether, "creator 99% token");
        assertEq(weth.balanceOf(predicted), 0, "nothing left behind");
        assertEq(token.balanceOf(predicted), 0, "nothing left behind");
    }

    function test_split_eth() public {
        address clone = factory.cloneFor(creator);
        vm.deal(clone, 1 ether);

        HydeFeeSplitter(payable(clone)).split(new address[](0));

        assertEq(treasury.balance, 0.01 ether);
        assertEq(creator.balance, 0.99 ether);
        assertEq(clone.balance, 0);
    }

    function test_split_zero_balance_noop() public {
        address clone = factory.cloneFor(creator);
        address[] memory tokens = new address[](1);
        tokens[0] = address(weth);
        HydeFeeSplitter(payable(clone)).split(tokens); // must not revert
        assertEq(weth.balanceOf(treasury), 0);
        assertEq(weth.balanceOf(creator), 0);
    }

    function test_split_callable_by_anyone() public {
        address clone = factory.cloneFor(creator);
        weth.mint(clone, 1 ether);
        address[] memory tokens = new address[](1);
        tokens[0] = address(weth);

        vm.prank(address(0xDEAD)); // arbitrary caller
        HydeFeeSplitter(payable(clone)).split(tokens);
        assertEq(weth.balanceOf(creator), 0.99 ether);
    }

    /* ─── fuzz: split is exact and total-preserving for any amount ─────────── */

    function testFuzz_split_exact(uint128 amount) public {
        vm.assume(amount > 0);
        address clone = factory.cloneFor(creator);
        weth.mint(clone, amount);

        address[] memory tokens = new address[](1);
        tokens[0] = address(weth);
        HydeFeeSplitter(payable(clone)).split(tokens);

        uint256 expectedTreasury = (uint256(amount) * HYDE_BPS) / 10_000;
        assertEq(weth.balanceOf(treasury), expectedTreasury);
        assertEq(weth.balanceOf(creator), uint256(amount) - expectedTreasury);
        assertEq(weth.balanceOf(clone), 0, "total preserved, nothing stranded");
    }
}
