import { useEffect, useState } from "react";
import type { TokenInfo } from "../utils/constants";
import type { DopplerPool } from "../utils/dopplerConfig";

const OPTIMISM_CHAIN_ID = 10;
// HydeAntiSnipeHook deployed on Optimism — all Hyde V4 pools use this hook
const HYDE_HOOK_ADDRESS = "0x4B2336d2DF984891cB98D693E48D310154109080" as `0x${string}`;

async function fetchHydePools(): Promise<DopplerPool[]> {
  const r = await fetch("/api/clanker-tokens?chainId=10");
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = await r.json();
  return (d.data ?? []).map((t: {
    contract_address: string;
    name: string;
    symbol: string;
    deployed_at: string;
  }): DopplerPool => ({
    address: t.contract_address,
    chainId: OPTIMISM_CHAIN_ID,
    baseToken: {
      address: t.contract_address,
      name: t.name,
      symbol: t.symbol,
      decimals: 18,
    },
    quoteToken: {
      address: "0x4200000000000000000000000000000000000006",
      name: "Wrapped Ether",
      symbol: "WETH",
      decimals: 18,
    },
    type: "v4",
    dollarLiquidity: null,
    volumeUsd: null,
    createdAt: t.deployed_at,
  }));
}

/** Fetches tokens launched via HydeTokenFactory on Optimism as TokenInfo[].
 *  Each token gets dopplerPool set so V4SwapCard routes through the anti-snipe hook. */
export function useHydeTokens(chainId: number): {
  tokens: TokenInfo[];
  loading: boolean;
} {
  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (chainId !== OPTIMISM_CHAIN_ID) return;

    let cancelled = false;
    setLoading(true);

    fetchHydePools()
      .then((pools) => {
        if (cancelled) return;
        setTokens(
          pools.map((p): TokenInfo => ({
            address: p.baseToken.address as `0x${string}`,
            name: p.baseToken.name,
            symbol: p.baseToken.symbol,
            decimals: p.baseToken.decimals,
            dopplerPool: {
              type: "v4",
              hookAddress: HYDE_HOOK_ADDRESS,
            },
          }))
        );
      })
      .catch(() => {
        // API unavailable — leave tokens empty
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [chainId]);

  return { tokens, loading };
}

/** Fetches full pool objects for the Launchpad explore tab and trending carousel. */
export function useHydeLaunches(): {
  pools: DopplerPool[];
  loading: boolean;
  refetch: () => void;
} {
  const [pools, setPools] = useState<DopplerPool[]>([]);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const refetch = () => setTick((t) => t + 1);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    fetchHydePools()
      .then((items) => {
        if (!cancelled) setPools(items);
      })
      .catch(() => {
        if (!cancelled) setPools([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [tick]);

  return { pools, loading, refetch };
}
