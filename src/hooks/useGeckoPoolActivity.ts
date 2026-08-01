import { useEffect, useState } from "react";

export type GeckoRange = "5m" | "1h" | "24h" | "7d";

export type GeckoCandle = {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volumeUsd: number;
};

export type GeckoTrade = {
  txHash: string;
  trader: string;
  timestamp: string;
  kind: "buy" | "sell";
  tokenAmount: number;
  quoteAmount: number;
  volumeUsd: number;
  priceUsd: number | null;
};

type GeckoSnapshot = {
  priceUsd: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  volumeUsd: number | null;
};

type GeckoPoolActivity = GeckoSnapshot & {
  candles: GeckoCandle[];
  trades: GeckoTrade[];
  loading: boolean;
  error: string | null;
  url: string | null;
};

const API_ROOT = "https://api.geckoterminal.com/api/v2";
const CACHE_TTL_MS = 60_000;

const NETWORK_SLUG: Record<number, string | undefined> = {
  988: "stable",
  4663: "robinhood",
  42161: "arbitrum",
};

const RANGE_PATH: Record<GeckoRange, string> = {
  "5m": "minute?aggregate=1&limit=5",
  "1h": "minute?aggregate=5&limit=12",
  "24h": "hour?aggregate=1&limit=24",
  "7d": "day?aggregate=1&limit=7",
};

type CacheEntry<T> = { at: number; value: Promise<T> };
const requestCache = new Map<string, CacheEntry<unknown>>();

function cachedJson<T>(url: string): Promise<T> {
  const cached = requestCache.get(url);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.value as Promise<T>;
  }
  const value = fetch(url, {
    headers: { Accept: "application/json;version=20230302" },
  }).then(async (response) => {
    if (!response.ok) {
      throw new Error(response.status === 429 ? "Market feed is rate limited." : "Market feed is unavailable.");
    }
    return response.json() as Promise<T>;
  });
  requestCache.set(url, { at: Date.now(), value });
  value.catch(() => requestCache.delete(url));
  return value;
}

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

type PoolResponse = {
  data?: {
    attributes?: {
      base_token_price_usd?: string;
      fdv_usd?: string;
      market_cap_usd?: string | null;
      reserve_in_usd?: string;
      volume_usd?: { h24?: string };
    };
  };
};

type TradesResponse = {
  data?: Array<{
    attributes?: {
      tx_hash?: string;
      tx_from_address?: string;
      block_timestamp?: string;
      kind?: string;
      from_token_amount?: string;
      to_token_amount?: string;
      from_token_address?: string;
      to_token_address?: string;
      volume_in_usd?: string;
      price_from_in_usd?: string;
      price_to_in_usd?: string;
    };
  }>;
};

type OhlcvResponse = {
  data?: {
    attributes?: {
      ohlcv_list?: Array<[number, number, number, number, number, number]>;
    };
  };
  meta?: { base?: { address?: string } };
};

function parseSnapshot(response: PoolResponse): GeckoSnapshot {
  const attributes = response.data?.attributes;
  return {
    priceUsd: finite(attributes?.base_token_price_usd),
    marketCapUsd: finite(attributes?.market_cap_usd) ?? finite(attributes?.fdv_usd),
    liquidityUsd: finite(attributes?.reserve_in_usd),
    volumeUsd: finite(attributes?.volume_usd?.h24),
  };
}

function parseTrades(response: TradesResponse, tokenAddress: string): GeckoTrade[] {
  const token = tokenAddress.toLowerCase();
  return (response.data ?? []).flatMap((entry) => {
    const attributes = entry.attributes;
    if (!attributes?.tx_hash || !attributes.block_timestamp) return [];
    const fromIsToken = attributes.from_token_address?.toLowerCase() === token;
    const tokenAmount = finite(fromIsToken ? attributes.from_token_amount : attributes.to_token_amount);
    const quoteAmount = finite(fromIsToken ? attributes.to_token_amount : attributes.from_token_amount);
    const priceUsd = finite(fromIsToken ? attributes.price_from_in_usd : attributes.price_to_in_usd);
    const kind = attributes.kind === "sell" ? "sell" : "buy";
    return [{
      txHash: attributes.tx_hash,
      trader: attributes.tx_from_address ?? "",
      timestamp: attributes.block_timestamp,
      kind,
      tokenAmount: tokenAmount ?? 0,
      quoteAmount: quoteAmount ?? 0,
      volumeUsd: finite(attributes.volume_in_usd) ?? 0,
      priceUsd,
    }];
  });
}

function parseCandles(response: OhlcvResponse): GeckoCandle[] {
  return (response.data?.attributes?.ohlcv_list ?? [])
    .map(([timestamp, open, high, low, close, volumeUsd]) => ({
      timestamp,
      open,
      high,
      low,
      close,
      volumeUsd,
    }))
    .filter((candle) => (
      Number.isFinite(candle.timestamp)
      && Number.isFinite(candle.open)
      && Number.isFinite(candle.high)
      && Number.isFinite(candle.low)
      && Number.isFinite(candle.close)
    ))
    .sort((a, b) => a.timestamp - b.timestamp);
}

export function useGeckoPoolActivity(
  chainId: number,
  poolAddress: string | null | undefined,
  tokenAddress: string,
  range: GeckoRange,
): GeckoPoolActivity {
  const [state, setState] = useState<GeckoPoolActivity>({
    priceUsd: null,
    marketCapUsd: null,
    liquidityUsd: null,
    volumeUsd: null,
    candles: [],
    trades: [],
    loading: false,
    error: null,
    url: null,
  });

  useEffect(() => {
    const network = NETWORK_SLUG[chainId];
    if (!network || !poolAddress || !/^0x(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(poolAddress)) {
      setState({
        priceUsd: null,
        marketCapUsd: null,
        liquidityUsd: null,
        volumeUsd: null,
        candles: [],
        trades: [],
        loading: false,
        error: null,
        url: null,
      });
      return;
    }

    let cancelled = false;
    const normalizedPool = poolAddress.toLowerCase();
    const poolUrl = `${API_ROOT}/networks/${network}/pools/${normalizedPool}`;
    const tradesUrl = `${poolUrl}/trades`;
    const ohlcvUrl = `${poolUrl}/ohlcv/${RANGE_PATH[range]}&currency=usd&token=base`;
    const terminalUrl = `https://www.geckoterminal.com/${network}/pools/${normalizedPool}`;

    setState((current) => ({ ...current, loading: true, error: null, url: terminalUrl }));
    Promise.allSettled([
      cachedJson<PoolResponse>(poolUrl),
      cachedJson<TradesResponse>(tradesUrl),
      cachedJson<OhlcvResponse>(ohlcvUrl),
    ]).then(([snapshotResult, tradesResult, candlesResult]) => {
      if (cancelled) return;
      const snapshot = snapshotResult.status === "fulfilled"
        ? parseSnapshot(snapshotResult.value)
        : { priceUsd: null, marketCapUsd: null, liquidityUsd: null, volumeUsd: null };
      const trades = tradesResult.status === "fulfilled"
        ? parseTrades(tradesResult.value, tokenAddress)
        : [];
      const candles = candlesResult.status === "fulfilled"
        ? parseCandles(candlesResult.value)
        : [];
      const failed = [snapshotResult, tradesResult, candlesResult].every((result) => result.status === "rejected");
      setState({
        ...snapshot,
        trades,
        candles,
        loading: false,
        error: failed ? "Live market history is temporarily unavailable." : null,
        url: terminalUrl,
      });
    });

    return () => { cancelled = true; };
  }, [chainId, poolAddress, range, tokenAddress]);

  return state;
}
