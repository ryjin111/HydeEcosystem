// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";

import {IPositionManager} from "v4-periphery/src/interfaces/IPositionManager.sol";
import {IStateView} from "v4-periphery/src/interfaces/IStateView.sol";
import {Actions} from "v4-periphery/src/libraries/Actions.sol";
import {LiquidityAmounts} from "v4-periphery/src/libraries/LiquidityAmounts.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";

import {HydeERC20} from "../HydeERC20.sol";
import {IHydeHook} from "../interfaces/IHydeHook.sol";
import {TrenchV4Graduator} from "./TrenchV4Graduator.sol";
import {TrenchV4Locker} from "./TrenchV4Locker.sol";
import {IFlywheelVault, IFlywheelVaultFactory} from "../flywheel/interfaces/IFlywheelVault.sol";

/// @title TrenchV4Factory
/// @notice Hydeout V5 launch rail for Robinhood Chain and Arbitrum:
///         80% pool-native Trench Curve + 20% graduation reserve.
contract TrenchV4Factory is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;

    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;
    uint256 public constant CURVE_BPS = 8_000;
    uint256 public constant BPS = 10_000;
    uint256 public constant CURVE_TARGET = (TOTAL_SUPPLY * CURVE_BPS) / BPS;
    uint256 public constant GRADUATION_RESERVE_TARGET = TOTAL_SUPPLY - CURVE_TARGET;
    uint256 public constant MAX_SALT_TRIES = 64;
    uint256 public constant MAX_NAME_BYTES = 64;
    uint256 public constant MAX_SYMBOL_BYTES = 16;

    address public immutable IMPL;
    TrenchV4Locker public immutable LOCKER;
    TrenchV4Graduator public immutable GRADUATOR;
    IPoolManager public immutable POOL_MANAGER;
    IPositionManager public immutable POSITION_MANAGER;
    IAllowanceTransfer public immutable PERMIT2;
    IStateView public immutable STATE_VIEW;
    IHydeHook public immutable HOOK;
    IFlywheelVaultFactory public immutable FLYWHEEL_VAULT_FACTORY;

    address public immutable NUMERAIRE;
    uint8 public immutable NUMERAIRE_DECIMALS;
    int24 public immutable TICK_SPACING;
    address public immutable UNIVERSAL_ROUTER;
    uint256 public immutable MAX_WALLET_BPS;
    uint64 public immutable MAX_WALLET_WINDOW_SECS;
    uint256 public immutable MAX_CURVE_DUST;

    uint256 public immutable LAUNCH_FEE_AMOUNT;
    address public immutable LAUNCH_FEE_TREASURY;
    address public constant LAUNCH_FEE_ASSET = address(0);
    bool public constant LAUNCH_FEE_NATIVE = true;
    int24 public immutable TICK_FLOOR;
    int24 public immutable TICK_GRADUATION;
    uint256 public immutable ACTUAL_START_FDV_RAW;
    uint256 public immutable ACTUAL_GRADUATION_FDV_RAW;
    uint256 public immutable EXPECTED_TERMINAL_PROCEEDS;

    address public owner;
    address public pendingOwner;
    bool public paused;
    uint256 public launchNonce;
    mapping(address token => bool) public isTrenchToken;
    address[] public allTokens;

    event LaunchFeePaid(address indexed creator, address indexed treasury, uint256 amount);
    event LaunchCreated(
        address indexed token,
        address indexed creator,
        PoolId indexed poolId,
        uint256 curveTokenId,
        uint128 curveLiquidity,
        uint256 curveTokenUsed,
        uint256 graduationReserve
    );
    event FlywheelLaunchCreated(address indexed token, address indexed creator, address indexed recipient);
    event Paused();
    event Unpaused();
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error InvalidConfig();
    error BadFee();
    error FeeTransferFailed();
    error LaunchGriefed();
    error NotSingleSided();
    error SeedFailed();
    error TickRangeInvalid();
    error NotCustodied();
    error InvalidMetadata();
    error PausedError();
    error OnlyOwner();
    error InvalidFlywheel();

    struct Config {
        address impl;
        IPoolManager poolManager;
        IPositionManager positionManager;
        IAllowanceTransfer permit2;
        IStateView stateView;
        IHydeHook hook;
        TrenchV4Locker locker;
        TrenchV4Graduator graduator;
        address flywheelVaultFactory;
        address hydeTreasury;
        address numeraire;
        uint8 numeraireDecimals;
        int24 tickSpacing;
        address universalRouter;
        uint256 startFdvWad;
        uint256 graduationFdvWad;
        uint256 launchFeeAmount;
        address launchFeeTreasury;
        uint256 maxWalletBps;
        uint64 maxWalletWindowSecs;
        uint32 graduationDelay;
        int24 twapTickTolerance;
        uint256 minimumProceeds;
        uint256 maxCurveDust;
        uint256 maxPermanentTokenDust;
        uint256 maxPermanentQuoteDust;
        uint32 compoundTwapWindow;
        int24 maxCompoundDeviation;
        uint128 minCompoundLiquidity;
        address owner;
    }

    constructor(Config memory c) {
        if (
            c.impl == address(0) || address(c.poolManager) == address(0) || address(c.positionManager) == address(0)
                || address(c.permit2) == address(0) || address(c.stateView) == address(0)
                || address(c.hook) == address(0) || address(c.locker) == address(0)
                || address(c.graduator) == address(0) || c.hydeTreasury == address(0) || c.numeraire == address(0)
                || c.flywheelVaultFactory == address(0) || c.flywheelVaultFactory.code.length == 0
                || c.numeraireDecimals > 18 || c.tickSpacing <= 0 || c.universalRouter == address(0)
                || c.startFdvWad == 0 || c.graduationFdvWad <= c.startFdvWad || c.launchFeeAmount == 0
                || c.launchFeeTreasury == address(0) || c.maxWalletBps == 0 || c.maxWalletBps > 300
                || c.maxWalletWindowSecs == 0 || c.maxWalletWindowSecs > 3600 || c.minimumProceeds == 0
                || c.maxCurveDust == 0 || c.maxCurveDust > CURVE_TARGET / 1000 || c.maxPermanentTokenDust == 0
                || c.maxPermanentQuoteDust == 0 || c.owner == address(0)
        ) revert InvalidConfig();
        if (
            uint160(address(c.hook)) & Hooks.ALL_HOOK_MASK
                != uint160(
                    Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG
                        | Hooks.AFTER_SWAP_FLAG
                )
        ) revert InvalidConfig();
        if (HydeERC20(c.impl).TOTAL_SUPPLY() != TOTAL_SUPPLY) revert InvalidConfig();

        IMPL = c.impl;
        POOL_MANAGER = c.poolManager;
        POSITION_MANAGER = c.positionManager;
        PERMIT2 = c.permit2;
        STATE_VIEW = c.stateView;
        HOOK = c.hook;
        FLYWHEEL_VAULT_FACTORY = IFlywheelVaultFactory(c.flywheelVaultFactory);
        NUMERAIRE = c.numeraire;
        NUMERAIRE_DECIMALS = c.numeraireDecimals;
        TICK_SPACING = c.tickSpacing;
        UNIVERSAL_ROUTER = c.universalRouter;
        LAUNCH_FEE_AMOUNT = c.launchFeeAmount;
        LAUNCH_FEE_TREASURY = c.launchFeeTreasury;
        MAX_WALLET_BPS = c.maxWalletBps;
        MAX_WALLET_WINDOW_SECS = c.maxWalletWindowSecs;
        MAX_CURVE_DUST = c.maxCurveDust;
        owner = c.owner;

        uint256 numScale = 10 ** c.numeraireDecimals;
        uint256 startFdvRaw = Math.mulDiv(c.startFdvWad, numScale, 1e18);
        uint256 graduationFdvRaw = Math.mulDiv(c.graduationFdvWad, numScale, 1e18);
        int24 floor_ = _alignToSpacing(TickMath.getTickAtSqrtPrice(_sqrtPriceX96FromFdv(startFdvRaw)), c.tickSpacing);
        int24 graduation_ =
            _alignToSpacing(TickMath.getTickAtSqrtPrice(_sqrtPriceX96FromFdv(graduationFdvRaw)), c.tickSpacing);
        if (
            floor_ >= graduation_ || floor_ <= TickMath.MIN_TICK + c.tickSpacing
                || graduation_ >= TickMath.MAX_TICK - c.tickSpacing
        ) revert TickRangeInvalid();
        TICK_FLOOR = floor_;
        TICK_GRADUATION = graduation_;
        ACTUAL_START_FDV_RAW = _fdvRawFromSqrtPriceX96(TickMath.getSqrtPriceAtTick(floor_));
        ACTUAL_GRADUATION_FDV_RAW = _fdvRawFromSqrtPriceX96(TickMath.getSqrtPriceAtTick(graduation_));
        uint256 terminal0 = _terminalProceeds(floor_, graduation_, true);
        uint256 terminal1 = _terminalProceeds(-graduation_, -floor_, false);
        uint256 expectedTerminal = terminal0 < terminal1 ? terminal0 : terminal1;
        if (expectedTerminal < c.minimumProceeds) revert InvalidConfig();
        EXPECTED_TERMINAL_PROCEEDS = expectedTerminal;

        if (
            c.graduator.FACTORY() != address(this)
                || address(c.graduator.POSITION_MANAGER()) != address(c.positionManager)
                || address(c.graduator.PERMIT2()) != address(c.permit2)
                || address(c.graduator.STATE_VIEW()) != address(c.stateView)
                || address(c.graduator.HOOK()) != address(c.hook) || address(c.graduator.LOCKER()) != address(c.locker)
                || c.graduator.NUMERAIRE() != c.numeraire || c.graduator.TICK_SPACING() != c.tickSpacing
                || c.graduator.GRADUATION_DELAY() != c.graduationDelay
                || c.graduator.TWAP_TICK_TOLERANCE() != c.twapTickTolerance
                || c.graduator.MINIMUM_PROCEEDS() != c.minimumProceeds || c.graduator.MAX_CURVE_DUST() != c.maxCurveDust
                || c.graduator.MAX_PERMANENT_TOKEN_DUST() != c.maxPermanentTokenDust
                || c.graduator.MAX_PERMANENT_QUOTE_DUST() != c.maxPermanentQuoteDust
                || c.locker.graduator() != address(c.graduator)
                || address(c.locker.POSITION_MANAGER()) != address(c.positionManager)
                || address(c.locker.PERMIT2()) != address(c.permit2)
                || address(c.locker.STATE_VIEW()) != address(c.stateView) || address(c.locker.HOOK()) != address(c.hook)
                || c.locker.NUMERAIRE() != c.numeraire || c.locker.HYDE_TREASURY() != c.hydeTreasury
                || c.locker.TICK_SPACING() != c.tickSpacing || c.locker.COMPOUND_TWAP_WINDOW() != c.compoundTwapWindow
                || c.locker.MAX_COMPOUND_DEVIATION() != c.maxCompoundDeviation
                || c.locker.MIN_COMPOUND_LIQUIDITY() != c.minCompoundLiquidity
        ) revert InvalidConfig();
        LOCKER = c.locker;
        GRADUATOR = c.graduator;
    }

    function launch(string calldata name, string calldata symbol, bytes32 salt)
        external
        payable
        nonReentrant
        returns (address token, uint256 curveTokenId)
    {
        return _launch(name, symbol, salt, address(0));
    }

    /// @notice Launches a Trench token whose fees use immutable 90/5/5 Flywheel accounting.
    /// @param flywheelRecipient Deployed receiver contract funded with 90% of both fee assets.
    function launchFlywheel(string calldata name, string calldata symbol, bytes32 salt, address flywheelRecipient)
        external
        payable
        nonReentrant
        returns (address token, uint256 curveTokenId)
    {
        _validateFlywheel(flywheelRecipient, msg.sender);
        return _launch(name, symbol, salt, flywheelRecipient);
    }

    function _launch(string calldata name, string calldata symbol, bytes32 salt, address flywheelRecipient)
        private
        returns (address token, uint256 curveTokenId)
    {
        if (paused) revert PausedError();
        if (
            bytes(name).length == 0 || bytes(name).length > MAX_NAME_BYTES || bytes(symbol).length == 0
                || bytes(symbol).length > MAX_SYMBOL_BYTES
        ) revert InvalidMetadata();
        if (msg.value != LAUNCH_FEE_AMOUNT) revert BadFee();
        (bool feeOk,) = LAUNCH_FEE_TREASURY.call{value: msg.value}("");
        if (!feeOk) revert FeeTransferFailed();
        emit LaunchFeePaid(msg.sender, LAUNCH_FEE_TREASURY, msg.value);

        bytes32 seed = keccak256(abi.encode(msg.sender, salt, launchNonce++));
        uint256 tries;
        for (; tries < MAX_SALT_TRIES;) {
            address predicted = Clones.predictDeterministicAddress(IMPL, seed, address(this));
            if (predicted.code.length == 0) break;
            unchecked {
                ++tries;
                seed = keccak256(abi.encode(seed));
            }
        }
        if (tries == MAX_SALT_TRIES) revert LaunchGriefed();
        token = Clones.cloneDeterministic(IMPL, seed);

        bool tokenIs0 = token < NUMERAIRE;
        (int24 tickLower, int24 tickUpper, int24 initTick) = _rangeFor(tokenIs0);
        PoolKey memory key = _poolKey(token);
        HOOK.registerPendingPool(key, token);

        HydeERC20(token)
            .initialize(
                HydeERC20.InitParams({
                    name: name,
                    symbol: symbol,
                    poolRecipient: address(this),
                    vault: address(LOCKER),
                    maxWalletBps: MAX_WALLET_BPS,
                    maxWalletWindowSecs: MAX_WALLET_WINDOW_SECS,
                    exemptAddrs: _exemptSet(flywheelRecipient)
                })
            );

        POOL_MANAGER.initialize(key, TickMath.getSqrtPriceAtTick(initTick));
        uint128 curveLiquidity;
        uint256 curveTokenUsed;
        (curveTokenId, curveLiquidity, curveTokenUsed) = _mintCurve(token, key, tokenIs0, tickLower, tickUpper);
        if (IERC721(address(POSITION_MANAGER)).ownerOf(curveTokenId) != address(GRADUATOR)) {
            revert NotCustodied();
        }

        uint256 reserve = IERC20(token).balanceOf(address(this));
        if (
            curveTokenUsed > CURVE_TARGET || CURVE_TARGET - curveTokenUsed > MAX_CURVE_DUST
                || reserve < GRADUATION_RESERVE_TARGET || curveTokenUsed + reserve != TOTAL_SUPPLY
        ) revert SeedFailed();
        IERC20(token).safeTransfer(address(GRADUATOR), reserve);
        if (IERC20(token).balanceOf(address(this)) != 0) revert SeedFailed();

        GRADUATOR.registerCurve(
            token,
            msg.sender,
            key,
            curveTokenId,
            CURVE_TARGET,
            reserve,
            tickLower,
            tickUpper,
            tokenIs0,
            flywheelRecipient
        );

        if (flywheelRecipient != address(0)) {
            IFlywheelVault(flywheelRecipient).initialize(token);
            if (
                FLYWHEEL_VAULT_FACTORY.vaultToken(flywheelRecipient) != token
                    || FLYWHEEL_VAULT_FACTORY.tokenVault(token) != flywheelRecipient
            ) revert InvalidFlywheel();
        }

        isTrenchToken[token] = true;
        allTokens.push(token);
        emit LaunchCreated(token, msg.sender, key.toId(), curveTokenId, curveLiquidity, curveTokenUsed, reserve);
        if (flywheelRecipient != address(0)) {
            emit FlywheelLaunchCreated(token, msg.sender, flywheelRecipient);
        }
    }

    function _validateFlywheel(address recipient, address creator) private view {
        if (
            recipient == address(0) || !FLYWHEEL_VAULT_FACTORY.isVault(recipient)
                || !FLYWHEEL_VAULT_FACTORY.isVaultConfigActive(recipient)
                || IFlywheelVault(recipient).DEPLOYER_FACTORY() != address(FLYWHEEL_VAULT_FACTORY)
                || IFlywheelVault(recipient).FEE_SOURCE() != address(LOCKER)
                || IFlywheelVault(recipient).NUMERAIRE() != NUMERAIRE
                || IFlywheelVault(recipient).CONTROLLER() != creator
                || IFlywheelVault(recipient).stakingToken() != address(0)
                || FLYWHEEL_VAULT_FACTORY.vaultToken(recipient) != address(0)
        ) revert InvalidFlywheel();
    }

    function _mintCurve(address token, PoolKey memory key, bool tokenIs0, int24 tickLower, int24 tickUpper)
        private
        returns (uint256 tokenId, uint128 liquidity, uint256 tokenUsed)
    {
        uint160 sqrtA = TickMath.getSqrtPriceAtTick(tickLower);
        uint160 sqrtB = TickMath.getSqrtPriceAtTick(tickUpper);
        liquidity = tokenIs0
            ? LiquidityAmounts.getLiquidityForAmount0(sqrtA, sqrtB, CURVE_TARGET)
            : LiquidityAmounts.getLiquidityForAmount1(sqrtA, sqrtB, CURVE_TARGET);
        tokenUsed = tokenIs0
            ? SqrtPriceMath.getAmount0Delta(sqrtA, sqrtB, liquidity, true)
            : SqrtPriceMath.getAmount1Delta(sqrtA, sqrtB, liquidity, true);
        if (liquidity == 0 || tokenUsed == 0 || tokenUsed > CURVE_TARGET || CURVE_TARGET - tokenUsed > MAX_CURVE_DUST) {
            revert SeedFailed();
        }

        IERC20(token).forceApprove(address(PERMIT2), CURVE_TARGET);
        PERMIT2.approve(token, address(POSITION_MANAGER), uint160(CURVE_TARGET), type(uint48).max);
        tokenId = POSITION_MANAGER.nextTokenId();
        bytes memory actions = abi.encodePacked(uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE_PAIR));
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(
            key,
            tickLower,
            tickUpper,
            uint256(liquidity),
            tokenIs0 ? uint128(CURVE_TARGET) : uint128(0),
            tokenIs0 ? uint128(0) : uint128(CURVE_TARGET),
            address(GRADUATOR),
            bytes("")
        );
        params[1] = abi.encode(key.currency0, key.currency1);
        POSITION_MANAGER.modifyLiquidities(abi.encode(actions, params), block.timestamp);
        IERC20(token).forceApprove(address(PERMIT2), 0);
        PERMIT2.approve(token, address(POSITION_MANAGER), 0, 0);

        uint256 measured = TOTAL_SUPPLY - IERC20(token).balanceOf(address(this));
        if (measured != tokenUsed) revert NotSingleSided();
    }

    function _poolKey(address token) private view returns (PoolKey memory key) {
        (Currency c0, Currency c1) = token < NUMERAIRE
            ? (Currency.wrap(token), Currency.wrap(NUMERAIRE))
            : (Currency.wrap(NUMERAIRE), Currency.wrap(token));
        key = PoolKey({
            currency0: c0,
            currency1: c1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(HOOK))
        });
    }

    function _exemptSet(address flywheelRecipient) private view returns (address[] memory set) {
        set = new address[](flywheelRecipient == address(0) ? 7 : 8);
        set[0] = address(POOL_MANAGER);
        set[1] = address(POSITION_MANAGER);
        set[2] = address(this);
        set[3] = address(LOCKER);
        set[4] = address(GRADUATOR);
        set[5] = UNIVERSAL_ROUTER;
        set[6] = address(PERMIT2);
        if (flywheelRecipient != address(0)) set[7] = flywheelRecipient;
    }

    function _rangeFor(bool tokenIs0) private view returns (int24 tickLower, int24 tickUpper, int24 initTick) {
        if (tokenIs0) return (TICK_FLOOR, TICK_GRADUATION, TICK_FLOOR);
        return (-TICK_GRADUATION, -TICK_FLOOR, -TICK_FLOOR);
    }

    function _sqrtPriceX96FromFdv(uint256 fdvRaw) private pure returns (uint160) {
        uint256 ratioX192 = Math.mulDiv(fdvRaw, 1 << 192, TOTAL_SUPPLY);
        return uint160(Math.sqrt(ratioX192));
    }

    function _fdvRawFromSqrtPriceX96(uint160 sqrtPriceX96) private pure returns (uint256) {
        uint256 p = uint256(sqrtPriceX96);
        return Math.mulDiv(p * p, TOTAL_SUPPLY, 1 << 192);
    }

    function _terminalProceeds(int24 lower, int24 upper, bool tokenIs0) private pure returns (uint256) {
        uint160 sqrtA = TickMath.getSqrtPriceAtTick(lower);
        uint160 sqrtB = TickMath.getSqrtPriceAtTick(upper);
        uint128 liquidity = tokenIs0
            ? LiquidityAmounts.getLiquidityForAmount0(sqrtA, sqrtB, CURVE_TARGET)
            : LiquidityAmounts.getLiquidityForAmount1(sqrtA, sqrtB, CURVE_TARGET);
        return tokenIs0
            ? SqrtPriceMath.getAmount1Delta(sqrtA, sqrtB, liquidity, false)
            : SqrtPriceMath.getAmount0Delta(sqrtA, sqrtB, liquidity, false);
    }

    function _alignToSpacing(int24 tick, int24 spacing) private pure returns (int24) {
        int24 q = tick / spacing;
        int24 r = tick % spacing;
        if (r >= spacing / 2) {
            q += 1;
        } else if (r <= -spacing / 2) {
            q -= 1;
        }
        return q * spacing;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    function pause() external onlyOwner {
        paused = true;
        emit Paused();
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused();
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidConfig();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert OnlyOwner();
        address oldOwner = owner;
        owner = msg.sender;
        pendingOwner = address(0);
        emit OwnershipTransferred(oldOwner, msg.sender);
    }

    function renounceOwnership() external onlyOwner {
        address oldOwner = owner;
        owner = address(0);
        pendingOwner = address(0);
        emit OwnershipTransferred(oldOwner, address(0));
    }

    function tokenCount() external view returns (uint256) {
        return allTokens.length;
    }

    /// @notice Predicts the first clone candidate for a launch nonce. A launch only advances to a
    ///         later deterministic seed if this candidate already has runtime code.
    function predictToken(address creator, bytes32 salt, uint256 nonce) external view returns (address) {
        bytes32 seed = keccak256(abi.encode(creator, salt, nonce));
        return Clones.predictDeterministicAddress(IMPL, seed, address(this));
    }
}
