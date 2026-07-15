// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal cross-contract slice of `HydeERC20` (CONTRACT_SPEC_L3.md §2 · rev8). The holder
///         reward system (and `isRewardExcluded`) is removed in rev8; only the ERC-20 balance view
///         remains for any generic reader.
interface IHydeToken {
    function balanceOf(address account) external view returns (uint256);
}
