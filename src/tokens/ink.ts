import type { TokenInfo } from "../utils/constants";

export const INK_TOKENS: TokenInfo[] = [
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
];
