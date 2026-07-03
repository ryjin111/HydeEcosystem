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
] as const;

// Dedicated client: launches must load even before a wallet connects.
const robinhoodChain = defineChain({
  id: ROBINHOOD_CHAIN_ID,
  name: ROBINHOOD_MAINNET.name,
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [ROBINHOOD_MAINNET.rpcUrl] } },
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

  const pools = await Promise.all(
    logs.map(async (log): Promise<DopplerPool | null> => {
      const asset = log.args.asset as `0x${string}`;
      try {
        const [name, symbol, block] = await Promise.all([
          client.readContract({ address: asset, abi: ERC20_META_ABI, functionName: "name" }),
          client.readContract({ address: asset, abi: ERC20_META_ABI, functionName: "symbol" }),
          client.getBlock({ blockNumber: log.blockNumber }),
        ]);
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
          type: graduated.has(asset.toLowerCase()) ? "v2" : "v4",
          dollarLiquidity: null,
          volumeUsd: null,
          createdAt: new Date(Number(block.timestamp) * 1000).toISOString(),
        };
      } catch {
        return null; // unreadable token — skip rather than crash the board
      }
    })
  );

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
