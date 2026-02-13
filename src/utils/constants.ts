import type { Address, Hex } from "viem";
import { TEMPO_MODERATO_TOKENS, ROBINHOOD_TESTNET_TOKENS, PHAROS_ATLANTIC_TOKENS } from "../tokens";

export type TokenInfo = {
  symbol: string;
  name: string;
  address: Address;
  decimals: number;
  /** URL to a token logo image. Put files in /public/tokens/<symbol>.svg or <address>.png */
  logoURI?: string;
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
  /** Official token list for this chain. Users can add extra tokens via the custom token flow. */
  tokens: TokenInfo[];
};

export type V4Contracts = {
  poolManager: Address;
  universalRouter: Address;
  quoter: Address;
  positionManager: Address;
  permit2: Address;
  gateway: Address;
};

export type V4EncodingTemplates = {
  swapCommand: Hex;
  sweepCommand: Hex;
  permit2PermitCommand: Hex;
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
  tokens: TEMPO_MODERATO_TOKENS,
};

export const ROBINHOOD_TESTNET: NetworkConfig = {
  id: 46630,
  name: "Robinhood Testnet",
  rpcUrl: "https://rpc.testnet.chain.robinhood.com",
  explorerUrl: "https://explorer.testnet.chain.robinhood.com",
  currencySymbol: "ETH",
  factory: PLACEHOLDER_FACTORY,
  router: PLACEHOLDER_ROUTER,
  tokens: ROBINHOOD_TESTNET_TOKENS,
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
  tokens: PHAROS_ATLANTIC_TOKENS,
};

// Focus: only Robinhood Testnet is active. Uncomment others when ready.
export const NETWORKS: NetworkConfig[] = [
  ROBINHOOD_TESTNET,
  // TEMPO_MODERATO,
  // PHAROS_ATLANTIC_TESTNET,
];

const PLACEHOLDER_V4_POOL_MANAGER = "0x000000000000000000000000000000000000beef" as Address;
const PLACEHOLDER_V4_UNIVERSAL_ROUTER = "0x000000000000000000000000000000000000cafe" as Address;
const PLACEHOLDER_V4_QUOTER = "0x000000000000000000000000000000000000f00d" as Address;
const PLACEHOLDER_V4_POSITION_MANAGER = "0x000000000000000000000000000000000000babe" as Address;
const PLACEHOLDER_V4_PERMIT2 = "0x000000000000000000000000000000000000d00d" as Address;
const PLACEHOLDER_V4_GATEWAY = "0x000000000000000000000000000000000000Da7a" as Address;

export const V4_CONTRACTS_BY_CHAIN: Record<number, V4Contracts> = {
  [TEMPO_MODERATO.id]: {
    poolManager: PLACEHOLDER_V4_POOL_MANAGER,
    universalRouter: PLACEHOLDER_V4_UNIVERSAL_ROUTER,
    quoter: PLACEHOLDER_V4_QUOTER,
    positionManager: PLACEHOLDER_V4_POSITION_MANAGER,
    permit2: PLACEHOLDER_V4_PERMIT2,
    gateway: PLACEHOLDER_V4_GATEWAY
  },
  [ROBINHOOD_TESTNET.id]: {
    poolManager: PLACEHOLDER_V4_POOL_MANAGER,
    universalRouter: PLACEHOLDER_V4_UNIVERSAL_ROUTER,
    quoter: PLACEHOLDER_V4_QUOTER,
    positionManager: PLACEHOLDER_V4_POSITION_MANAGER,
    permit2: PLACEHOLDER_V4_PERMIT2,
    gateway: PLACEHOLDER_V4_GATEWAY
  },
  [PHAROS_ATLANTIC_TESTNET.id]: {
    poolManager: PLACEHOLDER_V4_POOL_MANAGER,
    universalRouter: PLACEHOLDER_V4_UNIVERSAL_ROUTER,
    quoter: PLACEHOLDER_V4_QUOTER,
    positionManager: PLACEHOLDER_V4_POSITION_MANAGER,
    permit2: PLACEHOLDER_V4_PERMIT2,
    gateway: PLACEHOLDER_V4_GATEWAY
  }
};

// Template encoding config for auto payload generation.
// Adjust ABI parameter lists and command byte to match your deployed V4 periphery.
export const V4_ENCODING_TEMPLATES: V4EncodingTemplates = {
  swapCommand: "0x10",
  sweepCommand: "0x04",
  permit2PermitCommand: "0x0a",
  // Outer envelope: (packed actions bytes, per-action params array)
  swapInputAbi: "bytes,bytes[]",
  // Outer envelope for add-liquidity multicall: poolKeyEncoded, ticks, amounts, mins, recipient
  addLiquidityInputAbi: "bytes,int24,int24,uint256,uint256,uint256,uint256,address",
  // Remove-liquidity: tokenId, liquidity, amount0Min, amount1Min, recipient
  removeLiquidityInputAbi: "uint256,uint128,uint256,uint256,address"
};

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

export const v4QuoterAbi = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          {
            name: "poolKey",
            type: "tuple",
            components: [
              { name: "currency0", type: "address" },
              { name: "currency1", type: "address" },
              { name: "fee", type: "uint24" },
              { name: "tickSpacing", type: "int24" },
              { name: "hooks", type: "address" }
            ]
          },
          { name: "zeroForOne", type: "bool" },
          { name: "exactAmount", type: "uint128" },
          { name: "hookData", type: "bytes" }
        ]
      }
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "gasEstimate", type: "uint256" }
    ]
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

export const permit2Abi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" }
    ],
    outputs: []
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "token", type: "address" },
      { name: "spender", type: "address" }
    ],
    outputs: [
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
      { name: "nonce", type: "uint48" }
    ]
  }
] as const;

export const hydeGatewayAbi = [
  {
    type: "function",
    name: "executeSwap",
    stateMutability: "payable",
    inputs: [
      { name: "commands", type: "bytes" },
      { name: "inputs", type: "bytes[]" },
      { name: "deadline", type: "uint256" }
    ],
    outputs: []
  },
  {
    type: "function",
    name: "executePositionMulticall",
    stateMutability: "payable",
    inputs: [
      { name: "data", type: "bytes[]" },
      { name: "deadline", type: "uint256" }
    ],
    outputs: [{ name: "results", type: "bytes[]" }]
  }
] as const;

export const V4_ACTIONS = {
  SWAP_EXACT_IN_SINGLE: 0x06,
  SETTLE_ALL: 0x0c,
  TAKE_ALL: 0x09,
} as const;

export const SWEEP_ETH_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;
