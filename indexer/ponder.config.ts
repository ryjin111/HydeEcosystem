import { createConfig, factory } from "ponder";
import {
  erc20TransferAbi,
  trenchGraduatorAbi,
  trenchV3FactoryAbi,
  trenchV3LockerAbi,
  trenchV4FactoryAbi,
  trenchV4LockerAbi,
  legacyHoodieEngineAbi,
  legacyV3PadAbi,
  legacyV4FactoryAbi,
  uniswapV3PoolAbi,
} from "./abis/trenchV5";
import { INDEXER_CHAINS, LEGACY_SOURCES } from "./src/chains";

const stable = INDEXER_CHAINS[0];
const arbitrum = INDEXER_CHAINS[1];
const robinhood = INDEXER_CHAINS[2];
const ink = INDEXER_CHAINS[3];

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
    ink: {
      id: ink.id,
      rpc: process.env.PONDER_RPC_URL_57073 ?? ink.rpcUrl,
      ethGetLogsBlockRange: ink.ethGetLogsBlockRange,
    },
  },
  contracts: {
    TrenchV3Factory: {
      abi: trenchV3FactoryAbi,
      chain: {
        stable: { address: stable.factory, startBlock: stable.startBlock },
        ink: { address: ink.factory, startBlock: ink.startBlock },
      },
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
      chain: {
        stable: { address: stable.graduator, startBlock: stable.startBlock },
        ink: { address: ink.graduator, startBlock: ink.startBlock },
      },
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
      chain: {
        stable: { address: stable.locker, startBlock: stable.startBlock },
        ink: { address: ink.locker, startBlock: ink.startBlock },
      },
    },
    TrenchV4Locker: {
      abi: trenchV4LockerAbi,
      chain: {
        arbitrum: { address: arbitrum.locker, startBlock: arbitrum.startBlock },
        robinhood: { address: robinhood.locker, startBlock: robinhood.startBlock },
      },
    },
    LegacyStableV3Pad: {
      abi: legacyV3PadAbi,
      chain: "stable",
      address: LEGACY_SOURCES.stablePad.address,
      startBlock: LEGACY_SOURCES.stablePad.startBlock,
    },
    LegacyArbitrumV4Factory: {
      abi: legacyV4FactoryAbi,
      chain: "arbitrum",
      address: LEGACY_SOURCES.arbitrumFactory.address,
      startBlock: LEGACY_SOURCES.arbitrumFactory.startBlock,
    },
    LegacyRobinhoodV4Factory: {
      abi: legacyV4FactoryAbi,
      chain: "robinhood",
      address: LEGACY_SOURCES.robinhoodWethFactory.address,
      startBlock: LEGACY_SOURCES.robinhoodWethFactory.startBlock,
    },
    LegacyRobinhoodHoodieEngine: {
      abi: legacyHoodieEngineAbi,
      chain: "robinhood",
      address: LEGACY_SOURCES.robinhoodHoodieEngine.address,
      startBlock: LEGACY_SOURCES.robinhoodHoodieEngine.startBlock,
    },
    TrenchV3Token: {
      abi: erc20TransferAbi,
      chain: {
        stable: {
          startBlock: stable.startBlock,
          address: factory({
            address: stable.factory,
            event: trenchV3FactoryAbi[0],
            parameter: "token",
            startBlock: stable.startBlock,
          }),
        },
        ink: {
          startBlock: ink.startBlock,
          address: factory({
            address: ink.factory,
            event: trenchV3FactoryAbi[0],
            parameter: "token",
            startBlock: ink.startBlock,
          }),
        },
      },
    },
    TrenchV4Token: {
      abi: erc20TransferAbi,
      chain: {
        arbitrum: {
          startBlock: arbitrum.startBlock,
          address: factory({
            address: arbitrum.factory,
            event: trenchV4FactoryAbi[0],
            parameter: "token",
            startBlock: arbitrum.startBlock,
          }),
        },
        robinhood: {
          startBlock: robinhood.startBlock,
          address: factory({
            address: robinhood.factory,
            event: trenchV4FactoryAbi[0],
            parameter: "token",
            startBlock: robinhood.startBlock,
          }),
        },
      },
    },
    LegacyStableToken: {
      abi: erc20TransferAbi,
      chain: "stable",
      startBlock: LEGACY_SOURCES.stablePad.startBlock,
      address: factory({
        address: LEGACY_SOURCES.stablePad.address,
        event: legacyV3PadAbi[0],
        parameter: "token",
        startBlock: LEGACY_SOURCES.stablePad.startBlock,
      }),
    },
    LegacyArbitrumToken: {
      abi: erc20TransferAbi,
      chain: "arbitrum",
      startBlock: LEGACY_SOURCES.arbitrumFactory.startBlock,
      address: factory({
        address: LEGACY_SOURCES.arbitrumFactory.address,
        event: legacyV4FactoryAbi[0],
        parameter: "token",
        startBlock: LEGACY_SOURCES.arbitrumFactory.startBlock,
      }),
    },
    LegacyRobinhoodWethToken: {
      abi: erc20TransferAbi,
      chain: "robinhood",
      startBlock: LEGACY_SOURCES.robinhoodWethFactory.startBlock,
      address: factory({
        address: LEGACY_SOURCES.robinhoodWethFactory.address,
        event: legacyV4FactoryAbi[0],
        parameter: "token",
        startBlock: LEGACY_SOURCES.robinhoodWethFactory.startBlock,
      }),
    },
    LegacyRobinhoodHoodieToken: {
      abi: erc20TransferAbi,
      chain: "robinhood",
      startBlock: LEGACY_SOURCES.robinhoodHoodieEngine.startBlock,
      address: factory({
        address: LEGACY_SOURCES.robinhoodHoodieEngine.address,
        event: legacyHoodieEngineAbi[0],
        parameter: "token",
        startBlock: LEGACY_SOURCES.robinhoodHoodieEngine.startBlock,
      }),
    },
    TrenchV3Pool: {
      abi: uniswapV3PoolAbi,
      chain: {
        stable: {
          startBlock: stable.startBlock,
          address: factory({
            address: stable.factory,
            event: trenchV3FactoryAbi[0],
            parameter: "pool",
            startBlock: stable.startBlock,
          }),
        },
        ink: {
          startBlock: ink.startBlock,
          address: factory({
            address: ink.factory,
            event: trenchV3FactoryAbi[0],
            parameter: "pool",
            startBlock: ink.startBlock,
          }),
        },
      },
    },
    LegacyStableV3Pool: {
      abi: uniswapV3PoolAbi,
      chain: "stable",
      startBlock: LEGACY_SOURCES.stablePad.startBlock,
      address: factory({
        address: LEGACY_SOURCES.stablePad.address,
        event: legacyV3PadAbi[0],
        parameter: "pool",
        startBlock: LEGACY_SOURCES.stablePad.startBlock,
      }),
    },
  },
});
