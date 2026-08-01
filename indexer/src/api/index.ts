import { db, publicClients } from "ponder:api";
import { launch } from "ponder:schema";
import { and, count, desc, eq } from "ponder";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Address } from "viem";
import { erc20MetadataAbi, trenchGraduatorAbi, trenchV4LockerAbi } from "../../abis/trenchV5";
import { INDEXER_CHAINS, indexerChainById } from "../chains";

const app = new Hono();
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const RESPONSE_TTL_MS = 5_000;
const responseCache = new Map<string, { expiresAt: number; payload: unknown }>();

app.use("/v1/*", cors({ origin: "*", allowMethods: ["GET", "OPTIONS"] }));

function stateLabel(state: number, fallback: string): string {
  if (state === 3) return "graduated";
  if (state === 2) return "graduation-signaled";
  if (state === 1) return "curve-active";
  return fallback;
}

type LiveProgress = {
  sold: bigint;
  curveAllocation: bigint;
  progressWad: bigint;
  quotePrincipal: bigint;
  minimumProceeds: bigint;
  signaledAt: bigint;
  finalizableAt: bigint;
  state: number;
};

function asProgress(value: unknown): LiveProgress | null {
  if (!value || typeof value !== "object") return null;
  return value as LiveProgress;
}

type EnrichedLaunch = {
  row: typeof launch.$inferSelect;
  progress: LiveProgress | null;
  tokenFees: bigint | null;
  quoteFees: bigint | null;
  metadata: { name: string; symbol: string; decimals: number } | null;
};

function unenriched(row: typeof launch.$inferSelect): EnrichedLaunch {
  return { row, progress: null, tokenFees: null, quoteFees: null, metadata: null };
}

async function enrich(rows: Array<typeof launch.$inferSelect>, chainId: number): Promise<EnrichedLaunch[]> {
  const chain = indexerChainById(chainId);
  if (!chain || rows.length === 0) return rows.map(unenriched);
  const client = (publicClients as Record<string, any>)[chain.key];
  if (!client) return rows.map(unenriched);
  try {
    if (rows.every((row) => row.protocolVersion === "legacy-instant")) {
      const results = await client.multicall({
        allowFailure: true,
        contracts: rows.flatMap((row) => [
          { address: row.token, abi: erc20MetadataAbi, functionName: "name" },
          { address: row.token, abi: erc20MetadataAbi, functionName: "symbol" },
          { address: row.token, abi: erc20MetadataAbi, functionName: "decimals" },
        ]),
      });
      return rows.map((row, index) => {
        const offset = index * 3;
        const name = results[offset];
        const symbol = results[offset + 1];
        const decimals = results[offset + 2];
        return {
          ...unenriched(row),
          metadata: name?.status === "success" && symbol?.status === "success" && decimals?.status === "success"
            ? { name: name.result as string, symbol: symbol.result as string, decimals: Number(decimals.result) }
            : null,
        };
      });
    }
    const results = await client.multicall({
      allowFailure: true,
      contracts: rows.flatMap((row) => [
        { address: chain.graduator, abi: trenchGraduatorAbi, functionName: "curveProgress", args: [row.token] },
        { address: chain.locker, abi: trenchV4LockerAbi, functionName: "creatorClaimable", args: [row.token, row.token] },
        { address: chain.locker, abi: trenchV4LockerAbi, functionName: "creatorClaimable", args: [row.token, row.numeraire] },
      ]),
    });
    return rows.map((row, index) => {
      const offset = index * 3;
      const progressResult = results[offset];
      const tokenResult = results[offset + 1];
      const quoteResult = results[offset + 2];
      return {
        row,
        progress: progressResult?.status === "success" ? asProgress(progressResult.result) : null,
        tokenFees: tokenResult?.status === "success" ? tokenResult.result as bigint : null,
        quoteFees: quoteResult?.status === "success" ? quoteResult.result as bigint : null,
        metadata: null,
      };
    });
  } catch {
    return rows.map(unenriched);
  }
}

