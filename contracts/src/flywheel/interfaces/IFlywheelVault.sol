// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IFlywheelVault {
    function FEE_SOURCE() external view returns (address);
    function NUMERAIRE() external view returns (address);
    function REWARD_ASSET() external view returns (address);
    function rewardConverter() external view returns (address);
    function CONTROLLER() external view returns (address);
    function DEPLOYER_FACTORY() external view returns (address);
    function stakingToken() external view returns (address);
    function initialize(address token) external;
}

interface IFlywheelVaultFactory {
    function isVault(address vault) external view returns (bool);
    function vaultToken(address vault) external view returns (address);
    function tokenVault(address token) external view returns (address);
    function isVaultConfigActive(address vault) external view returns (bool);
    function isRewardRouteActive(address inputAsset, address rewardAsset, address converter)
        external
        view
        returns (bool);
    function rewardConverterFor(address inputAsset, address rewardAsset) external view returns (address);
    function bindVault(address token) external;
}
