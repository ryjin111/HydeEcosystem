import { createConfig } from "wagmi";
import { injected } from "wagmi/connectors";
import { type Chain, defineChain, type Transport } from "viem";
import { NETWORKS } from "./constants";
import { rpcTransportForNetwork, rpcUrlsForNetwork } from "./rpc";

if (NETWORKS.length === 0) {
  throw new Error("NETWORKS array is empty — at least one network must be configured");
}

const chains = NETWORKS.map((net) =>
  defineChain({
    id: net.id,
    name: net.name,
    nativeCurrency: {
      name: net.currencySymbol,
      symbol: net.currencySymbol,
      decimals: net.currencyDecimals ?? 18,
    },
    rpcUrls: { default: { http: rpcUrlsForNetwork(net) } },
    blockExplorers: { default: { name: "Explorer", url: net.explorerUrl } },
    testnet: net.testnet ?? false,
  })
);

export const supportedChains = chains as unknown as [Chain, ...Chain[]];

const transports = Object.fromEntries(
  NETWORKS.map((network) => [network.id, rpcTransportForNetwork(network)])
) as Record<number, Transport>;

export const wagmiConfig = createConfig({
  chains: supportedChains,
  connectors: [injected()],
  transports,
});
