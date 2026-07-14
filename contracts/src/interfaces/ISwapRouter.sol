// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal SwapRouter02 surface used by `HydeFeeVault.settle` — the ONLY swap in the system
///         (CONTRACT_SPEC_L3.md §4b / INV-18). Single pinned hop LT→WETH at `feeTier`. SwapRouter02
///         params carry no deadline field (the vault enforces `deadline` itself before calling).
interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    /// @return amountOut router-reported output; the vault ignores it and re-measures WETH by
    ///         balance delta (donation-proof, matches `noteRaw`), asserting `>= minOut`.
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}
