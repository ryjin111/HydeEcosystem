// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";

import {HydeERC20} from "../../src/v3/HydeERC20.sol";
import {TickMath} from "../../src/v3/libraries/TickMath.sol";
import {TrenchV3Factory} from "../../src/v5v3/TrenchV3Factory.sol";
import {TrenchV3Graduator} from "../../src/v5v3/TrenchV3Graduator.sol";
import {TrenchV3Locker} from "../../src/v5v3/TrenchV3Locker.sol";
import {FlywheelVault} from "../../src/flywheel/FlywheelVault.sol";
import {FlywheelVaultFactory} from "../../src/flywheel/FlywheelVaultFactory.sol";
import {IFlywheelFeeSource} from "../../src/flywheel/interfaces/IFlywheelFeeSource.sol";
import {MockFlywheelRewardConverter} from "../flywheel/mocks/MockFlywheel.sol";
import {MockERC20} from "../v3/mocks/MockERC20.sol";
import {MockTrenchV3Factory, MockTrenchV3Pool, MockTrenchV3PositionManager} from "./mocks/MockTrenchV3.sol";

contract TrenchV3LifecycleTest is Test {
    uint24 internal constant FEE = 10_000;
    int24 internal constant SPACING = 200;
    uint32 internal constant GRADUATION_DELAY = 300;

    address internal constant CREATOR = address(0xC0FFEE);
    address internal constant HYDE = address(0x5EED);
    address internal constant LAUNCH_TREASURY = address(0x1A0C);
    address internal constant CRANKER = address(0xBEEF);

    MockERC20 internal quote;
    MockTrenchV3Factory internal uniFactory;
    MockTrenchV3PositionManager internal positionManager;
    TrenchV3Factory internal factory;
    TrenchV3Graduator internal graduator;
    TrenchV3Locker internal locker;
    FlywheelVaultFactory internal vaultFactory;

    function setUp() public {
        quote = new MockERC20("USDT0", "USDT0", 6);
        uniFactory = new MockTrenchV3Factory();
        uniFactory.setSpacing(FEE, SPACING);
        positionManager = new MockTrenchV3PositionManager(uniFactory);
        HydeERC20 impl = new HydeERC20();
        vaultFactory = new FlywheelVaultFactory(address(this));

        factory = new TrenchV3Factory(
            TrenchV3Factory.Config({
                impl: address(impl),
                v3Factory: address(uniFactory),
                positionManager: address(positionManager),
                flywheelVaultFactory: address(vaultFactory),
                hydeTreasury: HYDE,
                numeraire: address(quote),
                numeraireDecimals: 6,
                feeTier: FEE,
                startFdvWad: 5_000e18,
                graduationFdvWad: 50_000e18,
                launchFeeAsset: address(quote),
                launchFeeAmount: 1e6,
                launchFeeNative: false,
                launchFeeTreasury: LAUNCH_TREASURY,
                maxWalletBps: 200,
                maxWalletWindowSecs: 60,
                observationCardinality: 16,
                graduationDelay: GRADUATION_DELAY,
                twapTickTolerance: SPACING,
                minimumProceeds: 1,
                maxCurveDust: 10e18,
                maxPermanentTokenDust: 100e18,
                maxPermanentQuoteDust: 1_000,
                owner: address(this)
            })
        );
        graduator = factory.GRADUATOR();
        locker = factory.LOCKER();

        quote.mint(CREATOR, 10e6);
        vm.prank(CREATOR);
        quote.approve(address(factory), type(uint256).max);
    }

    function test_curve_to_locked_graduation_token0() public {
        _assertFullLifecycle(true);
    }

    function test_curve_to_locked_graduation_token1() public {
        _assertFullLifecycle(false);
    }

    function test_curve_fees_are_95_5_and_do_not_advance_progress() public {
        (address token, uint256 curveTokenId,) = _launchWithOrdering(true, "FEE");
        TrenchV3Graduator.CurveProgress memory beforeProgress = graduator.curveProgress(token);

        uint256 tokenFees = 1_000e18;
        uint256 quoteFees = 500e6;
        quote.mint(address(positionManager), quoteFees);
        positionManager.setFees(
            curveTokenId, token < address(quote) ? tokenFees : quoteFees, token < address(quote) ? quoteFees : tokenFees
        );

        vm.prank(CRANKER);
        graduator.collectCurveFees(token);

        TrenchV3Graduator.CurveProgress memory afterProgress = graduator.curveProgress(token);
        assertEq(afterProgress.sold, beforeProgress.sold, "fees changed sold principal");
        assertEq(afterProgress.quotePrincipal, beforeProgress.quotePrincipal, "fees changed quote principal");

        uint256 expectedCreatorToken = tokenFees - (tokenFees * 500) / 10_000;
        uint256 expectedHydeToken = tokenFees - expectedCreatorToken;
        uint256 expectedCreatorQuote = quoteFees - (quoteFees * 500) / 10_000;
        uint256 expectedHydeQuote = quoteFees - expectedCreatorQuote;
        assertEq(locker.creatorClaimable(token, token), expectedCreatorToken);
        assertEq(locker.hydeClaimable(token, token), expectedHydeToken);
        assertEq(locker.creatorClaimable(token, address(quote)), expectedCreatorQuote);
        assertEq(locker.hydeClaimable(token, address(quote)), expectedHydeQuote);

        vm.warp(block.timestamp + 61);
        locker.claimCreator(token, token);
        locker.claimCreator(token, address(quote));
        locker.claimHyde(token, token);
        locker.claimHyde(token, address(quote));

        assertEq(HydeERC20(token).balanceOf(CREATOR), expectedCreatorToken);
        assertEq(HydeERC20(token).balanceOf(HYDE), expectedHydeToken);
        assertEq(quote.balanceOf(CREATOR), 9e6 + expectedCreatorQuote);
        assertEq(quote.balanceOf(HYDE), expectedHydeQuote);
        assertEq(locker.accountedBalance(token), 0);
        assertEq(locker.accountedBalance(address(quote)), 0);
    }

    function test_flywheel_launch_routes_fees_90_5_5() public {
        FlywheelVault receiver = vaultFactory.createVault(
            IFlywheelFeeSource(address(locker)), address(quote), CREATOR, 7 days, keccak256("V3_FLYWHEEL")
        );
        bytes32 salt = _findSalt(true, "FLYWHEEL");
        vm.prank(CREATOR);
        (address token, uint256 curveTokenId) =
            factory.launchFlywheel("Flywheel Token", "FLYW", salt, address(receiver));
        assertEq(receiver.stakingToken(), token, "vault not atomically initialized");
        assertEq(vaultFactory.vaultToken(address(receiver)), token);
        assertEq(locker.flywheelRecipient(token), address(receiver));
        assertTrue(HydeERC20(token).exempt(address(receiver)), "receiver not launch-window exempt");
        uint256 tokenFees = 1_000e18;
        uint256 quoteFees = 500e6;
        quote.mint(address(positionManager), quoteFees);
        positionManager.setFees(
            curveTokenId, token < address(quote) ? tokenFees : quoteFees, token < address(quote) ? quoteFees : tokenFees
        );
        graduator.collectCurveFees(token);

        uint256 expectedFlywheelToken = (tokenFees * 9_000) / 10_000;
        uint256 expectedCreatorToken = (tokenFees * 500) / 10_000;
        uint256 expectedHydeToken = tokenFees - expectedFlywheelToken - expectedCreatorToken;
        uint256 expectedFlywheelQuote = (quoteFees * 9_000) / 10_000;
        uint256 expectedCreatorQuote = (quoteFees * 500) / 10_000;
        uint256 expectedHydeQuote = quoteFees - expectedFlywheelQuote - expectedCreatorQuote;

        assertEq(locker.flywheelClaimable(token, token), expectedFlywheelToken);
        assertEq(locker.creatorClaimable(token, token), expectedCreatorToken);
        assertEq(locker.hydeClaimable(token, token), expectedHydeToken);
        assertEq(locker.flywheelClaimable(token, address(quote)), expectedFlywheelQuote);
        assertEq(locker.creatorClaimable(token, address(quote)), expectedCreatorQuote);
        assertEq(locker.hydeClaimable(token, address(quote)), expectedHydeQuote);

        receiver.pullAllFees();
        assertEq(HydeERC20(token).balanceOf(address(receiver)), expectedFlywheelToken);
        assertEq(quote.balanceOf(address(receiver)), expectedFlywheelQuote);
        assertEq(locker.flywheelClaimable(token, token), 0);
        assertEq(locker.flywheelClaimable(token, address(quote)), 0);
        (,,,,, uint256 queuedToken, uint256 reservedToken,) = receiver.rewardData(token);
        (,,,,, uint256 queuedQuote, uint256 reservedQuote,) = receiver.rewardData(address(quote));
        assertEq(queuedToken, expectedFlywheelToken);
        assertEq(reservedToken, expectedFlywheelToken);
        assertEq(queuedQuote, expectedFlywheelQuote);
        assertEq(reservedQuote, expectedFlywheelQuote);
    }

    function test_flywheel_launch_requires_official_unbound_receiver() public {
        bytes32 salt = _findSalt(true, "BAD_FLYWHEEL");
        uint256 nonceBefore = factory.launchNonce();
        uint256 treasuryBefore = quote.balanceOf(LAUNCH_TREASURY);
        vm.startPrank(CREATOR);
        vm.expectRevert(TrenchV3Factory.InvalidFlywheel.selector);
        factory.launchFlywheel("Bad Flywheel", "BADF", salt, address(0));
        vm.expectRevert(TrenchV3Factory.InvalidFlywheel.selector);
        factory.launchFlywheel("Bad Flywheel", "BADF", salt, address(positionManager));
        vm.stopPrank();
        assertEq(factory.launchNonce(), nonceBefore);
        assertEq(quote.balanceOf(LAUNCH_TREASURY), treasuryBefore);
    }

    function test_flywheel_launch_rejects_wrong_controller() public {
        FlywheelVault receiver = vaultFactory.createVault(
            IFlywheelFeeSource(address(locker)), address(quote), address(0xBAD), 7 days, keccak256("WRONG_CONTROLLER")
        );
        bytes32 salt = _findSalt(true, "WRONG_CONTROLLER");
        vm.prank(CREATOR);
        vm.expectRevert(TrenchV3Factory.InvalidFlywheel.selector);
        factory.launchFlywheel("Bad Flywheel", "BADF", salt, address(receiver));
    }

    function test_flywheel_launch_rejects_disabledSelectedRewardRoute() public {
        MockERC20 stock = new MockERC20("Stock", "STOCK", 18);
        MockFlywheelRewardConverter converter = new MockFlywheelRewardConverter();
        vaultFactory.proposeRewardRoute(address(quote), address(stock), address(converter));
        vm.warp(block.timestamp + vaultFactory.ROUTE_ACTIVATION_DELAY());
        vaultFactory.activateRewardRoute(address(quote), address(stock));
        FlywheelVault receiver = vaultFactory.createVault(
            IFlywheelFeeSource(address(locker)), address(quote), address(stock), CREATOR, 7 days, keccak256("DISABLED")
        );
        vaultFactory.disableRewardRoute(address(quote), address(stock));

        bytes32 salt = _findSalt(true, "DISABLED_ROUTE");
        vm.prank(CREATOR);
        vm.expectRevert(TrenchV3Factory.InvalidFlywheel.selector);
        factory.launchFlywheel("Disabled Route", "DSBL", salt, address(receiver));
    }

    function test_flywheel_vault_cannot_be_reused() public {
        FlywheelVault receiver = vaultFactory.createVault(
            IFlywheelFeeSource(address(locker)), address(quote), CREATOR, 7 days, keccak256("NO_REUSE")
        );
        bytes32 firstSalt = _findSalt(true, "NO_REUSE_1");
        vm.prank(CREATOR);
        factory.launchFlywheel("First Flywheel", "FLY1", firstSalt, address(receiver));
        bytes32 secondSalt = _findSalt(false, "NO_REUSE_2");
        vm.prank(CREATOR);
        vm.expectRevert(TrenchV3Factory.InvalidFlywheel.selector);
        factory.launchFlywheel("Second Flywheel", "FLY2", secondSalt, address(receiver));
    }

    function test_signal_reverts_before_curve_is_full() public {
        (address token,,) = _launchWithOrdering(true, "EARLY");
        vm.expectRevert(TrenchV3Graduator.NotReady.selector);
        graduator.signalGraduation(token);
    }

    function test_sell_moves_curve_progress_backwards_before_graduation() public {
        (address token,, address pool) = _launchWithOrdering(true, "SELL");
        TrenchV3Graduator.Curve memory curve = graduator.curveInfo(token);

        _setProgressTick(pool, curve, 6_000);
        TrenchV3Graduator.CurveProgress memory afterBuy = graduator.curveProgress(token);
        _setProgressTick(pool, curve, 3_000);
        TrenchV3Graduator.CurveProgress memory afterSell = graduator.curveProgress(token);

        assertLt(afterSell.sold, afterBuy.sold);
        assertLt(afterSell.progressWad, afterBuy.progressWad);
    }

    function test_stale_signal_cannot_bypass_final_spot_recheck() public {
        (address token,, address pool) = _launchWithOrdering(true, "STALE");
        TrenchV3Graduator.Curve memory curve = graduator.curveInfo(token);
        _setProgressTick(pool, curve, 10_000);
        graduator.signalGraduation(token);

        _setProgressTick(pool, curve, 5_000);
        vm.warp(block.timestamp + GRADUATION_DELAY + 1);
        vm.expectRevert(TrenchV3Graduator.NotReady.selector);
        graduator.finalizeGraduation(token, block.timestamp + 1 hours);
    }

    function test_only_owner_can_pause_new_launches() public {
        vm.prank(CRANKER);
        vm.expectRevert(TrenchV3Factory.OnlyOwner.selector);
        factory.pause();

        factory.pause();
        bytes32 salt = _findSalt(true, "PAUSED");
        vm.prank(CREATOR);
        vm.expectRevert(TrenchV3Factory.PausedError.selector);
        factory.launch("Paused", "PAUSED", salt);
        factory.unpause();
    }

    function test_launch_metadata_is_bounded_onchain() public {
        vm.startPrank(CREATOR);
        vm.expectRevert(TrenchV3Factory.InvalidMetadata.selector);
        factory.launch("", "EMPTY", bytes32("empty-name"));
        vm.expectRevert(TrenchV3Factory.InvalidMetadata.selector);
        factory.launch("Empty symbol", "", bytes32("empty-symbol"));
        vm.expectRevert(TrenchV3Factory.InvalidMetadata.selector);
        factory.launch(
            "This launch name is deliberately longer than the sixty-four-byte protocol maximum",
            "LONG",
            bytes32("long-name")
        );
        vm.expectRevert(TrenchV3Factory.InvalidMetadata.selector);
        factory.launch("Long symbol", "SYMBOL-OVER-16-BYTES", bytes32("long-symbol"));
        vm.stopPrank();
        assertEq(factory.launchNonce(), 0, "invalid metadata consumed a nonce");
        assertEq(quote.balanceOf(LAUNCH_TREASURY), 0, "invalid metadata charged a fee");
    }

    function testFuzz_curve_progress_is_bounded_and_monotonic(bool wantToken0, uint16 firstRaw, uint16 secondRaw)
        public
    {
        (address token,, address pool) = _launchWithOrdering(wantToken0, wantToken0 ? "FZ0" : "FZ1");
        TrenchV3Graduator.Curve memory curve = graduator.curveInfo(token);
        uint256 first = bound(uint256(firstRaw), 0, 9_999);
        uint256 second = bound(uint256(secondRaw), first, 10_000);

        _setProgressTick(pool, curve, first);
        TrenchV3Graduator.CurveProgress memory a = graduator.curveProgress(token);
        _setProgressTick(pool, curve, second);
        TrenchV3Graduator.CurveProgress memory b = graduator.curveProgress(token);

        assertLe(a.sold, a.curveAllocation);
        assertLe(b.sold, b.curveAllocation);
        assertLe(a.progressWad, 1e18);
        assertLe(b.progressWad, 1e18);
        assertGe(b.sold, a.sold, "sold principal moved backwards");
        assertGe(b.progressWad, a.progressWad, "curve progress moved backwards");
    }

    function testFuzz_fee_liabilities_are_conserved_and_solvable(bool wantToken0, uint128 rawFee) public {
        uint256 fee = bound(uint256(rawFee), 1, 1_000_000_000e6);
        (address token, uint256 curveTokenId,) = _launchWithOrdering(wantToken0, wantToken0 ? "SF0" : "SF1");
        quote.mint(address(positionManager), fee);
        positionManager.setFees(curveTokenId, token < address(quote) ? 0 : fee, token < address(quote) ? fee : 0);

        graduator.collectCurveFees(token);
        uint256 creatorCut = locker.creatorClaimable(token, address(quote));
        uint256 hydeCut = locker.hydeClaimable(token, address(quote));
        assertEq(creatorCut + hydeCut, fee);
        assertEq(locker.accountedBalance(address(quote)), fee);
        assertGe(quote.balanceOf(address(locker)), locker.accountedBalance(address(quote)));

        uint256 creatorBefore = quote.balanceOf(CREATOR);
        uint256 hydeBefore = quote.balanceOf(HYDE);
        vm.startPrank(CRANKER);
        locker.claimCreator(token, address(quote));
        locker.claimHyde(token, address(quote));
        vm.stopPrank();
        assertEq(quote.balanceOf(CREATOR) - creatorBefore, creatorCut);
        assertEq(quote.balanceOf(HYDE) - hydeBefore, hydeCut);
        assertEq(locker.accountedBalance(address(quote)), 0);
    }

    function test_permanent_locker_rejects_principal_movement_selectors() public {
        (address token,,) = _launchWithOrdering(true, "SEL");
        bytes4[9] memory forbidden = [
            bytes4(keccak256("transferFrom(address,address,uint256)")),
            bytes4(keccak256("safeTransferFrom(address,address,uint256)")),
            bytes4(keccak256("approve(address,uint256)")),
            bytes4(keccak256("setApprovalForAll(address,bool)")),
            bytes4(keccak256("decreaseLiquidity((uint256,uint128,uint256,uint256,uint256))")),
            bytes4(keccak256("burn(uint256)")),
            bytes4(keccak256("withdraw(address,address,uint256)")),
            bytes4(keccak256("execute(address,uint256,bytes)")),
            bytes4(keccak256("multicall(bytes[])"))
        ];
        for (uint256 i; i < forbidden.length; ++i) {
            (bool ok,) = address(locker).call(abi.encodePacked(forbidden[i], bytes32(uint256(uint160(token)))));
            assertFalse(ok, "locker exposed a forbidden selector");
        }
    }

    function _assertFullLifecycle(bool wantToken0) private {
        (address token, uint256 curveTokenId, address pool) = _launchWithOrdering(wantToken0, wantToken0 ? "T0" : "T1");
        TrenchV3Graduator.Curve memory curve = graduator.curveInfo(token);

        assertEq(uint256(curve.state), uint256(TrenchV3Graduator.CurveState.CURVE_ACTIVE));
        assertEq(positionManager.ownerOf(curveTokenId), address(graduator));
        assertEq(HydeERC20(token).totalSupply(), 1_000_000_000e18);
        assertEq(HydeERC20(token).balanceOf(address(factory)), 0);
        assertGe(HydeERC20(token).balanceOf(address(graduator)), 200_000_000e18);

        TrenchV3Graduator.CurveProgress memory atOpen = graduator.curveProgress(token);
        assertLe(atOpen.progressWad, 1e12, "curve did not start near zero");

        int24 terminalTick = curve.tokenIs0 ? curve.tickUpper : curve.tickLower;
        MockTrenchV3Pool(pool).setSlot0(TickMath.getSqrtRatioAtTick(terminalTick), terminalTick);
        TrenchV3Graduator.CurveProgress memory full = graduator.curveProgress(token);
        assertEq(full.progressWad, 1e18, "curve did not reach 100%");
        assertGe(full.quotePrincipal, full.minimumProceeds);

        // The mock does not execute swaps, so fund the quote principal that real traders would have
        // paid into the position before the mock PositionManager releases it at graduation.
        quote.mint(address(positionManager), full.quotePrincipal + 1_000e6);

        vm.prank(CRANKER);
        graduator.signalGraduation(token);
        vm.expectRevert(TrenchV3Graduator.DelayPending.selector);
        graduator.finalizeGraduation(token, block.timestamp + 1 hours);

        vm.warp(block.timestamp + GRADUATION_DELAY + 1);
        vm.prank(CRANKER);
        uint256[] memory permanentIds = graduator.finalizeGraduation(token, block.timestamp + 1 hours);

        assertGe(permanentIds.length, 1);
        assertLe(permanentIds.length, 3);
        for (uint256 i; i < permanentIds.length; ++i) {
            assertEq(positionManager.ownerOf(permanentIds[i]), address(locker), "permanent NFT not locked");
        }
        vm.expectRevert(bytes("NOT_MINTED"));
        positionManager.ownerOf(curveTokenId);

        TrenchV3Graduator.Curve memory graduated = graduator.curveInfo(token);
        assertEq(uint256(graduated.state), uint256(TrenchV3Graduator.CurveState.GRADUATED));
        assertEq(graduated.permanentPositionCount, permanentIds.length);
        assertEq(graduator.curveProgress(token).progressWad, 1e18);
        assertEq(HydeERC20(token).balanceOf(address(graduator)), 0, "graduator retained token");
        assertEq(quote.balanceOf(address(graduator)), 0, "graduator retained quote");
        assertEq(locker.positionCount(token), permanentIds.length);

        // The permanent locker has no decrease selector: even a correctly shaped call cannot move LP.
        (bool ok,) = address(locker)
            .call(
                abi.encodeWithSignature(
                    "decreaseLiquidity((uint256,uint128,uint256,uint256,uint256))",
                    permanentIds[0],
                    uint128(1),
                    uint256(0),
                    uint256(0),
                    block.timestamp
                )
            );
        assertFalse(ok, "locker unexpectedly exposed decreaseLiquidity");
    }

    function _launchWithOrdering(bool wantToken0, string memory symbol)
        internal
        returns (address token, uint256 curveTokenId, address pool)
    {
        bytes32 salt = _findSalt(wantToken0, symbol);
        vm.prank(CREATOR);
        (token, curveTokenId) = factory.launch("Trench Token", symbol, salt);
        assertEq(token < address(quote), wantToken0, "wrong token ordering");
        pool = uniFactory.getPool(token, address(quote), FEE);
        assertTrue(pool != address(0));
    }

    function _findSalt(bool wantToken0, string memory domain) internal view returns (bytes32 salt) {
        for (uint256 i; i < 1_000; ++i) {
            salt = keccak256(abi.encode(domain, i));
            address predicted = factory.predictToken(CREATOR, salt, factory.launchNonce());
            if ((predicted < address(quote)) == wantToken0) return salt;
        }
        revert("SALT_NOT_FOUND");
    }

    function _setProgressTick(address pool, TrenchV3Graduator.Curve memory curve, uint256 progressBps) private {
        uint256 span = uint256(int256(curve.tickUpper - curve.tickLower));
        int24 tick = curve.tokenIs0
            ? curve.tickLower + int24(int256((span * progressBps) / 10_000))
            : curve.tickUpper - int24(int256((span * progressBps) / 10_000));
        MockTrenchV3Pool(pool).setSlot0(TickMath.getSqrtRatioAtTick(tick), tick);
    }
}
