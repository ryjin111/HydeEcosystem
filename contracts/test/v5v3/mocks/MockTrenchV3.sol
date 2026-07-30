// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {
    ITrenchV3Factory,
    ITrenchV3Pool,
    ITrenchV3PositionManager,
    TrenchV3CollectParams,
    TrenchV3DecreaseParams,
    TrenchV3MintParams
} from "../../../src/v5v3/interfaces/ITrenchV3.sol";
import {TrenchV3Math} from "../../../src/v5v3/libraries/TrenchV3Math.sol";
import {TickMath} from "../../../src/v3/libraries/TickMath.sol";

contract MockTrenchV3Pool is ITrenchV3Pool {
    uint160 public sqrtPriceX96;
    int24 public tick;
    uint16 public observationCardinalityNext = 1;

    function initialize(uint160 sqrtPriceX96_) external {
        require(sqrtPriceX96 == 0, "INITIALIZED");
        sqrtPriceX96 = sqrtPriceX96_;
        tick = TickMath.getTickAtSqrtRatio(sqrtPriceX96_);
    }

    function setSlot0(uint160 sqrtPriceX96_, int24 tick_) external {
        sqrtPriceX96 = sqrtPriceX96_;
        tick = tick_;
    }

    function increaseObservationCardinalityNext(uint16 next) external {
        if (next > observationCardinalityNext) observationCardinalityNext = next;
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (sqrtPriceX96, tick, 0, observationCardinalityNext, observationCardinalityNext, 0, true);
    }

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory cumulatives, uint160[] memory secondsPerLiquidity)
    {
        cumulatives = new int56[](secondsAgos.length);
        secondsPerLiquidity = new uint160[](secondsAgos.length);
        int56 nowCumulative = int56(tick) * int56(uint56(block.timestamp));
        for (uint256 i; i < secondsAgos.length; ++i) {
            cumulatives[i] = nowCumulative - int56(tick) * int56(uint56(secondsAgos[i]));
        }
    }
}
contract MockTrenchV3Factory is ITrenchV3Factory {
    mapping(uint24 fee => int24 spacing) public spacingOf;
    mapping(bytes32 key => address pool) private _poolOf;

    function setSpacing(uint24 fee, int24 spacing) external {
        spacingOf[fee] = spacing;
    }

    function feeAmountTickSpacing(uint24 fee) external view returns (int24) {
        return spacingOf[fee];
    }

    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address) {
        return _poolOf[_key(tokenA, tokenB, fee)];
    }

    function createPool(address tokenA, address tokenB, uint24 fee) external returns (address pool) {
        bytes32 key = _key(tokenA, tokenB, fee);
        require(_poolOf[key] == address(0), "EXISTS");
        pool = address(new MockTrenchV3Pool());
        _poolOf[key] = pool;
    }

    function _key(address a, address b, uint24 fee) private pure returns (bytes32) {
        (address token0, address token1) = a < b ? (a, b) : (b, a);
        return keccak256(abi.encode(token0, token1, fee));
    }
}

