// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Audited, route-specific adapter used by an official Flywheel vault.
/// @dev Implementations MUST derive `minimumOutput` from a manipulation-resistant oracle or TWAP.
///      A spot quote from the pool being traded is not sufficient protection against MEV.
interface IFlywheelRewardConverter {
    function minimumOutput(address inputAsset, address rewardAsset, uint256 inputAmount)
        external
        view
        returns (uint256);

    function convert(
        address inputAsset,
        address rewardAsset,
        uint256 inputAmount,
        uint256 minimumOutput,
        address recipient
    ) external returns (uint256 outputAmount);
}
