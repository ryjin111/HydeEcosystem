// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PosmTestSetup} from "v4-periphery/test/shared/PosmTestSetup.sol";
import {HookMiner} from "v4-periphery/test/shared/HookMiner.sol";
import {StateView} from "v4-periphery/src/lens/StateView.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {HydeERC20} from "../../src/HydeERC20.sol";
import {HydeHook} from "../../src/HydeHook.sol";
import {IHydeHook} from "../../src/interfaces/IHydeHook.sol";
import {TrenchV4Factory} from "../../src/v5v4/TrenchV4Factory.sol";
import {TrenchV4Graduator} from "../../src/v5v4/TrenchV4Graduator.sol";
import {TrenchV4Locker} from "../../src/v5v4/TrenchV4Locker.sol";
import {ITrenchV4LockerRegister} from "../../src/v5v4/interfaces/ITrenchV4.sol";
import "../support/ForceCompile.sol";

contract TrenchV4LifecycleTest is PosmTestSetup {
    int24 internal constant TICK_SPACING = 60;
    uint24 internal constant START_FEE = 30_000;
    uint24 internal constant BASE_FEE = 10_000;
    uint24 internal constant MAX_FEE = 50_000;
    uint32 internal constant ANTI_SNIPE = 300;
    uint16 internal constant CARDINALITY = 64;
    uint32 internal constant GRADUATION_DELAY = 300;
    uint256 internal constant LAUNCH_FEE = 0.0004 ether;

    address internal constant CREATOR = address(0xC0FFEE);
    address internal constant BUYER = address(0xB0B);
    address internal constant HYDE_TREASURY = address(0x11DE);
    address internal constant LAUNCH_TREASURY = address(0xFEE5);
    address internal constant OWNER = address(0x0FF1CE);

    MockERC20 internal weth;
    HydeERC20 internal impl;
    HydeHook internal trenchHook;
    StateView internal stateView;
    TrenchV4Factory internal factory;
    TrenchV4Graduator internal graduator;
    TrenchV4Locker internal locker;

    function setUp() public virtual {
        vm.warp(1_000_000);
        deployFreshManagerAndRouters();
        deployPosm(manager);

        weth = new MockERC20("Wrapped Ether", "WETH", 18);
        impl = new HydeERC20();
        stateView = new StateView(manager);

        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
        );
        bytes memory hookArgs =
            abi.encode(manager, address(0xBEEF), address(weth), START_FEE, BASE_FEE, MAX_FEE, ANTI_SNIPE, CARDINALITY);
        (address hookAddress, bytes32 hookSalt) =
            HookMiner.find(address(this), flags, type(HydeHook).creationCode, hookArgs);
        trenchHook = new HydeHook{salt: hookSalt}(
            manager, address(0xBEEF), address(weth), START_FEE, BASE_FEE, MAX_FEE, ANTI_SNIPE, CARDINALITY
        );
        assertEq(address(trenchHook), hookAddress);

        address expectedFactory = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 2);
        locker = new TrenchV4Locker(
            lpm,
            permit2,
            stateView,
            IHydeHook(address(trenchHook)),
            address(weth),
            HYDE_TREASURY,
            TICK_SPACING,
            120,
            200,
            1e6
        );
        graduator = new TrenchV4Graduator(
            TrenchV4Graduator.Config({
                factory: expectedFactory,
                positionManager: lpm,
                permit2: permit2,
                stateView: stateView,
                hook: IHydeHook(address(trenchHook)),
                locker: ITrenchV4LockerRegister(address(locker)),
                numeraire: address(weth),
                tickSpacing: TICK_SPACING,
                graduationDelay: GRADUATION_DELAY,
                twapTickTolerance: TICK_SPACING,
                minimumProceeds: 700_000_000e18,
                maxCurveDust: 10e18,
                maxPermanentTokenDust: 10e18,
                maxPermanentQuoteDust: 10e18
            })
        );
        locker.initGraduator(address(graduator));
        factory = new TrenchV4Factory(
            TrenchV4Factory.Config({
                impl: address(impl),
                poolManager: manager,
                positionManager: lpm,
                permit2: permit2,
                stateView: stateView,
                hook: IHydeHook(address(trenchHook)),
                locker: locker,
                graduator: graduator,
                hydeTreasury: HYDE_TREASURY,
                numeraire: address(weth),
                numeraireDecimals: 18,
                tickSpacing: TICK_SPACING,
                universalRouter: address(swapRouter),
                startFdvWad: 1_000_000_000e18,
                graduationFdvWad: 1_100_000_000e18,
                launchFeeAmount: LAUNCH_FEE,
                launchFeeTreasury: LAUNCH_TREASURY,
                maxWalletBps: 100,
                maxWalletWindowSecs: 300,
                graduationDelay: GRADUATION_DELAY,
                twapTickTolerance: TICK_SPACING,
                minimumProceeds: 700_000_000e18,
                maxCurveDust: 10e18,
                maxPermanentTokenDust: 10e18,
                maxPermanentQuoteDust: 10e18,
                compoundTwapWindow: 120,
                maxCompoundDeviation: 200,
                minCompoundLiquidity: 1e6,
                owner: OWNER
            })
        );
        assertEq(address(factory), expectedFactory);
        trenchHook.initFactory(address(factory));
        assertEq(address(factory.GRADUATOR()), address(graduator));
        assertEq(address(factory.LOCKER()), address(locker));
    }

    function test_fullLifecycle_realV4_token0() public {
        _assertFullLifecycle(true);
    }

    function test_fullLifecycle_realV4_token1() public {
        _assertFullLifecycle(false);
    }

    function _assertFullLifecycle(bool wantToken0) internal {
        (address token, uint256 curveTokenId) = _launch(wantToken0);
        TrenchV4Graduator.Curve memory curve = graduator.curveInfo(token);
        assertEq(curve.tokenIs0, wantToken0, "wrong token ordering");
        assertEq(curve.curveTokenId, curveTokenId);
        assertEq(uint8(curve.state), uint8(TrenchV4Graduator.CurveState.CURVE_ACTIVE));
        assertEq(IERC721(address(lpm)).ownerOf(curveTokenId), address(graduator));
        assertGe(IERC20(token).balanceOf(address(graduator)), 200_000_000e18);

        TrenchV4Graduator.CurveProgress memory beforeProgress = graduator.curveProgress(token);
        assertEq(beforeProgress.sold, 0);
        assertEq(beforeProgress.progressWad, 0);

        _moveToTerminal(token, curve);
        TrenchV4Graduator.CurveProgress memory terminal = graduator.curveProgress(token);
        assertEq(terminal.progressWad, 1e18);
        assertGe(terminal.quotePrincipal, 700_000_000e18);

        graduator.signalGraduation(token);
        vm.warp(block.timestamp + GRADUATION_DELAY);
        graduator.finalizeGraduation(token, block.timestamp + 1);

        TrenchV4Graduator.Curve memory graduated = graduator.curveInfo(token);
        assertEq(uint8(graduated.state), uint8(TrenchV4Graduator.CurveState.GRADUATED));
        assertEq(graduated.curveLiquidity, 0);
        vm.expectRevert();
        IERC721(address(lpm)).ownerOf(curveTokenId);

        (address creator, bool opened, bool registered, uint256 count) = locker.positionInfo(token);
        assertEq(creator, CREATOR);
        assertTrue(opened);
        assertTrue(registered);
        assertGt(count, 0);
        assertLe(count, 3);
        for (uint256 i; i < count; ++i) {
            assertEq(IERC721(address(lpm)).ownerOf(locker.positionIdAt(token, i)), address(locker));
        }
        assertEq(IERC20(token).balanceOf(address(graduator)), 0);
        assertEq(weth.balanceOf(address(graduator)), 0);
    }

    function test_curveFees_doNotAdvanceProgress_andSplit9055() public {
        (address token,) = _launch();
        TrenchV4Graduator.Curve memory curve = graduator.curveInfo(token);
        vm.warp(block.timestamp + ANTI_SNIPE + 1);
        _buy(token, 25_000_000e18, curve);

        TrenchV4Graduator.CurveProgress memory beforeCollect = graduator.curveProgress(token);
        graduator.collectCurveFees(token);
        TrenchV4Graduator.CurveProgress memory afterCollect = graduator.curveProgress(token);
        assertEq(afterCollect.sold, beforeCollect.sold);
        assertEq(afterCollect.quotePrincipal, beforeCollect.quotePrincipal);

        uint256 total = locker.totalFeesAccounted(token, address(weth));
        assertGt(total, 0);
        uint256 creator = locker.creatorClaimable(token, address(weth));
        uint256 hyde = locker.hydeClaimable(token, address(weth));
        uint256 autoLp = locker.pendingAutoLp(token, address(weth));
        assertEq(creator, (total * 9_000) / 10_000);
        assertEq(hyde, (total * 500) / 10_000);
        assertEq(creator + hyde + autoLp, total);
    }

    function test_signalBeforeTerminal_reverts() public {
        (address token,) = _launch();
        vm.expectRevert(TrenchV4Graduator.NotReady.selector);
        graduator.signalGraduation(token);
    }

    function test_oracleConsult_survivesFirstSwapAfterLongIdleGap() public {
        (address token,) = _launch();
        TrenchV4Graduator.Curve memory curve = graduator.curveInfo(token);

        // The first post-idle observation brackets the target with the launch observation.
        // Interpolation must widen its cumulative-delta multiplication or this year-long gap
        // overflows int56 and temporarily DoSes consult/compound.
        vm.warp(block.timestamp + 365 days);
        _buy(token, 1e18, curve);

        int24 twap = trenchHook.consult(curve.poolId, 300);
        assertGe(twap, TickMath.MIN_TICK);
        assertLe(twap, TickMath.MAX_TICK);
    }

    function test_sellMovesCurveProgressBackwardsBeforeGraduation() public {
        (address token,) = _launch();
        TrenchV4Graduator.Curve memory curve = graduator.curveInfo(token);
        vm.warp(block.timestamp + ANTI_SNIPE + 1);

        _buy(token, 100_000_000e18, curve);
        TrenchV4Graduator.CurveProgress memory afterBuy = graduator.curveProgress(token);
        uint256 sellAmount = IERC20(token).balanceOf(BUYER) / 2;
        assertGt(sellAmount, 0);
        _sell(token, sellAmount, curve);
        TrenchV4Graduator.CurveProgress memory afterSell = graduator.curveProgress(token);

        assertLt(afterSell.sold, afterBuy.sold);
        assertLt(afterSell.progressWad, afterBuy.progressWad);
    }

    function test_autoLpFeeBucketCompoundsIntoPrimaryLockedPosition() public {
        (address token,) = _launch();
        TrenchV4Graduator.Curve memory curve = graduator.curveInfo(token);
        vm.warp(block.timestamp + ANTI_SNIPE + 1);

        // Generate both in-kind fee legs before graduation so the primary full-range position can
        // consume the 5% auto-LP buckets without a swap.
        _buy(token, 100_000_000e18, curve);
        uint256 sellAmount = IERC20(token).balanceOf(BUYER) / 4;
        assertGt(sellAmount, 0);
        _sell(token, sellAmount, curve);
        graduator.collectCurveFees(token);
        assertGt(locker.pendingAutoLp(token, token), 0);
        assertGt(locker.pendingAutoLp(token, address(weth)), 0);

        _moveToTerminal(token, curve);
        graduator.signalGraduation(token);
        vm.warp(block.timestamp + GRADUATION_DELAY);
        graduator.finalizeGraduation(token, block.timestamp + 1);

        uint256 primaryId = locker.positionIdAt(token, 0);
        uint128 liquidityBefore = lpm.getPositionLiquidity(primaryId);
        uint256 pendingTokenBefore = locker.pendingAutoLp(token, token);
        uint256 pendingWethBefore = locker.pendingAutoLp(token, address(weth));

        locker.compound(token, block.timestamp + 1);

        uint256 pendingTokenAfter = locker.pendingAutoLp(token, token);
        uint256 pendingWethAfter = locker.pendingAutoLp(token, address(weth));
        assertGt(lpm.getPositionLiquidity(primaryId), liquidityBefore);
        assertLt(pendingTokenAfter, pendingTokenBefore);
        assertLt(pendingWethAfter, pendingWethBefore);
        assertEq(
            locker.totalAutoLpCompounded(token, token),
            pendingTokenBefore - pendingTokenAfter
        );
        assertEq(
            locker.totalAutoLpCompounded(token, address(weth)),
            pendingWethBefore - pendingWethAfter
        );
    }

    function test_staleSignalCannotBypassFinalSpotRecheck() public {
        (address token,) = _launch();
        TrenchV4Graduator.Curve memory curve = graduator.curveInfo(token);
        _moveToTerminal(token, curve);
        graduator.signalGraduation(token);

        uint256 sellAmount = IERC20(token).balanceOf(BUYER) / 2;
        assertGt(sellAmount, 0);
        _sell(token, sellAmount, curve);
        vm.warp(block.timestamp + GRADUATION_DELAY);

        vm.expectRevert(TrenchV4Graduator.NotReady.selector);
        graduator.finalizeGraduation(token, block.timestamp + 1);
    }

    function test_onlyOwnerCanPauseNewLaunches() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(TrenchV4Factory.OnlyOwner.selector);
        factory.pause();

        vm.prank(OWNER);
        factory.pause();
        vm.deal(CREATOR, LAUNCH_FEE);
        vm.prank(CREATOR);
        vm.expectRevert(TrenchV4Factory.PausedError.selector);
        factory.launch{value: LAUNCH_FEE}("Paused", "PAUSE", bytes32("paused"));
    }

    function test_launchMetadataIsBoundedOnchain() public {
        uint256 nonceBefore = factory.launchNonce();
        uint256 treasuryBefore = LAUNCH_TREASURY.balance;
        vm.startPrank(CREATOR);
        vm.expectRevert(TrenchV4Factory.InvalidMetadata.selector);
        factory.launch("", "EMPTY", bytes32("empty-name"));
        vm.expectRevert(TrenchV4Factory.InvalidMetadata.selector);
        factory.launch("Empty symbol", "", bytes32("empty-symbol"));
        vm.expectRevert(TrenchV4Factory.InvalidMetadata.selector);
        factory.launch(
            "This launch name is deliberately longer than the sixty-four-byte protocol maximum",
            "LONG",
            bytes32("long-name")
        );
        vm.expectRevert(TrenchV4Factory.InvalidMetadata.selector);
        factory.launch("Long symbol", "SYMBOL-OVER-16-BYTES", bytes32("long-symbol"));
        vm.stopPrank();
        assertEq(factory.launchNonce(), nonceBefore, "invalid metadata consumed a nonce");
        assertEq(LAUNCH_TREASURY.balance, treasuryBefore, "invalid metadata charged a fee");
    }

    function testFuzz_curveProgressIsBoundedAndMonotonic(bool wantToken0, uint96 firstRaw, uint96 secondRaw) public {
        (address token,) = _launch(wantToken0);
        TrenchV4Graduator.Curve memory curve = graduator.curveInfo(token);
        vm.warp(block.timestamp + ANTI_SNIPE + 1);

        _buy(token, bound(uint256(firstRaw), 1e18, 100_000_000e18), curve);
        TrenchV4Graduator.CurveProgress memory first = graduator.curveProgress(token);
        _buy(token, bound(uint256(secondRaw), 1e18, 100_000_000e18), curve);
        TrenchV4Graduator.CurveProgress memory second = graduator.curveProgress(token);

        assertLe(first.sold, first.curveAllocation);
        assertLe(second.sold, second.curveAllocation);
        assertLe(first.progressWad, 1e18);
        assertLe(second.progressWad, 1e18);
        assertGe(second.sold, first.sold, "sold principal moved backwards");
        assertGe(second.progressWad, first.progressWad, "curve progress moved backwards");
    }

    function testFuzz_curveFeeLiabilitiesAreConservedAndSolvable(bool wantToken0, uint96 rawAmount) public {
        (address token,) = _launch(wantToken0);
        TrenchV4Graduator.Curve memory curve = graduator.curveInfo(token);
        uint256 lockerBalanceBefore = weth.balanceOf(address(locker));
        vm.warp(block.timestamp + ANTI_SNIPE + 1);
        _buy(token, bound(uint256(rawAmount), 1e18, 100_000_000e18), curve);
        graduator.collectCurveFees(token);

        uint256 total = locker.totalFeesAccounted(token, address(weth));
        uint256 creator = locker.creatorClaimable(token, address(weth));
        uint256 hyde = locker.hydeClaimable(token, address(weth));
        uint256 autoLp = locker.pendingAutoLp(token, address(weth));
        assertGt(total, 0);
        assertEq(creator, (total * 9_000) / 10_000);
        assertEq(hyde, (total * 500) / 10_000);
        assertEq(creator + hyde + autoLp, total);
        assertGe(weth.balanceOf(address(locker)), creator + hyde + autoLp);

        uint256 creatorBefore = weth.balanceOf(CREATOR);
        uint256 hydeBefore = weth.balanceOf(HYDE_TREASURY);
        locker.claimCreator(token, address(weth));
        locker.claimHyde(token, address(weth));
        assertEq(weth.balanceOf(CREATOR) - creatorBefore, creator);
        assertEq(weth.balanceOf(HYDE_TREASURY) - hydeBefore, hyde);
        assertEq(locker.creatorClaimable(token, address(weth)), 0);
        assertEq(locker.hydeClaimable(token, address(weth)), 0);
        assertEq(weth.balanceOf(address(locker)), lockerBalanceBefore + autoLp);
    }

    function test_permanentLockerRejectsPrincipalMovementSelectors() public {
        (address token,) = _launch();
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

    function _launch() internal returns (address token, uint256 tokenId) {
        return _launch(true);
    }

    function _launch(bool wantToken0) internal returns (address token, uint256 tokenId) {
        bytes32 salt = _findSalt(wantToken0);
        vm.deal(CREATOR, LAUNCH_FEE);
        vm.prank(CREATOR);
        return factory.launch{value: LAUNCH_FEE}("Trench V5", "TRNCH", salt);
    }

    function _findSalt(bool wantToken0) internal view returns (bytes32 salt) {
        for (uint256 i; i < 1_000; ++i) {
            salt = keccak256(abi.encode("V4_ORDER", wantToken0, i));
            address predicted = factory.predictToken(CREATOR, salt, factory.launchNonce());
            if ((predicted < address(weth)) == wantToken0) return salt;
        }
        revert("SALT_NOT_FOUND");
    }

    function _key(address token) internal view returns (PoolKey memory key) {
        (Currency c0, Currency c1) = token < address(weth)
            ? (Currency.wrap(token), Currency.wrap(address(weth)))
            : (Currency.wrap(address(weth)), Currency.wrap(token));
        key = PoolKey({
            currency0: c0,
            currency1: c1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(trenchHook))
        });
    }

    function _buy(address token, uint256 wethIn, TrenchV4Graduator.Curve memory curve) internal {
        weth.mint(BUYER, wethIn);
        vm.startPrank(BUYER);
        weth.approve(address(swapRouter), wethIn);
        bool wethIs0 = address(weth) < token;
        uint160 limit = curve.tokenIs0
            ? TickMath.getSqrtPriceAtTick(curve.tickUpper)
            : TickMath.getSqrtPriceAtTick(curve.tickLower);
        swapRouter.swap(
            _key(token),
            SwapParams({zeroForOne: wethIs0, amountSpecified: -int256(wethIn), sqrtPriceLimitX96: limit}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();
    }

    function _sell(address token, uint256 tokenIn, TrenchV4Graduator.Curve memory curve) internal {
        vm.startPrank(BUYER);
        IERC20(token).approve(address(swapRouter), tokenIn);
        uint160 limit = curve.tokenIs0
            ? TickMath.getSqrtPriceAtTick(curve.tickLower)
            : TickMath.getSqrtPriceAtTick(curve.tickUpper);
        swapRouter.swap(
            _key(token),
            SwapParams({
                zeroForOne: curve.tokenIs0,
                amountSpecified: -int256(tokenIn),
                sqrtPriceLimitX96: limit
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();
    }

    function _moveToTerminal(address token, TrenchV4Graduator.Curve memory curve) internal {
        vm.warp(block.timestamp + ANTI_SNIPE + 1);
        _buy(token, 2_000_000_000e18, curve);
    }
}
