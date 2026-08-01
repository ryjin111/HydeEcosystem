import { useEffect, useState } from "react";
import { createPublicClient, defineChain, parseAbiItem, type PublicClient } from "viem";
import type { TokenInfo } from "../utils/constants";
import {
  ARBITRUM_MAINNET,
  ROBINHOOD_MAINNET,
  ROBINHOOD_TESTNET,
  STABLE_MAINNET,
  DOPPLER_CONTRACTS_BY_CHAIN,
  ROBINHOOD_TESTNET_VAULT,
  V4_CONTRACTS_BY_CHAIN,
  hydeVaultAbi,
} from "../utils/constants";
import type { DopplerPool } from "../utils/dopplerConfig";
import { v3ChainRow } from "../utils/chainRegistry";
import { rpcTransportForNetwork, rpcUrlsForNetwork } from "../utils/rpc";
import {
  fetchTrenchV5Pools,
  fetchTrenchV5Token,
  isTrenchV5Configured,
} from "../utils/trenchV5";
import { fetchIndexedLegacyPools, fetchIndexedLegacyToken } from "../utils/trenchV5Indexer";
import { fetchGeckoTerminalMarkets } from "../utils/geckoTerminalMarkets";

const ROBINHOOD_CHAIN_ID = 4663;

const AIRLOCK = DOPPLER_CONTRACTS_BY_CHAIN[ROBINHOOD_CHAIN_ID].airlock;

// Doppler Airlock events — every Hydeout launch emits Create; graduation emits Migrate.
const CREATE_EVENT  = parseAbiItem("event Create(address asset, address indexed numeraire, address initializer, address poolOrHook)");
const MIGRATE_EVENT = parseAbiItem("event Migrate(address indexed asset, address indexed pool)");

const ERC20_META_ABI = [
  { type: "function", name: "name",   stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

// Uniswap v4 PoolManager custodies every live curve's token inventory —
// curve progress is measured against it.
const POOL_MANAGER = "0x8366a39CC670B4001A1121B8F6A443A643e40951" as const;

const TRANSFER_EVENT = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

// ─── Mainnet own-stack sources (deployed 2026-07-21) ────────────────────────────────────────────
// The 4663 board now reads OUR factories' launch events ONLY — no Doppler Airlock (clint: "only our
// stack"). WETH factory emits `LaunchCreated`; the HOODIE launcher-launcher engine emits
// `HoodieLaunchCreated` (standard shape, human creator indexed). Deploy blocks bound every scan.
// WETH stack REDEPLOYED 2026-07-24 (numeraire-aware $5k preset, audited 08d99a7) — old broken
// factory 0x710fEa…509f + its $1.9T HYDE are delisted by pointing the board at the new factory.
const MAINNET_WETH_FACTORY = "0x159A2fa37427299466B0723713eaa260e6124cbc" as `0x${string}`;
const MAINNET_WETH_FACTORY_BLOCK = 17418907n;
const MAINNET_HOODIE_ENGINE = "0x8062951c99CfFA5365f979D5139Cf96b5c77CFCc" as `0x${string}`;
const MAINNET_HOODIE_ENGINE_BLOCK = 15652257n;
const MAINNET_HOODIE = "0xC72c01AAB5f5678dc1d6f5C6d2B417d91D402Ba3" as `0x${string}`;
const HOODIE_LAUNCH_CREATED = parseAbiItem(
  "event HoodieLaunchCreated(address indexed launcher, address indexed creator, address indexed token, bytes32 poolId, uint256 tokenId)"
);

// Dedicated client: launches must load even before a wallet connects.
const robinhoodChain = defineChain({
  id: ROBINHOOD_CHAIN_ID,
  name: ROBINHOOD_MAINNET.name,
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: rpcUrlsForNetwork(ROBINHOOD_MAINNET) } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});
const client = createPublicClient({ chain: robinhoodChain, transport: rpcTransportForNetwork(ROBINHOOD_MAINNET) });

// Stable V3 launch source. Scans begin at the HydeV3Pad deployment block, never block zero.
const STABLE_CHAIN_ID = 988;
const stableV3 = v3ChainRow(STABLE_CHAIN_ID)!;
const STABLE_V3_PAD = stableV3.launchpad.pad as `0x${string}`;
const STABLE_V3_LOCKER = stableV3.launchpad.locker as `0x${string}`;
const STABLE_V3_DEPLOY_BLOCK = stableV3.launchpad.deploymentBlock;
const STABLE_V3_LAUNCH_CREATED = parseAbiItem(
  "event LaunchCreated(address indexed token, address indexed creator, address pool, uint256 tokenId, uint128 liquidity)"
);
const STABLE_V3_POSITION_ABI = [{
  type: "function",
  name: "positionOf",
  stateMutability: "view",
  inputs: [{ name: "token", type: "address" }],
  outputs: [
    { name: "creator", type: "address" },
    { name: "token0", type: "address" },
    { name: "token1", type: "address" },
    { name: "numeraire", type: "address" },
    { name: "tokenId", type: "uint256" },
    { name: "feeTier", type: "uint24" },
    { name: "cumulativeNumeraireFees", type: "uint256" },
    { name: "graduated", type: "bool" },
    { name: "registered", type: "bool" },
  ],
}] as const;
const STABLE_V3_FACTORY_ABI = [{
  type: "function",
  name: "getPool",
  stateMutability: "view",
  inputs: [
    { name: "tokenA", type: "address" },
    { name: "tokenB", type: "address" },
    { name: "fee", type: "uint24" },
  ],
  outputs: [{ name: "pool", type: "address" }],
}] as const;
const stableChain = defineChain({
  id: STABLE_CHAIN_ID,
  name: STABLE_MAINNET.name,
  nativeCurrency: { name: "USDT0", symbol: "USDT0", decimals: 18 },
  rpcUrls: { default: { http: rpcUrlsForNetwork(STABLE_MAINNET) } },
});
const stableRpcUrls = rpcUrlsForNetwork(STABLE_MAINNET);
const stableUsesPublicPrimary = stableRpcUrls[0] === STABLE_MAINNET.rpcUrl.replace(/\/$/, "");
const stableClient = createPublicClient({ chain: stableChain, transport: rpcTransportForNetwork(STABLE_MAINNET) });

// Bounded scan: with thousands of launches, block-0 / all-asset getLogs times
// out in the browser. Scan the NEWEST launches backwards in fixed block chunks,
// then enrich only that page — all queries bounded. `MAX_SHOWN` caps the board
// page (newest first); older launches load via pagination later (not silently
// dropped — the count reflects the page, and there's a documented cap here).
const RANGE = 100_000n;   // blocks per getLogs (public-RPC-safe)
const MAX_SHOWN = 60;     // newest launches enriched per board load
const BLOCKSCOUT_BASE = ROBINHOOD_MAINNET.explorerUrl.replace(/\/$/, "");
const LAUNCH_CREATED_TOPIC = "0x8af4c8ab7fe4c9373619cf9401e1cd3d4a3c3794b4dbc6fdf28648062817790e";
const HOODIE_LAUNCH_CREATED_TOPIC = "0x972f647994f3d28b970cea4db05f18ae9917dc52b856f836eb66266659572ca0";

type ExplorerLog = {
  address: string;
  blockNumber: string;
  data: string;
  timeStamp: string;
  topics: (string | null)[];
  transactionHash: string;
};

type ExplorerToken = {
  address_hash?: string;
  decimals?: string | null;
  name?: string | null;
  symbol?: string | null;
};

function topicAddress(topic?: string | null): `0x${string}` | null {
  if (!topic || !/^0x[0-9a-fA-F]{64}$/.test(topic)) return null;
  return `0x${topic.slice(-40)}` as `0x${string}`;
}

function topicForAddress(address: `0x${string}`): string {
  return `0x${address.slice(2).padStart(64, "0")}`;
}

function explorerInteger(value: string): number {
  return Number(BigInt(value));
}

async function explorerFetch(url: URL | string): Promise<Response> {
  let response: Response | null = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    response = await fetch(url);
    if (response.status !== 429) return response;
    if (attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 750 * (2 ** attempt)));
    }
  }
  return response!;
}

