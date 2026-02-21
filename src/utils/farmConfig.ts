import type { Address } from "viem";

// ─── Farm config ──────────────────────────────────────────────────────────
export type FarmConfig = {
  pid:          number;
  masterChef:   Address;
  lpToken:      Address;
  tokenASymbol: string;
  tokenBSymbol: string;
  tokenALogo:   string;
  tokenBLogo:   string;
  feeTier:      string;
  multiplier:   string;
  apr:          number;
  tvl:          string;
  rewardSymbol: string;
};

// Populated when HYDE MasterChef is deployed to Ink Mainnet
export const FARM_CONFIGS: FarmConfig[] = [];

// ─── Pool config ──────────────────────────────────────────────────────────
export type PoolConfig = {
  id:             number;
  contract:       Address;
  stakedSymbol:   string;
  stakedLogo:     string;
  stakedToken:    Address;
  stakedDecimals: number;
  rewardSymbol:   string;
  rewardLogo:     string;
  apr:            number;
  totalStaked:    string;
  isAutoCompound?: boolean;
};

// Populated when HYDE staking contracts are deployed to Ink Mainnet
export const POOL_CONFIGS: PoolConfig[] = [];
