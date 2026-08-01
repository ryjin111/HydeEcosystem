import type { DopplerPool } from "./dopplerConfig";

export type GeckoTerminalMarket = {
  priceUsd: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  volumeUsd: number | null;
};

const API_ROOT = "https://api.geckoterminal.com/api/v2";
const REQUEST_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 60_000;
const MAX_POOLS_PER_REQUEST = 30;
const POOL_IDENTIFIER = /^0x(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/;

const NETWORK_SLUG: Record<number, string | undefined> = {
  988: "stable",
  4_663: "robinhood",
  42_161: "arbitrum",
};

type GeckoPool = {
  attributes?: {
    address?: string;
    base_token_price_usd?: string;
    quote_token_price_usd?: string;
    fdv_usd?: string;
    market_cap_usd?: string | null;
    reserve_in_usd?: string;
    volume_usd?: { h24?: string };
  };
  relationships?: {
    base_token?: { data?: { id?: string } };
    quote_token?: { data?: { id?: string } };
    dex?: { data?: { id?: string } };
  };
};

type GeckoPoolsResponse = { data?: GeckoPool[] };
type CacheEntry = { at: number; value: Promise<GeckoPoolsResponse | null> };
const requestCache = new Map<string, CacheEntry>();

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function relatedAddress(id: string | undefined): string {
  if (!id) return "";
  const separator = id.indexOf("_");
  return (separator >= 0 ? id.slice(separator + 1) : id).toLowerCase();
}

async function cachedPools(url: string): Promise<GeckoPoolsResponse | null> {
  const cached = requestCache.get(url);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
  const value = (async () => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json;version=20230302" },
        signal: controller.signal,
      });
      if (!response.ok) return null;
      return await response.json() as GeckoPoolsResponse;
    } catch {
      return null;
    } finally {
      window.clearTimeout(timeout);
    }
  })();
  requestCache.set(url, { at: Date.now(), value });
  value.then((result) => {
    if (!result) requestCache.delete(url);
  });
  return value;
}

/** Accept market data only when pool, venue, launch token, and quote all match the launch record. */
export async function fetchGeckoTerminalMarkets(
  pools: readonly DopplerPool[],
): Promise<Map<string, GeckoTerminalMarket>> {
  const markets = new Map<string, GeckoTerminalMarket>();
  const byChain = new Map<number, DopplerPool[]>();
  for (const pool of pools) {
    const identifier = pool.poolAddress ?? pool.poolId;
    if (!identifier || !POOL_IDENTIFIER.test(identifier) || !NETWORK_SLUG[pool.chainId]) continue;
    const chainPools = byChain.get(pool.chainId) ?? [];
    chainPools.push(pool);
    byChain.set(pool.chainId, chainPools);
  }

  for (const [chainId, chainPools] of byChain) {
    const network = NETWORK_SLUG[chainId]!;
    for (let index = 0; index < chainPools.length; index += MAX_POOLS_PER_REQUEST) {
      const batch = chainPools.slice(index, index + MAX_POOLS_PER_REQUEST);
      const byIdentifier = new Map(batch.map((pool) => [
        (pool.poolAddress ?? pool.poolId)!.toLowerCase(),
        pool,
      ]));
      const identifiers = [...byIdentifier.keys()];
      const payload = await cachedPools(`${API_ROOT}/networks/${network}/pools/multi/${identifiers.join(",")}`);
      for (const entry of payload?.data ?? []) {
        const attributes = entry.attributes;
        const identifier = attributes?.address?.toLowerCase();
        const pool = identifier ? byIdentifier.get(identifier) : undefined;
        if (!pool || !entry.relationships?.dex?.data?.id?.toLowerCase().startsWith("uniswap")) continue;
        const token = pool.address.toLowerCase();
        const quote = pool.quoteToken.address.toLowerCase();
        const base = relatedAddress(entry.relationships.base_token?.data?.id);
        const poolQuote = relatedAddress(entry.relationships.quote_token?.data?.id);
        const tokenIsBase = base === token && poolQuote === quote;
        const tokenIsQuote = poolQuote === token && base === quote;
        if (!tokenIsBase && !tokenIsQuote) continue;
        markets.set(token, {
          priceUsd: finite(tokenIsBase ? attributes?.base_token_price_usd : attributes?.quote_token_price_usd),
          marketCapUsd: tokenIsBase
            ? finite(attributes?.market_cap_usd) ?? finite(attributes?.fdv_usd)
            : null,
          liquidityUsd: finite(attributes?.reserve_in_usd),
          volumeUsd: finite(attributes?.volume_usd?.h24),
        });
      }
    }
  }
  return markets;
}
