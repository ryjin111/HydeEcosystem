import { useEffect, useState } from "react";
import { createPublicClient, http, defineChain, parseAbiItem } from "viem";
import type { TokenInfo } from "../utils/constants";
import { ROBINHOOD_MAINNET, DOPPLER_CONTRACTS_BY_CHAIN } from "../utils/constants";
import type { DopplerPool } from "../utils/dopplerConfig";

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

// Dedicated client: launches must load even before a wallet connects.
const robinhoodChain = defineChain({
  id: ROBINHOOD_CHAIN_ID,
  name: ROBINHOOD_MAINNET.name,
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [ROBINHOOD_MAINNET.rpcUrl] } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});
const client = createPublicClient({ chain: robinhoodChain, transport: http() });

// Bounded scan: with thousands of launches, block-0 / all-asset getLogs times
// out in the browser. Scan the NEWEST launches backwards in fixed block chunks,
// then enrich only that page — all queries bounded. `MAX_SHOWN` caps the board
// page (newest first); older launches load via pagination later (not silently
// dropped — the count reflects the page, and there's a documented cap here).
const RANGE = 100_000n;   // blocks per getLogs (public-RPC-safe)
const MAX_SHOWN = 60;     // newest launches enriched per board load

// chunked getLogs over bounded ranges; the call factory keeps viem's typed logs
async function getLogsChunked<E>(call: (from: bigint, to: bigint) => Promise<E[]>, fromBlock: bigint, toBlock: bigint): Promise<E[]> {
  const out: E[] = [];
  for (let s = fromBlock; s <= toBlock; s += RANGE) {
    const e = s + RANGE - 1n > toBlock ? toBlock : s + RANGE - 1n;
    out.push(...(await call(s, e)));
  }
  return out;
}

type CreateLog = { args: { asset: `0x${string}` }; blockNumber: bigint | null };
const blockOf = (l: CreateLog): bigint => l.blockNumber ?? 0n;

