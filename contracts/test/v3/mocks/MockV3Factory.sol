// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IUniswapV3Factory} from "../../../src/v3/interfaces/IUniswapV3Minimal.sol";

/// @dev Minimal V3 factory stub for CONSTRUCTOR-level unit tests (the FDV→tick derivation). Only
///      `feeAmountTickSpacing` is exercised in the pad constructor; getPool/createPool are stubbed for
///      completeness (the full launch/seed path is proven on the Stable/988 FORK test, not here).
contract MockV3Factory is IUniswapV3Factory {
    mapping(uint24 => int24) public tickSpacingOf;
    mapping(bytes32 => address) internal _pools;

    function setTickSpacing(uint24 fee, int24 spacing) external {
        tickSpacingOf[fee] = spacing;
    }

    function feeAmountTickSpacing(uint24 fee) external view returns (int24) {
        return tickSpacingOf[fee];
    }

    function getPool(address a, address b, uint24 fee) external view returns (address) {
        (address t0, address t1) = a < b ? (a, b) : (b, a);
        return _pools[keccak256(abi.encode(t0, t1, fee))];
    }

    function createPool(address a, address b, uint24 fee) external returns (address pool) {
        (address t0, address t1) = a < b ? (a, b) : (b, a);
        pool = address(uint160(uint256(keccak256(abi.encode(t0, t1, fee, "pool")))));
        _pools[keccak256(abi.encode(t0, t1, fee))] = pool;
    }
}
