// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {FlywheelVault} from "../../src/flywheel/FlywheelVault.sol";
import {FlywheelVaultFactory} from "../../src/flywheel/FlywheelVaultFactory.sol";
import {IFlywheelFeeSource} from "../../src/flywheel/interfaces/IFlywheelFeeSource.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {
    MockFlywheelFeeSource,
    MockFlywheelRewardConverter,
    MockFlywheelToken
} from "./mocks/MockFlywheel.sol";

contract FlywheelVaultTest is Test {
    uint32 internal constant DURATION = 7 days;
    address internal constant CONTROLLER = address(0xC0FFEE);
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);

    MockFlywheelToken internal token;
    MockERC20 internal quote;
    MockFlywheelFeeSource internal source;
    FlywheelVaultFactory internal vaultFactory;
    FlywheelVault internal vault;

    function setUp() public {
        vm.warp(1_000_000);
        token = new MockFlywheelToken();
        quote = new MockERC20(6);
        source = new MockFlywheelFeeSource();
        vaultFactory = new FlywheelVaultFactory(address(this));
        vault = vaultFactory.createVault(
            IFlywheelFeeSource(address(source)), address(quote), CONTROLLER, DURATION, keccak256("PRIMARY")
        );
        source.configure(address(token), address(vault));
        vault.initialize(address(token));

        token.mint(ALICE, 2_000_000e18);
        token.mint(BOB, 2_000_000e18);
        vm.prank(ALICE);
        token.approve(address(vault), type(uint256).max);
        vm.prank(BOB);
        token.approve(address(vault), type(uint256).max);
    }

    function test_initialize_isPermissionlessOneShot_andRequiresRegisteredReceiver() public {
        MockFlywheelToken freshToken = new MockFlywheelToken();
        FlywheelVault fresh = vaultFactory.createVault(
            IFlywheelFeeSource(address(source)), address(quote), CONTROLLER, DURATION, keccak256("FRESH")
        );

        vm.expectRevert(FlywheelVault.InvalidToken.selector);
        fresh.initialize(address(freshToken));

        source.configure(address(freshToken), address(fresh));
        vm.prank(ALICE);
        fresh.initialize(address(freshToken));
        assertEq(vaultFactory.vaultToken(address(fresh)), address(freshToken));
        assertEq(vaultFactory.tokenVault(address(freshToken)), address(fresh));
        vm.expectRevert(FlywheelVault.AlreadyInitialized.selector);
        fresh.initialize(address(freshToken));
    }

    function test_rewardsQueueWithoutStakers_thenStreamToFirstStake() public {
        _accrue(address(quote), 700e6);
        vault.pullFees(address(quote));
        (,,,,, uint256 queued, uint256 reserve,) = vault.rewardData(address(quote));
        assertEq(queued, 700e6);
        assertEq(reserve, 700e6);

        _stake(ALICE, 100e18);
        (,, uint256 finish,,, uint256 queuedAfter,,) = vault.rewardData(address(quote));
        assertEq(queuedAfter, 0);
        vm.warp(finish);

        vm.prank(ALICE);
        (, uint256 quoteReward) = vault.claimAll();
        assertEq(quoteReward, 700e6);
        assertEq(quote.balanceOf(ALICE), 700e6);
        assertTrue(vault.isSolvent(address(quote)));
    }

    function test_stakingWaitsForLaunchWindowExpiry() public {
        MockFlywheelToken delayedToken = new MockFlywheelToken();
        delayedToken.setMaxWalletExpiry(block.timestamp + 5 minutes);
        FlywheelVault delayed = vaultFactory.createVault(
            IFlywheelFeeSource(address(source)), address(quote), CONTROLLER, DURATION, keccak256("DELAYED")
        );
        source.configure(address(delayedToken), address(delayed));
        delayed.initialize(address(delayedToken));
        delayedToken.mint(ALICE, 100e18);
        vm.prank(ALICE);
        delayedToken.approve(address(delayed), type(uint256).max);

        vm.prank(ALICE);
        vm.expectRevert(FlywheelVault.StakingNotOpen.selector);
        delayed.stake(100e18);
        vm.warp(block.timestamp + 5 minutes);
        vm.prank(ALICE);
        delayed.stake(100e18);
        assertEq(delayed.balanceOf(ALICE), 100e18);
    }

    function test_streamIsTimeWeighted_andResistsPullTimeSniping() public {
        _stake(ALICE, 100e18);
        uint256 reward = uint256(DURATION) * 1e18;
        _accrue(address(quote), reward);
        vault.pullFees(address(quote));

        vm.warp(block.timestamp + 1 days);
        _stake(BOB, 100e18);
        vm.warp(block.timestamp + DURATION - 1 days);

        uint256 aliceExpected = 1 days * 1e18 + (uint256(DURATION) - 1 days) * 5e17;
        uint256 bobExpected = (uint256(DURATION) - 1 days) * 5e17;
        assertEq(vault.earned(ALICE, address(quote)), aliceExpected);
        assertEq(vault.earned(BOB, address(quote)), bobExpected);
        assertEq(aliceExpected + bobExpected, reward);
    }

    function test_tokenRewardsNeverConsumeStakedPrincipal() public {
        uint256 principal = 250e18;
        uint256 reward = uint256(DURATION) * 1e18;
        _stake(ALICE, principal);
        _accrue(address(token), reward);
        vault.pullFees(address(token));
        vm.warp(block.timestamp + DURATION);

        uint256 before = token.balanceOf(ALICE);
        vm.prank(ALICE);
        (uint256 tokenReward,) = vault.exit();
        assertEq(tokenReward, reward);
        assertEq(token.balanceOf(ALICE), before + principal + reward);
        assertEq(vault.totalStaked(), 0);
        assertEq(token.balanceOf(address(vault)), 0);
        assertTrue(vault.isSolvent(address(token)));
    }

    function test_lastExitPausesUnvestedRewards_andNextStakeResumesThem() public {
        _stake(ALICE, 100e18);
        uint256 reward = uint256(DURATION) * 1e18;
        _accrue(address(quote), reward);
        vault.pullFees(address(quote));

        vm.warp(block.timestamp + 1 days);
        vm.prank(ALICE);
        vault.withdraw(100e18);
        (,,,,, uint256 queued,,) = vault.rewardData(address(quote));
        assertEq(queued, (uint256(DURATION) - 1 days) * 1e18);
        assertEq(vault.earned(ALICE, address(quote)), 1 days * 1e18);

        _stake(BOB, 100e18);
        vm.warp(block.timestamp + DURATION);
        assertEq(vault.earned(BOB, address(quote)), queued);
        assertEq(vault.earned(ALICE, address(quote)) + vault.earned(BOB, address(quote)), reward);
    }

    function test_pullAndClaimBothAssetsInOneTransaction() public {
        _stake(ALICE, 100e18);
        uint256 tokenReward = uint256(DURATION) * 2e18;
        uint256 quoteReward = uint256(DURATION) * 3e6;
        _accrue(address(token), tokenReward);
        _accrue(address(quote), quoteReward);

        (uint256 tokenPulled, uint256 quotePulled) = vault.pullAllFees();
        assertEq(tokenPulled, tokenReward);
        assertEq(quotePulled, quoteReward);
        vm.warp(block.timestamp + DURATION);

        vm.prank(ALICE);
        (uint256 claimedToken, uint256 claimedQuote) = vault.claimAll();
        assertEq(claimedToken, tokenReward);
        assertEq(claimedQuote, quoteReward);
        assertTrue(vault.isSolvent(address(token)));
        assertTrue(vault.isSolvent(address(quote)));
    }

    function test_pullFeesCapturesAllocationAlreadyForwardedByAnotherCaller() public {
        _stake(ALICE, 100e18);
        _accrue(address(quote), 77e6);
        source.fundFlywheel(address(token), address(quote));

        assertEq(vault.pullFees(address(quote)), 77e6);
        (,,,,,, uint256 reserve,) = vault.rewardData(address(quote));
        assertEq(reserve, 77e6);
    }

    function test_initialize_recoversFeesForwardedBeforeBinding() public {
        MockFlywheelToken freshToken = new MockFlywheelToken();
        FlywheelVault fresh = vaultFactory.createVault(
            IFlywheelFeeSource(address(source)), address(quote), CONTROLLER, DURATION, keccak256("PRE_BIND_FEES")
        );
        source.configure(address(freshToken), address(fresh));
        quote.mint(address(fresh), 42e6);

        fresh.initialize(address(freshToken));
        (,,,,, uint256 queued, uint256 reserve,) = fresh.rewardData(address(quote));
        assertEq(queued, 42e6);
        assertEq(reserve, 42e6);
        freshToken.mint(ALICE, 100e18);
        vm.prank(ALICE);
        freshToken.approve(address(fresh), type(uint256).max);
        vm.prank(ALICE);
        fresh.stake(100e18);
        vm.warp(block.timestamp + DURATION);
        assertEq(fresh.earned(ALICE, address(quote)), 42e6);
    }

    function test_factoryPredictionMatchesDeterministicDeployment() public {
        FlywheelVaultFactory predictionFactory = new FlywheelVaultFactory(address(this));
        bytes32 salt = keccak256("OFFICIAL_FLYWHEEL");
        address predicted = predictionFactory.predictVault(
            address(this), IFlywheelFeeSource(address(source)), address(quote), CONTROLLER, DURATION, salt
        );
        FlywheelVault deployed =
            predictionFactory.createVault(IFlywheelFeeSource(address(source)), address(quote), CONTROLLER, DURATION, salt);
        assertEq(address(deployed), predicted);
    }

    function test_tinyDonationCannotExtendActiveStream() public {
        _stake(ALICE, 100e18);
        _accrue(address(quote), uint256(DURATION) * 1e6);
        vault.pullFees(address(quote));
        (,, uint256 originalFinish,,,,,) = vault.rewardData(address(quote));

        for (uint256 i; i < 20; ++i) {
            vm.warp(block.timestamp + 1 hours);
            quote.mint(address(vault), 1);
            vault.syncSurplus(address(quote));
            (,, uint256 finish,,,,,) = vault.rewardData(address(quote));
            assertEq(finish, originalFinish);
        }
        (,,,,, uint256 queued,,) = vault.rewardData(address(quote));
        assertEq(queued, 20);

        vm.warp(originalFinish);
        vm.prank(ALICE);
        vault.claimAll();
        (,, uint256 nextFinish,,, uint256 queuedAfter,,) = vault.rewardData(address(quote));
        assertEq(queuedAfter, 0);
        assertEq(nextFinish, originalFinish + DURATION);
    }

    function test_factoryRejectsSecondVaultForSameToken() public {
        FlywheelVault second = vaultFactory.createVault(
            IFlywheelFeeSource(address(source)), address(quote), CONTROLLER, DURATION, keccak256("SECOND")
        );
        source.configure(address(token), address(second));
        vm.expectRevert(FlywheelVaultFactory.TokenAlreadyBound.selector);
        second.initialize(address(token));
    }

    function test_creatorSelectsImmutableApprovedStockReward() public {
        (MockFlywheelToken customToken, MockERC20 stock, MockFlywheelRewardConverter converter, FlywheelVault custom) =
            _createStockVault("STOCK_SELECTION");

        assertEq(custom.REWARD_ASSET(), address(stock));
        assertEq(custom.rewardConverter(), address(converter));
        assertTrue(vaultFactory.isVaultConfigActive(address(custom)));
        assertTrue(address(customToken) != address(token));
    }

    function test_unapprovedRewardRouteCannotCreateVault() public {
        MockERC20 stock = new MockERC20(18);
        vm.expectRevert(FlywheelVaultFactory.InvalidRewardRoute.selector);
        vaultFactory.createVault(
            IFlywheelFeeSource(address(source)),
            address(quote),
            address(stock),
            CONTROLLER,
            DURATION,
            keccak256("UNAPPROVED")
        );
    }

    function test_onlyFactoryOwnerCanApproveRewardRoute() public {
        MockERC20 stock = new MockERC20(18);
        MockFlywheelRewardConverter converter = new MockFlywheelRewardConverter();
        vm.prank(ALICE);
        vm.expectRevert();
        vaultFactory.proposeRewardRoute(address(quote), address(stock), address(converter));
    }

    function test_factoryCannotRenounceEmergencyRouteControl() public {
        vm.expectRevert(FlywheelVaultFactory.OwnershipRenunciationDisabled.selector);
        vaultFactory.renounceOwnership();
    }

    function test_rewardRouteCannotActivateBeforeDelay() public {
        MockERC20 stock = new MockERC20(18);
        MockFlywheelRewardConverter converter = new MockFlywheelRewardConverter();
        vaultFactory.proposeRewardRoute(address(quote), address(stock), address(converter));
        vm.expectRevert(FlywheelVaultFactory.RewardRouteNotReady.selector);
        vaultFactory.activateRewardRoute(address(quote), address(stock));
    }

    function test_rewardRouteProposalCanBeInspectedAndCancelled() public {
        MockERC20 stock = new MockERC20(18);
        MockFlywheelRewardConverter converter = new MockFlywheelRewardConverter();
        vaultFactory.proposeRewardRoute(address(quote), address(stock), address(converter));
        (address pending, uint64 activateAfter) = vaultFactory.pendingRewardRoute(address(quote), address(stock));
        assertEq(pending, address(converter));
        assertEq(activateAfter, block.timestamp + vaultFactory.ROUTE_ACTIVATION_DELAY());

        vaultFactory.cancelRewardRouteProposal(address(quote), address(stock));
        (pending, activateAfter) = vaultFactory.pendingRewardRoute(address(quote), address(stock));
        assertEq(pending, address(0));
        assertEq(activateAfter, 0);
        vm.expectRevert(FlywheelVaultFactory.RewardRouteNotReady.selector);
        vaultFactory.activateRewardRoute(address(quote), address(stock));
    }

    function test_invalidRewardRouteConfigurationFailsClosed() public {
        MockERC20 stock = new MockERC20(18);
        MockFlywheelRewardConverter converter = new MockFlywheelRewardConverter();
        vm.expectRevert(FlywheelVaultFactory.InvalidRewardRoute.selector);
        vaultFactory.proposeRewardRoute(address(quote), address(quote), address(converter));
        vm.expectRevert(FlywheelVaultFactory.InvalidRewardRoute.selector);
        vaultFactory.proposeRewardRoute(address(quote), address(stock), ALICE);
        vm.expectRevert(FlywheelVaultFactory.InvalidRewardRoute.selector);
        vaultFactory.cancelRewardRouteProposal(address(quote), address(stock));
        vm.expectRevert(FlywheelVaultFactory.InvalidRewardRoute.selector);
        vaultFactory.disableRewardRoute(address(quote), address(stock));
    }

    function test_factoryOwnershipTransferRequiresAcceptance() public {
        vaultFactory.transferOwnership(ALICE);
        assertEq(vaultFactory.owner(), address(this));
        assertEq(vaultFactory.pendingOwner(), ALICE);
        vm.prank(ALICE);
        vaultFactory.acceptOwnership();
        assertEq(vaultFactory.owner(), ALICE);
        assertEq(vaultFactory.pendingOwner(), address(0));
    }

    function test_numeraireFeesConvertToStock_whileTokenFeesRemainNative() public {
        (MockFlywheelToken customToken, MockERC20 stock, MockFlywheelRewardConverter converter, FlywheelVault custom) =
            _createStockVault("MIXED_REWARDS");
        _stakeCustom(customToken, custom, ALICE, 100e18);

        uint256 tokenReward = uint256(DURATION) * 2e18;
        uint256 quoteFees = 700e6;
        customToken.mint(address(source), tokenReward);
        quote.mint(address(source), quoteFees);
        source.accrue(address(customToken), address(customToken), tokenReward);
        source.accrue(address(customToken), address(quote), quoteFees);

        (uint256 tokenPulled, uint256 quotePulled) = custom.pullAllFees();
        assertEq(tokenPulled, tokenReward);
        assertEq(quotePulled, quoteFees);
        assertEq(custom.pendingConversion(), quoteFees);
        (,,,,,, uint256 quoteRewardReserve,) = custom.rewardData(address(quote));
        assertEq(quoteRewardReserve, 0);

        uint256 stockOutput = custom.convertPending(0);
        assertEq(stockOutput, 700e18);
        assertEq(custom.pendingConversion(), 0);
        assertEq(quote.allowance(address(custom), address(converter)), 0);

        vm.warp(block.timestamp + DURATION);
        vm.prank(ALICE);
        (uint256 claimedToken, uint256 claimedStock) = custom.claimAll();
        assertEq(claimedToken, tokenReward);
        assertEq(claimedStock, stockOutput);
        assertEq(stock.balanceOf(ALICE), stockOutput);
        assertTrue(custom.isSolvent(address(customToken)));
        assertTrue(custom.isSolvent(address(stock)));
        assertTrue(custom.isSolvent(address(quote)));
    }

    function test_disabledRouteStopsConversion_withoutLockingStakeOrExistingRewards() public {
        (MockFlywheelToken customToken, MockERC20 stock,, FlywheelVault custom) =
            _createStockVault("DISABLE_ROUTE");
        _stakeCustom(customToken, custom, ALICE, 100e18);
        quote.mint(address(source), 10e6);
        source.accrue(address(customToken), address(quote), 10e6);
        custom.pullFees(address(quote));

        vaultFactory.disableRewardRoute(address(quote), address(stock));
        assertFalse(vaultFactory.isVaultConfigActive(address(custom)));
        vm.expectRevert(FlywheelVault.ConversionDisabled.selector);
        custom.convertPending(0);
        assertEq(custom.pendingConversion(), 10e6);

        vm.prank(ALICE);
        custom.withdraw(100e18);
        assertEq(customToken.balanceOf(ALICE), 2_000_000e18);
    }

    function test_delayedAdapterReplacementRecoversExistingVault() public {
        (MockFlywheelToken customToken, MockERC20 stock, MockFlywheelRewardConverter oldConverter, FlywheelVault custom) =
            _createStockVault("REPLACE_ROUTE");
        MockFlywheelRewardConverter replacement = new MockFlywheelRewardConverter();
        replacement.configure(1e12, 1, 9_900);
        stock.mint(address(replacement), 1_000_000e18);

        vaultFactory.proposeRewardRoute(address(quote), address(stock), address(replacement));
        assertEq(custom.rewardConverter(), address(oldConverter));
        vm.warp(block.timestamp + vaultFactory.ROUTE_ACTIVATION_DELAY());
        vaultFactory.activateRewardRoute(address(quote), address(stock));
        assertEq(custom.rewardConverter(), address(replacement));

        quote.mint(address(source), 10e6);
        source.accrue(address(customToken), address(quote), 10e6);
        custom.pullFees(address(quote));
        assertEq(custom.convertPending(0), 10e18);
        assertEq(quote.balanceOf(address(replacement)), 10e6);
        assertEq(quote.balanceOf(address(oldConverter)), 0);
    }

    function test_conversionEnforcesStricterCallerMinimum_andPreservesPendingOnRevert() public {
        (MockFlywheelToken customToken,, MockFlywheelRewardConverter converter, FlywheelVault custom) =
            _createStockVault("MIN_OUT");
        quote.mint(address(source), 10e6);
        source.accrue(address(customToken), address(quote), 10e6);
        custom.pullFees(address(quote));

        vm.expectRevert(bytes("SLIPPAGE"));
        custom.convertPending(11e18);
        assertEq(custom.pendingConversion(), 10e6);
        assertEq(quote.allowance(address(custom), address(converter)), 0);
    }

    function test_conversionRejectsAdapterMisreport() public {
        (MockFlywheelToken customToken,, MockFlywheelRewardConverter converter, FlywheelVault custom) =
            _createStockVault("MISREPORT");
        quote.mint(address(source), 10e6);
        source.accrue(address(customToken), address(quote), 10e6);
        custom.pullFees(address(quote));
        converter.setMisreport(true);

        vm.expectRevert(FlywheelVault.TransferMismatch.selector);
        custom.convertPending(0);
        assertEq(custom.pendingConversion(), 10e6);
    }

    function test_customFactoryPredictionMatchesDeployment() public {
        MockERC20 stock = new MockERC20(18);
        MockFlywheelRewardConverter converter = new MockFlywheelRewardConverter();
        _approveRoute(stock, converter);
        bytes32 salt = keccak256("STOCK_PREDICTION");
        address predicted = vaultFactory.predictVault(
            address(this),
            IFlywheelFeeSource(address(source)),
            address(quote),
            address(stock),
            CONTROLLER,
            DURATION,
            salt
        );
        FlywheelVault deployed = vaultFactory.createVault(
            IFlywheelFeeSource(address(source)),
            address(quote),
            address(stock),
            CONTROLLER,
            DURATION,
            salt
        );
        assertEq(address(deployed), predicted);
    }

    function testFuzz_twoStakerConservation(uint128 aliceStake, uint128 bobStake, uint128 reward) public {
        aliceStake = uint128(bound(aliceStake, 1e9, 1_000_000e18));
        bobStake = uint128(bound(bobStake, 1e9, 1_000_000e18));
        reward = uint128(bound(reward, DURATION, 1_000_000e18));
        _stake(ALICE, aliceStake);
        _stake(BOB, bobStake);
        _accrue(address(quote), reward);
        vault.pullFees(address(quote));
        vm.warp(block.timestamp + DURATION);

        uint256 aliceEarned = vault.earned(ALICE, address(quote));
        uint256 bobEarned = vault.earned(BOB, address(quote));
        assertLe(aliceEarned + bobEarned, reward);
        assertLe(reward - aliceEarned - bobEarned, 2);
        assertTrue(vault.isSolvent(address(quote)));
    }

    function testFuzz_selectedRewardConversionConservesValue(uint128 rawQuoteFees) public {
        uint256 quoteFees = bound(uint256(rawQuoteFees), 1, 1_000_000e6);
        (MockFlywheelToken customToken, MockERC20 stock,, FlywheelVault custom) =
            _createStockVault("FUZZ_CONVERSION");
        _stakeCustom(customToken, custom, ALICE, 100e18);
        quote.mint(address(source), quoteFees);
        source.accrue(address(customToken), address(quote), quoteFees);

        assertEq(custom.pullFees(address(quote)), quoteFees);
        assertEq(custom.pendingConversion(), quoteFees);
        uint256 output = custom.convertPending(quoteFees * 1e12 * 99 / 100);
        assertEq(output, quoteFees * 1e12);
        assertEq(custom.pendingConversion(), 0);

        vm.warp(block.timestamp + DURATION);
        vm.prank(ALICE);
        (, uint256 claimed) = custom.claimAll();
        assertEq(claimed, output);
        assertEq(stock.balanceOf(ALICE), output);
        assertTrue(custom.isSolvent(address(stock)));
        assertTrue(custom.isSolvent(address(quote)));
    }

    function _stake(address account, uint256 amount) private {
        vm.prank(account);
        vault.stake(amount);
    }

    function _createStockVault(string memory label)
        private
        returns (
            MockFlywheelToken customToken,
            MockERC20 stock,
            MockFlywheelRewardConverter converter,
            FlywheelVault custom
        )
    {
        customToken = new MockFlywheelToken();
        stock = new MockERC20(18);
        converter = new MockFlywheelRewardConverter();
        converter.configure(1e12, 1, 9_900);
        stock.mint(address(converter), 10_000_000e18);
        _approveRoute(stock, converter);
        custom = vaultFactory.createVault(
            IFlywheelFeeSource(address(source)),
            address(quote),
            address(stock),
            CONTROLLER,
            DURATION,
            keccak256(bytes(label))
        );
        source.configure(address(customToken), address(custom));
        custom.initialize(address(customToken));
        customToken.mint(ALICE, 2_000_000e18);
    }

    function _stakeCustom(MockFlywheelToken customToken, FlywheelVault custom, address account, uint256 amount) private {
        vm.startPrank(account);
        customToken.approve(address(custom), type(uint256).max);
        custom.stake(amount);
        vm.stopPrank();
    }

    function _approveRoute(MockERC20 stock, MockFlywheelRewardConverter converter) private {
        vaultFactory.proposeRewardRoute(address(quote), address(stock), address(converter));
        vm.warp(block.timestamp + vaultFactory.ROUTE_ACTIVATION_DELAY());
        vaultFactory.activateRewardRoute(address(quote), address(stock));
    }

    function _accrue(address asset, uint256 amount) private {
        if (asset == address(token)) token.mint(address(source), amount);
        else quote.mint(address(source), amount);
        source.accrue(address(token), asset, amount);
    }
}
