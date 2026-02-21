import type { TokenInfo } from "../utils/constants";

/**
 * Official token list for Tempo Moderato Testnet (chain 42431).
 * Add logoURI pointing to /public/tokens/<symbol>.svg for each token.
 */
export const TEMPO_MODERATO_TOKENS: TokenInfo[] = [
  {
    symbol: "pathUSD",
    name: "Path USD",
    address: "0x1111111111111111111111111111111111111111",
    decimals: 18,
    logoURI: "/tokens/pathUSD.svg",
  },
  {
    symbol: "AlphaUSD",
    name: "Alpha USD",
    address: "0x2222222222222222222222222222222222222222",
    decimals: 18,
    logoURI: "/tokens/AlphaUSD.svg",
  },
  {
    symbol: "BetaUSD",
    name: "Beta USD",
    address: "0x3333333333333333333333333333333333333333",
    decimals: 18,
    logoURI: "/tokens/BetaUSD.svg",
  },
  {
    symbol: "ThetaUSD",
    name: "Theta USD",
    address: "0x4444444444444444444444444444444444444444",
    decimals: 18,
    logoURI: "/tokens/ThetaUSD.svg",
  },
];
