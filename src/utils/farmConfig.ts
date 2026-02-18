import type { Address } from "viem";
import { PLACEHOLDER_MASTERCHEF, PLACEHOLDER_STAKING_POOL } from "./constants";

// ─── HYDE reward token (placeholder) ─────────────────────────────────────
export const HYDE_TOKEN = {
  symbol:   "HYDE",
  name:     "Hyde Token",
  address:  "0x000000000000000000000000000000000000HYDE" as Address,
  decimals: 18,
  logoURI:  "/logo/lo.png",
};

// ─── Farm config ──────────────────────────────────────────────────────────
export type FarmConfig = {
  pid:         number;
  masterChef:  Address;
  lpToken:     Address;
  tokenASymbol: string;
  tokenBSymbol: string;
  tokenALogo:  string;
  tokenBLogo:  string;
  feeTier:     string;
  multiplier:  string;
  apr:         number;  // placeholder APR %
  tvl:         string;  // placeholder TVL string
  rewardSymbol: string;
};

export const FARM_CONFIGS: FarmConfig[] = [
  {
    pid: 0, masterChef: PLACEHOLDER_MASTERCHEF,
    lpToken:      "0x000000000000000000000000000000000000lP01" as Address,
    tokenASymbol: "ETH",  tokenALogo: "/tokens/ETH.svg",
    tokenBSymbol: "TSLA", tokenBLogo: "/tokens/TSLA.svg",
    feeTier: "0.3%", multiplier: "40x", apr: 125.4, tvl: "$2.4M",
    rewardSymbol: "HYDE",
  },
  {
    pid: 1, masterChef: PLACEHOLDER_MASTERCHEF,
    lpToken:      "0x000000000000000000000000000000000000lP02" as Address,
    tokenASymbol: "ETH",  tokenALogo: "/tokens/ETH.svg",
    tokenBSymbol: "AMZN", tokenBLogo: "/tokens/AMZN.svg",
    feeTier: "0.3%", multiplier: "20x", apr: 80.2, tvl: "$1.1M",
    rewardSymbol: "HYDE",
  },
  {
    pid: 2, masterChef: PLACEHOLDER_MASTERCHEF,
    lpToken:      "0x000000000000000000000000000000000000lP03" as Address,
    tokenASymbol: "ETH",  tokenALogo: "/tokens/ETH.svg",
    tokenBSymbol: "NFLX", tokenBLogo: "/tokens/NFLX.svg",
    feeTier: "0.3%", multiplier: "15x", apr: 60.8, tvl: "$840K",
    rewardSymbol: "HYDE",
  },
  {
    pid: 3, masterChef: PLACEHOLDER_MASTERCHEF,
    lpToken:      "0x000000000000000000000000000000000000lP04" as Address,
    tokenASymbol: "ETH",  tokenALogo: "/tokens/ETH.svg",
    tokenBSymbol: "WETH", tokenBLogo: "/tokens/WETH.svg",
    feeTier: "0.05%", multiplier: "10x", apr: 42.5, tvl: "$3.2M",
    rewardSymbol: "HYDE",
  },
  {
    pid: 4, masterChef: PLACEHOLDER_MASTERCHEF,
    lpToken:      "0x000000000000000000000000000000000000lP05" as Address,
    tokenASymbol: "ETH",  tokenALogo: "/tokens/ETH.svg",
    tokenBSymbol: "PLTR", tokenBLogo: "/tokens/PLTR.svg",
    feeTier: "0.3%", multiplier: "8x", apr: 35.1, tvl: "$510K",
    rewardSymbol: "HYDE",
  },
  {
    pid: 5, masterChef: PLACEHOLDER_MASTERCHEF,
    lpToken:      "0x000000000000000000000000000000000000lP06" as Address,
    tokenASymbol: "WETH", tokenALogo: "/tokens/WETH.svg",
    tokenBSymbol: "AMD",  tokenBLogo: "/tokens/AMD.svg",
    feeTier: "0.3%", multiplier: "5x", apr: 22.7, tvl: "$290K",
    rewardSymbol: "HYDE",
  },
];

// ─── Pool config ──────────────────────────────────────────────────────────
export type PoolConfig = {
  id:           number;
  contract:     Address;
  stakedSymbol: string;
  stakedLogo:   string;
  stakedToken:  Address;
  stakedDecimals: number;
  rewardSymbol: string;
  rewardLogo:   string;
  apr:          number;
  totalStaked:  string;
  isAutoCompound?: boolean;
};

export const POOL_CONFIGS: PoolConfig[] = [
  {
    id: 0, contract: PLACEHOLDER_STAKING_POOL,
    stakedSymbol: "HYDE",   stakedLogo: "/logo/lo.png",
    stakedToken:  HYDE_TOKEN.address, stakedDecimals: 18,
    rewardSymbol: "HYDE",   rewardLogo: "/logo/lo.png",
    apr: 50.0, totalStaked: "12.4M HYDE",
    isAutoCompound: true,
  },
  {
    id: 1, contract: "0x000000000000000000000000000000000000P001" as Address,
    stakedSymbol: "ETH",   stakedLogo: "/tokens/ETH.svg",
    stakedToken:  "0x0000000000000000000000000000000000000000" as Address, stakedDecimals: 18,
    rewardSymbol: "HYDE",  rewardLogo: "/logo/lo.png",
    apr: 30.0, totalStaked: "850 ETH",
  },
  {
    id: 2, contract: "0x000000000000000000000000000000000000P002" as Address,
    stakedSymbol: "WETH",  stakedLogo: "/tokens/WETH.svg",
    stakedToken:  "0x7943e237c7F95DA44E0301572D358911207852Fa" as Address, stakedDecimals: 18,
    rewardSymbol: "HYDE",  rewardLogo: "/logo/lo.png",
    apr: 25.0, totalStaked: "620 WETH",
  },
];
