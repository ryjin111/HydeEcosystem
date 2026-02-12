import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { defineChain } from "viem";
import { NETWORKS } from "./constants";

const tempoChain = defineChain({
  id: NETWORKS[0].id,
  name: NETWORKS[0].name,
  nativeCurrency: {
    name: "USD",
    symbol: "USD",
    decimals: 18
  },
  rpcUrls: {
    default: { http: [NETWORKS[0].rpcUrl] }
  },
  blockExplorers: {
    default: { name: "Explorer", url: NETWORKS[0].explorerUrl }
  },
  testnet: true
});

const robinhoodChain = defineChain({
  id: NETWORKS[1].id,
  name: NETWORKS[1].name,
  nativeCurrency: {
    name: "USD",
    symbol: "USD",
    decimals: 18
  },
  rpcUrls: {
    default: { http: [NETWORKS[1].rpcUrl] }
  },
  blockExplorers: {
    default: { name: "Explorer", url: NETWORKS[1].explorerUrl }
  },
  testnet: true
});

const pharosChain = defineChain({
  id: NETWORKS[2].id,
  name: NETWORKS[2].name,
  nativeCurrency: {
    name: "USD",
    symbol: "USD",
    decimals: 18
  },
  rpcUrls: {
    default: { http: [NETWORKS[2].rpcUrl] }
  },
  blockExplorers: {
    default: { name: "Explorer", url: NETWORKS[2].explorerUrl }
  },
  testnet: true
});

export const supportedChains = [tempoChain, robinhoodChain, pharosChain] as const;

export const wagmiConfig = createConfig({
  chains: supportedChains,
  connectors: [injected()],
  transports: {
    [tempoChain.id]: http(tempoChain.rpcUrls.default.http[0]),
    [robinhoodChain.id]: http(robinhoodChain.rpcUrls.default.http[0]),
    [pharosChain.id]: http(pharosChain.rpcUrls.default.http[0])
  }
});
