import type { TokenInfo } from "../utils/constants";

// Curated BNB Smart Chain (56) majors — every address symbol()+decimals()-verified
// on-chain via scripts/chainverify.mjs (2026-07-20). BNB-chain quirk carried
// honestly: the major stables are 18-decimal here (not 6 like everywhere else).
export const BNB_TOKENS: TokenInfo[] = [
  {
    symbol: "BNB",
    name: "BNB",
    address: "0x0000000000000000000000000000000000000000",
    decimals: 18,
    logoURI: "/tokens/BNB.svg",
    isNative: true,
  },
  {
    symbol: "WBNB",
    name: "Wrapped BNB",
    address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    decimals: 18,
    logoURI: "/tokens/WBNB.svg",
  },
  {
    symbol: "USDT",
    name: "Tether USD",
    address: "0x55d398326f99059fF775485246999027B3197955",
    decimals: 18,
    logoURI: "/tokens/USDT.svg",
  },
  {
    symbol: "USDC",
    name: "USD Coin",
    address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
    decimals: 18,
    logoURI: "/tokens/USDC.svg",
  },
  {
    symbol: "BTCB",
    name: "BTCB Token",
    address: "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c",
    decimals: 18,
    logoURI: "/tokens/BTCB.svg",
  },
  {
    symbol: "ETH",
    name: "Ethereum Token",
    address: "0x2170Ed0880ac9A755fd29B2688956BD959F933F8",
    decimals: 18,
    logoURI: "/tokens/ETH.svg",
  },
];
