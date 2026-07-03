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

async function fetchHydePools(): Promise<DopplerPool[]> {
  const [createLogs, migrateLogs] = await Promise.all([
    client.getLogs({ address: AIRLOCK, event: CREATE_EVENT, fromBlock: 0n, toBlock: "latest" }),
    client.getLogs({ address: AIRLOCK, event: MIGRATE_EVENT, fromBlock: 0n, toBlock: "latest" }),
  ]);

  const graduated = new Set(migrateLogs.map((l) => (l.args.asset as string).toLowerCase()));

  // newest first
  const logs = [...createLogs].reverse();
  const assets = logs.map((l) => l.args.asset as `0x${string}`);
  const createBlockOf = new Map(logs.map((l) => [(l.args.asset as string).toLowerCase(), l.blockNumber]));

  // Curve baseline: tokens transferred INTO the PoolManager in each asset's
  // create block = the initial curve inventory. Exact even when a launch
  // pre-mints a creator allocation (the naive supply-minus-balance metric
  // would count that allocation as "sold"). One log query covers all assets;
  // the create-block filter drops later sell-side inflows.
  const seedTransfers = assets.length
    ? await client.getLogs({ address: assets, event: TRANSFER_EVENT, args: { to: POOL_MANAGER }, fromBlock: 0n, toBlock: "latest" })
    : [];
  const initialCurve = new Map<string, bigint>();
  for (const t of seedTransfers) {
    const asset = t.address.toLowerCase();
    if (t.blockNumber !== createBlockOf.get(asset)) continue;
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
  const uniqueBlocks = [...new Set(logs.map((l) => l.blockNumber))];
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

    const ts = blockTimes.get(log.blockNumber);
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
 *  No swap routing attached — trading opens as tokens graduate. */
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
