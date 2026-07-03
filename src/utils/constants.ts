import type { Address, Hex } from "viem";
import { TEMPO_MODERATO_TOKENS, ROBINHOOD_TESTNET_TOKENS, ROBINHOOD_MAINNET_TOKENS, PHAROS_ATLANTIC_TOKENS, INK_TOKENS, OPTIMISM_TOKENS } from "../tokens";

export type TokenInfo = {
  symbol: string;
  name: string;
  address: Address;
  decimals: number;
  /** URL to a token logo image. Put files in /public/tokens/<symbol>.svg or <address>.png */
  logoURI?: string;
  /** True for the chain's native currency (ETH). No approval needed; sent as msg.value. */
  isNative?: boolean;
  /** Set for tokens launched via Doppler. Drives swap routing. */
  dopplerPool?: {
    /** 'v4' = in-auction (V4 hook pool), 'v2' = graduated (Uniswap V2 pair) */
    type: "v4" | "v2";
    /** For V4 pools: hook address used in the PoolKey (Doppler V4Initializer). */
    hookAddress?: Address;
  };
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
  /** Router for Doppler-graduated (V2) tokens — uses Doppler's factory (standard Uni V2 hash). */
  dopplerRouter?: Address;
  /** WETH address used by the router for native ETH pairs. */
  weth: Address;
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
  /** HydeTokenFactory address — present only on chains where it's deployed */
  hydeTokenFactory?: Address;
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
const PLACEHOLDER_WETH = "0x0000000000000000000000000000000000000000" as Address;

export const TEMPO_MODERATO: NetworkConfig = {
  id: 42431,
  name: "Tempo Moderato Testnet",
  rpcUrl: "https://rpc.moderato.tempo.xyz",
  explorerUrl: "https://moderato.tempo.xyz",
  currencySymbol: "USD",
  factory: PLACEHOLDER_FACTORY,
  router: PLACEHOLDER_ROUTER,
  weth: PLACEHOLDER_WETH,
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
  weth: "0x7943e237c7F95DA44E0301572D358911207852Fa",
  tokens: ROBINHOOD_TESTNET_TOKENS,
};

// Robinhood Chain Mainnet — chain id 4663 (0x1237), verified live via eth_chainId 2026-07-03.
// WETH verified on-chain (UniswapV2MigratorSplit.weth() + symbol/name check).
export const ROBINHOOD_MAINNET: NetworkConfig = {
  id: 4663,
  name: "Robinhood Chain",
  rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
  explorerUrl: "https://robinhoodchain.blockscout.com",
  currencySymbol: "ETH",
  factory: PLACEHOLDER_FACTORY,   // no V2 factory needed — launches go via Doppler / V4
  router: PLACEHOLDER_ROUTER,
  weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  tokens: ROBINHOOD_MAINNET_TOKENS,
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
  weth: PLACEHOLDER_WETH,
  tokens: PHAROS_ATLANTIC_TOKENS,
};

export const INK_MAINNET: NetworkConfig = {
  id: 57073,
  name: "Ink",
  rpcUrl: "https://rpc-gel.inkonchain.com",
  explorerUrl: "https://explorer.inkonchain.com",
  currencySymbol: "ETH",
  factory: "0xA0E8D06bD1D1B25de55D3fDc6a2F7B1A030ca25B" as Address,
  router: "0xd3B8A589897990d554911a22eCBd748ed088D002" as Address,
  dopplerRouter: "0x936cc31Ce3D0e0abcD76ED29851Ab8bC5f8bEFf9" as Address,
  weth: "0x4200000000000000000000000000000000000006",
  tokens: INK_TOKENS,
};

export const UNICHAIN_MAINNET: NetworkConfig = {
  id: 130,
  name: "Unichain",
  rpcUrl: "https://mainnet.unichain.org",
  explorerUrl: "https://unichain.blockscout.com",
  currencySymbol: "ETH",
  factory: PLACEHOLDER_FACTORY,   // no V2 factory needed — Doppler tokens use V4
  router: PLACEHOLDER_ROUTER,
  weth: "0x4200000000000000000000000000000000000006" as Address,
  tokens: [],
};

export const OPTIMISM_MAINNET: NetworkConfig = {
  id: 10,
  name: "Optimism",
  rpcUrl: "https://mainnet.optimism.io",
  explorerUrl: "https://optimistic.etherscan.io",
  currencySymbol: "ETH",
  factory: PLACEHOLDER_FACTORY,   // no V2 factory needed — Hyde tokens use V4 only
  router: PLACEHOLDER_ROUTER,     // no V2 router needed — swaps go via HydeV4Gateway
  weth: "0x4200000000000000000000000000000000000006" as Address,
  tokens: OPTIMISM_TOKENS,
};

export const NETWORKS: NetworkConfig[] = [
  ROBINHOOD_MAINNET,
  // OPTIMISM_MAINNET,  // legacy lane retired 2026-07-03 — Hydeout is Robinhood-only
  // INK_MAINNET,       // hidden — multichain later
  // UNICHAIN_MAINNET,  // dropped
  // ROBINHOOD_TESTNET,
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
  },
  // Ink Mainnet — real Uniswap V4 deployments
  [INK_MAINNET.id]: {
    poolManager: "0x360e68faccca8ca495c1b759fd9eee466db9fb32" as Address,
    universalRouter: "0x112908dac86e20e7241b0927479ea3bf935d1fa0" as Address,
    quoter: "0x3972c00f7ed4885e145823eb7c655375d275a1c5" as Address,
    positionManager: "0x1b35d13a2e2528f192637f14b05f0dc0e7deb566" as Address,
    permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address,
    gateway: "0x21d6Ce25aa1AB3F59eE51b7693A596C6d39A03C9" as Address
  },
  // Robinhood Chain Mainnet (4663) — canonical Uniswap V4, every address verified on-chain 2026-07-03:
  //   eth_getCode ≠ 0x on all, and poolManager() cross-checked identical from SIX contracts
  //   (UniswapV4Initializer, DopplerLensQuoter, UniversalRouter, Quoter, PositionManager, StateView).
  //   universalRouter from Bundler.router(); positionManager/stateView are Blockscout-verified sources;
  //   PositionManager.permit2() → canonical Permit2.
  [ROBINHOOD_MAINNET.id]: {
    poolManager:     "0x8366a39CC670B4001A1121B8F6A443A643e40951" as Address,
    universalRouter: "0x8876789976dEcBfCbBbe364623C63652db8C0904" as Address,
    quoter:          "0x7232686FC954f12079cadFC5e9F755a9fEAeb3Ca" as Address,
    positionManager: "0x58daec3116aae6D93017bAAea7749052E8a04fA7" as Address,
    permit2:         "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address,
    gateway:         PLACEHOLDER_V4_GATEWAY, // HydeV4Gateway not yet deployed on 4663 — Foundry deploy needs clint's key
  },
  // Optimism Mainnet — Uniswap V4
  [10]: {
    poolManager:      "0x9a13F98Cb987694C9F086b1F5eB990EeA8264Ec3" as Address,
    universalRouter:  "0x851116D9223fabED8E56C0E6b8Ad0c31d98B3507" as Address,
    quoter:           "0x1f3131a13296fb91c90870043742c3cdbff1a8d7" as Address,
    positionManager:  "0x3C3Ea4B57a46241e54610e5f022E5c45859A1017" as Address,
    permit2:          "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address,
    gateway:          "0x21d6Ce25aa1AB3F59eE51b7693A596C6d39A03C9" as Address,
    hydeTokenFactory: "0x9532Dc6534122443a0C14F0Ec6407447f262fF42" as Address,
  },
};

