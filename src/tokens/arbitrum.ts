import type { TokenInfo } from "../utils/constants";

// Arbitrum One launch-selector metadata. Addresses are verified on-chain by
// scripts/chainverify.mjs before the chain is exposed by the app.
export const ARBITRUM_TOKENS: TokenInfo[] = [
  {
    symbol: "ETH",
    name: "Ether",
    address: "0x0000000000000000000000000000000000000000",
    decimals: 18,
    logoURI: "/tokens/ETH.svg",
    isNative: true,
  },
  {
    symbol: "WETH",
    name: "Wrapped Ether",
    address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    decimals: 18,
    logoURI: "/tokens/WETH.svg",
  },
  {
    symbol: "USDC",
    name: "USD Coin",
    address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    decimals: 6,
  },
  {
    symbol: "USD₮0",
    name: "Tether USD₮0",
    address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
    decimals: 6,
  },
  {
    symbol: "ARB",
    name: "Arbitrum",
    address: "0x912CE59144191C1204E64559FE8253a0e49E6548",
    decimals: 18,
  },
  {
    symbol: "WBTC",
    name: "Wrapped BTC",
    address: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f",
    decimals: 8,
  },
];
