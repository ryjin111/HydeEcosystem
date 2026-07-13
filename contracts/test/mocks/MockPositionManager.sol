// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPositionManager} from "../../src/interfaces/IPositionManager.sol";
import {MockERC20} from "./MockERC20.sol";

/// @notice Test double for the Uniswap V3 position manager. `collect` pays out configured amounts
///         of token0/token1 (it must be pre-funded); `positions` reports token0/token1 + owed.
contract MockPositionManager is IPositionManager {
    struct Pos {
        address token0;
        address token1;
        uint128 owed0;
        uint128 owed1;
    }

    mapping(uint256 => Pos) public pos;

    function setPosition(uint256 tokenId, address token0, address token1, uint128 owed0, uint128 owed1) external {
        pos[tokenId] = Pos(token0, token1, owed0, owed1);
    }

    function collect(CollectParams calldata p) external returns (uint256 amount0, uint256 amount1) {
        Pos memory pp = pos[p.tokenId];
        amount0 = pp.owed0;
        amount1 = pp.owed1;
        if (amount0 > 0) MockERC20(pp.token0).transfer(p.recipient, amount0);
        if (amount1 > 0) MockERC20(pp.token1).transfer(p.recipient, amount1);
        // fees consumed
        pos[p.tokenId].owed0 = 0;
        pos[p.tokenId].owed1 = 0;
    }

    function positions(uint256 tokenId)
        external
        view
        returns (
            uint96,
            address,
            address token0,
            address token1,
            uint24,
            int24,
            int24,
            uint128,
            uint256,
            uint256,
            uint128 tokensOwed0,
            uint128 tokensOwed1
        )
    {
        Pos memory pp = pos[tokenId];
        return (0, address(0), pp.token0, pp.token1, 0, 0, 0, 0, 0, 0, pp.owed0, pp.owed1);
    }
}
