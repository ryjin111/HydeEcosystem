import type { TokenInfo } from "../utils/constants";

// Curated X Layer (196) majors — every address symbol()+decimals()-verified
// on-chain via scripts/chainverify.mjs (2026-07-20). Native currency is OKB.
export const XLAYER_TOKENS: TokenInfo[] = [
  {
    symbol: "OKB",
    name: "OKB",
    address: "0x0000000000000000000000000000000000000000",
    decimals: 18,
    logoURI: "/tokens/OKB.svg",
    isNative: true,
  },
  {
    symbol: "WOKB",
    name: "Wrapped OKB",
    address: "0xe538905cf8410324e03A5A23C1c177a474D59b2b",
    decimals: 18,
    logoURI: "/tokens/WOKB.svg",
  },
  {
    symbol: "USDT",
    name: "Tether USD",
    address: "0x1E4a5963aBFD975d8c9021ce480b42188849D41d",
    decimals: 6,
    logoURI: "/tokens/USDT.svg",
  },
  {
    symbol: "USDC",
    name: "USD Coin",
    address: "0x74b7F16337b8972027F6196A17a631aC6dE26d22",
    decimals: 6,
    logoURI: "/tokens/USDC.svg",
  },
  {
    symbol: "WETH",
    name: "Wrapped Ether",
    address: "0x5A77f1443D16ee5761d310e38b62f77f726bC71c",
    decimals: 18,
    logoURI: "/tokens/WETH.svg",
  },
];
