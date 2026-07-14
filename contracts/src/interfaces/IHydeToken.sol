// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The slice of `HydeERC20` the vault reads when settling a holder claim: current balance
///         and the frozen reward-exclusion flag (CONTRACT_SPEC_L3.md §2/§4b).
interface IHydeToken {
    function balanceOf(address account) external view returns (uint256);
    function isRewardExcluded(address account) external view returns (bool);
}
