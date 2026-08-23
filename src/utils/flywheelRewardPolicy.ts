import type { Address } from "viem";
import {
  ARBITRUM_MAINNET,
  ARC_MAINNET,
  HYPEREVM_MAINNET,
  ROBINHOOD_MAINNET,
  STABLE_MAINNET,
} from "./constants";

export type FlywheelRewardTheme = "tokenized-stocks" | "native-ecosystem" | "native-only";
export type FlywheelCatalogSource = "robinhood-asset-registry" | "factory-routes" | "none";

export interface FlywheelRewardPolicy {
  chainId: number;
  theme: FlywheelRewardTheme;
  nativeRewardSymbol: string;
  nativeRewardAsset: Address;
  /** Presentation hint only. The factory's active route remains the on-chain authorization source. */
  catalogSource: FlywheelCatalogSource;
  convertedRewardsEnabled: boolean;
  preferredVenue?: string;
  notice: string;
}

const ZERO = "0x0000000000000000000000000000000000000000" as Address;

/**
 * Chain-specific Flywheel presentation policy. This cannot authorize a reward or router: the UI must also
 * verify an active `FlywheelVaultFactory.rewardConverterFor(numeraire, rewardAsset)` route before showing it.
 */
export const FLYWHEEL_REWARD_POLICY: Readonly<Record<number, FlywheelRewardPolicy>> = {
  [ROBINHOOD_MAINNET.id]: {
    chainId: ROBINHOOD_MAINNET.id,
    theme: "tokenized-stocks",
    nativeRewardSymbol: "WETH",
    nativeRewardAsset: ROBINHOOD_MAINNET.weth,
    catalogSource: "robinhood-asset-registry",
    convertedRewardsEnabled: true,
    preferredVenue: "Uniswap",
    notice: "Only canonical Robinhood Stock Tokens with an active audited factory route are selectable.",
  },
  [HYPEREVM_MAINNET.id]: {
    chainId: HYPEREVM_MAINNET.id,
    theme: "native-ecosystem",
    nativeRewardSymbol: "WHYPE",
    nativeRewardAsset: HYPEREVM_MAINNET.weth,
    catalogSource: "none",
    convertedRewardsEnabled: false,
    preferredVenue: "HyperSwap",
    notice: "Native launch-token and WHYPE rewards only until a liquid, oracle-protected adapter is approved.",
  },
  [ARBITRUM_MAINNET.id]: {
    chainId: ARBITRUM_MAINNET.id,
    theme: "native-only",
    nativeRewardSymbol: "WETH",
    nativeRewardAsset: ARBITRUM_MAINNET.weth,
    catalogSource: "none",
    convertedRewardsEnabled: false,
    notice: "Native launch-token and WETH rewards only.",
  },
  [STABLE_MAINNET.id]: {
    chainId: STABLE_MAINNET.id,
    theme: "native-only",
    nativeRewardSymbol: "USDT0",
    nativeRewardAsset: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736" as Address,
    catalogSource: "none",
    convertedRewardsEnabled: false,
    notice: "Native launch-token and USDT0 rewards only.",
  },
  [ARC_MAINNET.id]: {
    chainId: ARC_MAINNET.id,
    theme: "native-only",
    nativeRewardSymbol: "USDC",
    nativeRewardAsset: "0x3600000000000000000000000000000000000000" as Address,
    catalogSource: "none",
    convertedRewardsEnabled: false,
    notice: "Native launch-token and USDC rewards only while Arc remains release-gated.",
  },
};

const UNKNOWN_POLICY: FlywheelRewardPolicy = {
  chainId: 0,
  theme: "native-only",
  nativeRewardSymbol: "NUMERAIRE",
  nativeRewardAsset: ZERO,
  catalogSource: "none",
  convertedRewardsEnabled: false,
  notice: "Only the vault's native fee assets are available on this chain.",
};

export function flywheelRewardPolicy(chainId: number): FlywheelRewardPolicy {
  return FLYWHEEL_REWARD_POLICY[chainId] ?? { ...UNKNOWN_POLICY, chainId };
}

export function canShowConvertedFlywheelRewards(chainId: number, activeRouteCount: number): boolean {
  const policy = flywheelRewardPolicy(chainId);
  return policy.convertedRewardsEnabled && policy.catalogSource !== "none" && activeRouteCount > 0;
}
