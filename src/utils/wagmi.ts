import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { type Chain, defineChain, type Transport } from "viem";
import { NETWORKS } from "./constants";

if (NETWORKS.length === 0) {
  throw new Error("NETWORKS array is empty — at least one network must be configured");
}

const MAINNET_CHAIN_IDS = new Set([57073]); // Ink is a production chain

const chains = NETWORKS.map((net) =>
  defineChain({
    id: net.id,
    name: net.name,
    nativeCurrency: { name: net.currencySymbol, symbol: net.currencySymbol, decimals: 18 },
    rpcUrls: { default: { http: [net.rpcUrl] } },
    blockExplorers: { default: { name: "Explorer", url: net.explorerUrl } },
    testnet: !MAINNET_CHAIN_IDS.has(net.id),
  })
);

export const supportedChains = chains as unknown as [Chain, ...Chain[]];

const transports = Object.fromEntries(
  chains.map((c) => [c.id, http(c.rpcUrls.default.http[0])])
) as Record<number, Transport>;

export const wagmiConfig = createConfig({
  chains: supportedChains,
  connectors: [injected()],
  transports,
});
