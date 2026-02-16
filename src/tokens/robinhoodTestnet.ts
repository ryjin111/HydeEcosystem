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
  {
    symbol: "TSLA",
    name: "Tesla Stock Token",
    address: "0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E",
    decimals: 18,
    logoURI: "/tokens/TSLA.svg",
  },
  {
    symbol: "AMZN",
    name: "Amazon Stock Token",
    address: "0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02",
    decimals: 18,
    logoURI: "/tokens/AMZN.svg",
  },
  {
    symbol: "PLTR",
    name: "Palantir Stock Token",
    address: "0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0",
    decimals: 18,
    logoURI: "/tokens/PLTR.svg",
  },
  {
    symbol: "NFLX",
    name: "Netflix Stock Token",
    address: "0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93",
    decimals: 18,
    logoURI: "/tokens/NFLX.svg",
  },
  {
    symbol: "AMD",
    name: "AMD Stock Token",
    address: "0x71178BAc73cBeb415514eB542a8995b82669778d",
    decimals: 18,
    logoURI: "/tokens/AMD.svg",
  },
];
