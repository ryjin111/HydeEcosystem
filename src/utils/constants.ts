import type { Address, Hex } from "viem";

export type TokenInfo = {
  symbol: string;
  name: string;
  address: Address;
  decimals: number;
};

export type NetworkConfig = {
  id: number;
  name: string;
  rpcUrl: string;
  wssUrl?: string;
  explorerUrl: string;
  currencySymbol: string;
  factory: Address;
  router: Address;
  faucetTokens: TokenInfo[];
};

export type V4Contracts = {
  poolManager: Address;
  universalRouter: Address;
  quoter: Address;
  positionManager: Address;
  permit2: Address;
};

export type V4EncodingTemplates = {
  swapCommand: Hex;
  swapInputAbi: string;
  addLiquidityInputAbi: string;
  removeLiquidityInputAbi: string;
};

// Replace these with deployed addresses per network.
const PLACEHOLDER_FACTORY = "0x000000000000000000000000000000000000fAc7" as Address;
const PLACEHOLDER_ROUTER = "0x000000000000000000000000000000000000aAA1" as Address;

export const TEMPO_MODERATO: NetworkConfig = {
  id: 42431,
  name: "Tempo Moderato Testnet",
  rpcUrl: "https://rpc.moderato.tempo.xyz",
  explorerUrl: "https://moderato.tempo.xyz",
  currencySymbol: "USD",
  factory: PLACEHOLDER_FACTORY,
  router: PLACEHOLDER_ROUTER,
  faucetTokens: [
    {
      symbol: "pathUSD",
      name: "Path USD",
      address: "0x1111111111111111111111111111111111111111",
      decimals: 18
    },
    {
      symbol: "AlphaUSD",
      name: "Alpha USD",
      address: "0x2222222222222222222222222222222222222222",
      decimals: 18
    },
    {
      symbol: "BetaUSD",
      name: "Beta USD",
      address: "0x3333333333333333333333333333333333333333",
      decimals: 18
    },
    {
      symbol: "ThetaUSD",
      name: "Theta USD",
      address: "0x4444444444444444444444444444444444444444",
      decimals: 18
    }
  ]
};

export const ROBINHOOD_TESTNET: NetworkConfig = {
  id: 43124,
  name: "Robinhood Testnet",
  // Replace with your actual Robinhood testnet RPC and explorer.
  rpcUrl: "https://rpc.testnet.robinhood.example",
  explorerUrl: "https://explorer.testnet.robinhood.example",
  currencySymbol: "USD",
  factory: PLACEHOLDER_FACTORY,
  router: PLACEHOLDER_ROUTER,
  faucetTokens: [
    {
      symbol: "pathUSD",
      name: "Path USD",
      address: "0x5555555555555555555555555555555555555555",
      decimals: 18
    },
    {
      symbol: "AlphaUSD",
      name: "Alpha USD",
      address: "0x6666666666666666666666666666666666666666",
      decimals: 18
    },
    {
      symbol: "BetaUSD",
      name: "Beta USD",
      address: "0x7777777777777777777777777777777777777777",
      decimals: 18
    },
    {
      symbol: "ThetaUSD",
      name: "Theta USD",
      address: "0x8888888888888888888888888888888888888888",
      decimals: 18
    }
  ]
};

export const PHAROS_ATLANTIC_TESTNET: NetworkConfig = {
  id: 688689,
  name: "Pharos Atlantic Testnet",
  rpcUrl: "https://atlantic.dplabs-internal.com",
  wssUrl: "wss://atlantic.dplabs-internal.com",
  explorerUrl: "https://atlantic.pharosscan.xyz/",
  currencySymbol: "USD",
  factory: PLACEHOLDER_FACTORY,
  router: PLACEHOLDER_ROUTER,
  faucetTokens: [
    {
      symbol: "pathUSD",
      name: "Path USD",
      address: "0x9999999999999999999999999999999999999999",
      decimals: 18
    },
    {
      symbol: "AlphaUSD",
      name: "Alpha USD",
      address: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      decimals: 18
    },
    {
      symbol: "BetaUSD",
      name: "Beta USD",
      address: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      decimals: 18
    },
    {
      symbol: "ThetaUSD",
      name: "Theta USD",
      address: "0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
      decimals: 18
    }
  ]
};

export const NETWORKS: NetworkConfig[] = [TEMPO_MODERATO, ROBINHOOD_TESTNET, PHAROS_ATLANTIC_TESTNET];

const PLACEHOLDER_V4_POOL_MANAGER = "0x000000000000000000000000000000000000beef" as Address;
const PLACEHOLDER_V4_UNIVERSAL_ROUTER = "0x000000000000000000000000000000000000cafe" as Address;
const PLACEHOLDER_V4_QUOTER = "0x000000000000000000000000000000000000f00d" as Address;
const PLACEHOLDER_V4_POSITION_MANAGER = "0x000000000000000000000000000000000000babe" as Address;
const PLACEHOLDER_V4_PERMIT2 = "0x000000000000000000000000000000000000d00d" as Address;

