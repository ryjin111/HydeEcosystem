// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Minimal Uniswap V3 surfaces used by the V5 Trench Curve contracts.
/// @dev The permanent locker imports only `ITrenchV3CollectOnly`. The graduation-only
///      decrease/burn selectors live in `ITrenchV3PositionManager`.

interface ITrenchV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
    function createPool(address tokenA, address tokenB, uint24 fee) external returns (address pool);
    function feeAmountTickSpacing(uint24 fee) external view returns (int24);
}

interface ITrenchV3Pool {
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );

    function initialize(uint160 sqrtPriceX96) external;
    function increaseObservationCardinalityNext(uint16 observationCardinalityNext) external;
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);
}

struct TrenchV3MintParams {
    address token0;
    address token1;
    uint24 fee;
    int24 tickLower;
    int24 tickUpper;
    uint256 amount0Desired;
    uint256 amount1Desired;
    uint256 amount0Min;
    uint256 amount1Min;
    address recipient;
    uint256 deadline;
}

struct TrenchV3DecreaseParams {
    uint256 tokenId;
    uint128 liquidity;
    uint256 amount0Min;
    uint256 amount1Min;
    uint256 deadline;
}

struct TrenchV3CollectParams {
    uint256 tokenId;
    address recipient;
    uint128 amount0Max;
    uint128 amount1Max;
}

interface ITrenchV3MintOnly {
    function mint(TrenchV3MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);

    function ownerOf(uint256 tokenId) external view returns (address owner);
}

interface ITrenchV3CollectOnly {
    function collect(TrenchV3CollectParams calldata params) external payable returns (uint256 amount0, uint256 amount1);

    function positions(uint256 tokenId)
        external
        view
        returns (
            uint96 nonce,
            address operator,
            address token0,
            address token1,
            uint24 fee,
            int24 tickLower,
            int24 tickUpper,
            uint128 liquidity,
            uint256 feeGrowthInside0LastX128,
            uint256 feeGrowthInside1LastX128,
            uint128 tokensOwed0,
            uint128 tokensOwed1
        );

    function ownerOf(uint256 tokenId) external view returns (address owner);
}

interface ITrenchV3PositionManager is ITrenchV3CollectOnly {
    function mint(TrenchV3MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);

    function decreaseLiquidity(TrenchV3DecreaseParams calldata params)
        external
        payable
        returns (uint256 amount0, uint256 amount1);

    function burn(uint256 tokenId) external payable;
}

interface ITrenchV3LockerRegister {
    function openCurve(address token, address creator, address numeraire, uint24 feeTier) external;
    function noteCurveFees(address token, address asset, uint256 amount) external;
    function registerPositions(address token, uint256[] calldata tokenIds) external;
}