/** True once the HydeV4Gateway is actually deployed on the chain — the swap lane
 *  stays honestly disabled until then (no submitting swaps to a placeholder). */
export function isGatewayLive(chainId: number): boolean {
  const gateway = V4_CONTRACTS_BY_CHAIN[chainId]?.gateway;
  return !!gateway && gateway !== PLACEHOLDER_V4_GATEWAY;
}

/** Doppler protocol deployment on a chain — drives the token-launch (launchpad) flow. */
export type DopplerContracts = {
  airlock: Address;
  bundler: Address;
  dopplerDeployer: Address;
  tokenFactory: Address;
  uniswapV4Initializer: Address;
  dopplerLensQuoter: Address;
  governanceFactory: Address;
  noOpGovernanceFactory: Address;
  noOpMigrator: Address;
  streamableFeesLockerV2: Address;
  uniswapV2MigratorSplit: Address;
};

// Robinhood Chain Mainnet (4663) Doppler stack.
// Source: docs.doppler.lol contract-addresses page, cross-checked byte-identical against
// @whetstone-research/doppler-sdk@1.0.27 address map; key contracts eth_getCode-verified on-chain 2026-07-03.
export const DOPPLER_CONTRACTS_BY_CHAIN: Record<number, DopplerContracts> = {
  [ROBINHOOD_MAINNET.id]: {
    airlock:                "0xeb7C034704eF8Dcd2D32324c1545f62fB4aD0862" as Address,
    bundler:                "0xEdE0B5fae363232c396724Fa962250Fa197cc5a1" as Address,
    dopplerDeployer:        "0x4389AD34938B14F25cff7ED983c53f5a42A2573f" as Address,
    tokenFactory:           "0x1B37D3a72082029c44B35B604Ea473617580b69a" as Address, // DopplerERC20V1Factory
    uniswapV4Initializer:   "0x6cce158B6D1747617fc218592B4D60B239B957ea" as Address,
    dopplerLensQuoter:      "0xf4c22465532f64777FfcD7770831AEca38F35c04" as Address,
    governanceFactory:      "0xDeb0447DAE3EB177c4dbA8bBCCCa25c8F273B7ef" as Address,
    noOpGovernanceFactory:  "0x85f37f74Ef2478A770318bc810177a9835911aD7" as Address,
    noOpMigrator:           "0xba2F330EDb16cD8056f5988d8CE19BbC63475A0e" as Address,
    streamableFeesLockerV2: "0x7B6147AC3F615bdb764e7EbD5f517dac1AD163B8" as Address,
    uniswapV2MigratorSplit: "0xB05046cEa797c993FB5b583098B1c4682e9Da333" as Address,
  },
};