function serialize(item: Awaited<ReturnType<typeof enrich>>[number]) {
  const { row, progress } = item;
  return {
    chainId: row.chainId,
    token: row.token,
    creator: row.creator,
    poolAddress: row.poolAddress,
    poolId: row.poolId,
    name: item.metadata?.name ?? row.name,
    symbol: item.metadata?.symbol ?? row.symbol,
    decimals: item.metadata?.decimals ?? row.decimals,
    engine: row.engine,
    numeraire: row.numeraire,
    quoteSymbol: row.quoteSymbol,
    quoteDecimals: row.quoteDecimals,
    protocolVersion: row.protocolVersion,
    source: row.source,
    curveState: stateLabel(progress?.state ?? 0, row.curveState),
    progressWad: (progress?.progressWad ?? row.progressWad).toString(),
    sold: (progress?.sold ?? row.sold).toString(),
    curveAllocation: (progress?.curveAllocation ?? row.curveAllocation).toString(),
    quotePrincipal: (progress?.quotePrincipal ?? row.quotePrincipal).toString(),
    minimumProceeds: (progress?.minimumProceeds ?? row.minimumProceeds).toString(),
    signaledAt: (progress?.signaledAt ?? row.signaledAt).toString(),
    finalizableAt: (progress?.finalizableAt ?? row.finalizableAt).toString(),
    creatorClaimableToken: (item.tokenFees ?? row.creatorClaimableToken).toString(),
    creatorClaimableNumeraire: (item.quoteFees ?? row.creatorClaimableNumeraire).toString(),
    createdAt: row.createdAt.toString(),
    createdBlock: row.createdBlock.toString(),
    createdTransaction: row.createdTransaction,
  };
}

async function cachedPayload(key: string, load: () => Promise<unknown>): Promise<unknown> {
  const cached = responseCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.payload;
  const payload = await load();
  responseCache.set(key, { expiresAt: Date.now() + RESPONSE_TTL_MS, payload });
  if (responseCache.size > 250) {
    const first = responseCache.keys().next().value;
    if (first) responseCache.delete(first);
  }
  return payload;
}

app.get("/v1/status", async (c) => {
  const counts = await db
    .select({ chainId: launch.chainId, protocolVersion: launch.protocolVersion, launches: count() })
    .from(launch)
    .groupBy(launch.chainId, launch.protocolVersion);
  return c.json({
    service: "hydeout-v5-indexer",
    chains: INDEXER_CHAINS.map((chain) => ({
      chainId: chain.id,
      name: chain.name,
      launches: counts
        .filter((row) => row.chainId === chain.id)
        .reduce((total, row) => total + Number(row.launches), 0),
      v5: Number(counts.find((row) => row.chainId === chain.id && row.protocolVersion === "v5-trench")?.launches ?? 0),
      legacy: Number(counts.find((row) => row.chainId === chain.id && row.protocolVersion === "legacy-instant")?.launches ?? 0),
    })),
  });
});

app.get("/v1/launches", async (c) => {
  const chainId = Number(c.req.query("chainId"));
  const chain = indexerChainById(chainId);
  if (!chain) return c.json({ error: "unsupported chainId" }, 400);
  const creatorRaw = c.req.query("creator");
  const creator = creatorRaw && ADDRESS.test(creatorRaw) ? creatorRaw.toLowerCase() as Address : undefined;
  if (creatorRaw && !creator) return c.json({ error: "invalid creator address" }, 400);
  const versionRaw = c.req.query("protocolVersion");
  const protocolVersion = versionRaw === "v5-trench" || versionRaw === "legacy-instant" ? versionRaw : undefined;
  if (versionRaw && !protocolVersion) return c.json({ error: "invalid protocolVersion" }, 400);
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit")) || 60));
  const key = `launches:${chainId}:${creator ?? "all"}:${protocolVersion ?? "all"}:${limit}`;
  const payload = await cachedPayload(key, async () => {
    const rows = await db
      .select()
      .from(launch)
      .where(and(
        eq(launch.chainId, chainId),
        creator ? eq(launch.creator, creator) : undefined,
        protocolVersion ? eq(launch.protocolVersion, protocolVersion) : undefined,
      ))
      .orderBy(desc(launch.createdBlock))
      .limit(limit);
    return { source: "ponder", chainId, launches: (await enrich(rows, chainId)).map(serialize) };
  });
  c.header("Cache-Control", "public, max-age=5, stale-while-revalidate=30");
  return c.json(payload);
});

app.get("/v1/launches/:chainId/:token", async (c) => {
  const chainId = Number(c.req.param("chainId"));
  const tokenRaw = c.req.param("token");
  if (!indexerChainById(chainId)) return c.json({ error: "unsupported chainId" }, 400);
  if (!ADDRESS.test(tokenRaw)) return c.json({ error: "invalid token address" }, 400);
  const token = tokenRaw.toLowerCase() as Address;
  const key = `launch:${chainId}:${token}`;
  const payload = await cachedPayload(key, async () => {
    const rows = await db
      .select()
      .from(launch)
      .where(and(eq(launch.chainId, chainId), eq(launch.token, token)))
      .limit(1);
    const [item] = await enrich(rows, chainId);
    return { source: "ponder", chainId, launch: item ? serialize(item) : null };
  });
  c.header("Cache-Control", "public, max-age=5, stale-while-revalidate=30");
  return c.json(payload);
});

export default app;
