import type { TokenInfo } from "../utils/constants";

// Curated Unichain (130) majors — every address symbol()+decimals()-verified
// on-chain via scripts/chainverify.mjs (2026-07-20). NOTE: Tether on Unichain
// is the omnichain USDT0 deployment whose on-chain symbol is literally "USD₮0"
// — we display the chain's truth, not a prettified "USDT".
export const UNICHAIN_TOKENS: TokenInfo[] = [
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
    address: "0x4200000000000000000000000000000000000006",
    decimals: 18,
    logoURI: "/tokens/WETH.svg",
  },
  {
    symbol: "USDC",
    name: "USD Coin",
    address: "0x078D782b760474a361dDA0AF3839290b0EF57AD6",
    decimals: 6,
    logoURI: "/tokens/USDC.svg",
  },
  {
    symbol: "USD₮0",
    name: "Tether USD (USDT0)",
    address: "0x9151434b16b9763660705744891fA906F660EcC5",
    decimals: 6,
    logoURI: "/tokens/USDT.svg",
  },
];
