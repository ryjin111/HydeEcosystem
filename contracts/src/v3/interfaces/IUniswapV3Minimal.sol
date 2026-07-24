// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @dev Minimal, DELIBERATELY-SPLIT Uniswap V3 interfaces — hand-written so the V3 line compiles
///      standalone on 0.8.24 (the Uniswap solidity packages target 0.7.x) AND so the perma-lock
///      invariant is STRUCTURAL: the fee locker imports only {IV3PositionManagerCollect}, which does
///      NOT declare `decreaseLiquidity` / `burn` / `transferFrom` / `approve` / `setApprovalForAll`,
///      so those selectors cannot compile into the locker at all.

interface IUniswapV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
    function createPool(address tokenA, address tokenB, uint24 fee) external returns (address pool);
    function feeAmountTickSpacing(uint24 fee) external view returns (int24);
}

interface IUniswapV3Pool {
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
}

/// @notice Shared position-read tuple used by both roles below.
struct PositionData {
    uint96 nonce;
    address operator;
    address token0;
    address token1;
    uint24 fee;
    int24 tickLower;
    int24 tickUpper;
    uint128 liquidity;
    uint256 feeGrowthInside0LastX128;
    uint256 feeGrowthInside1LastX128;
    uint128 tokensOwed0;
    uint128 tokensOwed1;
}

/// @notice FACTORY-ONLY surface: mint + read. Used by `HydeV3Pad` to seed the single-sided position.
///         Intentionally does NOT expose collect (the pad never harvests fees — the locker does).
interface IV3PositionManagerMint {
    struct MintParams {
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

    function mint(MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);

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

/// @notice LOCKER-ONLY surface: collect + read. Used by `HydeV3FeeLocker`. The ABSENCE of
///         decreaseLiquidity / burn / transferFrom / approve / setApprovalForAll here is the
///         perma-lock proof — the locker literally cannot emit those calls.
interface IV3PositionManagerCollect {
    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    function collect(CollectParams calldata params)
        external
        payable
        returns (uint256 amount0, uint256 amount1);

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
