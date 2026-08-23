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

/// @title TrenchV4Locker
/// @notice Permanent V4 NFT custody and launch-mode-specific 90/5/5 fee accounting. Normal launches
///         route creator/protocol/auto-LP; Flywheel launches route receiver/creator/protocol. There is no
///         NFT transfer, approval, liquidity-decrease, burn, token withdrawal, or arbitrary-call path.
contract TrenchV4Locker is IERC721Receiver, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;
    using PositionInfoLibrary for PositionInfo;

    uint256 public constant CREATOR_BPS = 9_000;
    uint256 public constant HYDE_BPS = 500;
    uint256 public constant AUTO_LP_BPS = 500;
    uint256 public constant FLYWHEEL_BPS = 9_000;
    uint256 public constant FLYWHEEL_CREATOR_BPS = 500;
    uint256 private constant BPS = 10_000;
    uint256 public constant MAX_POSITIONS = 3;

    IPositionManager public immutable POSITION_MANAGER;
    IAllowanceTransfer public immutable PERMIT2;
    IStateView public immutable STATE_VIEW;
    IHydeHook public immutable HOOK;
    address public immutable NUMERAIRE;
    address public immutable HYDE_TREASURY;
    int24 public immutable TICK_SPACING;
    uint32 public immutable COMPOUND_TWAP_WINDOW;
    int24 public immutable MAX_COMPOUND_DEVIATION;
    uint128 public immutable MIN_COMPOUND_LIQUIDITY;

    address private immutable _deployer;
    address public graduator;

    struct LockedPosition {
        address creator;
        address flywheelRecipient;
        bool curveOpened;
        bool positionsRegistered;
        uint256[] tokenIds;
    }

    mapping(address token => LockedPosition) private _positionOf;
    mapping(address token => mapping(address asset => uint256)) public creatorClaimable;
    mapping(address token => mapping(address asset => uint256)) public hydeClaimable;
    mapping(address token => mapping(address asset => uint256)) public flywheelClaimable;
    mapping(address token => mapping(address asset => uint256)) public pendingAutoLp;
    mapping(address token => mapping(address asset => uint256)) public totalFeesAccounted;
    mapping(address token => mapping(address asset => uint256)) public totalAutoLpCompounded;

    event GraduatorInitialized(address indexed graduator);
    event CurveOpened(address indexed token, address indexed creator, PoolId indexed poolId);
    event PositionsLocked(
        address indexed token, address indexed creator, uint256 indexed primaryTokenId, uint256 positionCount
    );
    event FeeCredited(
        address indexed token, address indexed asset, uint256 creatorCut, uint256 hydeCut, uint256 autoLpCut
    );
    event FlywheelConfigured(address indexed token, address indexed recipient);
    event FlywheelFeeCredited(
        address indexed token,
        address indexed asset,
        address indexed recipient,
        uint256 flywheelCut,
        uint256 creatorCut,
        uint256 hydeCut
    );
    event FeesCollected(address indexed token, address indexed caller, uint256 amountToken, uint256 amountNumeraire);
    event AutoLpCompounded(
        address indexed token, uint256 indexed tokenId, uint128 liquidity, uint256 used0, uint256 used1
    );
    event CreatorClaimed(address indexed token, address indexed asset, address indexed creator, uint256 amount);
    event HydeClaimed(address indexed token, address indexed asset, address indexed treasury, uint256 amount);
    event FlywheelFunded(address indexed token, address indexed asset, address indexed recipient, uint256 amount);

    error OnlyDeployer();
    error OnlyGraduator();
    error AlreadyInitialized();
    error AlreadyRegistered();
    error InvalidRegistration();
    error UnknownPosition();
    error NotCustodied();
    error DeadlineExpired();
    error TwapDeviation();
    error DustAccumulate();
    error AmountOverflow();

    constructor(
        IPositionManager positionManager,
        IAllowanceTransfer permit2,
        IStateView stateView,
        IHydeHook hook,
        address numeraire,
        address hydeTreasury,
        int24 tickSpacing,
        uint32 compoundTwapWindow,
        int24 maxCompoundDeviation,
        uint128 minCompoundLiquidity
    ) {
        if (
            address(positionManager) == address(0) || address(permit2) == address(0) || address(stateView) == address(0)
                || address(hook) == address(0) || numeraire == address(0) || hydeTreasury == address(0)
                || tickSpacing <= 0 || compoundTwapWindow == 0 || maxCompoundDeviation <= 0 || minCompoundLiquidity == 0
        ) revert InvalidRegistration();
        POSITION_MANAGER = positionManager;
        PERMIT2 = permit2;
        STATE_VIEW = stateView;
        HOOK = hook;
        NUMERAIRE = numeraire;
        HYDE_TREASURY = hydeTreasury;
        TICK_SPACING = tickSpacing;
        COMPOUND_TWAP_WINDOW = compoundTwapWindow;
        MAX_COMPOUND_DEVIATION = maxCompoundDeviation;
        MIN_COMPOUND_LIQUIDITY = minCompoundLiquidity;
        _deployer = msg.sender;
    }

    function initGraduator(address graduator_) external {
        if (msg.sender != _deployer) revert OnlyDeployer();
        if (graduator != address(0)) revert AlreadyInitialized();
        if (graduator_ == address(0)) revert InvalidRegistration();
        graduator = graduator_;
        emit GraduatorInitialized(graduator_);
    }

    function openCurve(address token, address creator, PoolKey calldata key, address flywheelRecipient_) external {
        if (msg.sender != graduator) revert OnlyGraduator();
        LockedPosition storage pos = _positionOf[token];
        if (pos.curveOpened) revert AlreadyRegistered();
        if (token == address(0) || creator == address(0) || token == NUMERAIRE || !_keyEq(key, _poolKey(token))) {
            revert InvalidRegistration();
        }
        pos.creator = creator;
        pos.flywheelRecipient = flywheelRecipient_;
        pos.curveOpened = true;
        emit CurveOpened(token, creator, key.toId());
        if (flywheelRecipient_ != address(0)) emit FlywheelConfigured(token, flywheelRecipient_);
    }

    function registerPositions(address token, uint256[] calldata tokenIds) external {
        if (msg.sender != graduator) revert OnlyGraduator();
        LockedPosition storage pos = _positionOf[token];
        if (!pos.curveOpened || pos.positionsRegistered) revert AlreadyRegistered();
        if (tokenIds.length == 0 || tokenIds.length > MAX_POSITIONS) revert InvalidRegistration();

        PoolKey memory expected = _poolKey(token);
        for (uint256 i; i < tokenIds.length; ++i) {
            uint256 tokenId = tokenIds[i];
            if (IERC721(address(POSITION_MANAGER)).ownerOf(tokenId) != address(this)) revert NotCustodied();
            (PoolKey memory key, PositionInfo info) = POSITION_MANAGER.getPoolAndPositionInfo(tokenId);
            if (
                !_keyEqMemory(key, expected) || info.tickLower() >= info.tickUpper()
                    || info.tickLower() % TICK_SPACING != 0 || info.tickUpper() % TICK_SPACING != 0
            ) revert InvalidRegistration();
            pos.tokenIds.push(tokenId);
        }
        pos.positionsRegistered = true;
        emit PositionsLocked(token, pos.creator, tokenIds[0], tokenIds.length);
    }

    /// @notice Pull-and-measure curve fees from the temporary NFT owner, then apply the launch-mode split.
    function noteCurveFees(address token, address asset, uint256 amount) external nonReentrant {
        if (msg.sender != graduator) revert OnlyGraduator();
        LockedPosition storage pos = _positionOf[token];
        if (!pos.curveOpened || (asset != token && asset != NUMERAIRE)) revert InvalidRegistration();
        if (amount == 0) return;
        uint256 beforeBalance = IERC20(asset).balanceOf(address(this));
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(asset).balanceOf(address(this)) - beforeBalance;
        if (received != amount) revert InvalidRegistration();
        _credit(token, asset, received);
    }

    /// @notice Permissionless fee harvest from every permanently locked NFT.
    function collect(address token) external nonReentrant returns (uint256 amountToken, uint256 amountNumeraire) {
        LockedPosition storage pos = _positionOf[token];
        if (!pos.positionsRegistered) revert UnknownPosition();

        uint256 tokenBefore = IERC20(token).balanceOf(address(this));
        uint256 numeraireBefore = IERC20(NUMERAIRE).balanceOf(address(this));
        (Currency c0, Currency c1) = _currencies(token);

        for (uint256 i; i < pos.tokenIds.length; ++i) {
            bytes memory actions = abi.encodePacked(uint8(Actions.INCREASE_LIQUIDITY), uint8(Actions.TAKE_PAIR));
            bytes[] memory params = new bytes[](2);
            params[0] = abi.encode(pos.tokenIds[i], uint256(0), type(uint128).max, type(uint128).max, bytes(""));
            params[1] = abi.encode(c0, c1, address(this));
            POSITION_MANAGER.modifyLiquidities(abi.encode(actions, params), block.timestamp);
        }

        amountToken = IERC20(token).balanceOf(address(this)) - tokenBefore;
        amountNumeraire = IERC20(NUMERAIRE).balanceOf(address(this)) - numeraireBefore;
        _credit(token, token, amountToken);
        _credit(token, NUMERAIRE, amountNumeraire);
        emit FeesCollected(token, msg.sender, amountToken, amountNumeraire);
    }

    /// @notice Permissionless, swap-free compounding into the primary permanent NFT.
    function compound(address token, uint256 deadline) external nonReentrant {
        if (block.timestamp > deadline) revert DeadlineExpired();
        LockedPosition storage pos = _positionOf[token];
        if (!pos.positionsRegistered) revert UnknownPosition();

        uint256 tokenId = pos.tokenIds[0];
        (PoolKey memory key, PositionInfo info) = POSITION_MANAGER.getPoolAndPositionInfo(tokenId);
        PoolId poolId = key.toId();
        (uint160 sqrtPriceX96, int24 spot,,) = STATE_VIEW.getSlot0(poolId);
        int24 twap = HOOK.consult(poolId, COMPOUND_TWAP_WINDOW);
        int24 deviation = spot >= twap ? spot - twap : twap - spot;
        if (deviation > MAX_COMPOUND_DEVIATION) revert TwapDeviation();

        bool tokenIs0 = token < NUMERAIRE;
        uint256 amount0 = pendingAutoLp[token][tokenIs0 ? token : NUMERAIRE];
        uint256 amount1 = pendingAutoLp[token][tokenIs0 ? NUMERAIRE : token];
        if (
            amount0 > type(uint128).max || amount1 > type(uint128).max || amount0 > type(uint160).max
                || amount1 > type(uint160).max
        ) revert AmountOverflow();

        uint128 liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96,
            TickMath.getSqrtPriceAtTick(info.tickLower()),
            TickMath.getSqrtPriceAtTick(info.tickUpper()),
            amount0,
            amount1
        );
        if (liquidity < MIN_COMPOUND_LIQUIDITY) revert DustAccumulate();

        address asset0 = Currency.unwrap(key.currency0);
        address asset1 = Currency.unwrap(key.currency1);
        _permit2Approve(asset0, amount0);
        _permit2Approve(asset1, amount1);
        uint256 before0 = IERC20(asset0).balanceOf(address(this));
        uint256 before1 = IERC20(asset1).balanceOf(address(this));

        bytes memory actions = abi.encodePacked(uint8(Actions.INCREASE_LIQUIDITY), uint8(Actions.SETTLE_PAIR));
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(tokenId, uint256(liquidity), uint128(amount0), uint128(amount1), bytes(""));
        params[1] = abi.encode(key.currency0, key.currency1);
        POSITION_MANAGER.modifyLiquidities(abi.encode(actions, params), deadline);

        uint256 used0 = before0 - IERC20(asset0).balanceOf(address(this));
        uint256 used1 = before1 - IERC20(asset1).balanceOf(address(this));
        pendingAutoLp[token][asset0] -= used0;
        pendingAutoLp[token][asset1] -= used1;
        totalAutoLpCompounded[token][asset0] += used0;
        totalAutoLpCompounded[token][asset1] += used1;
        _permit2Approve(asset0, 0);
        _permit2Approve(asset1, 0);
        emit AutoLpCompounded(token, tokenId, liquidity, used0, used1);
    }

    function _credit(address token, address asset, uint256 amount) private {
        if (amount == 0) return;
        LockedPosition storage pos = _positionOf[token];
        if (pos.flywheelRecipient != address(0)) {
            uint256 flywheelCut = (amount * FLYWHEEL_BPS) / BPS;
            uint256 flywheelCreatorCut = (amount * FLYWHEEL_CREATOR_BPS) / BPS;
            uint256 flywheelHydeCut = amount - flywheelCut - flywheelCreatorCut;
            flywheelClaimable[token][asset] += flywheelCut;
            creatorClaimable[token][asset] += flywheelCreatorCut;
            hydeClaimable[token][asset] += flywheelHydeCut;
            totalFeesAccounted[token][asset] += amount;
            emit FlywheelFeeCredited(
                token, asset, pos.flywheelRecipient, flywheelCut, flywheelCreatorCut, flywheelHydeCut
            );
            return;
        }
        uint256 creatorCut = (amount * CREATOR_BPS) / BPS;
        uint256 hydeCut = (amount * HYDE_BPS) / BPS;
        uint256 autoLpCut = amount - creatorCut - hydeCut;
        creatorClaimable[token][asset] += creatorCut;
        hydeClaimable[token][asset] += hydeCut;
        pendingAutoLp[token][asset] += autoLpCut;
        totalFeesAccounted[token][asset] += amount;
        emit FeeCredited(token, asset, creatorCut, hydeCut, autoLpCut);
    }

    function claimCreator(address token, address asset) external nonReentrant returns (uint256 amount) {
        LockedPosition storage pos = _positionOf[token];
        if (!pos.curveOpened || (asset != token && asset != NUMERAIRE)) revert UnknownPosition();
        amount = creatorClaimable[token][asset];
        if (amount == 0) return 0;
        creatorClaimable[token][asset] = 0;
        IERC20(asset).safeTransfer(pos.creator, amount);
        emit CreatorClaimed(token, asset, pos.creator, amount);
    }

    function claimHyde(address token, address asset) external nonReentrant returns (uint256 amount) {
        LockedPosition storage pos = _positionOf[token];
        if (!pos.curveOpened || (asset != token && asset != NUMERAIRE)) revert UnknownPosition();
        amount = hydeClaimable[token][asset];
        if (amount == 0) return 0;
        hydeClaimable[token][asset] = 0;
        IERC20(asset).safeTransfer(HYDE_TREASURY, amount);
        emit HydeClaimed(token, asset, HYDE_TREASURY, amount);
    }

    /// @notice Permissionlessly forwards the immutable 90% Flywheel allocation to its receiver.
    /// @dev The receiver contract owns all staking and reward-accounting behavior.
    function fundFlywheel(address token, address asset) external nonReentrant returns (uint256 amount) {
        LockedPosition storage pos = _positionOf[token];
        if (!pos.curveOpened || pos.flywheelRecipient == address(0) || (asset != token && asset != NUMERAIRE)) {
            revert UnknownPosition();
        }
        amount = flywheelClaimable[token][asset];
        if (amount == 0) return 0;
        flywheelClaimable[token][asset] = 0;
        IERC20(asset).safeTransfer(pos.flywheelRecipient, amount);
        emit FlywheelFunded(token, asset, pos.flywheelRecipient, amount);
    }

    function flywheelRecipient(address token) external view returns (address) {
        return _positionOf[token].flywheelRecipient;
    }

    function _permit2Approve(address asset, uint256 amount) private {
        IERC20(asset).forceApprove(address(PERMIT2), amount);
        PERMIT2.approve(asset, address(POSITION_MANAGER), uint160(amount), amount == 0 ? 0 : type(uint48).max);
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

    function positionInfo(address token)
        external
        view
        returns (address creator, bool curveOpened, bool positionsRegistered, uint256 positionCount)
    {
        LockedPosition storage pos = _positionOf[token];
        return (pos.creator, pos.curveOpened, pos.positionsRegistered, pos.tokenIds.length);
    }

    function positionIdAt(address token, uint256 index) external view returns (uint256) {
        return _positionOf[token].tokenIds[index];
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}
