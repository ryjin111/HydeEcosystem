// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";

import {IPositionManager} from "v4-periphery/src/interfaces/IPositionManager.sol";
import {IStateView} from "v4-periphery/src/interfaces/IStateView.sol";
import {Actions} from "v4-periphery/src/libraries/Actions.sol";
import {LiquidityAmounts} from "v4-periphery/src/libraries/LiquidityAmounts.sol";
import {PositionInfo, PositionInfoLibrary} from "v4-periphery/src/libraries/PositionInfoLibrary.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";

import {IHydeHook} from "../interfaces/IHydeHook.sol";
import {ITrenchV4LockerRegister} from "./interfaces/ITrenchV4.sol";
import {TrenchV4Math} from "./libraries/TrenchV4Math.sol";

/// @title TrenchV4Graduator
/// @notice Owns only temporary curve NFTs. Its only principal-removal operation is the one-way
///         delayed graduation that burns the curve NFT and remints all usable assets to the locker.
contract TrenchV4Graduator is IERC721Receiver, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;
    using PositionInfoLibrary for PositionInfo;

    uint256 public constant WAD = 1e18;
    uint256 public constant MAX_PERMANENT_POSITIONS = 3;

    enum CurveState {
        NONE,
        CURVE_ACTIVE,
        GRADUATION_SIGNALED,
        GRADUATED
    }

    struct Config {
        address factory;
        IPositionManager positionManager;
        IAllowanceTransfer permit2;
        IStateView stateView;
        IHydeHook hook;
        ITrenchV4LockerRegister locker;
        address numeraire;
        int24 tickSpacing;
        uint32 graduationDelay;
        int24 twapTickTolerance;
        uint256 minimumProceeds;
        uint256 maxCurveDust;
        uint256 maxPermanentTokenDust;
        uint256 maxPermanentQuoteDust;
    }

    struct Curve {
        address creator;
        PoolId poolId;
        uint256 curveTokenId;
        uint128 curveLiquidity;
        uint256 curveAllocation;
        uint256 reserveToken;
        uint256 graduatedQuotePrincipal;
        int24 tickLower;
        int24 tickUpper;
        uint64 signaledAt;
        uint8 permanentPositionCount;
        bool tokenIs0;
        CurveState state;
    }

    struct CurveProgress {
        uint256 sold;
        uint256 curveAllocation;
        uint256 progressWad;
        uint256 quotePrincipal;
        uint256 minimumProceeds;
        uint64 signaledAt;
        uint64 finalizableAt;
        CurveState state;
    }

    address public immutable FACTORY;
    IPositionManager public immutable POSITION_MANAGER;
    IAllowanceTransfer public immutable PERMIT2;
    IStateView public immutable STATE_VIEW;
    IHydeHook public immutable HOOK;
    ITrenchV4LockerRegister public immutable LOCKER;
    address public immutable NUMERAIRE;
    int24 public immutable TICK_SPACING;
    uint32 public immutable GRADUATION_DELAY;
    int24 public immutable TWAP_TICK_TOLERANCE;
    uint256 public immutable MINIMUM_PROCEEDS;
    uint256 public immutable MAX_CURVE_DUST;
    uint256 public immutable MAX_PERMANENT_TOKEN_DUST;
    uint256 public immutable MAX_PERMANENT_QUOTE_DUST;

    mapping(address token => Curve) private _curveOf;

    event CurveRegistered(
        address indexed token,
        address indexed creator,
        PoolId indexed poolId,
        uint256 curveTokenId,
        uint256 curveAllocation,
        uint256 reserveToken
    );
    event CurveFeesCredited(address indexed token, uint256 amountToken, uint256 amountNumeraire);
    event GraduationSignaled(address indexed token, uint64 signaledAt, uint64 finalizableAt);
    event Graduated(
        address indexed token,
        uint256 quotePrincipal,
        uint256 tokenPrincipal,
        uint256 primaryPositionId,
        uint256 positionCount
    );

    error OnlyFactory();
    error InvalidConfig();
    error InvalidCurve();
    error InvalidState();
    error NotReady();
    error DelayPending();
    error TwapNotReady();
    error PrincipalMismatch();
    error SeedFailed();
    error DustExceeded();
    error DeadlineExpired();
    error AmountOverflow();

    constructor(Config memory c) {
        if (
            c.factory == address(0) || address(c.positionManager) == address(0) || address(c.permit2) == address(0)
                || address(c.stateView) == address(0) || address(c.hook) == address(0)
                || address(c.locker) == address(0) || c.numeraire == address(0) || c.tickSpacing <= 0
                || c.graduationDelay < 60 || c.graduationDelay > 1 days || c.twapTickTolerance < 0
                || c.twapTickTolerance > c.tickSpacing || c.minimumProceeds == 0 || c.maxCurveDust == 0
                || c.maxPermanentTokenDust == 0 || c.maxPermanentQuoteDust == 0
        ) revert InvalidConfig();
        FACTORY = c.factory;
        POSITION_MANAGER = c.positionManager;
        PERMIT2 = c.permit2;
        STATE_VIEW = c.stateView;
        HOOK = c.hook;
        LOCKER = c.locker;
        NUMERAIRE = c.numeraire;
        TICK_SPACING = c.tickSpacing;
        GRADUATION_DELAY = c.graduationDelay;
        TWAP_TICK_TOLERANCE = c.twapTickTolerance;
        MINIMUM_PROCEEDS = c.minimumProceeds;
        MAX_CURVE_DUST = c.maxCurveDust;
        MAX_PERMANENT_TOKEN_DUST = c.maxPermanentTokenDust;
        MAX_PERMANENT_QUOTE_DUST = c.maxPermanentQuoteDust;
    }

    function registerCurve(
        address token,
        address creator,
        PoolKey calldata key,
        uint256 curveTokenId,
        uint256 expectedCurveAllocation,
        uint256 reserveToken,
        int24 tickLower,
        int24 tickUpper,
        bool tokenIs0
    ) external {
        if (msg.sender != FACTORY) revert OnlyFactory();
        if (_curveOf[token].state != CurveState.NONE) revert InvalidState();
        if (
            token == address(0) || creator == address(0) || token == NUMERAIRE || expectedCurveAllocation == 0
                || reserveToken == 0 || tickLower >= tickUpper || tickLower % TICK_SPACING != 0
                || tickUpper % TICK_SPACING != 0 || tokenIs0 != (token < NUMERAIRE) || !_keyEq(key, _poolKey(token))
        ) revert InvalidCurve();
        if (IERC721(address(POSITION_MANAGER)).ownerOf(curveTokenId) != address(this)) revert InvalidCurve();

        (PoolKey memory positionKey, PositionInfo info) = POSITION_MANAGER.getPoolAndPositionInfo(curveTokenId);
        uint128 liquidity = POSITION_MANAGER.getPositionLiquidity(curveTokenId);
        if (
            !_keyEqMemory(positionKey, _poolKey(token)) || info.tickLower() != tickLower
                || info.tickUpper() != tickUpper || liquidity == 0
        ) revert InvalidCurve();

        (uint160 sqrtPriceX96,,,) = STATE_VIEW.getSlot0(key.toId());
        (uint256 amount0, uint256 amount1) =
            TrenchV4Math.amountsForLiquidity(sqrtPriceX96, tickLower, tickUpper, liquidity);
        uint256 initialTokenPrincipal = tokenIs0 ? amount0 : amount1;
        if (
            initialTokenPrincipal == 0 || initialTokenPrincipal > expectedCurveAllocation
                || expectedCurveAllocation - initialTokenPrincipal > MAX_CURVE_DUST
                || IERC20(token).balanceOf(address(this)) < reserveToken
        ) revert PrincipalMismatch();

        uint160 sqrtA = TickMath.getSqrtPriceAtTick(tickLower);
        uint160 sqrtB = TickMath.getSqrtPriceAtTick(tickUpper);
        (uint256 terminal0, uint256 terminal1) =
            TrenchV4Math.amountsForLiquidity(tokenIs0 ? sqrtB : sqrtA, tickLower, tickUpper, liquidity);
        uint256 terminalQuote = tokenIs0 ? terminal1 : terminal0;
        if (terminalQuote < MINIMUM_PROCEEDS) revert PrincipalMismatch();

        PoolId poolId = key.toId();
        _curveOf[token] = Curve({
            creator: creator,
            poolId: poolId,
            curveTokenId: curveTokenId,
            curveLiquidity: liquidity,
            curveAllocation: initialTokenPrincipal,
            reserveToken: reserveToken,
            graduatedQuotePrincipal: 0,
            tickLower: tickLower,
            tickUpper: tickUpper,
            signaledAt: 0,
            permanentPositionCount: 0,
            tokenIs0: tokenIs0,
            state: CurveState.CURVE_ACTIVE
        });
        LOCKER.openCurve(token, creator, key);
        emit CurveRegistered(token, creator, poolId, curveTokenId, initialTokenPrincipal, reserveToken);
    }

    function curveProgress(address token) public view returns (CurveProgress memory out) {
        Curve storage curve = _curveOf[token];
        if (curve.state == CurveState.NONE) return out;

        uint256 sold;
        uint256 quotePrincipal;
        if (curve.state == CurveState.GRADUATED) {
            sold = curve.curveAllocation;
            quotePrincipal = curve.graduatedQuotePrincipal;
        } else {
            (uint256 remaining, uint256 quote,) = _principalAtSpot(curve);
            sold = remaining >= curve.curveAllocation ? 0 : curve.curveAllocation - remaining;
            quotePrincipal = quote;
        }

        uint256 progressWad = curve.curveAllocation == 0 ? 0 : (sold * WAD) / curve.curveAllocation;
        if (progressWad > WAD) progressWad = WAD;
        uint64 finalizableAt = curve.signaledAt == 0 ? 0 : curve.signaledAt + uint64(GRADUATION_DELAY);
        out = CurveProgress({
            sold: sold,
            curveAllocation: curve.curveAllocation,
            progressWad: progressWad,
            quotePrincipal: quotePrincipal,
            minimumProceeds: MINIMUM_PROCEEDS,
            signaledAt: curve.signaledAt,
            finalizableAt: finalizableAt,
            state: curve.state
        });
    }

    function collectCurveFees(address token)
        external
        nonReentrant
        returns (uint256 amountToken, uint256 amountNumeraire)
    {
        Curve storage curve = _curveOf[token];
        if (curve.state != CurveState.CURVE_ACTIVE && curve.state != CurveState.GRADUATION_SIGNALED) {
            revert InvalidState();
        }
        return _collectCurveFees(token, curve);
    }

    function signalGraduation(address token) external nonReentrant {
        Curve storage curve = _curveOf[token];
        if (curve.state != CurveState.CURVE_ACTIVE) revert InvalidState();
        (uint256 tokenRemaining, uint256 quotePrincipal, int24 spotTick) = _principalAtSpot(curve);
        if (!_terminalReady(curve, tokenRemaining, quotePrincipal, spotTick)) revert NotReady();
        curve.signaledAt = uint64(block.timestamp);
        curve.state = CurveState.GRADUATION_SIGNALED;
        emit GraduationSignaled(token, curve.signaledAt, curve.signaledAt + uint64(GRADUATION_DELAY));
    }

    function finalizeGraduation(address token, uint256 deadline) external nonReentrant {
        if (block.timestamp > deadline) revert DeadlineExpired();
        Curve storage curve = _curveOf[token];
        if (curve.state != CurveState.GRADUATION_SIGNALED) revert InvalidState();
        if (block.timestamp < uint256(curve.signaledAt) + GRADUATION_DELAY) revert DelayPending();

        (uint256 tokenRemaining, uint256 quoteAtSpot, int24 spotTick) = _principalAtSpot(curve);
        if (!_terminalReady(curve, tokenRemaining, quoteAtSpot, spotTick)) revert NotReady();
        int24 twap = HOOK.consult(curve.poolId, GRADUATION_DELAY);
        bool twapReady = curve.tokenIs0
            ? twap >= curve.tickUpper - TWAP_TICK_TOLERANCE
            : twap <= curve.tickLower + TWAP_TICK_TOLERANCE;
        if (!twapReady) revert TwapNotReady();

        _collectCurveFees(token, curve);
        uint256 tokenBefore = IERC20(token).balanceOf(address(this));
        uint256 quoteBefore = IERC20(NUMERAIRE).balanceOf(address(this));

        PoolKey memory key = _poolKey(token);
        bytes memory actions = abi.encodePacked(uint8(Actions.BURN_POSITION), uint8(Actions.TAKE_PAIR));
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(curve.curveTokenId, uint128(0), uint128(0), bytes(""));
        params[1] = abi.encode(key.currency0, key.currency1, address(this));
        POSITION_MANAGER.modifyLiquidities(abi.encode(actions, params), deadline);
        if (_positionExists(curve.curveTokenId)) revert PrincipalMismatch();

        uint256 tokenPrincipal = IERC20(token).balanceOf(address(this)) - tokenBefore;
        uint256 quotePrincipal = IERC20(NUMERAIRE).balanceOf(address(this)) - quoteBefore;
        if (
            tokenPrincipal > MAX_CURVE_DUST || quotePrincipal < MINIMUM_PROCEEDS
                || quotePrincipal + MAX_PERMANENT_QUOTE_DUST < quoteAtSpot
        ) revert PrincipalMismatch();

        curve.curveLiquidity = 0;
        curve.graduatedQuotePrincipal = quotePrincipal;
        curve.state = CurveState.GRADUATED;

        uint256[] memory permanentIds = _seedPermanent(token, key, spotTick, deadline);
        curve.permanentPositionCount = uint8(permanentIds.length);
        LOCKER.registerPositions(token, permanentIds);
        emit Graduated(token, quotePrincipal, tokenPrincipal, permanentIds[0], permanentIds.length);
    }

    function _collectCurveFees(address token, Curve storage curve)
        private
        returns (uint256 amountToken, uint256 amountNumeraire)
    {
        uint256 tokenBefore = IERC20(token).balanceOf(address(this));
        uint256 quoteBefore = IERC20(NUMERAIRE).balanceOf(address(this));
        PoolKey memory key = _poolKey(token);
        bytes memory actions = abi.encodePacked(uint8(Actions.INCREASE_LIQUIDITY), uint8(Actions.TAKE_PAIR));
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(curve.curveTokenId, uint256(0), type(uint128).max, type(uint128).max, bytes(""));
        params[1] = abi.encode(key.currency0, key.currency1, address(this));
        POSITION_MANAGER.modifyLiquidities(abi.encode(actions, params), block.timestamp);
        amountToken = IERC20(token).balanceOf(address(this)) - tokenBefore;
        amountNumeraire = IERC20(NUMERAIRE).balanceOf(address(this)) - quoteBefore;
        _noteFee(token, token, amountToken);
        _noteFee(token, NUMERAIRE, amountNumeraire);
        emit CurveFeesCredited(token, amountToken, amountNumeraire);
    }

    function _noteFee(address token, address asset, uint256 amount) private {
        if (amount == 0) return;
        IERC20(asset).forceApprove(address(LOCKER), amount);
        LOCKER.noteCurveFees(token, asset, amount);
        IERC20(asset).forceApprove(address(LOCKER), 0);
    }

    function _seedPermanent(address token, PoolKey memory key, int24 spotTick, uint256 deadline)
        private
        returns (uint256[] memory ids)
    {
        uint256 tokenBalance = IERC20(token).balanceOf(address(this));
        uint256 quoteBalance = IERC20(NUMERAIRE).balanceOf(address(this));
        if (
            tokenBalance > type(uint128).max || quoteBalance > type(uint128).max || tokenBalance > type(uint160).max
                || quoteBalance > type(uint160).max
        ) revert AmountOverflow();
        _permit2Approve(token, tokenBalance);
        _permit2Approve(NUMERAIRE, quoteBalance);

        uint256[] memory staged = new uint256[](MAX_PERMANENT_POSITIONS);
        uint256 count;
        int24 minTick = TrenchV4Math.minUsableTick(TICK_SPACING);
        int24 maxTick = TrenchV4Math.maxUsableTick(TICK_SPACING);
        staged[count++] = _mintPosition(token, key, minTick, maxTick, tokenBalance, quoteBalance, deadline);

        tokenBalance = IERC20(token).balanceOf(address(this));
        quoteBalance = IERC20(NUMERAIRE).balanceOf(address(this));
        if (tokenBalance > MAX_PERMANENT_TOKEN_DUST) {
            (int24 lower, int24 upper) = token < NUMERAIRE
                ? (TrenchV4Math.ceilToSpacing(spotTick, TICK_SPACING), maxTick)
                : (minTick, TrenchV4Math.floorToSpacing(spotTick, TICK_SPACING));
            staged[count++] = _mintPosition(token, key, lower, upper, tokenBalance, 0, deadline);
        }

        tokenBalance = IERC20(token).balanceOf(address(this));
        quoteBalance = IERC20(NUMERAIRE).balanceOf(address(this));
        if (quoteBalance > MAX_PERMANENT_QUOTE_DUST) {
            (int24 lower, int24 upper) = NUMERAIRE < token
                ? (TrenchV4Math.ceilToSpacing(spotTick, TICK_SPACING), maxTick)
                : (minTick, TrenchV4Math.floorToSpacing(spotTick, TICK_SPACING));
            staged[count++] = _mintPosition(token, key, lower, upper, 0, quoteBalance, deadline);
        }

        tokenBalance = IERC20(token).balanceOf(address(this));
        quoteBalance = IERC20(NUMERAIRE).balanceOf(address(this));
        if (tokenBalance > MAX_PERMANENT_TOKEN_DUST || quoteBalance > MAX_PERMANENT_QUOTE_DUST) revert DustExceeded();
        if (tokenBalance > 0) IERC20(token).safeTransfer(address(LOCKER), tokenBalance);
        if (quoteBalance > 0) IERC20(NUMERAIRE).safeTransfer(address(LOCKER), quoteBalance);
        _permit2Approve(token, 0);
        _permit2Approve(NUMERAIRE, 0);

        ids = new uint256[](count);
        for (uint256 i; i < count; ++i) {
            ids[i] = staged[i];
        }
    }

    function _mintPosition(
        address token,
        PoolKey memory key,
        int24 lower,
        int24 upper,
        uint256 tokenMax,
        uint256 quoteMax,
        uint256 deadline
    ) private returns (uint256 tokenId) {
        if (
            lower >= upper || lower % TICK_SPACING != 0 || upper % TICK_SPACING != 0 || tokenMax > type(uint128).max
                || quoteMax > type(uint128).max
        ) revert SeedFailed();
        (uint160 sqrtPriceX96,,,) = STATE_VIEW.getSlot0(key.toId());
        bool tokenIs0 = token < NUMERAIRE;
        uint256 amount0 = tokenIs0 ? tokenMax : quoteMax;
        uint256 amount1 = tokenIs0 ? quoteMax : tokenMax;
        uint128 liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96, TickMath.getSqrtPriceAtTick(lower), TickMath.getSqrtPriceAtTick(upper), amount0, amount1
        );
        if (liquidity == 0) revert SeedFailed();

        tokenId = POSITION_MANAGER.nextTokenId();
        bytes memory actions = abi.encodePacked(uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE_PAIR));
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(
            key, lower, upper, uint256(liquidity), uint128(amount0), uint128(amount1), address(LOCKER), bytes("")
        );
        params[1] = abi.encode(key.currency0, key.currency1);
        POSITION_MANAGER.modifyLiquidities(abi.encode(actions, params), deadline);
        if (IERC721(address(POSITION_MANAGER)).ownerOf(tokenId) != address(LOCKER)) {
            revert SeedFailed();
        }
    }

    function _permit2Approve(address asset, uint256 amount) private {
        IERC20(asset).forceApprove(address(PERMIT2), amount);
        PERMIT2.approve(asset, address(POSITION_MANAGER), uint160(amount), amount == 0 ? 0 : type(uint48).max);
    }

    function _principalAtSpot(Curve storage curve)
        private
        view
        returns (uint256 tokenRemaining, uint256 quotePrincipal, int24 spotTick)
    {
        (uint160 sqrtPriceX96, int24 tick,,) = STATE_VIEW.getSlot0(curve.poolId);
        (uint256 amount0, uint256 amount1) =
            TrenchV4Math.amountsForLiquidity(sqrtPriceX96, curve.tickLower, curve.tickUpper, curve.curveLiquidity);
        tokenRemaining = curve.tokenIs0 ? amount0 : amount1;
        quotePrincipal = curve.tokenIs0 ? amount1 : amount0;
        spotTick = tick;
    }

    function _terminalReady(Curve storage curve, uint256 tokenRemaining, uint256 quotePrincipal, int24 spotTick)
        private
        view
        returns (bool)
    {
        if (tokenRemaining > MAX_CURVE_DUST || quotePrincipal < MINIMUM_PROCEEDS) return false;
        return curve.tokenIs0
            ? spotTick >= curve.tickUpper - TWAP_TICK_TOLERANCE
            : spotTick <= curve.tickLower + TWAP_TICK_TOLERANCE;
    }

    function _positionExists(uint256 tokenId) private view returns (bool) {
        try IERC721(address(POSITION_MANAGER)).ownerOf(tokenId) returns (address) {
            return true;
        } catch {
            return false;
        }
    }

    function _currencies(address token) private view returns (Currency c0, Currency c1) {
        return token < NUMERAIRE
            ? (Currency.wrap(token), Currency.wrap(NUMERAIRE))
            : (Currency.wrap(NUMERAIRE), Currency.wrap(token));
    }

    function _poolKey(address token) private view returns (PoolKey memory key) {
        (Currency c0, Currency c1) = _currencies(token);
        key = PoolKey({
            currency0: c0,
            currency1: c1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(HOOK))
        });
    }

    function _keyEq(PoolKey calldata a, PoolKey memory b) private pure returns (bool) {
        return Currency.unwrap(a.currency0) == Currency.unwrap(b.currency0)
            && Currency.unwrap(a.currency1) == Currency.unwrap(b.currency1) && a.fee == b.fee
            && a.tickSpacing == b.tickSpacing && address(a.hooks) == address(b.hooks);
    }

    function _keyEqMemory(PoolKey memory a, PoolKey memory b) private pure returns (bool) {
        return Currency.unwrap(a.currency0) == Currency.unwrap(b.currency0)
            && Currency.unwrap(a.currency1) == Currency.unwrap(b.currency1) && a.fee == b.fee
            && a.tickSpacing == b.tickSpacing && address(a.hooks) == address(b.hooks);
    }

    function curveInfo(address token) external view returns (Curve memory) {
        return _curveOf[token];
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}
