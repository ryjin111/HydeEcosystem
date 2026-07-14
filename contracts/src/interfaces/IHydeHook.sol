// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";

/// @notice Cross-contract surface of `HydeHook` (CONTRACT_SPEC_L3.md §4c) used by the factory
///         (one-shot pending-pool registration before pool init) and the vault (TWAP floor + the
///         swap-only volume graduation metric).
interface IHydeHook {
    /// @notice Factory records the exact pending LT/WETH pool + its launch token, one-shot per poolId,
    ///         BEFORE `POOL_MANAGER.initialize` (consumed in `beforeInitialize`). `onlyFactory`.
    function registerPendingPool(PoolKey calldata key, address token) external;

    /// @notice Time-weighted average tick over the trailing `window`, interpolated at exactly
    ///         `now - window` (idle-pool synthetic bracket, signed −∞ rounding). Reverts
    ///         `ORACLE_NOT_READY` until the window is spanned. The vault converts tick→price.
    function consult(PoolId poolId, uint32 window) external view returns (int24 twapTick);

    /// @notice Monotonic swap-only gross WETH volume for the pool (graduation metric; donation/flash
    ///         and system settlement swaps are excluded).
    function swapVolume(PoolId poolId) external view returns (uint256);
}