async function fetchHydePools(): Promise<DopplerPool[]> {
  const latest = await client.getBlockNumber();

  // walk backwards from `latest` in RANGE chunks until we have MAX_SHOWN creates
  const collected: CreateLog[] = [];
  let toB = latest;
  for (let guard = 0; guard < 80 && collected.length < MAX_SHOWN && toB > 0n; guard++) {
    const fromB = toB > RANGE ? toB - RANGE + 1n : 0n;
    const chunk = await client.getLogs({ address: AIRLOCK, event: CREATE_EVENT, fromBlock: fromB, toBlock: toB });
    collected.unshift(...(chunk as unknown as CreateLog[]));
    if (fromB === 0n) break;
    toB = fromB - 1n;
  }

  // newest first, capped to the page
  const logs = collected.slice(-MAX_SHOWN).reverse();
  if (logs.length === 0) return [];
  const assets = logs.map((l) => l.args.asset as `0x${string}`);
  const createBlockOf = new Map(logs.map((l) => [l.args.asset.toLowerCase(), blockOf(l)]));

  // enrichment range = only the block span this page covers (bounded)
  const fromB = logs.map(blockOf).reduce((a, b) => (a < b ? a : b), latest);

  // graduation status for this page (Migrate over the bounded span)
  const migrateLogs = await getLogsChunked((f, t) => client.getLogs({ address: AIRLOCK, event: MIGRATE_EVENT, fromBlock: f, toBlock: t }), fromB, latest);
  const graduated = new Set(migrateLogs.map((l) => (l.args.asset as string).toLowerCase()));

  // Curve baseline: tokens transferred INTO the PoolManager in each asset's
  // create block. Bounded to this page's asset set + block span (not block-0,
  // not all 2600+ assets), so it stays a small browser-safe query.
  const seedTransfers = await getLogsChunked((f, t) => client.getLogs({ address: assets, event: TRANSFER_EVENT, args: { to: POOL_MANAGER }, fromBlock: f, toBlock: t }), fromB, latest);
  const initialCurve = new Map<string, bigint>();
  for (const t of seedTransfers) {
    const asset = t.address.toLowerCase();
    if ((t.blockNumber ?? 0n) !== createBlockOf.get(asset)) continue;
    initialCurve.set(asset, (initialCurve.get(asset) ?? 0n) + (t.args.value as bigint));
  }

  // Metadata + live inventory in one multicall batch.
  const meta = await client.multicall({
    contracts: assets.flatMap((asset) => [
      { address: asset, abi: ERC20_META_ABI, functionName: "name" } as const,
      { address: asset, abi: ERC20_META_ABI, functionName: "symbol" } as const,
      { address: asset, abi: ERC20_META_ABI, functionName: "balanceOf", args: [POOL_MANAGER] } as const,
    ]),
  });

  // Block timestamps, deduped.
  const uniqueBlocks = [...new Set(logs.map(blockOf))];
  const blockTimes = new Map(
    (await Promise.all(uniqueBlocks.map((bn) => client.getBlock({ blockNumber: bn }))))
      .map((b) => [b.number, Number(b.timestamp)])
  );

  const pools = logs.map((log, i): DopplerPool | null => {
    const asset = log.args.asset as `0x${string}`;
    const key = asset.toLowerCase();
    const name = meta[i * 3].result as string | undefined;
    const symbol = meta[i * 3 + 1].result as string | undefined;
    const pmBalance = meta[i * 3 + 2].result as bigint | undefined;
    if (!name || !symbol) return null; // unreadable token — skip rather than crash the board

    const isGraduated = graduated.has(key);
    const initial = initialCurve.get(key);
    let progress: number | null = null;
    if (isGraduated) {
      progress = 100;
    } else if (initial && initial > 0n && pmBalance !== undefined) {
      const sold = initial > pmBalance ? initial - pmBalance : 0n;
      progress = Math.min(100, Number((sold * 10000n) / initial) / 100);
    }

    const ts = blockTimes.get(blockOf(log));
    return {
      address: asset,
      chainId: ROBINHOOD_CHAIN_ID,
      baseToken: { address: asset, name, symbol, decimals: 18 },
      quoteToken: {
        address: ROBINHOOD_MAINNET.weth,
        name: "Wrapped Ether",
        symbol: "WETH",
        decimals: 18,
      },
      // 'v4' = live on the launch curve (Auction badge), 'v2' = graduated
      type: isGraduated ? "v2" : "v4",
      dollarLiquidity: null,
      volumeUsd: null,
      createdAt: new Date((ts ?? 0) * 1000).toISOString(),
      progress,
    };
  });

  return pools.filter((p): p is DopplerPool => p !== null);
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
    if (chainId !== ROBINHOOD_CHAIN_ID) return;

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
const LAUNCH_IMPL = "3be8b97fd0e713b5abe0649fa830223b6b4bc599";

/** Read ONE launch by address — ADAPTER BOUNDARY. All Doppler-specific reads live
 *  here; on own-stack this swaps to Hyde-contract reads. Returns null when the
 *  address is NOT a launch (honest not-found). No block-0 scans — just getCode +
 *  a metadata multicall; graduation is inferred from the DEXScreener pair client-side. */
export async function fetchLaunchToken(address: `0x${string}`): Promise<DopplerPool | null> {
  // confirm it's a launch: minimal-proxy clone of the known token implementation
  const code = await client.getCode({ address }).catch(() => undefined);
  const m = code?.match(/363d73([0-9a-fA-F]{40})5af4/);
  if (!m || m[1].toLowerCase() !== LAUNCH_IMPL) return null;

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
    // type refined by the Token page from the DEXScreener pair (has pool = graduated)
    type: "v4", dollarLiquidity: null, volumeUsd: null,
    createdAt: new Date(0).toISOString(), // exact create time is unindexed; omitted honestly
    progress: null, // precise % only for board (newest-page) tokens; honest null here
  };
}

/** Cheap check: is this address a Hyde launch token (minimal-proxy clone of the
 *  canonical implementation)? getCode only — no scans. Used to filter holdings. */
export async function isHydeLaunch(address: `0x${string}`): Promise<boolean> {
  const code = await client.getCode({ address }).catch(() => undefined);
  const m = code?.match(/363d73([0-9a-fA-F]{40})5af4/);
  return !!m && m[1].toLowerCase() === LAUNCH_IMPL;
}

/** Single-token read for /token/:address — works for launches OUTSIDE the board
 *  page. Fails to null (honest not-found), never throws/blanks the page. */
export function useHydeToken(address?: string): { pool: DopplerPool | null; loading: boolean } {
  const [pool, setPool] = useState<DopplerPool | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    fetchLaunchToken(address as `0x${string}`)
      .then((p) => { if (!cancelled) setPool(p); })
      .catch(() => { if (!cancelled) setPool(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [address]);
  return { pool, loading };
}

/** Full pool objects for the Launchpad explore tab and trending carousel. */
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