export const V4_CONTRACTS_BY_CHAIN: Record<number, V4Contracts> = {
  [TEMPO_MODERATO.id]: {
    poolManager: PLACEHOLDER_V4_POOL_MANAGER,
    universalRouter: PLACEHOLDER_V4_UNIVERSAL_ROUTER,
    quoter: PLACEHOLDER_V4_QUOTER,
    positionManager: PLACEHOLDER_V4_POSITION_MANAGER,
    permit2: PLACEHOLDER_V4_PERMIT2
  },
  [ROBINHOOD_TESTNET.id]: {
    poolManager: PLACEHOLDER_V4_POOL_MANAGER,
    universalRouter: PLACEHOLDER_V4_UNIVERSAL_ROUTER,
    quoter: PLACEHOLDER_V4_QUOTER,
    positionManager: PLACEHOLDER_V4_POSITION_MANAGER,
    permit2: PLACEHOLDER_V4_PERMIT2
  },
  [PHAROS_ATLANTIC_TESTNET.id]: {
    poolManager: PLACEHOLDER_V4_POOL_MANAGER,
    universalRouter: PLACEHOLDER_V4_UNIVERSAL_ROUTER,
    quoter: PLACEHOLDER_V4_QUOTER,
    positionManager: PLACEHOLDER_V4_POSITION_MANAGER,
    permit2: PLACEHOLDER_V4_PERMIT2
  }
};

// Template encoding config for auto payload generation.
// Adjust ABI parameter lists and command byte to match your deployed V4 periphery.
export const V4_ENCODING_TEMPLATES: V4EncodingTemplates = {
  swapCommand: "0x10",
  swapInputAbi:
    "address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMin,bool payerIsUser",
  addLiquidityInputAbi:
    "address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient",
  removeLiquidityInputAbi: "uint256 tokenId,uint128 liquidity,uint256 amount0Min,uint256 amount1Min,address recipient"
};

export const erc20Abi = [
  {
    type: "function",
    name: "name",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }]
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }]
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }]
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "uint256" }]
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" }
    ],
    outputs: [{ type: "uint256" }]
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" }
    ],
    outputs: [{ type: "bool" }]
  },
  {
    type: "function",
    name: "totalSupply",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }]
  }
] as const;

export const routerAbi = [
  {
    type: "function",
    name: "getAmountsOut",
    stateMutability: "view",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "path", type: "address[]" }
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }]
  },
  {
    type: "function",
    name: "getAmountsIn",
    stateMutability: "view",
    inputs: [
      { name: "amountOut", type: "uint256" },
      { name: "path", type: "address[]" }
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }]
  },
  {
    type: "function",
    name: "swapExactTokensForTokens",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" }
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }]
  },
  {
    type: "function",
    name: "addLiquidity",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tokenA", type: "address" },
      { name: "tokenB", type: "address" },
      { name: "amountADesired", type: "uint256" },
      { name: "amountBDesired", type: "uint256" },
      { name: "amountAMin", type: "uint256" },
      { name: "amountBMin", type: "uint256" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" }
    ],
    outputs: [
      { name: "amountA", type: "uint256" },
      { name: "amountB", type: "uint256" },
      { name: "liquidity", type: "uint256" }
    ]
  },
  {
    type: "function",
    name: "removeLiquidity",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tokenA", type: "address" },
      { name: "tokenB", type: "address" },
      { name: "liquidity", type: "uint256" },
      { name: "amountAMin", type: "uint256" },
      { name: "amountBMin", type: "uint256" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" }
    ],
    outputs: [
      { name: "amountA", type: "uint256" },
      { name: "amountB", type: "uint256" }
    ]
  }
] as const;

export const factoryAbi = [
  {
    type: "function",
    name: "getPair",
    stateMutability: "view",
    inputs: [
      { name: "tokenA", type: "address" },
      { name: "tokenB", type: "address" }
    ],
    outputs: [{ name: "pair", type: "address" }]
  }
] as const;

// Placeholder ABI for your deployed V4 quoter. Replace with your exact quoter ABI if needed.
export const v4QuoterAbi = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "view",
    inputs: [
      { name: "tokenIn", type: "address" },
      { name: "tokenOut", type: "address" },
      { name: "amountIn", type: "uint256" },
      { name: "fee", type: "uint24" },
      { name: "sqrtPriceLimitX96", type: "uint160" }
    ],
    outputs: [{ name: "amountOut", type: "uint256" }]
  }
] as const;

export const universalRouterAbi = [
  {
    type: "function",
    name: "execute",
    stateMutability: "payable",
    inputs: [
      { name: "commands", type: "bytes" },
      { name: "inputs", type: "bytes[]" },
      { name: "deadline", type: "uint256" }
    ],
    outputs: []
  }
] as const;

export const v4PositionManagerAbi = [
  {
    type: "function",
    name: "multicall",
    stateMutability: "payable",
    inputs: [
      { name: "data", type: "bytes[]" },
      { name: "deadline", type: "uint256" }
    ],
    outputs: [{ name: "results", type: "bytes[]" }]
  }
] as const;
