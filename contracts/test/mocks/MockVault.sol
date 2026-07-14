// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IHydeVault} from "../../src/interfaces/IHydeVault.sol";

/// @notice Minimal IHydeVault stand-in for isolating HydeERC20 unit tests. Records `sync` calls and
///         can be toggled to revert (to prove the token still can't be bricked on the normal path is
///         the token's job — the vault's real `sync` is non-reverting; INV-23).
contract MockVault is IHydeVault {
    address public lastFrom;
    address public lastTo;
    uint256 public lastAmount;
    bool public lastFromExcl;
    bool public lastToExcl;
    uint256 public syncCount;
    bool public reverts;

    function setReverts(bool r) external {
        reverts = r;
    }

    function sync(address from, address to, uint256, uint256, uint256 amount, bool fromExcl, bool toExcl) external {
        if (reverts) revert("VAULT_REVERT");
        lastFrom = from;
        lastTo = to;
        lastAmount = amount;
        lastFromExcl = fromExcl;
        lastToExcl = toExcl;
        syncCount++;
    }

    function register(address, address) external {}
    function noteRaw(address, address, uint256) external {}
}
