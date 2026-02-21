import type { TokenInfo } from "../utils/constants";

export const ROBINHOOD_TESTNET_TOKENS: TokenInfo[] = [
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
    address: "0x7943e237c7F95DA44E0301572D358911207852Fa",
    decimals: 18,
    logoURI: "/tokens/WETH.svg",
  },
];
