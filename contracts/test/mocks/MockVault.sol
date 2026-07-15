// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IHydeVault} from "../../src/interfaces/IHydeVault.sol";

/// @notice Minimal IHydeVault stand-in for isolating HydeERC20 unit tests. (rev8) The token no longer
///         calls the vault (the reward `sync` hook is removed), so this is just a non-zero `vault`
///         placeholder that satisfies `initialize`.
contract MockVault is IHydeVault {
    function register(address, address) external {}
    function noteRaw(address, address, uint256) external {}
}
