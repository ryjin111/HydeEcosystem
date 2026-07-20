import type { TokenInfo } from "../utils/constants";

// Curated Ethereum mainnet majors — every address symbol()+decimals()-verified
// on-chain via scripts/chainverify.mjs (2026-07-20) before listing. Curated
// markets only (kami 23065): additions go through the same verification gate.
export const ETHEREUM_TOKENS: TokenInfo[] = [
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
    address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    decimals: 18,
    logoURI: "/tokens/WETH.svg",
  },
  {
    symbol: "USDC",
    name: "USD Coin",
    address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    decimals: 6,
    logoURI: "/tokens/USDC.svg",
  },
  {
    symbol: "USDT",
    name: "Tether USD",
    address: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    decimals: 6,
    logoURI: "/tokens/USDT.svg",
  },
  {
    symbol: "WBTC",
    name: "Wrapped BTC",
    address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
    decimals: 8,
    logoURI: "/tokens/WBTC.svg",
  },
  {
    symbol: "DAI",
    name: "Dai Stablecoin",
    address: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
    decimals: 18,
    logoURI: "/tokens/DAI.svg",
  },
];