async function fetchExplorerLogs(
  contract: `0x${string}`,
  topic0: string,
  fromBlock: bigint,
  indexedMatch?: { position: 1 | 3; value: string },
): Promise<ExplorerLog[]> {
  const url = new URL(`${BLOCKSCOUT_BASE}/api`);
  url.searchParams.set("module", "logs");
  url.searchParams.set("action", "getLogs");
  url.searchParams.set("fromBlock", fromBlock.toString());
  url.searchParams.set("toBlock", "latest");
  url.searchParams.set("address", contract);
  url.searchParams.set("topic0", topic0);
  url.searchParams.set("page", "1");
  url.searchParams.set("offset", "1000");
  if (indexedMatch) {
    url.searchParams.set(`topic${indexedMatch.position}`, indexedMatch.value);
    url.searchParams.set(`topic0_${indexedMatch.position}_opr`, "and");
  }

  const response = await explorerFetch(url);
  if (!response.ok) throw new Error(`Blockscout logs HTTP ${response.status}`);
  const payload = await response.json() as { status?: string; message?: string; result?: ExplorerLog[] | string };
  if (payload.status === "1" && Array.isArray(payload.result)) return payload.result;
  if (payload.status === "0" && payload.message === "No logs found" && Array.isArray(payload.result)) return [];
  throw new Error(typeof payload.result === "string" ? payload.result : "Blockscout logs unavailable");
}

async function fetchExplorerToken(address: `0x${string}`): Promise<ExplorerToken> {
  const response = await explorerFetch(`${BLOCKSCOUT_BASE}/api/v2/tokens/${address}`);
  if (!response.ok) throw new Error(`Blockscout token HTTP ${response.status}`);
  const token = await response.json() as ExplorerToken;
  if (!token.name || !token.symbol) throw new Error("Blockscout token metadata incomplete");
  return token;
}

// chunked getLogs over bounded ranges; the call factory keeps viem's typed logs
async function getLogsChunked<E>(call: (from: bigint, to: bigint) => Promise<E[]>, fromBlock: bigint, toBlock: bigint): Promise<E[]> {
  const out: E[] = [];
  for (let s = fromBlock; s <= toBlock; s += RANGE) {
    const e = s + RANGE - 1n > toBlock ? toBlock : s + RANGE - 1n;
    out.push(...(await call(s, e)));
  }
  return out;
}

// Stable's public RPC enforces a hard 500-block eth_getLogs window. Alchemy accepts at most 10,000
// blocks per request. Always stay inside the provider's advertised bound: an oversized first request
// used to fail, then viem's fallback transport silently moved the whole scan onto the slow public RPC.
const STABLE_PUBLIC_LOG_RANGE = 500n;
const STABLE_PAID_LOG_RANGE = 10_000n;
const STABLE_LOG_CONCURRENCY = 4;
const STABLE_LOG_RETRIES = 4;

