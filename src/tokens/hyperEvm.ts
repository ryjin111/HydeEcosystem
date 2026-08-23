import type { TokenInfo } from "../utils/constants";

/** Canonical HyperEVM native assets. This is configuration only; HyperEVM is not yet in NETWORKS. */
export const HYPEREVM_TOKENS: TokenInfo[] = [
  {
    symbol: "HYPE",
    name: "Hyperliquid",
    address: "0x0000000000000000000000000000000000000000",
    decimals: 18,
    isNative: true,
  },
  {
    symbol: "WHYPE",
    name: "Wrapped HYPE",
    address: "0x5555555555555555555555555555555555555555",
    decimals: 18,
  },
];
