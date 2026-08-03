import type { Address } from "viem";
import type { DopplerPool, TrenchCurveState } from "./dopplerConfig";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const WAD = 1_000_000_000_000_000_000n;
const REQUEST_TIMEOUT_MS = 4_000;

type IndexedLaunch = {
  chainId: number;
  token: string;
  creator: string;
  poolAddress: string | null;
  poolId: string | null;
  name: string;
  symbol: string;
  decimals: number;
  engine: "v3-single-sided" | "v4-hook";
  numeraire: string;
  quoteSymbol: string;
  quoteDecimals: number;
  protocolVersion: "legacy-instant" | "v5-trench";
  source: string;
  curveState: TrenchCurveState;
  progressWad: string;
  creatorClaimableNumeraire: string;
  createdAt: string;
};

export type IndexedActivity = {
  holders: Array<{ address: string; value: string }>;
  trades: Array<{
    txHash: string;
    trader: string;
    timestamp: string;
    kind: "buy" | "sell";
    tokenAmount: string;
    quoteAmount: string;
  }>;
};

function indexerBaseUrl(): string | null {
  const raw = import.meta.env.VITE_V5_INDEXER_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return null;
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function isCurveState(value: unknown): value is TrenchCurveState {
  return value === "curve-active" || value === "graduation-signaled" || value === "graduated";
}

function parseLaunch(
  value: unknown,
  expectedChainId: number,
  expectedVersion: IndexedLaunch["protocolVersion"],
): IndexedLaunch {
  const row = value as Partial<IndexedLaunch>;
  if (
    row.chainId !== expectedChainId
    || !row.token || !ADDRESS.test(row.token)
    || !row.creator || !ADDRESS.test(row.creator)
    || !row.numeraire || !ADDRESS.test(row.numeraire)
    || (row.poolAddress != null && !ADDRESS.test(row.poolAddress))
    || (row.poolId != null && !/^0x[0-9a-fA-F]{64}$/.test(row.poolId))
    || typeof row.name !== "string"
    || typeof row.symbol !== "string"
    || !Number.isInteger(row.decimals)
    || (row.engine !== "v3-single-sided" && row.engine !== "v4-hook")
    || typeof row.quoteSymbol !== "string"
    || !Number.isInteger(row.quoteDecimals)
    || row.protocolVersion !== expectedVersion
    || typeof row.source !== "string"
    || !isCurveState(row.curveState)
    || typeof row.progressWad !== "string"
    || typeof row.creatorClaimableNumeraire !== "string"
    || typeof row.createdAt !== "string"
  ) throw new Error("V5 indexer returned an invalid launch record.");
  BigInt(row.progressWad);
  BigInt(row.creatorClaimableNumeraire);
  BigInt(row.createdAt);
  return row as IndexedLaunch;
}

function toPool(row: IndexedLaunch): DopplerPool {
  const isV5 = row.protocolVersion === "v5-trench";
  const progressWad = BigInt(row.progressWad);
  const progress = Math.min(100, Number((progressWad * 10_000n) / WAD) / 100);
  const createdSeconds = Number(BigInt(row.createdAt));
  return {
    address: row.token,
    chainId: row.chainId,
    poolAddress: row.poolAddress,
    poolId: row.poolId,
    baseToken: {
      address: row.token,
      name: row.name,
      symbol: row.symbol,
      decimals: row.decimals,
    },
    quoteToken: {
      address: row.numeraire,
      name: row.quoteSymbol === "WETH" ? "Wrapped Ether" : row.quoteSymbol,
      symbol: row.quoteSymbol,
      decimals: row.quoteDecimals,
    },
    launchEngine: row.engine,
    protocolVersion: row.protocolVersion,
    curveState: isV5 ? row.curveState : undefined,
    type: row.engine === "v3-single-sided" ? "v3" : "v4",
    dollarLiquidity: null,
    volumeUsd: null,
    marketCapUsd: null,
    priceUsd: null,
    createdAt: new Date(createdSeconds * 1000).toISOString(),
    progress: isV5 ? progress : null,
    creator: row.creator,
    creatorClaimable: isV5 ? row.creatorClaimableNumeraire : null,
  };
}

async function fetchIndexer(path: string): Promise<unknown | null> {
  const base = indexerBaseUrl();
  if (!base) return null;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${base}${path}`, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    window.clearTimeout(timeout);
  }
}

/** Returns null when the indexer is unset/unavailable so callers can use their RPC fallback. */
export async function fetchIndexedTrenchV5Pools(chainId: number): Promise<DopplerPool[] | null> {
  const payload = await fetchIndexer(`/v1/launches?chainId=${chainId}&protocolVersion=v5-trench&limit=60`) as {
    chainId?: number;
    launches?: unknown[];
  } | null;
  if (!payload || payload.chainId !== chainId || !Array.isArray(payload.launches)) return null;
  try {
    return payload.launches.map((row) => toPool(parseLaunch(row, chainId, "v5-trench")));
  } catch {
    return null;
  }
}

/** Returns null for both a missing record and indexer failure; the caller verifies via factory logs. */
export async function fetchIndexedTrenchV5Token(
  chainId: number,
  token: Address,
): Promise<DopplerPool | null> {
  const payload = await fetchIndexer(`/v1/launches/${chainId}/${token}`) as {
    chainId?: number;
    launch?: unknown;
  } | null;
  if (!payload || payload.chainId !== chainId || payload.launch == null) return null;
  try {
    return toPool(parseLaunch(payload.launch, chainId, "v5-trench"));
  } catch {
    return null;
  }
}

/** Indexed legacy factories use the same DTO but intentionally have no curve progress or V5 claims. */
export async function fetchIndexedLegacyPools(chainId: number): Promise<DopplerPool[] | null> {
  const payload = await fetchIndexer(`/v1/launches?chainId=${chainId}&protocolVersion=legacy-instant&limit=60`) as {
    chainId?: number;
    launches?: unknown[];
  } | null;
  if (!payload || payload.chainId !== chainId || !Array.isArray(payload.launches)) return null;
  try {
    return payload.launches.map((row) => toPool(parseLaunch(row, chainId, "legacy-instant")));
  } catch {
    return null;
  }
}

export async function fetchIndexedLegacyToken(
  chainId: number,
  token: Address,
): Promise<DopplerPool | null> {
  const payload = await fetchIndexer(`/v1/launches/${chainId}/${token}`) as {
    chainId?: number;
    launch?: unknown;
  } | null;
  if (!payload || payload.chainId !== chainId || payload.launch == null) return null;
  try {
    return toPool(parseLaunch(payload.launch, chainId, "legacy-instant"));
  } catch {
    return null;
  }
}

export async function fetchIndexedTokenActivity(
  chainId: number,
  token: Address,
): Promise<IndexedActivity | null> {
  const payload = await fetchIndexer(`/v1/activity/${chainId}/${token}`) as {
    chainId?: number;
    token?: string;
    holders?: unknown[];
    trades?: unknown[];
  } | null;
  if (
    !payload
    || payload.chainId !== chainId
    || payload.token?.toLowerCase() !== token.toLowerCase()
    || !Array.isArray(payload.holders)
    || !Array.isArray(payload.trades)
  ) return null;
  try {
    const holders = payload.holders.map((value) => {
      const row = value as { address?: unknown; value?: unknown };
      if (typeof row.address !== "string" || !ADDRESS.test(row.address) || typeof row.value !== "string") {
        throw new Error("invalid holder");
      }
      BigInt(row.value);
      return { address: row.address, value: row.value };
    });
    const trades = payload.trades.map((value) => {
      const row = value as Record<string, unknown>;
      if (
        typeof row.txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(row.txHash)
        || typeof row.trader !== "string" || !ADDRESS.test(row.trader)
        || typeof row.timestamp !== "string"
        || (row.kind !== "buy" && row.kind !== "sell")
        || typeof row.tokenAmount !== "string"
        || typeof row.quoteAmount !== "string"
      ) throw new Error("invalid trade");
      BigInt(row.timestamp);
      BigInt(row.tokenAmount);
      BigInt(row.quoteAmount);
      return row as IndexedActivity["trades"][number];
    });
    return { holders, trades };
  } catch {
    return null;
  }
}