async function getStableLogChunk<E>(
  call: (from: bigint, to: bigint) => Promise<E[]>,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<E[]> {
  let lastError: unknown;
  for (let attempt = 0; attempt < STABLE_LOG_RETRIES; attempt += 1) {
    try {
      return await call(fromBlock, toBlock);
    } catch (error) {
      lastError = error;
      if (attempt < STABLE_LOG_RETRIES - 1) {
        await new Promise((resolve) => setTimeout(resolve, 750 * (2 ** attempt)));
      }
    }
  }
  throw lastError;
}

async function getStableLogs<E>(
  call: (from: bigint, to: bigint) => Promise<E[]>,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<E[]> {
  const scan = async (range: bigint): Promise<E[]> => {
    const ranges: [bigint, bigint][] = [];
    for (let from = fromBlock; from <= toBlock; from += range) {
      const to = from + range - 1n > toBlock
        ? toBlock
        : from + range - 1n;
      ranges.push([from, to]);
    }

    const out: E[] = [];
    for (let index = 0; index < ranges.length; index += STABLE_LOG_CONCURRENCY) {
      const chunks = await Promise.all(
        ranges.slice(index, index + STABLE_LOG_CONCURRENCY)
          .map(([from, to]) => getStableLogChunk(call, from, to)),
      );
      for (const chunk of chunks) out.push(...chunk);
      if (index + STABLE_LOG_CONCURRENCY < ranges.length) {
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
    return out;
  };

  if (stableUsesPublicPrimary) return scan(STABLE_PUBLIC_LOG_RANGE);
  try {
    return await scan(STABLE_PAID_LOG_RANGE);
  } catch {
    // If the paid endpoint is unavailable, the same fallback transport can still finish against the
    // chain-owned endpoint as long as every retry is rebuilt at its 500-block maximum.
    return scan(STABLE_PUBLIC_LOG_RANGE);
  }
}

// Real market-cap / price / liquidity / 24h-volume from a chain-scoped DEXScreener pair.
// A pair must match both the requested chain and Uniswap venue. Tokens not returned by
// that source remain null (honest — no fabricated number).
// Batched (up to 30 addrs/call) + fail-neutral: any error leaves everything null.
type DexData = { marketCapUsd: number | null; priceUsd: number | null; liquidityUsd: number | null; volumeUsd: number | null };
type DexChain = "robinhood" | "stable";
async function fetchDexData(
  addresses: string[],
  expectedChain: DexChain = "robinhood",
  canonicalPairByToken?: ReadonlyMap<string, string>,
): Promise<Map<string, DexData>> {
  const out = new Map<string, DexData>();
  const CHUNK = 30; // DEXScreener /tokens accepts up to 30 comma-separated addresses
  for (let i = 0; i < addresses.length; i += CHUNK) {
    const batch = addresses.slice(i, i + CHUNK);
    try {
      const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${batch.join(",")}`);
      if (!r.ok) continue;
      const d = await r.json();
      type Pair = { chainId?: string; dexId?: string; pairAddress?: string; baseToken?: { address?: string };
        marketCap?: number; fdv?: number; priceUsd?: string; liquidity?: { usd?: number }; volume?: { h24?: number } };
      for (const p of (d?.pairs ?? []) as Pair[]) {
        // Only the requested chain's Uniswap pair — never a wrong-chain price.
        if (p.chainId !== expectedChain || p.dexId !== "uniswap") continue;
        const key = (p.baseToken?.address ?? "").toLowerCase();
        if (!key) continue;
        const canonicalPair = canonicalPairByToken?.get(key);
        if (canonicalPair && p.pairAddress?.toLowerCase() !== canonicalPair.toLowerCase()) continue;
        const liq = p.liquidity?.usd ?? null;
        const prev = out.get(key);
        // keep the deepest-liquidity pair per token (the canonical/graduated one)
        if (prev && (prev.liquidityUsd ?? 0) >= (liq ?? 0)) continue;
        out.set(key, {
          marketCapUsd: p.marketCap ?? p.fdv ?? null,
          priceUsd: p.priceUsd != null ? Number(p.priceUsd) : null,
          liquidityUsd: liq,
          volumeUsd: p.volume?.h24 ?? null,
        });
      }
    } catch { /* fail neutral — leave this batch null */ }
  }
  return out;
}

async function fetchLaunchMarketData(
  pools: DopplerPool[],
  expectedChain: DexChain = "robinhood",
  canonicalPairByToken?: ReadonlyMap<string, string>,
): Promise<Map<string, DexData>> {
  const gecko = new Map<string, DexData>(await fetchGeckoTerminalMarkets(pools));
  const missing = pools.filter((pool) => !gecko.has(pool.address.toLowerCase()));
  if (missing.length === 0) return gecko;
  const fallback = await fetchDexData(
    missing.map((pool) => pool.address),
    expectedChain,
    canonicalPairByToken,
  );
  for (const [token, market] of fallback) gecko.set(token, market);
  return gecko;
}


/** Tokens launched via the Hydeout launchpad on Robinhood Chain, as TokenInfo[].
 *  No swap-routing metadata attached here; the Token page gates executable swaps
 *  on isGatewayLive() until router metadata (hook address per pool) is wired. */
export function useHydeTokens(chainId: number): {
  tokens: TokenInfo[];
  loading: boolean;
} {
  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // Clear stale mainnet tokens the moment we leave 4663 so a testnet view never carries mainnet
    // launches (kami A-blocker #3). This swap-routing list is mainnet-only by design.
    if (chainId !== ROBINHOOD_CHAIN_ID) { setTokens([]); setLoading(false); return; }

    let cancelled = false;
    setLoading(true);

    fetchMainnetOwnStackPools()
      .then((pools) => {
        if (cancelled) return;
        setTokens(
          pools.map((p): TokenInfo => ({
            address: p.baseToken.address as `0x${string}`,
            name: p.baseToken.name,
            symbol: p.baseToken.symbol,
            decimals: p.baseToken.decimals,
          }))
        );
      })
      .catch(() => {
        // RPC unavailable — leave tokens empty
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

// Canonical launch-token implementation (EIP-1167/Solady clone target). ADAPTER
// CONSTANT: on the Hyde own-stack this becomes HydeTokenFactory's implementation.
export const LAUNCH_IMPL = "3be8b97fd0e713b5abe0649fa830223b6b4bc599";

/** SINGLE SOURCE OF TRUTH for EIP-1167 impl resolution (kami's direction): read
 *  the minimal-proxy implementation from ONCHAIN BYTECODE. getCode only — no
 *  scans, no Blockscout dependency. Returns undefined for EOAs / non-clones.
 *  Used by fetchLaunchToken, isHydeLaunch AND useVerifiedStatus — one regex. */
export async function getLaunchImplementation(address: `0x${string}`): Promise<`0x${string}` | undefined> {
  const code = await client.getCode({ address }).catch(() => undefined);
  const m = code?.match(/363d73([0-9a-fA-F]{40})5af4/);
  return m ? (`0x${m[1].toLowerCase()}` as `0x${string}`) : undefined;
}

/** Read ONE launch by address — ADAPTER BOUNDARY. All Doppler-specific reads live
 *  here; on own-stack this swaps to Hyde-contract reads. Returns null when the
 *  address is NOT a launch (honest not-found). No block-0 scans — just getCode +
 *  a metadata multicall; graduation is inferred from the DEXScreener pair client-side. */
export async function fetchLaunchToken(address: `0x${string}`): Promise<DopplerPool | null> {
  // confirm it's a launch: minimal-proxy clone of the known token implementation
  if ((await getLaunchImplementation(address)) !== `0x${LAUNCH_IMPL}`) return null;

  const meta = await client.multicall({
    contracts: [
      { address, abi: ERC20_META_ABI, functionName: "name" } as const,
      { address, abi: ERC20_META_ABI, functionName: "symbol" } as const,
    ],
  });
  const name = meta[0].result as string | undefined;
  const symbol = meta[1].result as string | undefined;
  if (!name || !symbol) return null;

  return {
    address, chainId: ROBINHOOD_CHAIN_ID,
    baseToken: { address, name, symbol, decimals: 18 },
    quoteToken: { address: ROBINHOOD_MAINNET.weth, name: "Wrapped Ether", symbol: "WETH", decimals: 18 },
    launchEngine: "v4-hook",
    // type refined by the Token page from the DEXScreener pair (has pool = graduated)
    type: "v4", dollarLiquidity: null, volumeUsd: null, marketCapUsd: null, priceUsd: null,
    createdAt: new Date(0).toISOString(), // exact create time is unindexed; omitted honestly
    progress: null, // precise % only for board (newest-page) tokens; honest null here
  };
}

/** Cheap check: is this address a Hyde launch token (minimal-proxy clone of the
 *  canonical implementation)? getCode only — no scans. Used to filter holdings. */
export async function isHydeLaunch(address: `0x${string}`): Promise<boolean> {
  return (await getLaunchImplementation(address)) === `0x${LAUNCH_IMPL}`;
}

/** AUTHORITATIVE 4663 own-stack membership (kami 23886): the token was minted through OUR WETH factory
 *  (`LaunchCreated`) or the HOODIE engine (`HoodieLaunchCreated`) — event attribution, NOT a clone-bytecode
 *  guess. The old `isHydeLaunch` clone check both admitted the $HOODIE base asset and MISSED HOODIE-engine
 *  launches (e.g. LILHOODIE), showing wrong Profile holdings. This admits engine launches and explicitly
 *  excludes the $HOODIE / WETH base numeraires. Bounded from each contract's deploy block. */
export async function isMainnetOwnStackLaunch(address: `0x${string}`): Promise<boolean> {
  const a = address.toLowerCase();
  // Base numeraire assets are never a "launch you hold" — exclude fast, before any log query.
  if (a === MAINNET_HOODIE.toLowerCase() || a === ROBINHOOD_MAINNET.weth.toLowerCase()) return false;
  const cached = readMainnetLaunchCache(MAINNET_LAUNCH_CACHE_MAX_STALE);
  if (cached?.pools.some((pool) => pool.address.toLowerCase() === a)) return true;
  const indexed = await fetchIndexedLegacyToken(ROBINHOOD_CHAIN_ID, address);
  if (indexed) return true;
  const tokenTopic = topicForAddress(address);
  const [weth, hoodie] = await Promise.all([
    fetchExplorerLogs(MAINNET_WETH_FACTORY, LAUNCH_CREATED_TOPIC, MAINNET_WETH_FACTORY_BLOCK, { position: 1, value: tokenTopic }).catch(() => []),
    fetchExplorerLogs(MAINNET_HOODIE_ENGINE, HOODIE_LAUNCH_CREATED_TOPIC, MAINNET_HOODIE_ENGINE_BLOCK, { position: 3, value: tokenTopic }).catch(() => []),
  ]);
  return weth.length > 0 || hoodie.length > 0;
}

type StableLaunchLog = {
  args: {
    token: `0x${string}`;
    creator: `0x${string}`;
    pool: `0x${string}`;
    tokenId: bigint;
    liquidity: bigint;
  };
  blockNumber: bigint | null;
};

const STABLE_LAUNCH_CACHE_TTL_MS = 60_000;
let stableLaunchCache: { at: number; pools: DopplerPool[] } | null = null;
let stableLaunchInFlight: Promise<DopplerPool[]> | null = null;

/** Stable V3 launches from HydeV3Pad. Membership, metadata, and timestamps come directly from Stable;
 * market fields are accepted only from Stable-scoped Uniswap pairs returned by DEXScreener. */
async function loadStableV3Pools(): Promise<DopplerPool[]> {
  const indexed = await fetchIndexedLegacyPools(STABLE_CHAIN_ID);
  if (indexed) {
    const canonicalPairs = new Map(
      indexed
        .filter((pool) => !!pool.poolAddress)
        .map((pool) => [pool.address.toLowerCase(), pool.poolAddress!] as const),
    );
    const dex = await fetchLaunchMarketData(indexed, "stable", canonicalPairs);
    return indexed.map((pool) => {
      const data = dex.get(pool.address.toLowerCase());
      return data ? {
        ...pool,
        marketCapUsd: data.marketCapUsd,
        priceUsd: data.priceUsd,
        dollarLiquidity: data.liquidityUsd != null ? String(data.liquidityUsd) : pool.dollarLiquidity,
        volumeUsd: data.volumeUsd != null ? String(data.volumeUsd) : pool.volumeUsd,
      } : pool;
    });
  }
  const latest = await stableClient.getBlockNumber();
  const logs = await getStableLogs(
    (fromBlock, toBlock) => stableClient.getLogs({
      address: STABLE_V3_PAD,
      event: STABLE_V3_LAUNCH_CREATED,
      fromBlock,
      toBlock,
    }) as unknown as Promise<StableLaunchLog[]>,
    STABLE_V3_DEPLOY_BLOCK,
    latest,
  );
  const newest = logs.slice(-MAX_SHOWN).reverse();
  if (newest.length === 0) return [];

  const blockNumbers = [...new Set(newest.map((log) => log.blockNumber ?? STABLE_V3_DEPLOY_BLOCK))];
  const blocks = await Promise.all(blockNumbers.map((blockNumber) => stableClient.getBlock({ blockNumber })));
  const blockTimes = new Map(blocks.map((block) => [block.number, Number(block.timestamp)]));

  const rows = await Promise.all(newest.map(async (log): Promise<DopplerPool | null> => {
    const token = log.args.token;
    const [name, symbol] = await Promise.all([
      stableClient.readContract({ address: token, abi: ERC20_META_ABI, functionName: "name" }).catch(() => null),
      stableClient.readContract({ address: token, abi: ERC20_META_ABI, functionName: "symbol" }).catch(() => null),
    ]);
    if (!name || !symbol) return null;
    const timestamp = blockTimes.get(log.blockNumber ?? STABLE_V3_DEPLOY_BLOCK) ?? 0;
    return {
      address: token,
      chainId: STABLE_CHAIN_ID,
      poolAddress: log.args.pool,
      baseToken: { address: token, name, symbol, decimals: 18 },
      quoteToken: {
        address: stableV3.numeraire.address,
        name: "USDT0",
        symbol: "USDT0",
        decimals: stableV3.numeraire.decimals,
      },
      launchEngine: "v3-single-sided",
      type: "v3",
      dollarLiquidity: null,
      volumeUsd: null,
      marketCapUsd: null,
      priceUsd: null,
      createdAt: new Date(timestamp * 1000).toISOString(),
      progress: null,
      creator: log.args.creator,
      creatorClaimable: null,
    };
  }));

  const seen = new Set<string>();
  const deduped = rows.filter((pool): pool is DopplerPool => {
    if (!pool) return false;
    const key = pool.address.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const canonicalPairs = new Map(
    deduped
      .filter((pool) => !!pool.poolAddress)
      .map((pool) => [pool.address.toLowerCase(), pool.poolAddress!] as const),
  );
  const dex = await fetchLaunchMarketData(deduped, "stable", canonicalPairs);
  return deduped.map((pool) => {
    const data = dex.get(pool.address.toLowerCase());
    if (!data) return pool;
    return {
      ...pool,
      marketCapUsd: data.marketCapUsd,
      priceUsd: data.priceUsd,
      dollarLiquidity: data.liquidityUsd != null ? String(data.liquidityUsd) : pool.dollarLiquidity,
      volumeUsd: data.volumeUsd != null ? String(data.volumeUsd) : pool.volumeUsd,
    };
  });
}

async function fetchStableV3Pools(force = false): Promise<DopplerPool[]> {
  if (!force && stableLaunchCache && Date.now() - stableLaunchCache.at < STABLE_LAUNCH_CACHE_TTL_MS) {
    return stableLaunchCache.pools;
  }
  if (!force && stableLaunchInFlight) return stableLaunchInFlight;

  const request = loadStableV3Pools().then((pools) => {
    stableLaunchCache = { at: Date.now(), pools };
    return pools;
  });
  stableLaunchInFlight = request;
  try {
    return await request;
  } finally {
    if (stableLaunchInFlight === request) stableLaunchInFlight = null;
  }
}

/** Single Stable V3 launch read for the shared /token/:address detail page. Attribution comes from the
 * locker's factory-only position registry, which is both authoritative and a constant-time direct read.
 * This avoids scanning every 500-block log window before a token page can expose its live swap. */
async function fetchStableV3LaunchToken(address: `0x${string}`): Promise<DopplerPool | null> {
  const cached = stableLaunchCache?.pools.find(
    (pool) => pool.address.toLowerCase() === address.toLowerCase(),
  );
  if (cached) return cached;
  const indexed = await fetchIndexedLegacyToken(STABLE_CHAIN_ID, address);
  if (indexed) return indexed;

  const position = await stableClient.readContract({
    address: STABLE_V3_LOCKER,
    abi: STABLE_V3_POSITION_ABI,
    functionName: "positionOf",
    args: [address],
  }).catch(() => null);
  if (!position) return null;
  const [creator, token0, token1, positionNumeraire, , feeTier, , , registered] = position;
  const tokenLower = address.toLowerCase();
  const numeraireLower = stableV3.numeraire.address.toLowerCase();
  const pairMatches =
    (token0.toLowerCase() === tokenLower && token1.toLowerCase() === numeraireLower)
    || (token1.toLowerCase() === tokenLower && token0.toLowerCase() === numeraireLower);
  if (
    !registered
    || !pairMatches
    || positionNumeraire.toLowerCase() !== numeraireLower
    || Number(feeTier) !== stableV3.feeTier
  ) return null;

  const [name, symbol, poolAddress] = await Promise.all([
    stableClient.readContract({ address, abi: ERC20_META_ABI, functionName: "name" }).catch(() => null),
    stableClient.readContract({ address, abi: ERC20_META_ABI, functionName: "symbol" }).catch(() => null),
    stableClient.readContract({
      address: stableV3.v3Factory as `0x${string}`,
      abi: STABLE_V3_FACTORY_ABI,
      functionName: "getPool",
      args: [address, stableV3.numeraire.address as `0x${string}`, stableV3.feeTier],
    }).catch(() => null),
  ]);
  if (!name || !symbol || !poolAddress || /^0x0{40}$/i.test(poolAddress)) return null;

  const pool: DopplerPool = {
    address,
    chainId: STABLE_CHAIN_ID,
    poolAddress,
    baseToken: { address, name, symbol, decimals: 18 },
    quoteToken: {
      address: stableV3.numeraire.address,
      name: "USDT0",
      symbol: "USDT0",
      decimals: stableV3.numeraire.decimals,
    },
    launchEngine: "v3-single-sided",
    type: "v3",
    dollarLiquidity: null,
    volumeUsd: null,
    marketCapUsd: null,
    priceUsd: null,
    // The direct position registry intentionally avoids a history scan. Unknown time is omitted by
    // timeAgo() rather than fabricated; the board still carries the exact launch-block timestamp.
    createdAt: new Date(0).toISOString(),
    progress: null,
    creator,
    creatorClaimable: null,
  };
  const data = (await fetchLaunchMarketData(
    [pool],
    "stable",
    new Map([[address.toLowerCase(), poolAddress]]),
  )).get(address.toLowerCase());
  return data ? {
    ...pool,
    marketCapUsd: data.marketCapUsd,
    priceUsd: data.priceUsd,
    dollarLiquidity: data.liquidityUsd != null ? String(data.liquidityUsd) : pool.dollarLiquidity,
    volumeUsd: data.volumeUsd != null ? String(data.volumeUsd) : pool.volumeUsd,
  } : pool;
}

/** Single-token read for launches outside the board page. Network-aware: mainnet reads the two live
 *  own-stack launch sources; testnet reads its own factory. Fails to null (honest not-found). */
export function useHydeToken(address?: string, chainId: number = ROBINHOOD_CHAIN_ID, enabled = true): {
  pool: DopplerPool | null;
  loading: boolean;
  error: string | null;
} {
  const [pool, setPool] = useState<DopplerPool | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled || !address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
      setPool(null);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setPool(null); // drop the prior token immediately on address/chain change (kami A-blocker #3)
    setLoading(true);
    setError(null);
    const legacyFetcher =
      chainId === RH_TESTNET_ID
        ? fetchTestnetLaunchToken
        : chainId === ROBINHOOD_CHAIN_ID
          ? fetchMainnetLaunchToken
          : chainId === ARBITRUM_CHAIN_ID
            ? fetchArbitrumLaunchToken
          : chainId === STABLE_CHAIN_ID
            ? fetchStableV3LaunchToken
            : null;
    const fetcher = isTrenchV5Configured(chainId)
      ? async (token: `0x${string}`) => (
          await fetchTrenchV5Token(chainId, token).catch(() => null)
        ) ?? (legacyFetcher ? legacyFetcher(token) : null)
      : legacyFetcher;
    if (!fetcher) {
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }
    fetcher(address as `0x${string}`)
      .then((p) => { if (!cancelled) setPool(p); })
      .catch(() => {
        if (!cancelled) {
          setPool(null);
          setError("Token data source unavailable");
        }
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [address, chainId, enabled]);
  return { pool, loading, error };
}

/* ─── Testnet OWN-STACK (46630) — reads OUR HydeTokenFactory, not Doppler ───────────────
 * The launchpad is network-aware: on Robinhood Testnet the board enumerates launches from our
 * live-deployed factory's `LaunchCreated` events (our own contracts) instead of the Doppler Airlock.
 * DEXScreener/GeckoTerminal don't index 46630 testnet → MCAP/liquidity stay null (honest "not
 * indexed"); the real on-chain curve % still reads. Config-enforced boundary: only a network whose
 * `factory` is set reads own-stack data (mainnet's is unset → own-stack tiles stay "coming"). */
export const RH_TESTNET_ID = 46630;
const HYDE_TESTNET_FACTORY = ROBINHOOD_TESTNET.factory as `0x${string}`;
// Factory CREATION block on 46630 for the 0.0004-ETH factory (deploy tx 0x0e58fc6f…, block 91418522).
// Safe lower bound that bounds every LaunchCreated scan (never getLogs from block 0). Updated in
// lockstep with ROBINHOOD_TESTNET.factory + api/_ownstack.js at the ETH-fee redeploy.
const HYDE_TESTNET_FACTORY_DEPLOY_BLOCK = 91418522n;
const LAUNCH_CREATED = parseAbiItem(
  "event LaunchCreated(address indexed token, address indexed creator, bytes32 indexed poolId, uint256 tokenId, uint256 presetId)"
);
const rhTestnetChain = defineChain({
  id: RH_TESTNET_ID,
  name: "Robinhood Testnet",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: rpcUrlsForNetwork(ROBINHOOD_TESTNET) } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});
const testnetClient = createPublicClient({ chain: rhTestnetChain, transport: rpcTransportForNetwork(ROBINHOOD_TESTNET) });

type LaunchLog = {
  args: { token: `0x${string}`; creator: `0x${string}`; poolId?: `0x${string}` };
  blockNumber: bigint | null;
};
type OwnStackSource = {
  chainId: number;
  network: typeof ROBINHOOD_TESTNET | typeof ARBITRUM_MAINNET;
  client: PublicClient;
  factory: `0x${string}`;
  vault: `0x${string}`;
  poolManager: `0x${string}`;
  deploymentBlock: bigint;
};

const TESTNET_OWN_STACK: OwnStackSource = {
  chainId: RH_TESTNET_ID,
  network: ROBINHOOD_TESTNET,
  client: testnetClient,
  factory: HYDE_TESTNET_FACTORY,
  vault: ROBINHOOD_TESTNET_VAULT,
  poolManager: POOL_MANAGER,
  deploymentBlock: HYDE_TESTNET_FACTORY_DEPLOY_BLOCK,
};

const ARBITRUM_CHAIN_ID = ARBITRUM_MAINNET.id;
const arbitrumV4 = V4_CONTRACTS_BY_CHAIN[ARBITRUM_CHAIN_ID];
const arbitrumChain = defineChain({
  id: ARBITRUM_CHAIN_ID,
  name: ARBITRUM_MAINNET.name,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: rpcUrlsForNetwork(ARBITRUM_MAINNET) } },
  blockExplorers: { default: { name: "Arbiscan", url: ARBITRUM_MAINNET.explorerUrl } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});
const arbitrumClient = createPublicClient({
  chain: arbitrumChain,
  transport: rpcTransportForNetwork(ARBITRUM_MAINNET),
});
const ARBITRUM_OWN_STACK: OwnStackSource = {
  chainId: ARBITRUM_CHAIN_ID,
  network: ARBITRUM_MAINNET,
  client: arbitrumClient,
  factory: arbitrumV4.hydeTokenFactory as `0x${string}`,
  vault: arbitrumV4.hydeFeeVault as `0x${string}`,
  poolManager: arbitrumV4.poolManager,
  deploymentBlock: arbitrumV4.hydeDeploymentBlock ?? 488965908n,
};

/** Own-stack launches on 46630 — from `LaunchCreated` off our factory. Same enrichment shape as the
 *  Doppler board (name/symbol/curve %), minus third-party price data (testnet isn't indexed → null). */
async function fetchOwnStackFactoryPools(source: OwnStackSource): Promise<DopplerPool[]> {
  const latest = await source.client.getBlockNumber();
  const collected: LaunchLog[] = [];
  let toB = latest;
  // The own-stack factory is recently deployed → all launches are in recent blocks. Bounded scan
  // (not the mainnet 80-chunk walk): stop once we've found launches and then hit an older empty chunk,
  // hard-capped at 20 chunks so a near-empty testnet resolves fast (no 80-chunk timeout).
  for (let guard = 0; guard < 20 && collected.length < MAX_SHOWN && toB >= source.deploymentBlock; guard++) {
    const fromB = toB - source.deploymentBlock + 1n > RANGE
      ? toB - RANGE + 1n
      : source.deploymentBlock;
    const chunk = await source.client.getLogs({
      address: source.factory,
      event: LAUNCH_CREATED,
      fromBlock: fromB,
      toBlock: toB,
    });
    collected.unshift(...(chunk as unknown as LaunchLog[]));
    if (fromB === source.deploymentBlock) break;
    if (chunk.length === 0 && collected.length > 0) break; // passed the factory's active range
    toB = fromB - 1n;
  }
  const logs = collected.slice(-MAX_SHOWN).reverse();
  if (logs.length === 0) return [];
  const tokens = logs.map((l) => l.args.token);
  const createBlockOf = new Map(logs.map((l) => [l.args.token.toLowerCase(), l.blockNumber ?? 0n]));
  const fromB = logs.map((l) => l.blockNumber ?? latest).reduce((a, b) => (a < b ? a : b), latest);

  // curve baseline: tokens transferred INTO the PoolManager in each token's create block
  const seedTransfers = await getLogsChunked(
    (f, t) => source.client.getLogs({
      address: tokens,
      event: TRANSFER_EVENT,
      args: { to: source.poolManager },
      fromBlock: f,
      toBlock: t,
    }),
    fromB, latest
  );
  const initialCurve = new Map<string, bigint>();
  for (const t of seedTransfers) {
    const asset = t.address.toLowerCase();
    if ((t.blockNumber ?? 0n) !== createBlockOf.get(asset)) continue;
    initialCurve.set(asset, (initialCurve.get(asset) ?? 0n) + (t.args.value as bigint));
  }

  const meta = await source.client.multicall({
    contracts: tokens.flatMap((token) => [
      { address: token, abi: ERC20_META_ABI, functionName: "name" } as const,
      { address: token, abi: ERC20_META_ABI, functionName: "symbol" } as const,
      { address: token, abi: ERC20_META_ABI, functionName: "balanceOf", args: [source.poolManager] } as const,
    ]),
  });
  // Creator-claimable WETH per token from the fresh vault — ONE batched multicall (no per-render RPC
  // waterfall), fail-neutral: any read failure leaves that token's claimable null, never fabricated.
  const claimRes = await source.client.multicall({
    contracts: tokens.map((token) => ({
      address: source.vault, abi: hydeVaultAbi, functionName: "creatorClaimable", args: [token],
    } as const)),
  }).catch(() => null);
  const uniqueBlocks = [...new Set(logs.map((l) => l.blockNumber ?? 0n))];
  const blockTimes = new Map(
    (await Promise.all(uniqueBlocks.map((bn) => source.client.getBlock({ blockNumber: bn })))).map((b) => [b.number, Number(b.timestamp)])
  );

  const pools = logs.map((log, i): DopplerPool | null => {
    const token = log.args.token;
    const key = token.toLowerCase();
    const name = meta[i * 3].result as string | undefined;
    const symbol = meta[i * 3 + 1].result as string | undefined;
    const pmBalance = meta[i * 3 + 2].result as bigint | undefined;
    if (!name || !symbol) return null;
    const initial = initialCurve.get(key);
    let progress: number | null = null;
    if (initial && initial > 0n && pmBalance !== undefined) {
      const sold = initial > pmBalance ? initial - pmBalance : 0n;
      progress = Math.min(100, Number((sold * 10000n) / initial) / 100);
    }
    const ts = blockTimes.get(log.blockNumber ?? 0n);
    const claim = claimRes?.[i];
    return {
      address: token,
      chainId: source.chainId,
      poolId: log.args.poolId ?? null,
      baseToken: { address: token, name, symbol, decimals: 18 },
      quoteToken: { address: source.network.weth, name: "Wrapped Ether", symbol: "WETH", decimals: 18 },
      launchEngine: "v4-hook",
      type: "v4",
      dollarLiquidity: null,
      volumeUsd: null,
      marketCapUsd: null,
      priceUsd: null,
      createdAt: new Date((ts ?? 0) * 1000).toISOString(),
      progress,
      creator: log.args.creator as string,
      creatorClaimable: claim && claim.status === "success" ? (claim.result as bigint).toString() : null,
    };
  });
  const nonNull = pools.filter((p): p is DopplerPool => p !== null);
  const seen = new Set<string>();
  return nonNull.filter((p) => {
    const k = p.address.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Single own-stack (46630) launch read for /token/:address — reads name/symbol via the TESTNET
 *  client so a testnet token page never falls back to mainnet data (clint #4 cross-chain bleed).
 *  Testnet isn't third-party indexed → price/graduation stay null (honest). Fails to null. */
const fetchHydeFactoryPools = () => fetchOwnStackFactoryPools(TESTNET_OWN_STACK);
const fetchArbitrumFactoryPools = async () => (
  await fetchIndexedLegacyPools(ARBITRUM_CHAIN_ID)
) ?? fetchOwnStackFactoryPools(ARBITRUM_OWN_STACK);

async function fetchOwnStackLaunchToken(
  source: OwnStackSource,
  address: `0x${string}`,
): Promise<DopplerPool | null> {
  // Authoritative attribution (kami A-blocker #1): must be a token minted by OUR factory — proven by an
  // indexed LaunchCreated(token=address) event — NOT merely any 46630 ERC-20 that exposes name()/symbol().
  // Bounded from the factory deploy block (never fromBlock 0).
  const created = await source.client.getLogs({
    address: source.factory,
    event: LAUNCH_CREATED,
    args: { token: address },
    fromBlock: source.deploymentBlock,
    toBlock: "latest",
  }).catch(() => null);
  if (!created || created.length === 0) return null; // not a Hyde own-stack launch → honest not-found

  const meta = await source.client.multicall({
    contracts: [
      { address, abi: ERC20_META_ABI, functionName: "name" } as const,
      { address, abi: ERC20_META_ABI, functionName: "symbol" } as const,
    ],
  }).catch(() => null);
  const name = meta?.[0]?.result as string | undefined;
  const symbol = meta?.[1]?.result as string | undefined;
  if (!name || !symbol) return null;
  return {
    address, chainId: source.chainId,
    baseToken: { address, name, symbol, decimals: 18 },
    quoteToken: { address: source.network.weth, name: "Wrapped Ether", symbol: "WETH", decimals: 18 },
    launchEngine: "v4-hook",
    type: "v4", dollarLiquidity: null, volumeUsd: null, marketCapUsd: null, priceUsd: null,
    createdAt: new Date(0).toISOString(), // exact create time unindexed on the single-read path
    progress: null,
  };
}

/** Single-token read for /token/:address on 4663 — authoritative attribution: the address must have a
 *  `LaunchCreated` (WETH factory) OR `HoodieLaunchCreated` (HOODIE engine) event, bounded from each
 *  deploy block. Mirrors the testnet reader so a mainnet token page resolves OUR launches (not the
 *  old Doppler clone-impl check). Fails to null (honest not-found); the page refines graduation/price. */
export const fetchTestnetLaunchToken = (address: `0x${string}`) =>
  fetchOwnStackLaunchToken(TESTNET_OWN_STACK, address);
export const fetchArbitrumLaunchToken = (address: `0x${string}`) =>
  fetchIndexedLegacyToken(ARBITRUM_CHAIN_ID, address)
    .then((indexed) => indexed ?? fetchOwnStackLaunchToken(ARBITRUM_OWN_STACK, address));

async function fetchMainnetLaunchToken(address: `0x${string}`): Promise<DopplerPool | null> {
  const boardPool = (await fetchMainnetOwnStackPools().catch(() => []))
    .find((pool) => pool.address.toLowerCase() === address.toLowerCase());
  if (boardPool) return boardPool;
  const indexed = await fetchIndexedLegacyToken(ROBINHOOD_CHAIN_ID, address);
  if (indexed) return indexed;

  const tokenTopic = topicForAddress(address);
  const [wethCreated, hoodieCreated] = await Promise.all([
    fetchExplorerLogs(MAINNET_WETH_FACTORY, LAUNCH_CREATED_TOPIC, MAINNET_WETH_FACTORY_BLOCK, { position: 1, value: tokenTopic }),
    fetchExplorerLogs(MAINNET_HOODIE_ENGINE, HOODIE_LAUNCH_CREATED_TOPIC, MAINNET_HOODIE_ENGINE_BLOCK, { position: 3, value: tokenTopic }),
  ]);
  if (wethCreated.length === 0 && hoodieCreated.length === 0) return null; // not one of our launches
  const isHoodiePair = hoodieCreated.length > 0;
  const event = (isHoodiePair ? hoodieCreated : wethCreated)[0];
  const meta = await fetchExplorerToken(address);
  const timestamp = event?.timeStamp ? explorerInteger(event.timeStamp) : 0;
  const poolId = isHoodiePair
    ? (/^0x[0-9a-fA-F]{64}/.test(event?.data ?? "") ? event.data.slice(0, 66) : null)
    : (event?.topics[3] && /^0x[0-9a-fA-F]{64}$/.test(event.topics[3]) ? event.topics[3] : null);

  return {
    address,
    chainId: ROBINHOOD_CHAIN_ID,
    poolId,
    baseToken: {
      address,
      name: meta.name!,
      symbol: meta.symbol!,
      decimals: meta.decimals ? Number(meta.decimals) : 18,
    },
    // HOODIE-paired launches quote in $HOODIE; WETH launches quote in WETH.
    quoteToken: isHoodiePair
      ? { address: MAINNET_HOODIE, name: "Hoodie", symbol: "HOODIE", decimals: 18 }
      : { address: ROBINHOOD_MAINNET.weth, name: "Wrapped Ether", symbol: "WETH", decimals: 18 },
    launchEngine: "v4-hook",
    type: "v4",
    dollarLiquidity: null,
    volumeUsd: null,
    marketCapUsd: null,
    priceUsd: null,
    createdAt: new Date(timestamp * 1000).toISOString(),
    progress: null,
  };
}

/** 4663 mainnet own-stack board — unions our WETH factory `LaunchCreated` + the HOODIE engine's
 *  `HoodieLaunchCreated`; NO Doppler Airlock (clint: "only our stack"). Bounded from each contract's
 *  deploy block. Same enrichment as the Doppler board (curve % + DEXScreener MCAP/price on graduated
 *  tokens), so only tokens minted through OUR factories ever surface. */
async function loadMainnetOwnStackPoolsDirect(): Promise<DopplerPool[]> {
  // Blockscout's indexed REST API is browser-safe. Robinhood's public JSON-RPC currently emits
  // duplicate Access-Control-Allow-Origin headers, so using it directly in the SPA fails CORS and
  // previously collapsed the board/Stats into a false zero state.
  const wethLogs = await fetchExplorerLogs(MAINNET_WETH_FACTORY, LAUNCH_CREATED_TOPIC, MAINNET_WETH_FACTORY_BLOCK);
  const hoodieLogs = await fetchExplorerLogs(MAINNET_HOODIE_ENGINE, HOODIE_LAUNCH_CREATED_TOPIC, MAINNET_HOODIE_ENGINE_BLOCK);

  type ExplorerLaunch = {
    token: `0x${string}`;
    creator: `0x${string}` | null;
    poolId: string | null;
    block: number;
    timestamp: number;
    isHoodiePair: boolean;
  };
  const rows: ExplorerLaunch[] = [
    ...wethLogs.map((log) => ({
      token: topicAddress(log.topics[1]),
      creator: topicAddress(log.topics[2]),
      poolId: log.topics[3] && /^0x[0-9a-fA-F]{64}$/.test(log.topics[3]) ? log.topics[3] : null,
      block: explorerInteger(log.blockNumber),
      timestamp: explorerInteger(log.timeStamp),
      isHoodiePair: false,
    })),
    ...hoodieLogs.map((log) => ({
      token: topicAddress(log.topics[3]),
      creator: topicAddress(log.topics[2]),
      poolId: /^0x[0-9a-fA-F]{64}/.test(log.data) ? log.data.slice(0, 66) : null,
      block: explorerInteger(log.blockNumber),
      timestamp: explorerInteger(log.timeStamp),
      isHoodiePair: true,
    })),
  ]
    .filter((row): row is ExplorerLaunch => row.token !== null)
    .sort((a, b) => b.block - a.block)
    .slice(0, MAX_SHOWN);

  const enriched: DopplerPool[] = [];
  for (let i = 0; i < rows.length; i += 5) {
    const batch = rows.slice(i, i + 5);
    const metadata = await Promise.all(batch.map((row) => fetchExplorerToken(row.token)));
    for (let j = 0; j < batch.length; j += 1) {
      const row = batch[j];
      const meta = metadata[j];
      enriched.push({
        address: row.token,
        chainId: ROBINHOOD_CHAIN_ID,
        poolId: row.poolId,
        baseToken: {
          address: row.token,
          name: meta.name!,
          symbol: meta.symbol!,
          decimals: meta.decimals ? Number(meta.decimals) : 18,
        },
        quoteToken: row.isHoodiePair
          ? { address: MAINNET_HOODIE, name: "Hoodie", symbol: "HOODIE", decimals: 18 }
          : { address: ROBINHOOD_MAINNET.weth, name: "Wrapped Ether", symbol: "WETH", decimals: 18 },
        launchEngine: "v4-hook",
        type: "v4",
        dollarLiquidity: null,
        volumeUsd: null,
        marketCapUsd: null,
        priceUsd: null,
        createdAt: new Date(row.timestamp * 1000).toISOString(),
        // Blockscout establishes launch membership + metadata. Curve progress remains unknown until
        // a browser-safe indexed balance series is available; null is intentional, never fabricated.
        progress: null,
        creator: row.creator ?? undefined,
        creatorClaimable: null,
      });
    }
  }

  const seen = new Set<string>();
  const deduped = enriched.filter((p) => {
    const key = p.address.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const dex = await fetchLaunchMarketData(deduped);
  return deduped.map((p) => {
    const d = dex.get(p.address.toLowerCase());
    if (!d) return p;
    return { ...p, marketCapUsd: d.marketCapUsd, priceUsd: d.priceUsd, dollarLiquidity: d.liquidityUsd != null ? String(d.liquidityUsd) : p.dollarLiquidity, volumeUsd: d.volumeUsd != null ? String(d.volumeUsd) : p.volumeUsd };
  });
}

const MAINNET_LAUNCH_CACHE_KEY = "hyde_mainnet_launches_v3";
const MAINNET_LAUNCH_CACHE_TTL = 5 * 60 * 1000;
const MAINNET_LAUNCH_CACHE_MAX_STALE = 24 * 60 * 60 * 1000;
let mainnetLaunchMemoryCache: { at: number; pools: DopplerPool[] } | null = null;
let mainnetLaunchInFlight: Promise<DopplerPool[]> | null = null;

function readMainnetLaunchCache(maxAge = MAINNET_LAUNCH_CACHE_TTL): { at: number; pools: DopplerPool[] } | null {
  if (mainnetLaunchMemoryCache && Date.now() - mainnetLaunchMemoryCache.at < maxAge) {
    return mainnetLaunchMemoryCache;
  }
  try {
    const raw = localStorage.getItem(MAINNET_LAUNCH_CACHE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw) as { at?: number; pools?: DopplerPool[] };
    if (
      typeof cached.at !== "number"
      || !Array.isArray(cached.pools)
      || Date.now() - cached.at >= maxAge
    ) return null;
    mainnetLaunchMemoryCache = { at: cached.at, pools: cached.pools };
    return mainnetLaunchMemoryCache;
  } catch {
    return null;
  }
}

function isRobinhoodIndexPool(value: unknown): value is DopplerPool {
  const pool = value as Partial<DopplerPool>;
  return (
    pool?.chainId === ROBINHOOD_CHAIN_ID
    && pool?.launchEngine === "v4-hook"
    && typeof pool.address === "string"
    && /^0x[0-9a-fA-F]{40}$/.test(pool.address)
    && typeof pool.baseToken?.name === "string"
    && typeof pool.baseToken?.symbol === "string"
    && typeof pool.baseToken?.decimals === "number"
    && typeof pool.quoteToken?.address === "string"
    && [MAINNET_HOODIE.toLowerCase(), ROBINHOOD_MAINNET.weth.toLowerCase()]
      .includes(pool.quoteToken.address.toLowerCase())
  );
}

async function loadMainnetOwnStackPools(): Promise<DopplerPool[]> {
  const indexed = await fetchIndexedLegacyPools(ROBINHOOD_CHAIN_ID);
  if (indexed) {
    const dex = await fetchLaunchMarketData(indexed);
    return indexed.map((pool) => {
      const data = dex.get(pool.address.toLowerCase());
      return data ? {
        ...pool,
        marketCapUsd: data.marketCapUsd,
        priceUsd: data.priceUsd,
        dollarLiquidity: data.liquidityUsd != null ? String(data.liquidityUsd) : pool.dollarLiquidity,
        volumeUsd: data.volumeUsd != null ? String(data.volumeUsd) : pool.volumeUsd,
      } : pool;
    });
  }
  try {
    const response = await fetch("/api/robinhood-launches");
    if (!response.ok) throw new Error(`launch index HTTP ${response.status}`);
    const payload = await response.json() as { pools?: unknown[] };
    if (!Array.isArray(payload.pools)) throw new Error("launch index payload is malformed");
    const pools = payload.pools.filter(isRobinhoodIndexPool);
    if (pools.length !== payload.pools.length) throw new Error("launch index contains an invalid pool");
    const dex = await fetchLaunchMarketData(pools);
    return pools.map((pool) => {
      const data = dex.get(pool.address.toLowerCase());
      if (!data) return pool;
      return {
        ...pool,
        marketCapUsd: data.marketCapUsd,
        priceUsd: data.priceUsd,
        dollarLiquidity: data.liquidityUsd != null ? String(data.liquidityUsd) : pool.dollarLiquidity,
        volumeUsd: data.volumeUsd != null ? String(data.volumeUsd) : pool.volumeUsd,
      };
    });
  } catch {
    // Local Vite has no serverless route, and a cold CDN refresh may still fail upstream. Preserve the
    // direct Blockscout reader as a fallback; the stale cache below prevents a false empty board.
    return loadMainnetOwnStackPoolsDirect();
  }
}

async function fetchMainnetOwnStackPools(force = false): Promise<DopplerPool[]> {
  const stale = readMainnetLaunchCache(MAINNET_LAUNCH_CACHE_MAX_STALE);
  if (!force) {
    const cached = readMainnetLaunchCache();
    if (cached) return cached.pools;
    if (mainnetLaunchInFlight) return mainnetLaunchInFlight;
  }

  const request = loadMainnetOwnStackPools()
    .then((pools) => {
      const cached = { at: Date.now(), pools };
      mainnetLaunchMemoryCache = cached;
      try {
        localStorage.setItem(MAINNET_LAUNCH_CACHE_KEY, JSON.stringify(cached));
      } catch {
        /* storage unavailable; memory cache still prevents duplicate reads */
      }
      return pools;
    })
    .catch((error) => {
      if (stale) return stale.pools;
      throw error;
    });
  mainnetLaunchInFlight = request;
  try {
    return await request;
  } finally {
    if (mainnetLaunchInFlight === request) mainnetLaunchInFlight = null;
  }
}

/** Full pool objects for the Launchpad explore tab and trending carousel. Network-aware: Robinhood
 *  Testnet + mainnet both read our own-stack factories (mainnet = WETH factory + HOODIE engine). */
export function useHydeLaunches(chainId: number = ROBINHOOD_CHAIN_ID): {
  pools: DopplerPool[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
} {
  const [pools, setPools] = useState<DopplerPool[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refetch = () => setTick((t) => t + 1);

  useEffect(() => {
    let cancelled = false;
    setPools([]); // drop prior-chain launches immediately on a chain switch (kami A-blocker #3)
    setLoading(true);
    setError(null);

    // Only chains with a live Hyde deployment have launches. Unknown chains return empty instead of
    // falling back to Robinhood data (which would leak launches across chain contexts).
    const legacyFetcher =
      chainId === RH_TESTNET_ID
        ? fetchHydeFactoryPools
        : chainId === ROBINHOOD_CHAIN_ID
          ? () => fetchMainnetOwnStackPools(tick > 0)
          : chainId === ARBITRUM_CHAIN_ID
            ? fetchArbitrumFactoryPools
          : chainId === STABLE_CHAIN_ID
            ? () => fetchStableV3Pools(tick > 0)
          : null;
    const fetcher = legacyFetcher || isTrenchV5Configured(chainId)
      ? async () => {
          const [legacyResult, v5Result] = await Promise.allSettled([
            legacyFetcher ? legacyFetcher() : Promise.resolve([]),
            isTrenchV5Configured(chainId) ? fetchTrenchV5Pools(chainId) : Promise.resolve([]),
          ]);
          const legacy = legacyResult.status === "fulfilled" ? legacyResult.value : [];
          const v5 = v5Result.status === "fulfilled" ? v5Result.value : [];
          if (legacyResult.status === "rejected" && v5Result.status === "rejected") {
            throw v5Result.reason ?? legacyResult.reason;
          }
          const seen = new Set<string>();
          return [...v5, ...legacy].filter((pool) => {
            const key = pool.address.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
        }
      : null;
    if (!fetcher) {
      setPools([]);
      setLoading(false);
      setError(null);
      return () => {
        cancelled = true;
      };
    }
    fetcher()
      .then((items) => {
        if (!cancelled) setPools(items);
      })
      .catch((cause) => {
        if (!cancelled) {
          console.error(`[Hydeout] launch source failed on chain ${chainId}`, cause);
          setPools([]);
          setError("Launch data source unavailable");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [tick, chainId]);

  return { pools, loading, error, refetch };
}

/* ─── Platform stats (transparency page) ──────────────────────────────────────
 * Total UNIQUE tokens launched (dedup by asset — the Airlock emits several Create
 * logs per launch) + graduated count. Blockscout has no one-call filtered event
 * count, so this is a REAL on-chain scan; it's cached (localStorage, 10-min TTL)
 * and run in the background behind an honest "indexing" state — never a placeholder.
 * The clean long-term source is a stats indexer/cron; this is the honest client fallback. */
const STATS_CACHE_KEY = "hyde_stats_v1";
const STATS_TTL_MS = 10 * 60 * 1000;
type HydeStatsCache = { totalLaunched: number; graduated: number; at: number };

function readStatsCache(): HydeStatsCache | null {
  try {
    const raw = localStorage.getItem(STATS_CACHE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as HydeStatsCache;
    return typeof v?.totalLaunched === "number" && typeof v?.at === "number" ? v : null;
  } catch {
    return null;
  }
}

async function scanHydeStats(): Promise<{ totalLaunched: number; graduated: number }> {
  const latest = await client.getBlockNumber();
  const uniq = new Set<string>(); // unique launch tokens (dedup by asset address)
  let graduated = 0;
  for (let to = latest; to > 0n; to -= RANGE) {
    const from = to > RANGE ? to - RANGE + 1n : 0n;
    const [cLogs, mLogs] = await Promise.all([
      client.getLogs({ address: AIRLOCK, event: CREATE_EVENT, fromBlock: from, toBlock: to }),
      client.getLogs({ address: AIRLOCK, event: MIGRATE_EVENT, fromBlock: from, toBlock: to }),
    ]);
    for (const l of cLogs) {
      const a = (l.args as { asset?: string }).asset;
      if (a) uniq.add(a.toLowerCase());
    }
    graduated += mLogs.length;
    if (from === 0n) break;
  }
  return { totalLaunched: uniq.size, graduated };
}

/** Real platform-wide launch totals for the Stats page. Serves a cached value instantly and
 *  refreshes in the background; `loading` stays true (→ honest "indexing" state) until the first
 *  real scan resolves. Fail-neutral: an RPC error leaves the numbers null, never fabricated. */
export function useHydeStats(): {
  totalLaunched: number | null;
  graduated: number | null;
  updatedAt: number | null;
  loading: boolean;
} {
  const [s, setS] = useState(() => {
    const c = readStatsCache();
    return c
      ? { totalLaunched: c.totalLaunched, graduated: c.graduated, updatedAt: c.at, loading: Date.now() - c.at >= STATS_TTL_MS }
      : { totalLaunched: null as number | null, graduated: null as number | null, updatedAt: null as number | null, loading: true };
  });

  useEffect(() => {
    const c = readStatsCache();
    if (c && Date.now() - c.at < STATS_TTL_MS) return; // fresh cache — no rescan
    let cancelled = false;
    setS((p) => ({ ...p, loading: true }));
    scanHydeStats()
      .then((r) => {
        if (cancelled) return;
        const at = Date.now();
        try {
          localStorage.setItem(STATS_CACHE_KEY, JSON.stringify({ ...r, at }));
        } catch {
          /* ignore storage quota */
        }
        setS({ totalLaunched: r.totalLaunched, graduated: r.graduated, updatedAt: at, loading: false });
      })
      .catch(() => {
        if (!cancelled) setS((p) => ({ ...p, loading: false })); // honest: stays null → "indexing"
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return s;
}