contract MockTrenchV3PositionManager is ITrenchV3PositionManager {
    uint256 private constant Q96 = 1 << 96;

    struct Position {
        address owner;
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint256 owed0;
        uint256 owed1;
    }

    ITrenchV3Factory public immutable FACTORY;
    uint256 public nextTokenId = 1;
    mapping(uint256 tokenId => Position) private _positionOf;

    constructor(ITrenchV3Factory factory) {
        FACTORY = factory;
    }

    function mint(TrenchV3MintParams calldata p)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        address pool = FACTORY.getPool(p.token0, p.token1, p.fee);
        require(pool != address(0), "NO_POOL");
        (uint160 sqrtPriceX96,,,,,,) = ITrenchV3Pool(pool).slot0();
        uint160 sqrtA = TickMath.getSqrtRatioAtTick(p.tickLower);
        uint160 sqrtB = TickMath.getSqrtRatioAtTick(p.tickUpper);
        uint256 liq;

        if (sqrtPriceX96 <= sqrtA) {
            liq = _liquidityForAmount0(sqrtA, sqrtB, p.amount0Desired);
        } else if (sqrtPriceX96 >= sqrtB) {
            liq = _liquidityForAmount1(sqrtA, sqrtB, p.amount1Desired);
        } else {
            uint256 liq0 = _liquidityForAmount0(sqrtPriceX96, sqrtB, p.amount0Desired);
            uint256 liq1 = _liquidityForAmount1(sqrtA, sqrtPriceX96, p.amount1Desired);
            liq = liq0 < liq1 ? liq0 : liq1;
        }
        require(liq != 0 && liq <= type(uint128).max, "ZERO_LIQ");
        liquidity = uint128(liq);
        (amount0, amount1) = TrenchV3Math.amountsForLiquidity(sqrtPriceX96, p.tickLower, p.tickUpper, liquidity);
        require(amount0 <= p.amount0Desired && amount1 <= p.amount1Desired, "DESIRED");
        require(amount0 >= p.amount0Min && amount1 >= p.amount1Min, "MIN");

        if (amount0 != 0) IERC20(p.token0).transferFrom(msg.sender, address(this), amount0);
        if (amount1 != 0) IERC20(p.token1).transferFrom(msg.sender, address(this), amount1);

        tokenId = nextTokenId++;
        _positionOf[tokenId] = Position({
            owner: p.recipient,
            token0: p.token0,
            token1: p.token1,
            fee: p.fee,
            tickLower: p.tickLower,
            tickUpper: p.tickUpper,
            liquidity: liquidity,
            owed0: 0,
            owed1: 0
        });
    }

    function setFees(uint256 tokenId, uint256 amount0, uint256 amount1) external {
        _positionOf[tokenId].owed0 += amount0;
        _positionOf[tokenId].owed1 += amount1;
    }

    function decreaseLiquidity(TrenchV3DecreaseParams calldata p)
        external
        payable
        returns (uint256 amount0, uint256 amount1)
    {
        Position storage pos = _positionOf[p.tokenId];
        require(pos.owner == msg.sender, "NOT_OWNER");
        require(p.liquidity != 0 && p.liquidity <= pos.liquidity, "LIQ");
        address pool = FACTORY.getPool(pos.token0, pos.token1, pos.fee);
        (uint160 sqrtPriceX96,,,,,,) = ITrenchV3Pool(pool).slot0();
        (amount0, amount1) = TrenchV3Math.amountsForLiquidity(sqrtPriceX96, pos.tickLower, pos.tickUpper, p.liquidity);
        require(amount0 >= p.amount0Min && amount1 >= p.amount1Min, "MIN");
        pos.liquidity -= p.liquidity;
        pos.owed0 += amount0;
        pos.owed1 += amount1;
    }

    function collect(TrenchV3CollectParams calldata p) external payable returns (uint256 amount0, uint256 amount1) {
        Position storage pos = _positionOf[p.tokenId];
        require(pos.owner == msg.sender, "NOT_OWNER");
        amount0 = pos.owed0 > p.amount0Max ? p.amount0Max : pos.owed0;
        amount1 = pos.owed1 > p.amount1Max ? p.amount1Max : pos.owed1;
        pos.owed0 -= amount0;
        pos.owed1 -= amount1;
        if (amount0 != 0) IERC20(pos.token0).transfer(p.recipient, amount0);
        if (amount1 != 0) IERC20(pos.token1).transfer(p.recipient, amount1);
    }

    function burn(uint256 tokenId) external payable {
        Position storage pos = _positionOf[tokenId];
        require(pos.owner == msg.sender, "NOT_OWNER");
        require(pos.liquidity == 0 && pos.owed0 == 0 && pos.owed1 == 0, "NOT_EMPTY");
        delete _positionOf[tokenId];
    }

    function positions(uint256 tokenId)
        external
        view
        returns (uint96, address, address, address, uint24, int24, int24, uint128, uint256, uint256, uint128, uint128)
    {
        Position storage pos = _positionOf[tokenId];
        return (
            0,
            address(0),
            pos.token0,
            pos.token1,
            pos.fee,
            pos.tickLower,
            pos.tickUpper,
            pos.liquidity,
            0,
            0,
            uint128(pos.owed0),
            uint128(pos.owed1)
        );
    }

    function ownerOf(uint256 tokenId) external view returns (address owner) {
        owner = _positionOf[tokenId].owner;
        require(owner != address(0), "NOT_MINTED");
    }

    function _liquidityForAmount0(uint160 sqrtA, uint160 sqrtB, uint256 amount0) private pure returns (uint256) {
        if (sqrtA > sqrtB) (sqrtA, sqrtB) = (sqrtB, sqrtA);
        uint256 intermediate = Math.mulDiv(sqrtA, sqrtB, Q96);
        return Math.mulDiv(amount0, intermediate, uint256(sqrtB) - sqrtA);
    }

    function _liquidityForAmount1(uint160 sqrtA, uint160 sqrtB, uint256 amount1) private pure returns (uint256) {
        if (sqrtA > sqrtB) (sqrtA, sqrtB) = (sqrtB, sqrtA);
        return Math.mulDiv(amount1, Q96, uint256(sqrtB) - sqrtA);
    }
}
