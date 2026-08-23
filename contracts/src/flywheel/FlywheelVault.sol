// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IFlywheelFeeSource} from "./interfaces/IFlywheelFeeSource.sol";
import {IFlywheelRewardConverter} from "./interfaces/IFlywheelRewardConverter.sol";
import {IFlywheelVaultFactory} from "./interfaces/IFlywheelVault.sol";

/// @title FlywheelVault
/// @notice Non-custodial staking receiver for a Flywheel launch's 90% fee allocation.
/// @dev Rewards stream over time in the launched token and the creator-selected reward asset. In the
///      default mode the reward asset is the pool numeraire. In converted mode only numeraire-side fees
///      are swapped; launched-token fees remain native rewards and do not create automatic sell pressure.
///      The configured launcher
///      atomically binds the vault to one token through the official factory registry. The controller
///      has no withdrawal, reward-routing, duration, initialization, or upgrade authority.
contract FlywheelVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant REWARD_PRECISION = 1e27;
    uint32 public constant MIN_REWARD_DURATION = 1 hours;
    uint32 public constant MAX_REWARD_DURATION = 30 days;

    IFlywheelFeeSource public immutable FEE_SOURCE;
    address public immutable NUMERAIRE;
    address public immutable REWARD_ASSET;
    address public immutable CONTROLLER;
    address public immutable DEPLOYER_FACTORY;
    uint32 public immutable REWARD_DURATION;

    address public stakingToken;
    uint256 public stakingOpensAt;
    uint256 public totalStaked;
    uint256 public pendingConversion;

    struct RewardState {
        uint256 rewardPerTokenStored;
        uint256 rewardRate;
        uint256 periodFinish;
        uint256 lastUpdate;
        uint256 rateRemainder;
        uint256 queuedRewards;
        uint256 rewardReserve;
        uint256 indexCarry;
    }

    mapping(address asset => RewardState) public rewardData;
    mapping(address account => uint256) public balanceOf;
    mapping(address account => mapping(address asset => uint256)) public userRewardPerTokenPaid;
    mapping(address account => mapping(address asset => uint256)) public rewards;

    event Initialized(address indexed token, address indexed controller);
    event Staked(address indexed account, uint256 amount);
    event Withdrawn(address indexed account, uint256 amount);
    event RewardPulled(address indexed asset, address indexed caller, uint256 amount);
    event ConversionQueued(address indexed inputAsset, uint256 amount, uint256 totalPending);
    event RewardConverted(
        address indexed inputAsset,
        address indexed rewardAsset,
        address indexed converter,
        uint256 inputAmount,
        uint256 outputAmount
    );
    event SurplusSynced(address indexed asset, address indexed caller, uint256 amount);
    event RewardQueued(address indexed asset, uint256 amount);
    event RewardStreamStarted(address indexed asset, uint256 amount, uint256 rewardRate, uint256 periodFinish);
    event RewardPaid(address indexed account, address indexed asset, uint256 amount);

    error AlreadyInitialized();
    error NotInitialized();
    error InvalidConfig();
    error InvalidToken();
    error InvalidAsset();
    error InvalidAmount();
    error StakingNotOpen();
    error InsufficientStake();
    error TransferMismatch();
    error Insolvent();
    error ConversionDisabled();
    error InsufficientOutput();

    constructor(
        IFlywheelFeeSource feeSource,
        address numeraire,
        address rewardAsset,
        address controller,
        uint32 rewardDuration
    ) {
        if (
            address(feeSource) == address(0) || address(feeSource).code.length == 0 || numeraire == address(0)
                || numeraire.code.length == 0 || rewardAsset == address(0) || rewardAsset.code.length == 0
                || controller == address(0) || rewardDuration < MIN_REWARD_DURATION || rewardDuration > MAX_REWARD_DURATION
        ) revert InvalidConfig();
        FEE_SOURCE = feeSource;
        NUMERAIRE = numeraire;
        REWARD_ASSET = rewardAsset;
        CONTROLLER = controller;
        DEPLOYER_FACTORY = msg.sender;
        REWARD_DURATION = rewardDuration;
    }

    /// @notice One-time binding after the launcher registers `token` with this vault as its receiver.
    /// @dev Permissionless so the launcher can initialize atomically. The immutable fee source and
    ///      official factory registry fully determine which token can bind.
    function initialize(address token) external nonReentrant {
        if (stakingToken != address(0)) revert AlreadyInitialized();
        if (
            token == address(0) || token == NUMERAIRE || token.code.length == 0
                || (REWARD_ASSET != NUMERAIRE && token == REWARD_ASSET)
        ) revert InvalidToken();
        if (FEE_SOURCE.flywheelRecipient(token) != address(this)) revert InvalidToken();
        (bool expiryOk, bytes memory expiryData) = token.staticcall(abi.encodeWithSignature("maxWalletExpiry()"));
        if (!expiryOk || expiryData.length != 32) revert InvalidToken();
        stakingToken = token;
        stakingOpensAt = abi.decode(expiryData, (uint256));
        IFlywheelVaultFactory(DEPLOYER_FACTORY).bindVault(token);
        emit Initialized(token, CONTROLLER);
        _captureRewardSurplus(token);
        _captureNumeraireSurplus();
        if (REWARD_ASSET != NUMERAIRE) _captureRewardSurplus(REWARD_ASSET);
    }

    /// @notice Stakes launched tokens. Positions are liquid and can be withdrawn at any time.
    function stake(uint256 amount) external nonReentrant {
        address token = _requireInitialized();
        if (amount == 0) revert InvalidAmount();
        if (block.timestamp < stakingOpensAt) revert StakingNotOpen();

        _updateAccount(msg.sender);
        uint256 beforeBalance = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        if (IERC20(token).balanceOf(address(this)) - beforeBalance != amount) revert TransferMismatch();

        bool firstStake = totalStaked == 0;
        balanceOf[msg.sender] += amount;
        totalStaked += amount;
        if (firstStake) {
            _startQueued(token);
            _startQueued(REWARD_ASSET);
        }
        emit Staked(msg.sender, amount);
    }

    function withdraw(uint256 amount) external nonReentrant {
        _withdraw(msg.sender, amount);
    }

    /// @notice Claims both launched-token and selected-asset rewards in one transaction.
    function claimAll() external nonReentrant returns (uint256 tokenReward, uint256 selectedReward) {
        address token = _requireInitialized();
        _updateAccount(msg.sender);
        tokenReward = _claim(msg.sender, token);
        selectedReward = _claim(msg.sender, REWARD_ASSET);
    }

    /// @notice Withdraws the full stake and claims both reward assets in one transaction.
    function exit() external nonReentrant returns (uint256 tokenReward, uint256 selectedReward) {
        address token = _requireInitialized();
        uint256 amount = balanceOf[msg.sender];
        if (amount == 0) revert InvalidAmount();
        _updateAccount(msg.sender);
        _withdrawUpdated(msg.sender, amount, token);
        tokenReward = _claim(msg.sender, token);
        selectedReward = _claim(msg.sender, REWARD_ASSET);
    }

    /// @notice Pulls the locker's accumulated 90% allocation and schedules it for stakers.
    function pullFees(address asset) external nonReentrant returns (uint256 received) {
        received = _pullFees(asset);
    }

    /// @notice Pulls both fee assets in one transaction.
    function pullAllFees() external nonReentrant returns (uint256 tokenReceived, uint256 numeraireReceived) {
        address token = _requireInitialized();
        tokenReceived = _pullFees(token);
        numeraireReceived = _pullFees(NUMERAIRE);
    }

    /// @notice Current factory-approved converter. It can be disabled or replaced without changing
    ///         the creator's immutable reward asset or any vault accounting.
    function rewardConverter() public view returns (address) {
        if (REWARD_ASSET == NUMERAIRE) return address(0);
        return IFlywheelVaultFactory(DEPLOYER_FACTORY).rewardConverterFor(NUMERAIRE, REWARD_ASSET);
    }

    /// @notice Converts all queued numeraire fees into the immutable selected reward asset.
    /// @dev Permissionless. The approved adapter supplies an independent oracle/TWAP floor; callers can
    ///      only make that floor stricter. Exact input/output balance deltas are enforced by the vault.
    function convertPending(uint256 callerMinimumOutput) external nonReentrant returns (uint256 outputAmount) {
        _requireInitialized();
        address converter = rewardConverter();
        if (converter == address(0)) revert ConversionDisabled();
        IFlywheelVaultFactory factory = IFlywheelVaultFactory(DEPLOYER_FACTORY);
        if (!factory.isRewardRouteActive(NUMERAIRE, REWARD_ASSET, converter)) revert ConversionDisabled();

        uint256 inputAmount = pendingConversion;
        if (inputAmount == 0) revert InvalidAmount();
        uint256 adapterMinimum =
            IFlywheelRewardConverter(converter).minimumOutput(NUMERAIRE, REWARD_ASSET, inputAmount);
        uint256 minimumOutput = Math.max(callerMinimumOutput, adapterMinimum);
        if (minimumOutput == 0) revert InsufficientOutput();

        uint256 inputBefore = IERC20(NUMERAIRE).balanceOf(address(this));
        uint256 outputBefore = IERC20(REWARD_ASSET).balanceOf(address(this));
        pendingConversion = 0;
        IERC20(NUMERAIRE).forceApprove(converter, inputAmount);
        uint256 reported = IFlywheelRewardConverter(converter).convert(
            NUMERAIRE, REWARD_ASSET, inputAmount, minimumOutput, address(this)
        );
        IERC20(NUMERAIRE).forceApprove(converter, 0);

        uint256 inputAfter = IERC20(NUMERAIRE).balanceOf(address(this));
        uint256 outputAfter = IERC20(REWARD_ASSET).balanceOf(address(this));
        if (inputAfter > inputBefore || inputBefore - inputAfter != inputAmount || outputAfter < outputBefore) {
            revert TransferMismatch();
        }
        outputAmount = outputAfter - outputBefore;
        if (outputAmount != reported) revert TransferMismatch();
        if (outputAmount < minimumOutput) revert InsufficientOutput();
        _notifyReward(REWARD_ASSET, outputAmount);
        emit RewardConverted(NUMERAIRE, REWARD_ASSET, converter, inputAmount, outputAmount);
    }

    /// @notice Accounts direct transfers, including fees forwarded before initialization.
    /// @dev Donations intentionally become staker rewards; they cannot alter recorded stake principal.
    function syncSurplus(address asset) external nonReentrant returns (uint256 surplus) {
        _validateManagedAsset(asset);
        surplus = asset == NUMERAIRE ? _captureNumeraireSurplus() : _captureRewardSurplus(asset);
    }

    function earned(address account, address asset) external view returns (uint256) {
        _validateRewardAssetView(asset);
        uint256 index = _currentRewardPerToken(asset);
        return rewards[account][asset]
            + Math.mulDiv(balanceOf[account], index - userRewardPerTokenPaid[account][asset], REWARD_PRECISION);
    }

    function rewardPerToken(address asset) external view returns (uint256) {
        _validateRewardAssetView(asset);
        return _currentRewardPerToken(asset);
    }

    function lastTimeRewardApplicable(address asset) external view returns (uint256) {
        _validateRewardAssetView(asset);
        return Math.min(block.timestamp, rewardData[asset].periodFinish);
    }

    function isSolvent(address asset) external view returns (bool) {
        address token = _validateManagedAssetView(asset);
        if (asset == NUMERAIRE && REWARD_ASSET != NUMERAIRE) {
            return IERC20(asset).balanceOf(address(this)) >= pendingConversion;
        }
        uint256 principal = asset == token ? totalStaked : 0;
        return IERC20(asset).balanceOf(address(this)) >= principal + rewardData[asset].rewardReserve;
    }

    function _pullFees(address asset) private returns (uint256 received) {
        address token = _validateFeeAsset(asset);
        uint256 beforeBalance = IERC20(asset).balanceOf(address(this));
        uint256 reported = FEE_SOURCE.fundFlywheel(token, asset);
        uint256 afterBalance = IERC20(asset).balanceOf(address(this));
        if (afterBalance < beforeBalance || afterBalance - beforeBalance != reported) revert TransferMismatch();
        received = asset == NUMERAIRE ? _captureNumeraireSurplus() : _captureRewardSurplus(asset);
        if (received != 0) {
            emit RewardPulled(asset, msg.sender, received);
        }
    }

    function _captureRewardSurplus(address asset) private returns (uint256 surplus) {
        address token = stakingToken;
        RewardState storage state = rewardData[asset];
        uint256 principal = asset == token ? totalStaked : 0;
        uint256 accounted = principal + state.rewardReserve;
        uint256 actual = IERC20(asset).balanceOf(address(this));
        if (actual < accounted) revert Insolvent();
        surplus = actual - accounted;
        if (surplus != 0) {
            _notifyReward(asset, surplus);
            emit SurplusSynced(asset, msg.sender, surplus);
        }
    }

    function _captureNumeraireSurplus() private returns (uint256 surplus) {
        if (REWARD_ASSET == NUMERAIRE) return _captureRewardSurplus(NUMERAIRE);
        uint256 actual = IERC20(NUMERAIRE).balanceOf(address(this));
        if (actual < pendingConversion) revert Insolvent();
        surplus = actual - pendingConversion;
        if (surplus != 0) {
            pendingConversion += surplus;
            emit ConversionQueued(NUMERAIRE, surplus, pendingConversion);
            emit SurplusSynced(NUMERAIRE, msg.sender, surplus);
        }
    }

    function _withdraw(address account, uint256 amount) private {
        address token = _requireInitialized();
        if (amount == 0) revert InvalidAmount();
        if (amount > balanceOf[account]) revert InsufficientStake();
        _updateAccount(account);
        _withdrawUpdated(account, amount, token);
    }

    function _withdrawUpdated(address account, uint256 amount, address token) private {
        balanceOf[account] -= amount;
        totalStaked -= amount;
        if (totalStaked == 0) {
            _pauseStream(token);
            _pauseStream(REWARD_ASSET);
        }
        IERC20(token).safeTransfer(account, amount);
        emit Withdrawn(account, amount);
    }

    function _claim(address account, address asset) private returns (uint256 amount) {
        amount = rewards[account][asset];
        if (amount == 0) return 0;
        rewards[account][asset] = 0;
        rewardData[asset].rewardReserve -= amount;
        IERC20(asset).safeTransfer(account, amount);
        emit RewardPaid(account, asset, amount);
    }

    function _updateAccount(address account) private {
        address token = _requireInitialized();
        _updateReward(token, account);
        _updateReward(REWARD_ASSET, account);
    }

    function _updateReward(address asset, address account) private {
        _updateGlobal(asset);
        RewardState storage state = rewardData[asset];
        uint256 paid = userRewardPerTokenPaid[account][asset];
        uint256 index = state.rewardPerTokenStored;
        if (index != paid) {
            rewards[account][asset] += Math.mulDiv(balanceOf[account], index - paid, REWARD_PRECISION);
            userRewardPerTokenPaid[account][asset] = index;
        }
    }

    function _updateGlobal(address asset) private {
        RewardState storage state = rewardData[asset];
        uint256 applicable = Math.min(block.timestamp, state.periodFinish);
        if (applicable <= state.lastUpdate) return;

        uint256 emitted = (applicable - state.lastUpdate) * state.rewardRate;
        state.lastUpdate = applicable;
        if (applicable == state.periodFinish && state.rateRemainder != 0) {
            emitted += state.rateRemainder;
            state.rateRemainder = 0;
        }
        if (emitted != 0) _creditIndex(asset, emitted);
        if (applicable == state.periodFinish && totalStaked != 0 && state.queuedRewards != 0) {
            uint256 queued = state.queuedRewards;
            state.queuedRewards = 0;
            _schedule(asset, queued);
        }
    }

    function _creditIndex(address asset, uint256 amount) private {
        if (amount == 0 || totalStaked == 0) return;
        RewardState storage state = rewardData[asset];
        uint256 increment = Math.mulDiv(amount, REWARD_PRECISION, totalStaked);
        uint256 remainder = mulmod(amount, REWARD_PRECISION, totalStaked);

        uint256 carry = state.indexCarry;
        if (carry != 0) {
            increment += carry / totalStaked;
            remainder += carry % totalStaked;
        }
        if (remainder >= totalStaked) {
            increment += remainder / totalStaked;
            remainder %= totalStaked;
        }
        state.indexCarry = remainder;
        state.rewardPerTokenStored += increment;
    }

    function _notifyReward(address asset, uint256 amount) private {
        RewardState storage state = rewardData[asset];
        state.rewardReserve += amount;
        _updateGlobal(asset);
        if (totalStaked == 0) {
            state.queuedRewards += amount;
            emit RewardQueued(asset, amount);
            return;
        }
        if (block.timestamp < state.periodFinish) {
            state.queuedRewards += amount;
            emit RewardQueued(asset, amount);
            return;
        }
        _schedule(asset, amount);
    }

    function _schedule(address asset, uint256 amount) private {
        RewardState storage state = rewardData[asset];
        state.lastUpdate = block.timestamp;
        state.periodFinish = block.timestamp + REWARD_DURATION;
        state.rewardRate = amount / REWARD_DURATION;
        state.rateRemainder = amount % REWARD_DURATION;
        emit RewardStreamStarted(asset, amount, state.rewardRate, state.periodFinish);
    }

    function _startQueued(address asset) private {
        RewardState storage state = rewardData[asset];
        uint256 queued = state.queuedRewards;
        if (queued == 0) return;
        state.queuedRewards = 0;
        _schedule(asset, queued);
    }

    function _pauseStream(address asset) private {
        _updateGlobal(asset);
        RewardState storage state = rewardData[asset];
        if (block.timestamp < state.periodFinish) {
            uint256 remaining = (state.periodFinish - block.timestamp) * state.rewardRate + state.rateRemainder;
            if (remaining != 0) state.queuedRewards += remaining;
        }
        state.rewardRate = 0;
        state.rateRemainder = 0;
        state.lastUpdate = block.timestamp;
        state.periodFinish = block.timestamp;
    }

    function _currentRewardPerToken(address asset) private view returns (uint256 index) {
        RewardState storage state = rewardData[asset];
        index = state.rewardPerTokenStored;
        if (totalStaked == 0) return index;
        uint256 applicable = Math.min(block.timestamp, state.periodFinish);
        if (applicable <= state.lastUpdate) return index;
        uint256 emitted = (applicable - state.lastUpdate) * state.rewardRate;
        if (applicable == state.periodFinish) emitted += state.rateRemainder;
        uint256 increment = Math.mulDiv(emitted, REWARD_PRECISION, totalStaked);
        uint256 remainder = mulmod(emitted, REWARD_PRECISION, totalStaked);
        uint256 carry = state.indexCarry;
        if (carry != 0) {
            increment += carry / totalStaked;
            remainder += carry % totalStaked;
        }
        if (remainder >= totalStaked) increment += remainder / totalStaked;
        return index + increment;
    }

    function _requireInitialized() private view returns (address token) {
        token = stakingToken;
        if (token == address(0)) revert NotInitialized();
    }

    function _validateFeeAsset(address asset) private view returns (address token) {
        token = _requireInitialized();
        if (asset != token && asset != NUMERAIRE) revert InvalidAsset();
    }

    function _validateRewardAssetView(address asset) private view returns (address token) {
        token = stakingToken;
        if (token == address(0)) revert NotInitialized();
        if (asset != token && asset != REWARD_ASSET) revert InvalidAsset();
    }

    function _validateManagedAsset(address asset) private view returns (address token) {
        token = _requireInitialized();
        if (asset != token && asset != NUMERAIRE && asset != REWARD_ASSET) revert InvalidAsset();
    }

    function _validateManagedAssetView(address asset) private view returns (address token) {
        token = stakingToken;
        if (token == address(0)) revert NotInitialized();
        if (asset != token && asset != NUMERAIRE && asset != REWARD_ASSET) revert InvalidAsset();
    }
}
