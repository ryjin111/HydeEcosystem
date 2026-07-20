import type { TokenInfo } from "../utils/constants";

export const OPTIMISM_TOKENS: TokenInfo[] = [
  {
    symbol: "WETH",
    name: "Wrapped Ether",
    address: "0x4200000000000000000000000000000000000006",
    decimals: 18,
    logoURI: "/tokens/WETH.svg",
  },
  {
    symbol: "ETH",
    name: "Ether",
    address: "0x0000000000000000000000000000000000000000",
    decimals: 18,
    logoURI: "/tokens/ETH.svg",
    isNative: true,
  },
  // The 4 proven-market majors (scripts/chainevidence.mjs 2026-07-20: each has a
  // live canonical V4 pool with liquidity + a real quote; symbol/decimals gated
  // by scripts/chainverify.mjs). Selector metadata — the market claim lives in
  // chainEvidence.ts, not here.
  {
    symbol: "USDC",
    name: "USD Coin",
    address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    decimals: 6,
    logoURI: "/tokens/USDC.svg",
  },
  {
    symbol: "USDT",
    name: "Tether USD",
    address: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58",
    decimals: 6,
    logoURI: "/tokens/USDT.svg",
  },
  {
    symbol: "OP",
    name: "Optimism",
    address: "0x4200000000000000000000000000000000000042",
    decimals: 18,
    logoURI: "/tokens/OP.svg",
  },
  {
    symbol: "WBTC",
    name: "Wrapped BTC",
    address: "0x68f180fcCe6836688e9084f035309E29Bf0A2095",
    decimals: 8,
    logoURI: "/tokens/WBTC.svg",
  },
];
