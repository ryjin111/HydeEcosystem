// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {
    ITrenchV3LockerRegister,
    ITrenchV3Pool,
    ITrenchV3PositionManager,
    TrenchV3CollectParams,
    TrenchV3DecreaseParams,
    TrenchV3MintParams
} from "./interfaces/ITrenchV3.sol";
import {TrenchV3Math} from "./libraries/TrenchV3Math.sol";
import {TickMath} from "../v3/libraries/TickMath.sol";

/// @title TrenchV3Graduator
/// @notice Owns only temporary curve NFTs. The sole principal-removal path is the one-way,
///         permissionless, TWAP-gated graduation transaction that remints all principal into
///         permanent NFTs owned by `TrenchV3Locker`.
contract TrenchV3Graduator is IERC721Receiver, ReentrancyGuard {
    using SafeERC20 for IERC20;

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
        ITrenchV3PositionManager positionManager;
        ITrenchV3LockerRegister locker;
        address numeraire;
        uint24 feeTier;
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
        address pool;
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
    ITrenchV3PositionManager public immutable POSITION_MANAGER;
    ITrenchV3LockerRegister public immutable LOCKER;
    address public immutable NUMERAIRE;
    uint24 public immutable FEE_TIER;
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
        address indexed pool,
        uint256 curveTokenId,
        uint256 curveAllocation,
        uint256 reserveToken
    );
    event GraduationSignaled(address indexed token, uint64 signaledAt, uint64 finalizableAt);
    event CurveFeesCredited(address indexed token, uint256 amount0, uint256 amount1);
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

    constructor(Config memory c) {
        if (
            c.factory == address(0) || address(c.positionManager) == address(0) || address(c.locker) == address(0)
                || c.numeraire == address(0) || c.feeTier == 0 || c.tickSpacing <= 0 || c.graduationDelay < 60
                || c.graduationDelay > 1 days || c.twapTickTolerance < 0 || c.twapTickTolerance > c.tickSpacing
                || c.minimumProceeds == 0 || c.maxCurveDust == 0 || c.maxPermanentTokenDust == 0
                || c.maxPermanentQuoteDust == 0
        ) revert InvalidConfig();

        FACTORY = c.factory;
        POSITION_MANAGER = c.positionManager;
        LOCKER = c.locker;
        NUMERAIRE = c.numeraire;
        FEE_TIER = c.feeTier;
        TICK_SPACING = c.tickSpacing;
        GRADUATION_DELAY = c.graduationDelay;
        TWAP_TICK_TOLERANCE = c.twapTickTolerance;
        MINIMUM_PROCEEDS = c.minimumProceeds;
        MAX_CURVE_DUST = c.maxCurveDust;
        MAX_PERMANENT_TOKEN_DUST = c.maxPermanentTokenDust;
        MAX_PERMANENT_QUOTE_DUST = c.maxPermanentQuoteDust;
    }

    /// @notice Factory-only curve manifest registration after seed custody has been proven.
    function registerCurve(
        address token,
        address creator,
        address pool,
        uint256 curveTokenId,
        uint256 expectedCurveAllocation,
        uint256 reserveToken,
        int24 tickLower,
        int24 tickUpper,
        bool tokenIs0,
        address flywheelRecipient
    ) external {
        if (msg.sender != FACTORY) revert OnlyFactory();
        if (_curveOf[token].state != CurveState.NONE) revert InvalidState();
        if (
            token == address(0) || creator == address(0) || pool == address(0) || token == NUMERAIRE
                || expectedCurveAllocation == 0 || reserveToken == 0 || tickLower >= tickUpper
                || tickLower % TICK_SPACING != 0 || tickUpper % TICK_SPACING != 0 || tokenIs0 != (token < NUMERAIRE)
        ) revert InvalidCurve();
        if (POSITION_MANAGER.ownerOf(curveTokenId) != address(this)) revert InvalidCurve();

        (,, address token0, address token1, uint24 fee, int24 lower, int24 upper, uint128 liquidity,,,,) =
            POSITION_MANAGER.positions(curveTokenId);
        address expected0 = tokenIs0 ? token : NUMERAIRE;
        address expected1 = tokenIs0 ? NUMERAIRE : token;
        if (
            token0 != expected0 || token1 != expected1 || fee != FEE_TIER || lower != tickLower || upper != tickUpper
                || liquidity == 0
        ) revert InvalidCurve();

        (uint160 sqrtPriceX96,,,,,,) = ITrenchV3Pool(pool).slot0();
        (uint256 amount0, uint256 amount1) =
            TrenchV3Math.amountsForLiquidity(sqrtPriceX96, tickLower, tickUpper, liquidity);
        uint256 initialTokenPrincipal = tokenIs0 ? amount0 : amount1;
        if (
            initialTokenPrincipal == 0 || initialTokenPrincipal > expectedCurveAllocation
                || expectedCurveAllocation - initialTokenPrincipal > MAX_CURVE_DUST
                || IERC20(token).balanceOf(address(this)) < reserveToken
        ) revert PrincipalMismatch();

        uint160 sqrtA = TickMath.getSqrtRatioAtTick(tickLower);
        uint160 sqrtB = TickMath.getSqrtRatioAtTick(tickUpper);
        uint256 terminalQuote = tokenIs0
            ? TrenchV3Math.amount1ForLiquidity(sqrtA, sqrtB, liquidity)
            : TrenchV3Math.amount0ForLiquidity(sqrtA, sqrtB, liquidity);
        if (terminalQuote < MINIMUM_PROCEEDS) revert PrincipalMismatch();

        _curveOf[token] = Curve({
            creator: creator,
            pool: pool,
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

        LOCKER.openCurve(token, creator, NUMERAIRE, FEE_TIER, flywheelRecipient);
        emit CurveRegistered(token, creator, pool, curveTokenId, initialTokenPrincipal, reserveToken);
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

    function signalGraduation(address token) external nonReentrant {
        Curve storage curve = _curveOf[token];
        if (curve.state != CurveState.CURVE_ACTIVE) revert InvalidState();
        (uint256 remaining, uint256 quotePrincipal, int24 spotTick) = _principalAtSpot(curve);
        if (!_terminalReady(curve, remaining, quotePrincipal, spotTick)) revert NotReady();

        uint64 now64 = uint64(block.timestamp);
        curve.signaledAt = now64;
        curve.state = CurveState.GRADUATION_SIGNALED;
        emit GraduationSignaled(token, now64, now64 + uint64(GRADUATION_DELAY));
    }

    /// @notice Permissionlessly harvest curve-phase swap fees without moving principal.
    function collectCurveFees(address token) external nonReentrant returns (uint256 amount0, uint256 amount1) {
        Curve storage curve = _curveOf[token];
        if (curve.state != CurveState.CURVE_ACTIVE && curve.state != CurveState.GRADUATION_SIGNALED) {
            revert InvalidState();
        }
        (amount0, amount1) = _collectAndCreditCurveFees(token, curve);
    }

    /// @notice One-way curve -> permanent LP conversion. No principal recipient is caller-controlled.
    function finalizeGraduation(address token, uint256 deadline)
        external
        nonReentrant
        returns (uint256[] memory permanentTokenIds)
    {
        if (block.timestamp > deadline) revert DeadlineExpired();
        Curve storage curve = _curveOf[token];
        if (curve.state != CurveState.GRADUATION_SIGNALED) revert InvalidState();
        if (block.timestamp < uint256(curve.signaledAt) + GRADUATION_DELAY) revert DelayPending();

        (uint256 remaining, uint256 quoteAtSpot, int24 spotTick) = _principalAtSpot(curve);
        if (!_terminalReady(curve, remaining, quoteAtSpot, spotTick)) revert NotReady();
        if (!_twapReady(curve)) revert TwapNotReady();

        _collectAndCreditCurveFees(token, curve);

        (uint256 expected0, uint256 expected1) = POSITION_MANAGER.decreaseLiquidity(
            TrenchV3DecreaseParams({
                tokenId: curve.curveTokenId,
                liquidity: curve.curveLiquidity,
                amount0Min: 0,
                amount1Min: 0,
                deadline: deadline
            })
        );

        uint256 before0 = IERC20(curve.tokenIs0 ? token : NUMERAIRE).balanceOf(address(this));
        uint256 before1 = IERC20(curve.tokenIs0 ? NUMERAIRE : token).balanceOf(address(this));
        (uint256 principal0, uint256 principal1) = POSITION_MANAGER.collect(
            TrenchV3CollectParams({
                tokenId: curve.curveTokenId,
                recipient: address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );
        uint256 measured0 = IERC20(curve.tokenIs0 ? token : NUMERAIRE).balanceOf(address(this)) - before0;
        uint256 measured1 = IERC20(curve.tokenIs0 ? NUMERAIRE : token).balanceOf(address(this)) - before1;
        if (principal0 != measured0 || principal1 != measured1 || principal0 < expected0 || principal1 < expected1) {
            revert PrincipalMismatch();
        }

        POSITION_MANAGER.burn(curve.curveTokenId);

        uint256 tokenPrincipal = curve.tokenIs0 ? principal0 : principal1;
        uint256 quotePrincipal = curve.tokenIs0 ? principal1 : principal0;
        if (tokenPrincipal > MAX_CURVE_DUST || quotePrincipal < MINIMUM_PROCEEDS) {
            revert PrincipalMismatch();
        }

        uint256 tokenForGraduation = IERC20(token).balanceOf(address(this));
        permanentTokenIds = _seedPermanent(token, curve, deadline);
        LOCKER.registerPositions(token, permanentTokenIds);

        curve.graduatedQuotePrincipal = quotePrincipal;
        curve.permanentPositionCount = uint8(permanentTokenIds.length);
        curve.state = CurveState.GRADUATED;

        emit Graduated(token, quotePrincipal, tokenForGraduation, permanentTokenIds[0], permanentTokenIds.length);
    }

    function _collectAndCreditCurveFees(address token, Curve storage curve)
        private
        returns (uint256 fee0, uint256 fee1)
    {
        (fee0, fee1) = POSITION_MANAGER.collect(
            TrenchV3CollectParams({
                tokenId: curve.curveTokenId,
                recipient: address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );

        address token0 = curve.tokenIs0 ? token : NUMERAIRE;
        address token1 = curve.tokenIs0 ? NUMERAIRE : token;
        _noteCurveFee(token, token0, fee0);
        _noteCurveFee(token, token1, fee1);
        emit CurveFeesCredited(token, fee0, fee1);
    }

    function _noteCurveFee(address token, address asset, uint256 amount) private {
        if (amount == 0) return;
        IERC20(asset).forceApprove(address(LOCKER), amount);
        LOCKER.noteCurveFees(token, asset, amount);
        IERC20(asset).forceApprove(address(LOCKER), 0);
    }

    function _seedPermanent(address token, Curve storage curve, uint256 deadline)
        private
        returns (uint256[] memory tokenIds)
    {
        address token0 = curve.tokenIs0 ? token : NUMERAIRE;
        address token1 = curve.tokenIs0 ? NUMERAIRE : token;
        uint256 amount0 = IERC20(token0).balanceOf(address(this));
        uint256 amount1 = IERC20(token1).balanceOf(address(this));
        if (amount0 == 0 || amount1 == 0) revert SeedFailed();

        IERC20(token0).forceApprove(address(POSITION_MANAGER), amount0);
        IERC20(token1).forceApprove(address(POSITION_MANAGER), amount1);

        int24 minTick = TrenchV3Math.minUsableTick(TICK_SPACING);
        int24 maxTick = TrenchV3Math.maxUsableTick(TICK_SPACING);
        uint256[3] memory ids;
        uint256 count;

        (uint256 primaryId, uint128 primaryLiquidity,,) = POSITION_MANAGER.mint(
            TrenchV3MintParams({
                token0: token0,
                token1: token1,
                fee: FEE_TIER,
                tickLower: minTick,
                tickUpper: maxTick,
                amount0Desired: amount0,
                amount1Desired: amount1,
                amount0Min: 0,
                amount1Min: 0,
                recipient: address(LOCKER),
                deadline: deadline
            })
        );
        if (primaryLiquidity == 0) revert SeedFailed();
        ids[count++] = primaryId;

        (, int24 spotTick,,,,,) = ITrenchV3Pool(curve.pool).slot0();
        uint256 tokenRemainder = IERC20(token).balanceOf(address(this));
        uint256 quoteRemainder = IERC20(NUMERAIRE).balanceOf(address(this));

        if (tokenRemainder > MAX_PERMANENT_TOKEN_DUST) {
            ids[count++] = _mintOneSided(
                token0, token1, token, tokenRemainder, curve.tokenIs0, spotTick, minTick, maxTick, deadline
            );
        }
        if (quoteRemainder > MAX_PERMANENT_QUOTE_DUST) {
            ids[count++] = _mintOneSided(
                token0, token1, NUMERAIRE, quoteRemainder, !curve.tokenIs0, spotTick, minTick, maxTick, deadline
            );
        }
        if (count == 0 || count > MAX_PERMANENT_POSITIONS) revert SeedFailed();

        uint256 tokenDust = IERC20(token).balanceOf(address(this));
        uint256 quoteDust = IERC20(NUMERAIRE).balanceOf(address(this));
        if (tokenDust > MAX_PERMANENT_TOKEN_DUST || quoteDust > MAX_PERMANENT_QUOTE_DUST) {
            revert DustExceeded();
        }

        IERC20(token0).forceApprove(address(POSITION_MANAGER), 0);
        IERC20(token1).forceApprove(address(POSITION_MANAGER), 0);
        if (tokenDust != 0) IERC20(token).safeTransfer(address(LOCKER), tokenDust);
        if (quoteDust != 0) IERC20(NUMERAIRE).safeTransfer(address(LOCKER), quoteDust);

        tokenIds = new uint256[](count);
        for (uint256 i; i < count; ++i) {
            tokenIds[i] = ids[i];
        }
    }

    /// @dev `assetIs0` selects the one-sided range: token0 sits above spot, token1 sits below spot.
    function _mintOneSided(
        address token0,
        address token1,
        address asset,
        uint256 amount,
        bool assetIs0,
        int24 spotTick,
        int24 minTick,
        int24 maxTick,
        uint256 deadline
    ) private returns (uint256 tokenId) {
        int24 lower;
        int24 upper;
        if (assetIs0) {
            lower = TrenchV3Math.ceilToSpacing(spotTick, TICK_SPACING);
            upper = maxTick;
            if (lower >= upper) revert SeedFailed();
        } else {
            lower = minTick;
            upper = TrenchV3Math.floorToSpacing(spotTick, TICK_SPACING);
            if (lower >= upper) revert SeedFailed();
        }

        uint256 amount0Desired = asset == token0 ? amount : 0;
        uint256 amount1Desired = asset == token1 ? amount : 0;
        uint128 liquidity;
        uint256 used0;
        uint256 used1;
        (tokenId, liquidity, used0, used1) = POSITION_MANAGER.mint(
            TrenchV3MintParams({
                token0: token0,
                token1: token1,
                fee: FEE_TIER,
                tickLower: lower,
                tickUpper: upper,
                amount0Desired: amount0Desired,
                amount1Desired: amount1Desired,
                amount0Min: 0,
                amount1Min: 0,
                recipient: address(LOCKER),
                deadline: deadline
            })
        );
        if (
            liquidity == 0 || (asset == token0 && (used0 == 0 || used1 != 0))
                || (asset == token1 && (used1 == 0 || used0 != 0))
        ) revert SeedFailed();
    }

    function _principalAtSpot(Curve storage curve)
        private
        view
        returns (uint256 tokenRemaining, uint256 quotePrincipal, int24 spotTick)
    {
        (uint160 sqrtPriceX96, int24 tick,,,,,) = ITrenchV3Pool(curve.pool).slot0();
        (uint256 amount0, uint256 amount1) =
            TrenchV3Math.amountsForLiquidity(sqrtPriceX96, curve.tickLower, curve.tickUpper, curve.curveLiquidity);
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

    function _twapReady(Curve storage curve) private view returns (bool) {
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = GRADUATION_DELAY;
        secondsAgos[1] = 0;
        (int56[] memory cumulatives,) = ITrenchV3Pool(curve.pool).observe(secondsAgos);
        int56 delta = cumulatives[1] - cumulatives[0];
        int56 divisor = int56(uint56(GRADUATION_DELAY));
        int24 meanTick = int24(delta / divisor);
        if (delta < 0 && delta % divisor != 0) --meanTick;
        return curve.tokenIs0
            ? meanTick >= curve.tickUpper - TWAP_TICK_TOLERANCE
            : meanTick <= curve.tickLower + TWAP_TICK_TOLERANCE;
    }

    function curveInfo(address token) external view returns (Curve memory) {
        return _curveOf[token];
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}
