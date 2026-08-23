// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

import {IFlywheelFeeSource} from "./interfaces/IFlywheelFeeSource.sol";
import {IFlywheelVault} from "./interfaces/IFlywheelVault.sol";
import {FlywheelVault} from "./FlywheelVault.sol";

/// @title FlywheelVaultFactory
/// @notice Permissionless deterministic deployer for official Hydeout Flywheel vaults.
contract FlywheelVaultFactory is Ownable2Step {
    uint64 public constant ROUTE_ACTIVATION_DELAY = 2 days;

    struct PendingRoute {
        address converter;
        uint64 activateAfter;
    }

    mapping(address vault => bool) public isVault;
    mapping(address vault => address token) public vaultToken;
    mapping(address token => address vault) public tokenVault;
    mapping(bytes32 pairKey => address converter) private _rewardConverters;
    mapping(bytes32 pairKey => PendingRoute route) private _pendingRoutes;

    event VaultCreated(
        address indexed vault,
        address indexed controller,
        address indexed feeSource,
        address numeraire,
        address rewardAsset,
        address rewardConverter,
        uint32 rewardDuration,
        bytes32 userSalt
    );
    event VaultBound(address indexed vault, address indexed token);
    event RewardRouteProposed(
        address indexed inputAsset, address indexed rewardAsset, address indexed converter, uint64 activateAfter
    );
    event RewardRouteActivated(
        address indexed inputAsset, address indexed rewardAsset, address indexed converter
    );
    event RewardRouteDisabled(
        address indexed inputAsset, address indexed rewardAsset, address indexed converter
    );
    event RewardRouteProposalCancelled(
        address indexed inputAsset, address indexed rewardAsset, address indexed converter
    );

    error UnknownVault();
    error VaultAlreadyBound();
    error TokenAlreadyBound();
    error InvalidBinding();
    error InvalidRewardRoute();
    error RewardRouteNotReady();
    error OwnershipRenunciationDisabled();

    constructor(address initialOwner) Ownable(initialOwner) {}

    function renounceOwnership() public pure override {
        revert OwnershipRenunciationDisabled();
    }

    /// @notice Starts the mandatory delay for a new or replacement exact conversion route.
    /// @dev The owner should still be a multisig. Existing routes remain active during the delay.
    function proposeRewardRoute(address inputAsset, address rewardAsset, address converter) external onlyOwner {
        if (
            inputAsset == address(0) || rewardAsset == address(0) || converter == address(0)
                || inputAsset == rewardAsset || inputAsset.code.length == 0 || rewardAsset.code.length == 0
                || converter.code.length == 0
        ) revert InvalidRewardRoute();
        bytes32 key = _pairKey(inputAsset, rewardAsset);
        uint64 activateAfter = uint64(block.timestamp + ROUTE_ACTIVATION_DELAY);
        _pendingRoutes[key] = PendingRoute({converter: converter, activateAfter: activateAfter});
        emit RewardRouteProposed(inputAsset, rewardAsset, converter, activateAfter);
    }

    function activateRewardRoute(address inputAsset, address rewardAsset) external onlyOwner {
        bytes32 key = _pairKey(inputAsset, rewardAsset);
        PendingRoute memory pending = _pendingRoutes[key];
        if (pending.converter == address(0) || block.timestamp < pending.activateAfter) revert RewardRouteNotReady();
        delete _pendingRoutes[key];
        _rewardConverters[key] = pending.converter;
        emit RewardRouteActivated(inputAsset, rewardAsset, pending.converter);
    }

    function cancelRewardRouteProposal(address inputAsset, address rewardAsset) external onlyOwner {
        bytes32 key = _pairKey(inputAsset, rewardAsset);
        address converter = _pendingRoutes[key].converter;
        if (converter == address(0)) revert InvalidRewardRoute();
        delete _pendingRoutes[key];
        emit RewardRouteProposalCancelled(inputAsset, rewardAsset, converter);
    }

    /// @notice Immediately stops conversion for an unsafe route without blocking stake withdrawals.
    function disableRewardRoute(address inputAsset, address rewardAsset) external onlyOwner {
        bytes32 key = _pairKey(inputAsset, rewardAsset);
        address converter = _rewardConverters[key];
        if (converter == address(0)) revert InvalidRewardRoute();
        delete _rewardConverters[key];
        emit RewardRouteDisabled(inputAsset, rewardAsset, converter);
    }

    /// @notice Creates the default vault where both LP fee assets stream without swapping.

    function createVault(
        IFlywheelFeeSource feeSource,
        address numeraire,
        address controller,
        uint32 rewardDuration,
        bytes32 userSalt
    ) external returns (FlywheelVault vault) {
        vault = _createVault(msg.sender, feeSource, numeraire, numeraire, controller, rewardDuration, userSalt);
    }

    /// @notice Creates a vault whose numeraire-side fees convert into a creator-selected reward asset.
    /// @dev `rewardAsset` must have an active, owner-approved exact route from `numeraire`.
    function createVault(
        IFlywheelFeeSource feeSource,
        address numeraire,
        address rewardAsset,
        address controller,
        uint32 rewardDuration,
        bytes32 userSalt
    ) external returns (FlywheelVault vault) {
        if (rewardConverterFor(numeraire, rewardAsset) == address(0)) revert InvalidRewardRoute();
        vault = _createVault(msg.sender, feeSource, numeraire, rewardAsset, controller, rewardDuration, userSalt);
    }

    /// @notice Permanently binds an official vault to exactly one launched token.
    /// @dev Only the vault itself can bind, during its one-shot initialization.
    function bindVault(address token) external {
        if (!isVault[msg.sender]) revert UnknownVault();
        if (token == address(0) || token.code.length == 0 || IFlywheelVault(msg.sender).stakingToken() != token) {
            revert InvalidBinding();
        }
        if (vaultToken[msg.sender] != address(0)) revert VaultAlreadyBound();
        if (tokenVault[token] != address(0)) revert TokenAlreadyBound();
        vaultToken[msg.sender] = token;
        tokenVault[token] = msg.sender;
        emit VaultBound(msg.sender, token);
    }

    function predictVault(
        address deployer,
        IFlywheelFeeSource feeSource,
        address numeraire,
        address controller,
        uint32 rewardDuration,
        bytes32 userSalt
    ) external view returns (address predicted) {
        predicted = _predictVault(deployer, feeSource, numeraire, numeraire, controller, rewardDuration, userSalt);
    }

    function predictVault(
        address deployer,
        IFlywheelFeeSource feeSource,
        address numeraire,
        address rewardAsset,
        address controller,
        uint32 rewardDuration,
        bytes32 userSalt
    ) external view returns (address predicted) {
        if (rewardConverterFor(numeraire, rewardAsset) == address(0)) revert InvalidRewardRoute();
        predicted = _predictVault(deployer, feeSource, numeraire, rewardAsset, controller, rewardDuration, userSalt);
    }

    function isRewardRouteActive(address inputAsset, address rewardAsset, address converter)
        public
        view
        returns (bool)
    {
        if (rewardAsset == inputAsset) return converter == address(0) && inputAsset != address(0);
        return converter != address(0) && rewardConverterFor(inputAsset, rewardAsset) == converter;
    }

    function rewardConverterFor(address inputAsset, address rewardAsset) public view returns (address) {
        if (rewardAsset == inputAsset) return address(0);
        return _rewardConverters[_pairKey(inputAsset, rewardAsset)];
    }

    function pendingRewardRoute(address inputAsset, address rewardAsset)
        external
        view
        returns (address converter, uint64 activateAfter)
    {
        PendingRoute memory pending = _pendingRoutes[_pairKey(inputAsset, rewardAsset)];
        return (pending.converter, pending.activateAfter);
    }

    function isVaultConfigActive(address vault) external view returns (bool) {
        if (!isVault[vault]) return false;
        return isRewardRouteActive(
            IFlywheelVault(vault).NUMERAIRE(), IFlywheelVault(vault).REWARD_ASSET(), IFlywheelVault(vault).rewardConverter()
        );
    }

    function _createVault(
        address deployer,
        IFlywheelFeeSource feeSource,
        address numeraire,
        address rewardAsset,
        address controller,
        uint32 rewardDuration,
        bytes32 userSalt
    ) private returns (FlywheelVault vault) {
        bytes32 salt = _salt(deployer, feeSource, numeraire, rewardAsset, controller, rewardDuration, userSalt);
        vault = new FlywheelVault{salt: salt}(feeSource, numeraire, rewardAsset, controller, rewardDuration);
        isVault[address(vault)] = true;
        emit VaultCreated(
            address(vault),
            controller,
            address(feeSource),
            numeraire,
            rewardAsset,
            rewardConverterFor(numeraire, rewardAsset),
            rewardDuration,
            userSalt
        );
    }

    function _predictVault(
        address deployer,
        IFlywheelFeeSource feeSource,
        address numeraire,
        address rewardAsset,
        address controller,
        uint32 rewardDuration,
        bytes32 userSalt
    ) private view returns (address predicted) {
        bytes32 salt = _salt(deployer, feeSource, numeraire, rewardAsset, controller, rewardDuration, userSalt);
        bytes memory initCode = abi.encodePacked(
            type(FlywheelVault).creationCode, abi.encode(feeSource, numeraire, rewardAsset, controller, rewardDuration)
        );
        bytes32 hash = keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, keccak256(initCode)));
        predicted = address(uint160(uint256(hash)));
    }

    function _salt(
        address deployer,
        IFlywheelFeeSource feeSource,
        address numeraire,
        address rewardAsset,
        address controller,
        uint32 rewardDuration,
        bytes32 userSalt
    ) private pure returns (bytes32) {
        return keccak256(
            abi.encode(deployer, feeSource, numeraire, rewardAsset, controller, rewardDuration, userSalt)
        );
    }

    function _pairKey(address inputAsset, address rewardAsset) private pure returns (bytes32) {
        return keccak256(abi.encode(inputAsset, rewardAsset));
    }
}
