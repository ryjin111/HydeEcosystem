// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Cross-contract surface of `HydeFeeVault` (CONTRACT_SPEC_L3.md §4b) used by the
///         token / collector / factory. The vault holds raw V3 fees per launch, settles them to
///         WETH (the ONLY swap), splits 90/5/5, and vests the holder leg over non-extendable epochs.
interface IHydeVault {
    /// @notice Token-driven reward-index update. Called by the launch token BEFORE its balances
    ///         change (mint + every transfer). `onlyToken` (require registered[msg.sender]).
    ///         Pure arithmetic, no external calls, non-reverting on the normal path (INV-23).
    /// @param from / to        transfer endpoints (address(0) on mint)
    /// @param balFrom / balTo  PRE-change balances of from / to
    /// @param amount           transfer amount
    /// @param fromExcl/toExcl  reward-exclusion (infra/exempt) flags for from / to
    function sync(
        address from,
        address to,
        uint256 balFrom,
        uint256 balTo,
        uint256 amount,
        bool fromExcl,
        bool toExcl
    ) external;

    /// @notice Opens a launch's namespace + records its immutable creator. `onlyFactory`, BEFORE
    ///         the init mint (so the mint-`sync` is accepted; INV-30).
    function register(address token, address creator) external;

    /// @notice Pull-and-measure raw V3 fees from the collector into the token's `rawFees[asset]`
    ///         (donation-proof). `onlyCollector`. asset ∈ {launch token, WETH}.
    function noteRaw(address token, address asset, uint256 amount) external;
}
