import { useEffect, useState } from "react";
import {
  decodeAbiParameters,
  encodeEventTopics,
  formatUnits,
  parseAbiItem,
  parseAbiParameters,
  type Address,
  type Hex,
} from "viem";
import { V4_CONTRACTS_BY_CHAIN } from "../utils/constants";
import { fetchIndexedTokenActivity } from "../utils/trenchV5Indexer";
import type { GeckoTrade } from "./useGeckoPoolActivity";

export type Holder = { address: string; value: string };

type TokenActivity = {
  holders: Holder[];
  trades: GeckoTrade[];
  loading: boolean;
  holderSource: "indexer" | "explorer" | null;
  tradeSource: "indexer" | "explorer" | null;
};

const ROBINHOOD_MAINNET_ID = 4663;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const V4_SWAP = parseAbiItem(
  "event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)",
);
const V4_SWAP_TOPIC = encodeEventTopics({ abi: [V4_SWAP], eventName: "Swap" })[0];
const V4_SWAP_DATA = parseAbiParameters(
  "int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee",
);

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function asNumber(value: bigint, decimals: number): number {
  const parsed = Number(formatUnits(value, decimals));
  return Number.isFinite(parsed) ? parsed : 0;
}

async function fetchRobinhoodHolders(token: Address): Promise<Holder[]> {
  const response = await fetch(`https://robinhoodchain.blockscout.com/api/v2/tokens/${token}/holders`);
  if (!response.ok) return [];
  const payload = await response.json() as {
    items?: Array<{ address?: { hash?: string }; value?: string }>;
  };
  return (payload.items ?? []).flatMap((row) => {
    const address = row.address?.hash;
    const value = row.value;
    if (!address || !ADDRESS.test(address) || typeof value !== "string") return [];
    return [{ address, value }];
  }).slice(0, 8);
}

async function fetchRobinhoodV4Trades(
  token: Address,
  quote: Address,
  poolId: Hex,
  tokenDecimals: number,
  quoteDecimals: number,
): Promise<GeckoTrade[]> {
  const poolManager = V4_CONTRACTS_BY_CHAIN[ROBINHOOD_MAINNET_ID]?.poolManager;
  if (!poolManager || !V4_SWAP_TOPIC) return [];
  const params = new URLSearchParams({
    module: "logs",
    action: "getLogs",
    fromBlock: "0",
    toBlock: "latest",
    address: poolManager,
    topic0: V4_SWAP_TOPIC,
    topic0_1_opr: "and",
    topic1: poolId,
  });
  const response = await fetch(`https://robinhoodchain.blockscout.com/api?${params}`);
  if (!response.ok) return [];
  const payload = await response.json() as {
    result?: Array<{
      data?: Hex;
      topics?: Hex[];
      transactionHash?: string;
      timeStamp?: string;
    }>;
  };
  const tokenIs0 = token.toLowerCase() < quote.toLowerCase();
  return (payload.result ?? []).flatMap((row) => {
    if (!row.data || !row.transactionHash || !/^0x[0-9a-fA-F]{64}$/.test(row.transactionHash)) return [];
    try {
      const [amount0, amount1] = decodeAbiParameters(V4_SWAP_DATA, row.data);
      const tokenDelta = tokenIs0 ? amount0 : amount1;
      const quoteDelta = tokenIs0 ? amount1 : amount0;
      const timestamp = Number.parseInt(row.timeStamp ?? "0", 16);
      const senderTopic = row.topics?.[2];
      const trader = senderTopic ? `0x${senderTopic.slice(-40)}` : "";
      return [{
        txHash: row.transactionHash,
        trader,
        timestamp: timestamp > 0 ? new Date(timestamp * 1000).toISOString() : new Date(0).toISOString(),
        kind: tokenDelta > 0n ? "sell" as const : "buy" as const,
        tokenAmount: asNumber(abs(tokenDelta), tokenDecimals),
        quoteAmount: asNumber(abs(quoteDelta), quoteDecimals),
        volumeUsd: 0,
        priceUsd: null,
      }];
    } catch {
      return [];
    }
  }).sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)).slice(0, 12);
}

export function useTokenActivity({
  chainId,
  token,
  quote,
  poolId,
  tokenDecimals,
  quoteDecimals,
}: {
  chainId: number;
  token?: string;
  quote?: string;
  poolId?: string | null;
  tokenDecimals?: number;
  quoteDecimals?: number;
}): TokenActivity {
  const [state, setState] = useState<TokenActivity>({
    holders: [],
    trades: [],
    loading: true,
    holderSource: null,
    tradeSource: null,
  });

  useEffect(() => {
    let cancelled = false;
    setState({ holders: [], trades: [], loading: true, holderSource: null, tradeSource: null });
    if (!token || !ADDRESS.test(token)) {
      setState({ holders: [], trades: [], loading: false, holderSource: null, tradeSource: null });
      return;
    }
    const tokenAddress = token as Address;
    const validV4 = (
      chainId === ROBINHOOD_MAINNET_ID
      && quote && ADDRESS.test(quote)
      && poolId && /^0x[0-9a-fA-F]{64}$/.test(poolId)
      && Number.isInteger(tokenDecimals)
      && Number.isInteger(quoteDecimals)
    );

    Promise.all([
      fetchIndexedTokenActivity(chainId, tokenAddress),
      chainId === ROBINHOOD_MAINNET_ID ? fetchRobinhoodHolders(tokenAddress).catch(() => []) : Promise.resolve([]),
      validV4
        ? fetchRobinhoodV4Trades(
          tokenAddress,
          quote as Address,
          poolId as Hex,
          tokenDecimals as number,
          quoteDecimals as number,
        ).catch(() => [])
        : Promise.resolve([]),
    ]).then(([indexed, explorerHolders, explorerTrades]) => {
      if (cancelled) return;
      const holders = indexed?.holders.length ? indexed.holders : explorerHolders;
      const indexedTrades: GeckoTrade[] = (indexed?.trades ?? []).map((trade) => {
        const tokenAmount = asNumber(BigInt(trade.tokenAmount), tokenDecimals ?? 18);
        const quoteAmount = asNumber(BigInt(trade.quoteAmount), quoteDecimals ?? 18);
        const quoteIsUsd = chainId === 988;
        return {
          txHash: trade.txHash,
          trader: trade.trader,
          timestamp: new Date(Number(BigInt(trade.timestamp)) * 1000).toISOString(),
          kind: trade.kind,
          tokenAmount,
          quoteAmount,
          volumeUsd: quoteIsUsd ? quoteAmount : 0,
          priceUsd: quoteIsUsd && tokenAmount > 0 ? quoteAmount / tokenAmount : null,
        };
      });
      const trades = indexedTrades.length ? indexedTrades : explorerTrades;
      setState({
        holders,
        trades,
        loading: false,
        holderSource: indexed?.holders.length ? "indexer" : explorerHolders.length ? "explorer" : null,
        tradeSource: indexedTrades.length ? "indexer" : explorerTrades.length ? "explorer" : null,
      });
    }).catch(() => {
      if (!cancelled) setState({ holders: [], trades: [], loading: false, holderSource: null, tradeSource: null });
    });
    return () => { cancelled = true; };
  }, [chainId, poolId, quote, quoteDecimals, token, tokenDecimals]);

  return state;
}
