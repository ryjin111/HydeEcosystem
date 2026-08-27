import type { Address } from "viem";

export type HydeoutIndexerChain = {
  key: "stable" | "arbitrum" | "robinhood" | "ink";
  id: number;
  name: string;
  engine: "v3-single-sided" | "v4-hook";
  rpcUrl: string;
  factory: Address;
  graduator: Address;
  locker: Address;
  numeraire: Address;
  quoteSymbol: string;
  quoteDecimals: number;
  startBlock: number;
  ethGetLogsBlockRange: number;
};

export const INDEXER_CHAINS = [
  {
    key: "stable",
    id: 988,
    name: "Stable",
    engine: "v3-single-sided",
    rpcUrl: "https://rpc.stable.xyz",
    factory: "0xCf9023b509bf2c1FD53b3FF7Cd9dD5D1E88A5458",
    graduator: "0x81d5A6B7433420F7011612771eA74Ef71e239206",
    locker: "0x6422E1C4F696C17BA740595C17F6355496492751",
    numeraire: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736",
    quoteSymbol: "USDT0",
    quoteDecimals: 6,
    startBlock: 33_659_980,
    ethGetLogsBlockRange: 500,
  },
  {
    key: "arbitrum",
    id: 42_161,
    name: "Arbitrum One",
    engine: "v4-hook",
    rpcUrl: "https://arb1.arbitrum.io/rpc",
    factory: "0x1713FCC00dD51d88B6124419Fac0B8025CC84e6a",
    graduator: "0x159A616E885955F5463D70E4807d1D71568d76AC",
    locker: "0x08610aE598a24799e1843C683695B0Fc63b1bd6f",
    numeraire: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    quoteSymbol: "WETH",
    quoteDecimals: 18,
    startBlock: 489_243_637,
    ethGetLogsBlockRange: 9_000,
  },
  {
    key: "robinhood",
    id: 4_663,
    name: "Robinhood Chain",
    engine: "v4-hook",
    rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
    factory: "0x55957848ECeF5Ef38E527596Fd1E7eB583A46579",
    graduator: "0xa5dC3CD280592abD9237C83Ce296a8504031F378",
    locker: "0x1016A8fEd8da59f6A8542c8886f4b4e2A94eBf3f",
    numeraire: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    quoteSymbol: "WETH",
    quoteDecimals: 18,
    startBlock: 23_198_932,
    ethGetLogsBlockRange: 9_000,
  },
  {
    key: "ink",
    id: 57_073,
    name: "Ink",
    engine: "v3-single-sided",
    rpcUrl: "https://rpc-gel.inkonchain.com",
    factory: "0xCf9023b509bf2c1FD53b3FF7Cd9dD5D1E88A5458",
    graduator: "0x384951F77BD07bb3eCa992fcffb0AaDF972C2b1f",
    locker: "0xE9385e126A70cff82eceFd1791a509A6fB36AF71",
    numeraire: "0x4200000000000000000000000000000000000006",
    quoteSymbol: "WETH",
    quoteDecimals: 18,
    startBlock: 54_318_168,
    ethGetLogsBlockRange: 500,
  },
] as const satisfies readonly HydeoutIndexerChain[];

export function indexerChainById(chainId: number): HydeoutIndexerChain | undefined {
  return INDEXER_CHAINS.find((chain) => chain.id === chainId);
}

export function indexerChainByKey(key: string): HydeoutIndexerChain | undefined {
  return INDEXER_CHAINS.find((chain) => chain.key === key);
}

export const LEGACY_SOURCES = {
  stablePad: {
    chainId: 988,
    address: "0xE79F17Fe61F9c76824D74C496f122f0AB483ec6A" as Address,
    startBlock: 33_271_478,
  },
  arbitrumFactory: {
    chainId: 42_161,
    address: "0x710fEa288266518528A4230771E07ee310ce509f" as Address,
    startBlock: 488_965_908,
  },
  robinhoodWethFactory: {
    chainId: 4_663,
    address: "0x159A2fa37427299466B0723713eaa260e6124cbc" as Address,
    startBlock: 17_418_907,
  },
  robinhoodHoodieEngine: {
    chainId: 4_663,
    address: "0x8062951c99CfFA5365f979D5139Cf96b5c77CFCc" as Address,
    startBlock: 15_652_257,
    numeraire: "0xC72c01AAB5f5678dc1d6f5C6d2B417d91D402Ba3" as Address,
    quoteSymbol: "HOODIE",
    quoteDecimals: 18,
  },
} as const;