/** StateView (read-only V4 pool state) on Robinhood mainnet — Blockscout-verified, poolManager() cross-checked. */
export const ROBINHOOD_STATE_VIEW = "0xF3334192D15450CdD385c8B70e03f9A6bD9E673b" as Address;

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
  },
  {
    type: "function",
    name: "swapExactETHForTokens",
    stateMutability: "payable",
    inputs: [
      { name: "amountOutMin", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" }
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }]
  },
  {
    type: "function",
    name: "swapExactTokensForETH",
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
    name: "addLiquidityETH",
    stateMutability: "payable",
    inputs: [
      { name: "token", type: "address" },
      { name: "amountTokenDesired", type: "uint256" },
      { name: "amountTokenMin", type: "uint256" },
      { name: "amountETHMin", type: "uint256" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" }
    ],
    outputs: [
      { name: "amountToken", type: "uint256" },
      { name: "amountETH", type: "uint256" },
      { name: "liquidity", type: "uint256" }
    ]
  },
  {
    type: "function",
    name: "removeLiquidityETH",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "liquidity", type: "uint256" },
      { name: "amountTokenMin", type: "uint256" },
      { name: "amountETHMin", type: "uint256" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" }
    ],
    outputs: [
      { name: "amountToken", type: "uint256" },
      { name: "amountETH", type: "uint256" }
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

export const hydeTokenFactoryAbi = [
  {
    type: "function",
    name: "collectFees",
    stateMutability: "nonpayable",
    inputs: [{ name: "token", type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "launchToken",
    stateMutability: "nonpayable",
    inputs: [
      { name: "name",         type: "string" },
      { name: "symbol",       type: "string" },
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tickLower",    type: "int24" },
      { name: "tickUpper",    type: "int24" },
      { name: "creator",      type: "address" },
    ],
    outputs: [
      { name: "token",      type: "address" },
      { name: "positionId", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "computeDefaultParams",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tickLower",    type: "int24" },
      { name: "tickUpper",    type: "int24" },
    ],
  },
  {
    type: "function",
    name: "launches",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [
      { name: "token",      type: "address" },
      { name: "creator",    type: "address" },
      { name: "positionId", type: "uint256" },
      { name: "currency0",  type: "address" },
      { name: "currency1",  type: "address" },
    ],
  },
  {
    type: "function",
    name: "POOL_FEE",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint24" }],
  },
  {
    type: "event",
    name: "TokenLaunched",
    inputs: [
      { name: "token",      type: "address", indexed: true },
      { name: "creator",    type: "address", indexed: true },
      { name: "positionId", type: "uint256", indexed: false },
      { name: "sqrtPriceX96", type: "uint160", indexed: false },
      { name: "tickLower",  type: "int24",   indexed: false },
      { name: "tickUpper",  type: "int24",   indexed: false },
    ],
  },
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

// ─── MasterChef (yield farming) ───────────────────────────────────────────
export const PLACEHOLDER_MASTERCHEF = "0x000000000000000000000000000000000000cHeF" as Address;

export const masterChefAbi = [
  {
    type: "function", name: "pendingReward", stateMutability: "view",
    inputs: [{ name: "_pid", type: "uint256" }, { name: "_user", type: "address" }],
    outputs: [{ name: "", type: "uint256" }]
  },
  {
    type: "function", name: "userInfo", stateMutability: "view",
    inputs: [{ name: "_pid", type: "uint256" }, { name: "_user", type: "address" }],
    outputs: [{ name: "amount", type: "uint256" }, { name: "rewardDebt", type: "uint256" }]
  },
  {
    type: "function", name: "deposit", stateMutability: "nonpayable",
    inputs: [{ name: "_pid", type: "uint256" }, { name: "_amount", type: "uint256" }],
    outputs: []
  },
  {
    type: "function", name: "withdraw", stateMutability: "nonpayable",
    inputs: [{ name: "_pid", type: "uint256" }, { name: "_amount", type: "uint256" }],
    outputs: []
  }
] as const;

// ─── StakingPool (single-token staking) ──────────────────────────────────
export const PLACEHOLDER_STAKING_POOL = "0x000000000000000000000000000000000000P00L" as Address;

export const stakingPoolAbi = [
  {
    type: "function", name: "pendingReward", stateMutability: "view",
    inputs: [{ name: "_user", type: "address" }],
    outputs: [{ name: "", type: "uint256" }]
  },
  {
    type: "function", name: "userInfo", stateMutability: "view",
    inputs: [{ name: "_user", type: "address" }],
    outputs: [{ name: "amount", type: "uint256" }, { name: "rewardDebt", type: "uint256" }]
  },
  {
    type: "function", name: "deposit", stateMutability: "nonpayable",
    inputs: [{ name: "_amount", type: "uint256" }],
    outputs: []
  },
  {
    type: "function", name: "withdraw", stateMutability: "nonpayable",
    inputs: [{ name: "_amount", type: "uint256" }],
    outputs: []
  },
  {
    type: "function", name: "harvest", stateMutability: "nonpayable",
    inputs: [],
    outputs: []
  }
] as const;
