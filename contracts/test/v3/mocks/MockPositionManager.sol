// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IV3PositionManagerCollect} from "../../../src/v3/interfaces/IUniswapV3Minimal.sol";
import {MockERC20} from "./MockERC20.sol";

/// @dev Simulates the V3 NonfungiblePositionManager's COLLECT surface for locker unit tests. `collect`
///      transfers the configured owed fees (held by this mock — the test pre-funds it) to `recipient` and
///      returns them, exactly like the real NPM. `positions`/`ownerOf` are configurable.
contract MockPositionManager is IV3PositionManagerCollect {
    struct Pos {
        address token0;
        address token1;
        address owner;
        uint256 owed0;
        uint256 owed1;
    }

    mapping(uint256 => Pos) public pos;

    function setPosition(uint256 tokenId, address token0, address token1, address owner_) external {
        pos[tokenId].token0 = token0;
        pos[tokenId].token1 = token1;
        pos[tokenId].owner = owner_;
    }

    function setOwed(uint256 tokenId, uint256 owed0, uint256 owed1) external {
        pos[tokenId].owed0 = owed0;
        pos[tokenId].owed1 = owed1;
    }

    function collect(CollectParams calldata p) external payable returns (uint256 amount0, uint256 amount1) {
        Pos storage x = pos[p.tokenId];
        amount0 = x.owed0;
        amount1 = x.owed1;
        x.owed0 = 0;
        x.owed1 = 0;
        if (amount0 > 0) MockERC20(x.token0).transfer(p.recipient, amount0);
        if (amount1 > 0) MockERC20(x.token1).transfer(p.recipient, amount1);
    }

    function positions(uint256 tokenId)
        external
        view
        returns (uint96, address, address, address, uint24, int24, int24, uint128, uint256, uint256, uint128, uint128)
    {
        Pos memory x = pos[tokenId];
        return (0, address(0), x.token0, x.token1, 10000, 0, 0, 0, 0, 0, 0, 0);
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        return pos[tokenId].owner;
    }
}
