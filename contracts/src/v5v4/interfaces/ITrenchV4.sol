// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";

interface ITrenchV4LockerRegister {
    function openCurve(address token, address creator, PoolKey calldata key) external;
    function noteCurveFees(address token, address asset, uint256 amount) external;
    function registerPositions(address token, uint256[] calldata tokenIds) external;
}

interface ITrenchV4GraduatorRegister {
    function registerCurve(
        address token,
        address creator,
        PoolKey calldata key,
        uint256 curveTokenId,
        uint256 expectedCurveAllocation,
        uint256 reserveToken,
        int24 tickLower,
        int24 tickUpper,
        bool tokenIs0
    ) external;
}
