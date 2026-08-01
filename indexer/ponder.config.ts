import { createConfig } from "ponder";
import {
  trenchGraduatorAbi,
  trenchV3FactoryAbi,
  trenchV3LockerAbi,
  trenchV4FactoryAbi,
  trenchV4LockerAbi,
} from "./abis/trenchV5";
import { INDEXER_CHAINS } from "./src/chains";

const stable = INDEXER_CHAINS[0];
const arbitrum = INDEXER_CHAINS[1];
const robinhood = INDEXER_CHAINS[2];

export default createConfig({
  chains: {
    stable: {
      id: stable.id,
      rpc: process.env.PONDER_RPC_URL_988 ?? stable.rpcUrl,
      ethGetLogsBlockRange: stable.ethGetLogsBlockRange,
    },
    arbitrum: {
      id: arbitrum.id,
      rpc: process.env.PONDER_RPC_URL_42161 ?? arbitrum.rpcUrl,
      ethGetLogsBlockRange: arbitrum.ethGetLogsBlockRange,
    },
    robinhood: {
      id: robinhood.id,
      rpc: process.env.PONDER_RPC_URL_4663 ?? robinhood.rpcUrl,
      ethGetLogsBlockRange: robinhood.ethGetLogsBlockRange,
    },
  },
  contracts: {
    TrenchV3Factory: {
      abi: trenchV3FactoryAbi,
      chain: "stable",
      address: stable.factory,
      startBlock: stable.startBlock,
    },
    TrenchV4Factory: {
      abi: trenchV4FactoryAbi,
      chain: {
        arbitrum: { address: arbitrum.factory, startBlock: arbitrum.startBlock },
        robinhood: { address: robinhood.factory, startBlock: robinhood.startBlock },
      },
    },
    TrenchV3Graduator: {
      abi: trenchGraduatorAbi,
      chain: "stable",
      address: stable.graduator,
      startBlock: stable.startBlock,
    },
    TrenchV4Graduator: {
      abi: trenchGraduatorAbi,
      chain: {
        arbitrum: { address: arbitrum.graduator, startBlock: arbitrum.startBlock },
        robinhood: { address: robinhood.graduator, startBlock: robinhood.startBlock },
      },
    },
    TrenchV3Locker: {
      abi: trenchV3LockerAbi,
      chain: "stable",
      address: stable.locker,
      startBlock: stable.startBlock,
    },
    TrenchV4Locker: {
      abi: trenchV4LockerAbi,
      chain: {
        arbitrum: { address: arbitrum.locker, startBlock: arbitrum.startBlock },
        robinhood: { address: robinhood.locker, startBlock: robinhood.startBlock },
      },
    },
  },
});
