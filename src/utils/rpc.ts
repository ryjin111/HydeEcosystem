import { fallback, http, type Transport } from "viem";
import type { NetworkConfig } from "./constants";

const ALCHEMY_HOST_BY_CHAIN: Record<number, string | undefined> = {
  4663: "robinhood-mainnet.g.alchemy.com",
  988: "stable-mainnet.g.alchemy.com",
  42161: "arb-mainnet.g.alchemy.com",
};

const EXPLICIT_RPC_BY_CHAIN: Record<number, string | undefined> = {
  4663: import.meta.env.VITE_ROBINHOOD_MAINNET_RPC_URL,
  988: import.meta.env.VITE_STABLE_MAINNET_RPC_URL,
  42161: import.meta.env.VITE_ARBITRUM_MAINNET_RPC_URL,
  5042: import.meta.env.VITE_ARC_MAINNET_RPC_URL,
};

function cleanHttpsUrl(value?: string): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.toString().replace(/\/$/, "") : null;
  } catch {
    return null;
  }
}

function alchemyUrl(chainId: number): string | null {
  const explicit = cleanHttpsUrl(EXPLICIT_RPC_BY_CHAIN[chainId]);
  if (explicit) return explicit;

  const key = import.meta.env.VITE_ALCHEMY_API_KEY?.trim();
  const host = ALCHEMY_HOST_BY_CHAIN[chainId];
  if (!key || !host || !/^[A-Za-z0-9_-]+$/.test(key)) return null;
  return `https://${host}/v2/${key}`;
}

/** Ordered frontend RPCs: paid Alchemy first when configured, chain-owned public endpoint second.
 * The fallback prevents an Alchemy outage, quota error or bad deploy-time variable from taking Hydeout down. */
export function rpcUrlsForNetwork(network: NetworkConfig): [string, ...string[]] {
  const paid = alchemyUrl(network.id);
  const publicRpc = network.rpcUrl.replace(/\/$/, "");
  return paid && paid !== publicRpc ? [paid, publicRpc] : [publicRpc];
}

export function rpcTransportForNetwork(network: NetworkConfig): Transport {
  const transports = rpcUrlsForNetwork(network).map((url) => http(url));
  return transports.length === 1 ? transports[0] : fallback(transports);
}
