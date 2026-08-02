import { parseAbi } from "viem";

export const erc20MetadataAbi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);

export const erc20TransferAbi = parseAbi([
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);

export const uniswapV3PoolAbi = parseAbi([
  "event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)",
]);

export const trenchV3FactoryAbi = parseAbi([
  "event LaunchCreated(address indexed token,address indexed creator,address indexed pool,uint256 curveTokenId,uint128 curveLiquidity,uint256 curveTokenUsed,uint256 graduationReserve)",
]);

export const trenchV4FactoryAbi = parseAbi([
  "event LaunchCreated(address indexed token,address indexed creator,bytes32 indexed poolId,uint256 curveTokenId,uint128 curveLiquidity,uint256 curveTokenUsed,uint256 graduationReserve)",
]);

export const trenchGraduatorAbi = parseAbi([
  "event GraduationSignaled(address indexed token,uint64 signaledAt,uint64 finalizableAt)",
  "event Graduated(address indexed token,uint256 quotePrincipal,uint256 tokenPrincipal,uint256 primaryPositionId,uint256 positionCount)",
  "function curveProgress(address token) view returns (uint256 sold,uint256 curveAllocation,uint256 progressWad,uint256 quotePrincipal,uint256 minimumProceeds,uint64 signaledAt,uint64 finalizableAt,uint8 state)",
]);

export const trenchV3LockerAbi = parseAbi([
  "event FeeCredited(address indexed token,address indexed asset,address indexed creator,uint256 creatorCut,uint256 hydeCut)",
  "event CreatorClaimed(address indexed token,address indexed asset,address indexed creator,uint256 amount)",
  "function creatorClaimable(address token,address asset) view returns (uint256)",
]);

export const trenchV4LockerAbi = parseAbi([
  "event FeeCredited(address indexed token,address indexed asset,uint256 creatorCut,uint256 hydeCut,uint256 autoLpCut)",
  "event CreatorClaimed(address indexed token,address indexed asset,address indexed creator,uint256 amount)",
  "function creatorClaimable(address token,address asset) view returns (uint256)",
]);

export const legacyV4FactoryAbi = parseAbi([
  "event LaunchCreated(address indexed token,address indexed creator,bytes32 indexed poolId,uint256 tokenId,uint256 presetId)",
]);

export const legacyHoodieEngineAbi = parseAbi([
  "event HoodieLaunchCreated(address indexed launcher,address indexed creator,address indexed token,bytes32 poolId,uint256 tokenId)",
]);

export const legacyV3PadAbi = parseAbi([
  "event LaunchCreated(address indexed token,address indexed creator,address pool,uint256 tokenId,uint128 liquidity)",
]);
