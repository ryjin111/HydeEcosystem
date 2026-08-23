// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {FlywheelVault} from "../../src/flywheel/FlywheelVault.sol";
import {FlywheelVaultFactory} from "../../src/flywheel/FlywheelVaultFactory.sol";
import {IFlywheelFeeSource} from "../../src/flywheel/interfaces/IFlywheelFeeSource.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockFlywheelFeeSource, MockFlywheelToken} from "./mocks/MockFlywheel.sol";

contract FlywheelVaultHandler is Test {
    FlywheelVault public immutable vault;
    MockFlywheelFeeSource public immutable source;
    MockFlywheelToken public immutable token;
    MockERC20 public immutable quote;

    address[3] internal actors = [address(0xA11CE), address(0xB0B), address(0xCA11E)];
    uint256 public capturedToken;
    uint256 public capturedQuote;
    uint256 public claimedToken;
    uint256 public claimedQuote;

    constructor(FlywheelVault vault_, MockFlywheelFeeSource source_, MockFlywheelToken token_, MockERC20 quote_) {
        vault = vault_;
        source = source_;
        token = token_;
        quote = quote_;
    }

    function stake(uint8 actorSeed, uint96 rawAmount) external {
        address actor = actors[actorSeed % actors.length];
        uint256 available = token.balanceOf(actor);
        if (available == 0) return;
        uint256 amount = bound(uint256(rawAmount), 1, available);
        vm.prank(actor);
        vault.stake(amount);
    }

    function withdraw(uint8 actorSeed, uint96 rawAmount) external {
        address actor = actors[actorSeed % actors.length];
        uint256 staked = vault.balanceOf(actor);
        if (staked == 0) return;
        uint256 amount = bound(uint256(rawAmount), 1, staked);
        vm.prank(actor);
        vault.withdraw(amount);
    }

    function accrueAndPull(bool tokenAsset, uint96 rawAmount) external {
        address asset = tokenAsset ? address(token) : address(quote);
        uint256 amount = bound(uint256(rawAmount), 1, 1_000_000e18);
        if (tokenAsset) token.mint(address(source), amount);
        else quote.mint(address(source), amount);
        source.accrue(address(token), asset, amount);
        uint256 captured = vault.pullFees(asset);
        if (tokenAsset) capturedToken += captured;
        else capturedQuote += captured;
    }

    function claim(uint8 actorSeed) external {
        address actor = actors[actorSeed % actors.length];
        vm.prank(actor);
        (uint256 tokenAmount, uint256 quoteAmount) = vault.claimAll();
        claimedToken += tokenAmount;
        claimedQuote += quoteAmount;
    }

    function warp(uint32 elapsed) external {
        vm.warp(block.timestamp + bound(uint256(elapsed), 1, 14 days));
    }

    function actorAt(uint256 index) external view returns (address) {
        return actors[index];
    }
}

contract FlywheelVaultInvariantTest is Test {
    uint32 internal constant DURATION = 7 days;

    MockFlywheelToken internal token;
    MockERC20 internal quote;
    MockFlywheelFeeSource internal source;
    FlywheelVault internal vault;
    FlywheelVaultHandler internal handler;

    function setUp() public {
        vm.warp(1_000_000);
        token = new MockFlywheelToken();
        quote = new MockERC20(6);
        source = new MockFlywheelFeeSource();
        FlywheelVaultFactory vaultFactory = new FlywheelVaultFactory(address(this));
        vault = vaultFactory.createVault(
            IFlywheelFeeSource(address(source)), address(quote), address(this), DURATION, keccak256("INVARIANT")
        );
        source.configure(address(token), address(vault));
        vault.initialize(address(token));
        handler = new FlywheelVaultHandler(vault, source, token, quote);

        for (uint256 i; i < 3; ++i) {
            address actor = handler.actorAt(i);
            token.mint(actor, 1_000_000e18);
            vm.prank(actor);
            token.approve(address(vault), type(uint256).max);
        }
        targetContract(address(handler));
    }

    function invariant_principalAndRewardReservesStaySolvent() public view {
        (,,,,,, uint256 tokenReserve,) = vault.rewardData(address(token));
        (,,,,,, uint256 quoteReserve,) = vault.rewardData(address(quote));
        assertEq(token.balanceOf(address(vault)), vault.totalStaked() + tokenReserve);
        assertEq(quote.balanceOf(address(vault)), quoteReserve);
        assertTrue(vault.isSolvent(address(token)));
        assertTrue(vault.isSolvent(address(quote)));
    }

    function invariant_capturedRewardsEqualClaimsPlusReserve() public view {
        (,,,,,, uint256 tokenReserve,) = vault.rewardData(address(token));
        (,,,,,, uint256 quoteReserve,) = vault.rewardData(address(quote));
        assertEq(handler.capturedToken(), handler.claimedToken() + tokenReserve);
        assertEq(handler.capturedQuote(), handler.claimedQuote() + quoteReserve);
    }

    function invariant_stakeLedgerConservesPrincipal() public view {
        uint256 userTotal;
        for (uint256 i; i < 3; ++i) {
            userTotal += vault.balanceOf(handler.actorAt(i));
        }
        assertEq(userTotal, vault.totalStaked());
    }
}
