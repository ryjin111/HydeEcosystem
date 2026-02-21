import type { TokenInfo } from "../utils/constants";

/**
 * Official token list for Pharos Atlantic Testnet (chain 688689).
 * Replace placeholder addresses with real deployed contract addresses.
 * Add logoURI pointing to /public/tokens/<symbol>.svg for each token.
 */
export const PHAROS_ATLANTIC_TOKENS: TokenInfo[] = [
  {
    symbol: "pathUSD",
    name: "Path USD",
    address: "0x9999999999999999999999999999999999999999",
    decimals: 18,
    logoURI: "/tokens/pathUSD.svg",
  },
  {
    symbol: "AlphaUSD",
    name: "Alpha USD",
    address: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    decimals: 18,
    logoURI: "/tokens/AlphaUSD.svg",
  },
  {
    symbol: "BetaUSD",
    name: "Beta USD",
    address: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    decimals: 18,
    logoURI: "/tokens/BetaUSD.svg",
  },
  {
    symbol: "ThetaUSD",
    name: "Theta USD",
    address: "0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
    decimals: 18,
    logoURI: "/tokens/ThetaUSD.svg",
  },
];
