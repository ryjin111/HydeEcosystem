// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {HydeERC20} from "../v3/HydeERC20.sol";
import {
    ITrenchSlipstreamFactory,
    ITrenchSlipstreamMintOnly,
    ITrenchV3Factory,
    ITrenchV3MintOnly,
    ITrenchV3Pool,
    TrenchSlipstreamMintParams,
    TrenchV3MintParams
} from "./interfaces/ITrenchV3.sol";
import {TickMath} from "../v3/libraries/TickMath.sol";
import {TrenchV3Graduator} from "./TrenchV3Graduator.sol";
import {TrenchV3Locker} from "./TrenchV3Locker.sol";
import {TrenchV3Math} from "./libraries/TrenchV3Math.sol";
import {IFlywheelVault, IFlywheelVaultFactory} from "../flywheel/interfaces/IFlywheelVault.sol";

/// @title TrenchV3Factory
/// @notice Stable V5 launch rail: 80% single-sided V3 curve + 20% graduation reserve.
contract TrenchV3Factory is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;
    uint256 public constant CURVE_BPS = 8_000;
    uint256 public constant BPS = 10_000;
    uint256 public constant CURVE_TARGET = (TOTAL_SUPPLY * CURVE_BPS) / BPS;
    uint256 public constant GRADUATION_RESERVE_TARGET = TOTAL_SUPPLY - CURVE_TARGET;
    uint256 public constant MAX_SALT_TRIES = 64;
    uint256 public constant MAX_NAME_BYTES = 64;
    uint256 public constant MAX_SYMBOL_BYTES = 16;

    address public immutable IMPL;
    TrenchV3Locker public immutable LOCKER;
    TrenchV3Graduator public immutable GRADUATOR;
    ITrenchV3Factory public immutable V3_FACTORY;
    ITrenchV3MintOnly public immutable POSITION_MANAGER;
    IFlywheelVaultFactory public immutable FLYWHEEL_VAULT_FACTORY;

    address public immutable NUMERAIRE;
    uint8 public immutable NUMERAIRE_DECIMALS;
    uint24 public immutable FEE_TIER;
    uint24 public immutable POSITION_KEY;
    int24 public immutable TICK_SPACING;
    bool public immutable SLIPSTREAM;
    uint16 public immutable OBSERVATION_CARDINALITY;

    address public immutable LAUNCH_FEE_ASSET;
    uint256 public immutable LAUNCH_FEE_AMOUNT;
    bool public immutable LAUNCH_FEE_NATIVE;
    address public immutable LAUNCH_FEE_TREASURY;

    uint256 public immutable MAX_WALLET_BPS;
    uint64 public immutable MAX_WALLET_WINDOW_SECS;
    uint256 public immutable MAX_CURVE_DUST;

    int24 public immutable TICK_FLOOR;
    int24 public immutable TICK_GRADUATION;
    uint256 public immutable ACTUAL_START_FDV_RAW;
    uint256 public immutable ACTUAL_GRADUATION_FDV_RAW;
    uint256 public immutable EXPECTED_TERMINAL_PROCEEDS;

    address public owner;
    address public pendingOwner;
    bool public paused;

    mapping(address token => bool) public isTrenchToken;
    address[] public allTokens;
    uint256 public launchNonce;

    event LaunchFeePaid(address indexed creator, address indexed asset, uint256 amount);
    event LaunchCreated(
        address indexed token,
        address indexed creator,
        address indexed pool,
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
    error FeeOnTransfer();
    error EthFeeTransferFailed();
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
        address v3Factory;
        address positionManager;
        address locker;
        address graduator;
        address flywheelVaultFactory;
        address hydeTreasury;
        address numeraire;
        uint8 numeraireDecimals;
        uint24 feeTier;
        bool slipstream;
        int24 tickSpacing;
        uint256 startFdvWad;
        uint256 graduationFdvWad;
        address launchFeeAsset;
        uint256 launchFeeAmount;
        bool launchFeeNative;
        address launchFeeTreasury;
        uint256 maxWalletBps;
        uint64 maxWalletWindowSecs;
        uint16 observationCardinality;
        uint32 graduationDelay;
        int24 twapTickTolerance;
        uint256 minimumProceeds;
        uint256 maxCurveDust;
        uint256 maxPermanentTokenDust;
        uint256 maxPermanentQuoteDust;
        address owner;
    }

    constructor(Config memory c) {
        if (
            c.impl == address(0) || c.v3Factory == address(0) || c.positionManager == address(0)
                || c.locker.code.length == 0 || c.graduator.code.length == 0
                || (c.flywheelVaultFactory != address(0) && c.flywheelVaultFactory.code.length == 0)
                || c.hydeTreasury == address(0) || c.numeraire == address(0) || c.numeraireDecimals > 18
                || c.launchFeeTreasury == address(0) || c.startFdvWad == 0 || c.graduationFdvWad <= c.startFdvWad
                || c.launchFeeAmount == 0 || c.maxWalletBps == 0 || c.maxWalletBps > 300 || c.maxWalletWindowSecs == 0
                || c.maxWalletWindowSecs > 3600 || c.observationCardinality < 2 || c.minimumProceeds == 0
                || c.maxCurveDust == 0 || c.maxCurveDust > CURVE_TARGET / 1000 || c.maxPermanentTokenDust == 0
                || c.maxPermanentQuoteDust == 0 || c.owner == address(0)
        ) revert InvalidConfig();
        if (c.launchFeeNative) {
            if (c.launchFeeAsset != address(0)) revert InvalidConfig();
        } else if (c.launchFeeAsset == address(0)) {
            revert InvalidConfig();
        }
        if (HydeERC20(c.impl).TOTAL_SUPPLY() != TOTAL_SUPPLY) revert InvalidConfig();

        IMPL = c.impl;
        V3_FACTORY = ITrenchV3Factory(c.v3Factory);
        POSITION_MANAGER = ITrenchV3MintOnly(c.positionManager);
        FLYWHEEL_VAULT_FACTORY = IFlywheelVaultFactory(c.flywheelVaultFactory);
        NUMERAIRE = c.numeraire;
        NUMERAIRE_DECIMALS = c.numeraireDecimals;
        FEE_TIER = c.feeTier;
        OBSERVATION_CARDINALITY = c.observationCardinality;
        LAUNCH_FEE_ASSET = c.launchFeeAsset;
        LAUNCH_FEE_AMOUNT = c.launchFeeAmount;
        LAUNCH_FEE_NATIVE = c.launchFeeNative;
        LAUNCH_FEE_TREASURY = c.launchFeeTreasury;
        MAX_WALLET_BPS = c.maxWalletBps;
        MAX_WALLET_WINDOW_SECS = c.maxWalletWindowSecs;
        MAX_CURVE_DUST = c.maxCurveDust;
        owner = c.owner;

        int24 spacing;
        uint24 positionKey;
        if (c.slipstream) {
            spacing = c.tickSpacing;
            if (spacing <= 0 || ITrenchSlipstreamFactory(c.v3Factory).tickSpacingToFee(spacing) != c.feeTier) {
                revert InvalidConfig();
            }
            positionKey = uint24(uint256(int256(spacing)));
        } else {
            if (c.tickSpacing != 0) revert InvalidConfig();
            spacing = V3_FACTORY.feeAmountTickSpacing(c.feeTier);
            positionKey = c.feeTier;
        }
        if (spacing <= 0 || c.twapTickTolerance < 0 || c.twapTickTolerance > spacing) {
            revert InvalidConfig();
        }
        SLIPSTREAM = c.slipstream;
        POSITION_KEY = positionKey;
        TICK_SPACING = spacing;

        uint256 numScale = 10 ** c.numeraireDecimals;
        uint256 startFdvRaw = Math.mulDiv(c.startFdvWad, numScale, 1e18);
        uint256 graduationFdvRaw = Math.mulDiv(c.graduationFdvWad, numScale, 1e18);
        int24 floor_ = _alignToSpacing(TickMath.getTickAtSqrtRatio(_sqrtPriceX96FromFdv(startFdvRaw)), spacing);
        int24 graduation_ =
            _alignToSpacing(TickMath.getTickAtSqrtRatio(_sqrtPriceX96FromFdv(graduationFdvRaw)), spacing);
        if (
            floor_ >= graduation_ || floor_ <= TickMath.MIN_TICK + spacing || graduation_ >= TickMath.MAX_TICK - spacing
        ) revert TickRangeInvalid();
        TICK_FLOOR = floor_;
        TICK_GRADUATION = graduation_;
        ACTUAL_START_FDV_RAW = _fdvRawFromSqrtPriceX96(TickMath.getSqrtRatioAtTick(floor_));
        ACTUAL_GRADUATION_FDV_RAW = _fdvRawFromSqrtPriceX96(TickMath.getSqrtRatioAtTick(graduation_));
        uint256 terminal0 = _terminalProceeds(floor_, graduation_, true);
        uint256 terminal1 = _terminalProceeds(-graduation_, -floor_, false);
        uint256 expectedTerminal = terminal0 < terminal1 ? terminal0 : terminal1;
        if (expectedTerminal < c.minimumProceeds) revert InvalidConfig();
        EXPECTED_TERMINAL_PROCEEDS = expectedTerminal;

        TrenchV3Locker locker = TrenchV3Locker(c.locker);
        TrenchV3Graduator graduator = TrenchV3Graduator(c.graduator);
        if (
            address(locker.POSITION_MANAGER()) != c.positionManager || locker.HYDE_TREASURY() != c.hydeTreasury
                || locker.graduator() != c.graduator || graduator.FACTORY() != address(this)
                || address(graduator.POSITION_MANAGER()) != c.positionManager || address(graduator.LOCKER()) != c.locker
                || graduator.NUMERAIRE() != c.numeraire || graduator.FEE_TIER() != positionKey
                || graduator.TICK_SPACING() != spacing || graduator.SLIPSTREAM() != c.slipstream
                || graduator.GRADUATION_DELAY() != c.graduationDelay
                || graduator.TWAP_TICK_TOLERANCE() != c.twapTickTolerance
                || graduator.MINIMUM_PROCEEDS() != c.minimumProceeds || graduator.MAX_CURVE_DUST() != c.maxCurveDust
                || graduator.MAX_PERMANENT_TOKEN_DUST() != c.maxPermanentTokenDust
                || graduator.MAX_PERMANENT_QUOTE_DUST() != c.maxPermanentQuoteDust
        ) revert InvalidConfig();
        LOCKER = locker;
        GRADUATOR = graduator;
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
        address creator = msg.sender;
        _takeLaunchFee(creator);

        bytes32 seed = keccak256(abi.encode(creator, salt, launchNonce++));
        uint256 tries;
        for (; tries < MAX_SALT_TRIES;) {
            address predicted = Clones.predictDeterministicAddress(IMPL, seed, address(this));
            if (predicted.code.length == 0 && _getPool(predicted) == address(0)) break;
            unchecked {
                ++tries;
                seed = keccak256(abi.encode(seed));
            }
        }
        if (tries == MAX_SALT_TRIES) revert LaunchGriefed();

        token = Clones.cloneDeterministic(IMPL, seed);
        bool tokenIs0 = token < NUMERAIRE;
        (int24 tickLower, int24 tickUpper, int24 initTick) = _rangeFor(tokenIs0);
        uint160 initialSqrtPriceX96 = TickMath.getSqrtRatioAtTick(initTick);
        address pool = _getPool(token);
        if (pool == address(0)) pool = _createPool(token, initialSqrtPriceX96);

        address[] memory exemptAddrs = new address[](flywheelRecipient == address(0) ? 7 : 8);
        exemptAddrs[0] = address(this);
        exemptAddrs[1] = pool;
        exemptAddrs[2] = address(POSITION_MANAGER);
        exemptAddrs[3] = address(LOCKER);
        exemptAddrs[4] = address(GRADUATOR);
        exemptAddrs[5] = address(V3_FACTORY);
        exemptAddrs[6] = NUMERAIRE;
        if (flywheelRecipient != address(0)) exemptAddrs[7] = flywheelRecipient;
        HydeERC20(token)
            .initialize(
                HydeERC20.InitParams({
                    name: name,
                    symbol: symbol,
                    poolRecipient: address(this),
                    feeLocker: address(LOCKER),
                    maxWalletBps: MAX_WALLET_BPS,
                    maxWalletWindowSecs: MAX_WALLET_WINDOW_SECS,
                    exemptAddrs: exemptAddrs
                })
            );

        uint160 existing = _sqrtPriceX96(pool);
        if (SLIPSTREAM) {
            if (existing != initialSqrtPriceX96) revert LaunchGriefed();
        } else {
            if (existing != 0) revert LaunchGriefed();
            ITrenchV3Pool(pool).initialize(initialSqrtPriceX96);
        }
        ITrenchV3Pool(pool).increaseObservationCardinalityNext(OBSERVATION_CARDINALITY);

        uint128 curveLiquidity;
        uint256 curveTokenUsed;
        (curveTokenId, curveLiquidity, curveTokenUsed) = _mintCurve(token, tokenIs0, tickLower, tickUpper);

        if (POSITION_MANAGER.ownerOf(curveTokenId) != address(GRADUATOR)) revert NotCustodied();

        uint256 reserve = IERC20(token).balanceOf(address(this));
        if (
            curveTokenUsed > CURVE_TARGET || CURVE_TARGET - curveTokenUsed > MAX_CURVE_DUST
                || reserve < GRADUATION_RESERVE_TARGET || curveTokenUsed + reserve != TOTAL_SUPPLY
        ) revert SeedFailed();
        IERC20(token).safeTransfer(address(GRADUATOR), reserve);
        if (IERC20(token).balanceOf(address(this)) != 0) revert SeedFailed();

        GRADUATOR.registerCurve(
            token, creator, pool, curveTokenId, CURVE_TARGET, reserve, tickLower, tickUpper, tokenIs0, flywheelRecipient
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
        emit LaunchCreated(token, creator, pool, curveTokenId, curveLiquidity, curveTokenUsed, reserve);
        if (flywheelRecipient != address(0)) {
            emit FlywheelLaunchCreated(token, creator, flywheelRecipient);
        }
    }

    function _validateFlywheel(address recipient, address creator) private view {
        if (
            address(FLYWHEEL_VAULT_FACTORY) == address(0) || recipient == address(0)
                || !FLYWHEEL_VAULT_FACTORY.isVault(recipient) || !FLYWHEEL_VAULT_FACTORY.isVaultConfigActive(recipient)
                || IFlywheelVault(recipient).DEPLOYER_FACTORY() != address(FLYWHEEL_VAULT_FACTORY)
                || IFlywheelVault(recipient).FEE_SOURCE() != address(LOCKER)
                || IFlywheelVault(recipient).NUMERAIRE() != NUMERAIRE
                || IFlywheelVault(recipient).CONTROLLER() != creator
                || IFlywheelVault(recipient).stakingToken() != address(0)
                || FLYWHEEL_VAULT_FACTORY.vaultToken(recipient) != address(0)
        ) revert InvalidFlywheel();
    }

    function _mintCurve(address token, bool tokenIs0, int24 tickLower, int24 tickUpper)
        private
        returns (uint256 tokenId, uint128 liquidity, uint256 tokenUsed)
    {
        IERC20(token).forceApprove(address(POSITION_MANAGER), CURVE_TARGET);
        uint256 used0;
        uint256 used1;
        (tokenId, liquidity, used0, used1) = _mintPosition(
            TrenchV3MintParams({
                token0: tokenIs0 ? token : NUMERAIRE,
                token1: tokenIs0 ? NUMERAIRE : token,
                fee: FEE_TIER,
                tickLower: tickLower,
                tickUpper: tickUpper,
                amount0Desired: tokenIs0 ? CURVE_TARGET : 0,
                amount1Desired: tokenIs0 ? 0 : CURVE_TARGET,
                amount0Min: 0,
                amount1Min: 0,
                recipient: address(GRADUATOR),
                deadline: block.timestamp
            })
        );
        IERC20(token).forceApprove(address(POSITION_MANAGER), 0);

        uint256 quoteUsed = tokenIs0 ? used1 : used0;
        tokenUsed = tokenIs0 ? used0 : used1;
        if (quoteUsed != 0) revert NotSingleSided();
        if (liquidity == 0 || tokenUsed == 0 || tokenUsed > CURVE_TARGET || CURVE_TARGET - tokenUsed > MAX_CURVE_DUST) {
            revert SeedFailed();
        }
    }

    function _getPool(address token) private view returns (address) {
        if (SLIPSTREAM) {
            return ITrenchSlipstreamFactory(address(V3_FACTORY)).getPool(token, NUMERAIRE, TICK_SPACING);
        }
        return V3_FACTORY.getPool(token, NUMERAIRE, FEE_TIER);
    }

    /// @dev Uniswap V3 returns seven slot0 words while Slipstream returns six.
    ///      The sqrt price is their ABI-compatible first word.
    function _sqrtPriceX96(address pool) private view returns (uint160 sqrtPriceX96) {
        (bool ok, bytes memory data) = pool.staticcall(abi.encodeWithSignature("slot0()"));
        if (!ok || data.length < 32) revert LaunchGriefed();
        sqrtPriceX96 = abi.decode(data, (uint160));
    }

    function _createPool(address token, uint160 sqrtPriceX96) private returns (address) {
        if (SLIPSTREAM) {
            return
                ITrenchSlipstreamFactory(address(V3_FACTORY)).createPool(token, NUMERAIRE, TICK_SPACING, sqrtPriceX96);
        }
        return V3_FACTORY.createPool(token, NUMERAIRE, FEE_TIER);
    }

    function _mintPosition(TrenchV3MintParams memory p)
        private
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        if (!SLIPSTREAM) return POSITION_MANAGER.mint(p);
        return ITrenchSlipstreamMintOnly(address(POSITION_MANAGER))
            .mint(
                TrenchSlipstreamMintParams({
                    token0: p.token0,
                    token1: p.token1,
                    tickSpacing: TICK_SPACING,
                    tickLower: p.tickLower,
                    tickUpper: p.tickUpper,
                    amount0Desired: p.amount0Desired,
                    amount1Desired: p.amount1Desired,
                    amount0Min: p.amount0Min,
                    amount1Min: p.amount1Min,
                    recipient: p.recipient,
                    deadline: p.deadline,
                    sqrtPriceX96: 0
                })
            );
    }

    function _takeLaunchFee(address creator) private {
        if (LAUNCH_FEE_NATIVE) {
            if (msg.value != LAUNCH_FEE_AMOUNT) revert BadFee();
            (bool ok,) = LAUNCH_FEE_TREASURY.call{value: msg.value}("");
            if (!ok) revert EthFeeTransferFailed();
        } else {
            if (msg.value != 0) revert BadFee();
            IERC20 feeAsset = IERC20(LAUNCH_FEE_ASSET);
            uint256 beforeBalance = feeAsset.balanceOf(LAUNCH_FEE_TREASURY);
            feeAsset.safeTransferFrom(creator, LAUNCH_FEE_TREASURY, LAUNCH_FEE_AMOUNT);
            if (feeAsset.balanceOf(LAUNCH_FEE_TREASURY) - beforeBalance != LAUNCH_FEE_AMOUNT) {
                revert FeeOnTransfer();
            }
        }
        emit LaunchFeePaid(creator, LAUNCH_FEE_ASSET, LAUNCH_FEE_AMOUNT);
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
        uint160 sqrtA = TickMath.getSqrtRatioAtTick(lower);
        uint160 sqrtB = TickMath.getSqrtRatioAtTick(upper);
        uint128 liquidity = tokenIs0
            ? TrenchV3Math.liquidityForAmount0(sqrtA, sqrtB, CURVE_TARGET)
            : TrenchV3Math.liquidityForAmount1(sqrtA, sqrtB, CURVE_TARGET);
        return tokenIs0
            ? TrenchV3Math.amount1ForLiquidity(sqrtA, sqrtB, liquidity)
            : TrenchV3Math.amount0ForLiquidity(sqrtA, sqrtB, liquidity);
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
        address old = owner;
        owner = msg.sender;
        pendingOwner = address(0);
        emit OwnershipTransferred(old, msg.sender);
    }

    function renounceOwnership() external onlyOwner {
        address old = owner;
        owner = address(0);
        pendingOwner = address(0);
        emit OwnershipTransferred(old, address(0));
    }

    function tokenCount() external view returns (uint256) {
        return allTokens.length;
    }

    function predictToken(address creator, bytes32 salt, uint256 nonce) external view returns (address) {
        return Clones.predictDeterministicAddress(IMPL, keccak256(abi.encode(creator, salt, nonce)), address(this));
    }
}
