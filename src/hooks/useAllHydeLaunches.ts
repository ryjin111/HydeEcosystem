import { useMemo } from "react";
import { ROBINHOOD_MAINNET, STABLE_MAINNET } from "../utils/constants";
import type { DopplerPool } from "../utils/dopplerConfig";
import { useHydeLaunches } from "./useDopplerTokens";

export type HydeLaunchSource = {
  chainId: number;
  name: string;
  pools: DopplerPool[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
};

/**
 * Read-only discovery aggregate for Hydeout's two live mainnets.
 *
 * Transaction surfaces remain chain-scoped. This hook exists only for browse
 * surfaces, where every card carries its chain id into the token route.
 */
export function useAllHydeLaunches(): {
  pools: DopplerPool[];
  sources: HydeLaunchSource[];
  loading: boolean;
  error: string | null;
  warning: string | null;
  refetch: () => void;
} {
  // Keep these calls explicit: hooks cannot be created dynamically from NETWORKS.
  const robinhood = useHydeLaunches(ROBINHOOD_MAINNET.id);
  const stable = useHydeLaunches(STABLE_MAINNET.id);

  const sources = useMemo<HydeLaunchSource[]>(
    () => [
      {
        chainId: ROBINHOOD_MAINNET.id,
        name: ROBINHOOD_MAINNET.name,
        pools: robinhood.pools,
        loading: robinhood.loading,
        error: robinhood.error,
        refetch: robinhood.refetch,
      },
      {
        chainId: STABLE_MAINNET.id,
        name: STABLE_MAINNET.name,
        pools: stable.pools,
        loading: stable.loading,
        error: stable.error,
        refetch: stable.refetch,
      },
    ],
    [
      robinhood.error,
      robinhood.loading,
      robinhood.pools,
      stable.error,
      stable.loading,
      stable.pools,
    ],
  );

  const pools = useMemo(
    () => sources.flatMap((source) => source.pools),
    [sources],
  );
  const failed = sources.filter((source) => source.error);

  return {
    pools,
    sources,
    loading: sources.some((source) => source.loading),
    error: failed.length === sources.length
      ? "Launch data is unavailable on every live network."
      : null,
    warning: failed.length > 0 && failed.length < sources.length
      ? `${failed.map((source) => source.name).join(" and ")} data is temporarily unavailable.`
      : null,
    refetch: () => sources.forEach((source) => source.refetch()),
  };
}
