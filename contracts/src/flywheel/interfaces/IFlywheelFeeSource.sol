// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Common Flywheel surface implemented by both Trench V3 and V4 permanent lockers.
interface IFlywheelFeeSource {
    function fundFlywheel(address token, address asset) external returns (uint256 amount);
    function flywheelRecipient(address token) external view returns (address recipient);
}
