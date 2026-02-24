import { useEffect, useState } from "react";
import type { TokenInfo } from "../utils/constants";
import {
  DOPPLER_INDEXER_URLS,
  DOPPLER_POOLS_QUERY,
  type DopplerPool,
} from "../utils/dopplerConfig";

const CACHE_KEY = "hyde-doppler-tokens-v1";
const CACHE_TTL_MS = 60_000; // 1 minute

type CacheEntry = { tokens: TokenInfo[]; ts: number };

function isValidCacheEntry(obj: unknown): obj is CacheEntry {
  if (!obj || typeof obj !== "object") return false;
  const e = obj as Record<string, unknown>;
  return typeof e.ts === "number" && Number.isFinite(e.ts) && Array.isArray(e.tokens);
}

function loadCached(chainId: number): TokenInfo[] {
  try {
    const raw = localStorage.getItem(`${CACHE_KEY}-${chainId}`);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!isValidCacheEntry(parsed)) return [];
    if (Date.now() - parsed.ts > CACHE_TTL_MS) return [];
    return parsed.tokens;
  } catch {
    return [];
  }
}

function saveCache(chainId: number, tokens: TokenInfo[]) {
  try {
    const entry: CacheEntry = { tokens, ts: Date.now() };
    localStorage.setItem(`${CACHE_KEY}-${chainId}`, JSON.stringify(entry));
  } catch {
    /* storage full — ignore */
  }
}

async function fetchFromIndexer(chainId: number): Promise<TokenInfo[]> {
  const url = DOPPLER_INDEXER_URLS[chainId];
  if (!url || !url.startsWith("https://")) return [];

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: DOPPLER_POOLS_QUERY,
      variables: { chainId, limit: 500 },
    }),
  });

  if (!resp.ok) return [];
  const data = await resp.json();
  if (data?.errors) return [];
  const items: DopplerPool[] = data?.data?.pools?.items ?? [];

  const seen = new Set<string>();
  const tokens: TokenInfo[] = [];

  for (const pool of items) {
    const bt = pool.baseToken;
    if (bt?.address && !seen.has(bt.address.toLowerCase())) {
      seen.add(bt.address.toLowerCase());
      tokens.push({
        address: bt.address as `0x${string}`,
        name: bt.name ?? bt.symbol,
        symbol: bt.symbol,
        decimals: bt.decimals ?? 18,
        dopplerPool: {
          type: (pool.type === "v2" ? "v2" : "v4") as "v4" | "v2",
          // pool.address is the Doppler hook/airlock address used in the V4 PoolKey
          hookAddress: pool.type !== "v2" ? (pool.address as `0x${string}`) : undefined,
        },
      });
    }
  }

  return tokens;
}

/** Fetches all tokens launched via Doppler on the given chain (from indexer). */
export function useDopplerTokens(chainId: number): {
  tokens: TokenInfo[];
  loading: boolean;
} {
  const [tokens, setTokens] = useState<TokenInfo[]>(() => loadCached(chainId));
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!DOPPLER_INDEXER_URLS[chainId]) return;

    let cancelled = false;
    setLoading(true);

    fetchFromIndexer(chainId)
      .then((result) => {
        if (!cancelled) {
          setTokens(result);
          saveCache(chainId, result);
        }
      })
      .catch(() => {
        // Indexer unavailable — silently use cached tokens
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

/** Fetches full pool objects (with liquidity + volume) for the Launchpad explore tab. */
export function useDopplerPools(chainId: number): {
  pools: DopplerPool[];
  loading: boolean;
  refetch: () => void;
} {
  const [pools, setPools] = useState<DopplerPool[]>([]);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);

  const refetch = () => setTick((t) => t + 1);

  useEffect(() => {
    const url = DOPPLER_INDEXER_URLS[chainId];
    if (!url || !url.startsWith("https://")) return;

    let cancelled = false;
    setLoading(true);

    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: DOPPLER_POOLS_QUERY,
        variables: { chainId, limit: 100 },
      }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) {
          if (data?.errors) return;
          setPools(data?.data?.pools?.items ?? []);
        }
      })
      .catch(() => {
        // Indexer unavailable — leave pools empty
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [chainId, tick]);

  return { pools, loading, refetch };
}
