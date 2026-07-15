// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Cross-contract surface of `HydeFeeVault` (CONTRACT_SPEC_L3.md §4b · rev8) used by the
///         collector / factory. The vault holds raw V4 fees per launch, settles them to WETH (the
///         ONLY swap), and splits creator/Hyde via `NET_BPS` (9500) — no holder leg (rev8: the 5%
///         liquidity leg is carved in-kind at the collector, so the token no longer calls the vault).
interface IHydeVault {
    /// @notice Opens a launch's namespace + records its immutable creator. `onlyFactory`, BEFORE
    ///         the init mint (INV-30).
    function register(address token, address creator) external;

    /// @notice Pull-and-measure raw V3 fees from the collector into the token's `rawFees[asset]`
    ///         (donation-proof). `onlyCollector`. asset ∈ {launch token, WETH}.
    function noteRaw(address token, address asset, uint256 amount) external;
}
