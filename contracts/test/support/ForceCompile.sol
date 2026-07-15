// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Force Foundry to emit artifacts for the concrete contracts that PosmTestSetup's `Deploy` helper
// instantiates via `vm.getCode("<Name>.sol:<Name>")` (they are referenced only by string, so they are
// otherwise absent from the compilation dependency graph → "no matching artifact found").
import {PositionManager} from "v4-periphery/src/PositionManager.sol";
import {PositionDescriptor} from "v4-periphery/src/PositionDescriptor.sol";
import {TransparentUpgradeableProxy} from
    "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
