// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal Uniswap V3 factory surface — the vault derives a launch's LT/WETH pool address
///         (for the `settle` TWAP oracle) via `getPool`; the factory contract uses it at seed.
interface IUniswapV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
    function createPool(address tokenA, address tokenB, uint24 fee) external returns (address pool);
}
