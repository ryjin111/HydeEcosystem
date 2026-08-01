import {
  createPublicClient,
  defineChain,
  keccak256,
  parseAbiItem,
  parseEventLogs,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import {
  ARBITRUM_MAINNET,
  ARC_MAINNET,
  NETWORKS,
  ROBINHOOD_MAINNET,
  STABLE_MAINNET,
  V4_CONTRACTS_BY_CHAIN,
  type NetworkConfig,
} from "./constants";
import { v3ChainRow, type LaunchEngine } from "./chainRegistry";
import type { DopplerPool, TrenchCurveState } from "./dopplerConfig";
import { rpcTransportForNetwork, rpcUrlsForNetwork } from "./rpc";
import { fetchIndexedTrenchV5Pools, fetchIndexedTrenchV5Token } from "./trenchV5Indexer";
import { fetchGeckoTerminalMarkets } from "./geckoTerminalMarkets";

type V5EnvManifest = {
  factory?: string;
  factoryCodeHash?: string;
  graduatorCodeHash?: string;
  lockerCodeHash?: string;
  hook?: string;
  hookCodeHash?: string;
  deploymentBlock?: string;
};

export type TrenchV5Manifest = {
  chainId: number;
  network: NetworkConfig;
  engine: LaunchEngine;
  factory: Address;
  factoryCodeHash: Hex;
  graduatorCodeHash: Hex;
  lockerCodeHash: Hex;
  /** V4 only. The hook is part of every V5 PoolKey, so it is manifest-pinned just like the factory. */
  hook?: Address;
  hookCodeHash?: Hex;
  deploymentBlock: bigint;
};

const ZERO = /^0x0{40}$/i;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;

// Arc's public mainnet is not live yet. Keep its mined preview manifest for auditability, but never
// expose launch transactions until the chain is explicitly removed from this release gate.
const PUBLICLY_DISABLED_V5_CHAINS = new Set<number>([ARC_MAINNET.id]);

export function isTrenchV5PubliclyAvailable(chainId: number): boolean {
  return !PUBLICLY_DISABLED_V5_CHAINS.has(chainId);
}

function envManifest(chainId: number): V5EnvManifest {
  if (chainId === ARC_MAINNET.id) {
    return {
      factory: import.meta.env.VITE_TRENCH_V5_ARC_FACTORY,
      factoryCodeHash: import.meta.env.VITE_TRENCH_V5_ARC_FACTORY_CODE_HASH,
      graduatorCodeHash: import.meta.env.VITE_TRENCH_V5_ARC_GRADUATOR_CODE_HASH,
      lockerCodeHash: import.meta.env.VITE_TRENCH_V5_ARC_LOCKER_CODE_HASH,
      deploymentBlock: import.meta.env.VITE_TRENCH_V5_ARC_DEPLOYMENT_BLOCK,
    };
  }
  if (chainId === STABLE_MAINNET.id) {
    return {
      factory: import.meta.env.VITE_TRENCH_V5_STABLE_FACTORY,
      factoryCodeHash: import.meta.env.VITE_TRENCH_V5_STABLE_FACTORY_CODE_HASH,
      graduatorCodeHash: import.meta.env.VITE_TRENCH_V5_STABLE_GRADUATOR_CODE_HASH,
      lockerCodeHash: import.meta.env.VITE_TRENCH_V5_STABLE_LOCKER_CODE_HASH,
      deploymentBlock: import.meta.env.VITE_TRENCH_V5_STABLE_DEPLOYMENT_BLOCK,
    };
  }
  if (chainId === ROBINHOOD_MAINNET.id) {
    return {
      factory: import.meta.env.VITE_TRENCH_V5_ROBINHOOD_FACTORY,
      factoryCodeHash: import.meta.env.VITE_TRENCH_V5_ROBINHOOD_FACTORY_CODE_HASH,
      graduatorCodeHash: import.meta.env.VITE_TRENCH_V5_ROBINHOOD_GRADUATOR_CODE_HASH,
      lockerCodeHash: import.meta.env.VITE_TRENCH_V5_ROBINHOOD_LOCKER_CODE_HASH,
      hook: import.meta.env.VITE_TRENCH_V5_ROBINHOOD_HOOK,
      hookCodeHash: import.meta.env.VITE_TRENCH_V5_ROBINHOOD_HOOK_CODE_HASH,
      deploymentBlock: import.meta.env.VITE_TRENCH_V5_ROBINHOOD_DEPLOYMENT_BLOCK,
    };
  }
  if (chainId === ARBITRUM_MAINNET.id) {
    return {
      factory: import.meta.env.VITE_TRENCH_V5_ARBITRUM_FACTORY,
      factoryCodeHash: import.meta.env.VITE_TRENCH_V5_ARBITRUM_FACTORY_CODE_HASH,
      graduatorCodeHash: import.meta.env.VITE_TRENCH_V5_ARBITRUM_GRADUATOR_CODE_HASH,
      lockerCodeHash: import.meta.env.VITE_TRENCH_V5_ARBITRUM_LOCKER_CODE_HASH,
      hook: import.meta.env.VITE_TRENCH_V5_ARBITRUM_HOOK,
      hookCodeHash: import.meta.env.VITE_TRENCH_V5_ARBITRUM_HOOK_CODE_HASH,
      deploymentBlock: import.meta.env.VITE_TRENCH_V5_ARBITRUM_DEPLOYMENT_BLOCK,
    };
  }
  return {};
}

function parseManifest(chainId: number): TrenchV5Manifest | null {
  if (!isTrenchV5PubliclyAvailable(chainId)) return null;
  const raw = envManifest(chainId);
  const network = NETWORKS.find((item) => item.id === chainId);
  const engine: LaunchEngine = v3ChainRow(chainId) ? "v3-single-sided" : "v4-hook";
  if (
    !network
    || !raw.factory
    || !ADDRESS.test(raw.factory)
    || ZERO.test(raw.factory)
    || !raw.factoryCodeHash
    || !HASH.test(raw.factoryCodeHash)
    || !raw.graduatorCodeHash
    || !HASH.test(raw.graduatorCodeHash)
    || !raw.lockerCodeHash
    || !HASH.test(raw.lockerCodeHash)
    || !raw.deploymentBlock
  ) return null;
  if (
    engine === "v4-hook"
    && (
      !raw.hook
      || !ADDRESS.test(raw.hook)
      || ZERO.test(raw.hook)
      || !raw.hookCodeHash
      || !HASH.test(raw.hookCodeHash)
    )
  ) return null;
  let deploymentBlock: bigint;
  try {
    deploymentBlock = BigInt(raw.deploymentBlock);
  } catch {
    return null;
  }
  if (deploymentBlock <= 0n) return null;
  return {
    chainId,
    network,
    engine,
    factory: raw.factory as Address,
    factoryCodeHash: raw.factoryCodeHash as Hex,
    graduatorCodeHash: raw.graduatorCodeHash as Hex,
    lockerCodeHash: raw.lockerCodeHash as Hex,
    hook: raw.hook as Address | undefined,
    hookCodeHash: raw.hookCodeHash as Hex | undefined,
    deploymentBlock,
  };
}

export function trenchV5Manifest(chainId: number): TrenchV5Manifest | null {
  return parseManifest(chainId);
}

export function isTrenchV5Configured(chainId: number): boolean {
  return trenchV5Manifest(chainId) !== null;
}

const clients = new Map<number, PublicClient>();
function clientFor(manifest: TrenchV5Manifest): PublicClient {
  const existing = clients.get(manifest.chainId);
  if (existing) return existing;
  const chain = defineChain({
    id: manifest.chainId,
    name: manifest.network.name,
    nativeCurrency: {
      name: manifest.network.currencySymbol,
      symbol: manifest.network.currencySymbol,
      decimals: 18,
    },
    rpcUrls: { default: { http: rpcUrlsForNetwork(manifest.network) } },
  });
  const client = createPublicClient({
    chain,
    transport: rpcTransportForNetwork(manifest.network),
  }) as PublicClient;
  clients.set(manifest.chainId, client);
  return client;
}

export const trenchV5FactoryAbi = [
  { type: "function", name: "GRADUATOR", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "LOCKER", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "NUMERAIRE", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "V3_FACTORY", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "HOOK", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "POOL_MANAGER", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "POSITION_MANAGER", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "PERMIT2", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "STATE_VIEW", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "UNIVERSAL_ROUTER", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "TICK_SPACING", stateMutability: "view", inputs: [], outputs: [{ type: "int24" }] },
  { type: "function", name: "FEE_TIER", stateMutability: "view", inputs: [], outputs: [{ type: "uint24" }] },
  { type: "function", name: "LAUNCH_FEE_AMOUNT", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "LAUNCH_FEE_ASSET", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "LAUNCH_FEE_NATIVE", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "ACTUAL_START_FDV_RAW", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "ACTUAL_GRADUATION_FDV_RAW", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "EXPECTED_TERMINAL_PROCEEDS", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  {
    type: "function",
    name: "launch",
    stateMutability: "payable",
    inputs: [
      { name: "name", type: "string" },
      { name: "symbol", type: "string" },
      { name: "salt", type: "bytes32" },
    ],
    outputs: [
      { name: "token", type: "address" },
      { name: "curveTokenId", type: "uint256" },
    ],
  },
] as const;

export const trenchV5GraduatorAbi = [
  { type: "function", name: "FACTORY", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "LOCKER", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "NUMERAIRE", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  {
    type: "function",
    name: "curveProgress",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{
      name: "out",
      type: "tuple",
      components: [
        { name: "sold", type: "uint256" },
        { name: "curveAllocation", type: "uint256" },
        { name: "progressWad", type: "uint256" },
        { name: "quotePrincipal", type: "uint256" },
        { name: "minimumProceeds", type: "uint256" },
        { name: "signaledAt", type: "uint64" },
        { name: "finalizableAt", type: "uint64" },
        { name: "state", type: "uint8" },
      ],
    }],
  },
] as const;

export const trenchV5LockerAbi = [
  { type: "function", name: "graduator", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  {
    type: "function",
    name: "collect",
    stateMutability: "nonpayable",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ name: "amountToken", type: "uint256" }, { name: "amountNumeraire", type: "uint256" }],
  },
  {
    type: "function",
    name: "creatorClaimable",
    stateMutability: "view",
    inputs: [{ type: "address" }, { type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "claimCreator",
    stateMutability: "nonpayable",
    inputs: [{ type: "address" }, { type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

const erc20MetaAbi = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;
const erc20ApprovalAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [{ type: "address" }, { type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [{ type: "address" }, { type: "uint256" }],
    outputs: [{ type: "bool" }],
  },
] as const;

const trenchV5HookAbi = [
  { type: "function", name: "factory", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "POOL_MANAGER", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "WETH", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

const V3_LAUNCH = parseAbiItem(
  "event LaunchCreated(address indexed token,address indexed creator,address indexed pool,uint256 curveTokenId,uint128 curveLiquidity,uint256 curveTokenUsed,uint256 graduationReserve)",
);
const V4_LAUNCH = parseAbiItem(
  "event LaunchCreated(address indexed token,address indexed creator,bytes32 indexed poolId,uint256 curveTokenId,uint128 curveLiquidity,uint256 curveTokenUsed,uint256 graduationReserve)",
);

export type VerifiedTrenchV5Runtime = {
  manifest: TrenchV5Manifest;
  client: PublicClient;
  graduator: Address;
  locker: Address;
  numeraire: Address;
  /** Present only for the V4 rail, after code-hash and dependency binding checks pass. */
  hook?: Address;
  tickSpacing?: number;
};

async function checkedCodeHash(client: PublicClient, address: Address, expected: Hex, label: string) {
  const code = await client.getBytecode({ address });
  if (!code || code === "0x") throw new Error(`${label} is not deployed.`);
  if (keccak256(code).toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`${label} runtime does not match the V5 deployment manifest.`);
  }
}

export async function verifyTrenchV5Runtime(chainId: number): Promise<VerifiedTrenchV5Runtime> {
  const manifest = trenchV5Manifest(chainId);
  if (!manifest) throw new Error(`Hydeout V5 is not deployed on chain ${chainId}.`);
  const client = clientFor(manifest);
  const [liveChainId, graduator, locker, numeraire] = await Promise.all([
    client.getChainId(),
    client.readContract({ address: manifest.factory, abi: trenchV5FactoryAbi, functionName: "GRADUATOR" }),
    client.readContract({ address: manifest.factory, abi: trenchV5FactoryAbi, functionName: "LOCKER" }),
    client.readContract({ address: manifest.factory, abi: trenchV5FactoryAbi, functionName: "NUMERAIRE" }),
  ]);
  if (liveChainId !== chainId) throw new Error(`V5 RPC is on chain ${liveChainId}, expected ${chainId}.`);
  await Promise.all([
    checkedCodeHash(client, manifest.factory, manifest.factoryCodeHash, "V5 factory"),
    checkedCodeHash(client, graduator, manifest.graduatorCodeHash, "V5 graduator"),
    checkedCodeHash(client, locker, manifest.lockerCodeHash, "V5 locker"),
  ]);
  const [gradFactory, gradLocker, gradNumeraire, lockerGraduator] = await Promise.all([
    client.readContract({ address: graduator, abi: trenchV5GraduatorAbi, functionName: "FACTORY" }),
    client.readContract({ address: graduator, abi: trenchV5GraduatorAbi, functionName: "LOCKER" }),
    client.readContract({ address: graduator, abi: trenchV5GraduatorAbi, functionName: "NUMERAIRE" }),
    client.readContract({ address: locker, abi: trenchV5LockerAbi, functionName: "graduator" }),
  ]);
  if (
    gradFactory.toLowerCase() !== manifest.factory.toLowerCase()
    || gradLocker.toLowerCase() !== locker.toLowerCase()
    || gradNumeraire.toLowerCase() !== numeraire.toLowerCase()
    || lockerGraduator.toLowerCase() !== graduator.toLowerCase()
  ) throw new Error("V5 factory, graduator, and locker bindings do not match.");

  if (manifest.engine === "v4-hook") {
    if (!manifest.hook || !manifest.hookCodeHash) {
      throw new Error("V5 V4 hook is missing from the deployment manifest.");
    }
    const expected = V4_CONTRACTS_BY_CHAIN[chainId];
    if (!expected) throw new Error(`No canonical V4 dependencies are configured for chain ${chainId}.`);
    const [hook, poolManager, positionManager, permit2, stateView, universalRouter, tickSpacing] = await Promise.all([
      client.readContract({ address: manifest.factory, abi: trenchV5FactoryAbi, functionName: "HOOK" }),
      client.readContract({ address: manifest.factory, abi: trenchV5FactoryAbi, functionName: "POOL_MANAGER" }),
      client.readContract({ address: manifest.factory, abi: trenchV5FactoryAbi, functionName: "POSITION_MANAGER" }),
      client.readContract({ address: manifest.factory, abi: trenchV5FactoryAbi, functionName: "PERMIT2" }),
      client.readContract({ address: manifest.factory, abi: trenchV5FactoryAbi, functionName: "STATE_VIEW" }),
      client.readContract({ address: manifest.factory, abi: trenchV5FactoryAbi, functionName: "UNIVERSAL_ROUTER" }),
      client.readContract({ address: manifest.factory, abi: trenchV5FactoryAbi, functionName: "TICK_SPACING" }),
    ]);
    if (
      hook.toLowerCase() !== manifest.hook.toLowerCase()
      || poolManager.toLowerCase() !== expected.poolManager.toLowerCase()
      || positionManager.toLowerCase() !== expected.positionManager.toLowerCase()
      || permit2.toLowerCase() !== expected.permit2.toLowerCase()
      || stateView.toLowerCase() !== expected.stateView?.toLowerCase()
      || universalRouter.toLowerCase() !== expected.universalRouter.toLowerCase()
      || numeraire.toLowerCase() !== manifest.network.weth.toLowerCase()
      || tickSpacing <= 0
    ) throw new Error("V5 V4 factory dependencies do not match the canonical chain manifest.");
    await checkedCodeHash(client, hook, manifest.hookCodeHash, "V5 hook");
    const [hookFactory, hookPoolManager, hookWeth] = await Promise.all([
      client.readContract({ address: hook, abi: trenchV5HookAbi, functionName: "factory" }),
      client.readContract({ address: hook, abi: trenchV5HookAbi, functionName: "POOL_MANAGER" }),
      client.readContract({ address: hook, abi: trenchV5HookAbi, functionName: "WETH" }),
    ]);
    if (
      hookFactory.toLowerCase() !== manifest.factory.toLowerCase()
      || hookPoolManager.toLowerCase() !== poolManager.toLowerCase()
      || hookWeth.toLowerCase() !== numeraire.toLowerCase()
    ) throw new Error("V5 hook bindings do not match the verified factory.");
    return { manifest, client, graduator, locker, numeraire, hook, tickSpacing };
  }

  const expectedV3 = v3ChainRow(chainId);
  if (!expectedV3) throw new Error(`No canonical V3 dependencies are configured for chain ${chainId}.`);
  const [v3Factory, positionManager, feeTier] = await Promise.all([
    client.readContract({ address: manifest.factory, abi: trenchV5FactoryAbi, functionName: "V3_FACTORY" }),
    client.readContract({ address: manifest.factory, abi: trenchV5FactoryAbi, functionName: "POSITION_MANAGER" }),
    client.readContract({ address: manifest.factory, abi: trenchV5FactoryAbi, functionName: "FEE_TIER" }),
  ]);
  if (
    v3Factory.toLowerCase() !== expectedV3.v3Factory.toLowerCase()
    || positionManager.toLowerCase() !== expectedV3.positionManager.toLowerCase()
    || numeraire.toLowerCase() !== expectedV3.numeraire.address.toLowerCase()
    || Number(feeTier) !== expectedV3.feeTier
  ) throw new Error("V5 V3 factory dependencies do not match the canonical chain manifest.");

  return { manifest, client, graduator, locker, numeraire };
}

function stateLabel(state: number): TrenchCurveState | null {
  if (state === 1) return "curve-active";
  if (state === 2) return "graduation-signaled";
  if (state === 3) return "graduated";
  return null;
}

type TrenchLaunchLog = {
  args: {
    token?: Address;
    creator?: Address;
    pool?: Address;
    poolId?: Hex;
  };
  blockNumber: bigint;
};

const V5_PAGE_SIZE = 60;
const V5_DEFAULT_LOG_RANGE = 10_000n;
const V5_V3_LOG_RANGE = 500n;

async function newestLaunchLogs(
  runtime: VerifiedTrenchV5Runtime,
  token?: Address,
): Promise<TrenchLaunchLog[]> {
  const { manifest, client } = runtime;
  const range = manifest.engine === "v3-single-sided"
    ? V5_V3_LOG_RANGE
    : V5_DEFAULT_LOG_RANGE;
  const out: TrenchLaunchLog[] = [];
  let toBlock = await client.getBlockNumber();

  while (toBlock >= manifest.deploymentBlock && out.length < V5_PAGE_SIZE) {
    const candidate = toBlock >= range - 1n ? toBlock - range + 1n : 0n;
    const fromBlock = candidate < manifest.deploymentBlock
      ? manifest.deploymentBlock
      : candidate;
    const logs = manifest.engine === "v3-single-sided"
      ? await client.getLogs({
          address: manifest.factory,
          event: V3_LAUNCH,
          args: token ? { token } : undefined,
          fromBlock,
          toBlock,
        })
      : await client.getLogs({
          address: manifest.factory,
          event: V4_LAUNCH,
          args: token ? { token } : undefined,
          fromBlock,
          toBlock,
        });
    for (let index = logs.length - 1; index >= 0 && out.length < V5_PAGE_SIZE; index -= 1) {
      const log = logs[index];
      if (log.blockNumber != null) out.push(log as unknown as TrenchLaunchLog);
    }
    if (token && out.length > 0) break;
    if (fromBlock === manifest.deploymentBlock) break;
    toBlock = fromBlock - 1n;
  }
  return out;
}

async function enrichLaunchLog(
  runtime: VerifiedTrenchV5Runtime,
  log: TrenchLaunchLog,
  timestamp?: number,
): Promise<DopplerPool | null> {
  const { manifest } = runtime;
  const { token, creator, pool, poolId } = log.args;
  if (!token || !creator) return null;
  const [name, symbol, progress, claimable] = await Promise.all([
    runtime.client.readContract({ address: token, abi: erc20MetaAbi, functionName: "name" }).catch(() => null),
    runtime.client.readContract({ address: token, abi: erc20MetaAbi, functionName: "symbol" }).catch(() => null),
    runtime.client.readContract({
      address: runtime.graduator,
      abi: trenchV5GraduatorAbi,
      functionName: "curveProgress",
      args: [token],
    }).catch(() => null),
    runtime.client.readContract({
      address: runtime.locker,
      abi: trenchV5LockerAbi,
      functionName: "creatorClaimable",
      args: [token, runtime.numeraire],
    }).catch(() => null),
  ]);
  if (!name || !symbol || !progress) return null;
  const blockTimestamp = timestamp ?? Number(
    (await runtime.client.getBlock({ blockNumber: log.blockNumber })).timestamp,
  );
  const pct = Math.min(
    100,
    Number((progress.progressWad * 10_000n) / 1_000_000_000_000_000_000n) / 100,
  );
  const v3 = manifest.engine === "v3-single-sided";
  const v3Numeraire = v3ChainRow(manifest.chainId)?.numeraire;
  return {
    address: token,
    chainId: manifest.chainId,
    poolAddress: v3 ? pool : null,
    poolId: v3 ? null : poolId ?? null,
    baseToken: { address: token, name, symbol, decimals: 18 },
    quoteToken: v3
      ? {
          address: runtime.numeraire,
          name: v3Numeraire?.symbol ?? "Stablecoin",
          symbol: v3Numeraire?.symbol ?? "USD",
          decimals: v3Numeraire?.decimals ?? 6,
        }
      : { address: runtime.numeraire, name: "Wrapped Ether", symbol: "WETH", decimals: 18 },
    launchEngine: manifest.engine,
    protocolVersion: "v5-trench",
    curveState: stateLabel(Number(progress.state)),
    type: v3 ? "v3" : "v4",
    dollarLiquidity: null,
    volumeUsd: null,
    marketCapUsd: null,
    priceUsd: null,
    createdAt: new Date(blockTimestamp * 1000).toISOString(),
    progress: pct,
    creator,
    creatorClaimable: claimable?.toString() ?? null,
  };
}

type TrenchMarket = {
  priceUsd: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  volumeUsd: number | null;
};

function dexChainId(chainId: number): string | null {
  if (chainId === ARC_MAINNET.id) return "arc";
  if (chainId === STABLE_MAINNET.id) return "stable";
  if (chainId === ROBINHOOD_MAINNET.id) return "robinhood";
  if (chainId === ARBITRUM_MAINNET.id) return "arbitrum";
  return null;
}

/**
 * Market APIs are enrichment only: identity, engine, state and progress always come from verified
 * contracts. GeckoTerminal is primary and is accepted only for the canonical pool; DEXScreener is
 * the fail-neutral fallback and must match chain, Uniswap, launch token, and factory numeraire.
 */
async function fetchTrenchMarkets(
  chainId: number,
  numeraire: Address,
  pools: DopplerPool[],
): Promise<Map<string, TrenchMarket>> {
  const chain = dexChainId(chainId);
  const markets = new Map<string, TrenchMarket>(await fetchGeckoTerminalMarkets(pools));
  if (!chain || pools.length === 0) return markets;
  const byToken = new Map(
    pools
      .filter((pool) => !markets.has(pool.address.toLowerCase()))
      .map((pool) => [pool.address.toLowerCase(), pool]),
  );
  const addresses = [...byToken.keys()];
  for (let offset = 0; offset < addresses.length; offset += 30) {
    const batch = addresses.slice(offset, offset + 30);
    try {
      const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${batch.join(",")}`);
      if (!response.ok) continue;
      const payload = await response.json() as {
        pairs?: Array<{
          chainId?: string;
          dexId?: string;
          pairAddress?: string;
          baseToken?: { address?: string };
          quoteToken?: { address?: string };
          priceUsd?: string;
          marketCap?: number;
          fdv?: number;
          liquidity?: { usd?: number };
          volume?: { h24?: number };
        }>;
      };
      for (const pair of payload.pairs ?? []) {
        const tokenKey = pair.baseToken?.address?.toLowerCase() ?? "";
        const pool = byToken.get(tokenKey);
        if (
          !pool
          || pair.chainId !== chain
          || pair.dexId !== "uniswap"
          || pair.quoteToken?.address?.toLowerCase() !== numeraire.toLowerCase()
          || (
            pool.poolAddress
            && pair.pairAddress?.toLowerCase() !== pool.poolAddress.toLowerCase()
          )
        ) continue;
        const liquidityUsd = pair.liquidity?.usd ?? null;
        const previous = markets.get(tokenKey);
        if (previous && (previous.liquidityUsd ?? 0) >= (liquidityUsd ?? 0)) continue;
        const parsedPrice = pair.priceUsd == null ? null : Number(pair.priceUsd);
        markets.set(tokenKey, {
          priceUsd: parsedPrice != null && Number.isFinite(parsedPrice) ? parsedPrice : null,
          marketCapUsd: pair.marketCap ?? pair.fdv ?? null,
          liquidityUsd,
          volumeUsd: pair.volume?.h24 ?? null,
        });
      }
    } catch {
      // Honest fail-neutral enrichment.
    }
  }
  return markets;
}

async function withTrenchMarkets(
  chainId: number,
  numeraire: Address,
  pools: DopplerPool[],
): Promise<DopplerPool[]> {
  const markets = await fetchTrenchMarkets(chainId, numeraire, pools);
  return pools.map((pool) => {
    const market = markets.get(pool.address.toLowerCase());
    return market
      ? {
          ...pool,
          priceUsd: market.priceUsd,
          marketCapUsd: market.marketCapUsd,
          dollarLiquidity: market.liquidityUsd?.toString() ?? null,
          volumeUsd: market.volumeUsd?.toString() ?? null,
        }
      : pool;
  });
}

export async function fetchTrenchV5Pools(chainId: number): Promise<DopplerPool[]> {
  const manifest = trenchV5Manifest(chainId);
  if (!manifest) return [];
  const indexed = await fetchIndexedTrenchV5Pools(chainId);
  if (indexed) {
    if (indexed.length === 0) return [];
    return withTrenchMarkets(chainId, indexed[0].quoteToken.address as Address, indexed);
  }
  const runtime = await verifyTrenchV5Runtime(chainId);
  const newest = await newestLaunchLogs(runtime);
  const blockNumbers = [...new Set(newest.map((log) => log.blockNumber))];
  const blocks = await Promise.all(
    blockNumbers.map((blockNumber) => runtime.client.getBlock({ blockNumber })),
  );
  const timestamps = new Map(blocks.map((block) => [block.number, Number(block.timestamp)]));
  const rows = await Promise.all(
    newest.map((log) => enrichLaunchLog(runtime, log, timestamps.get(log.blockNumber))),
  );
  return withTrenchMarkets(
    chainId,
    runtime.numeraire,
    rows.filter((pool): pool is DopplerPool => pool !== null),
  );
}

export async function fetchTrenchV5Token(chainId: number, token: Address): Promise<DopplerPool | null> {
  const manifest = trenchV5Manifest(chainId);
  if (!manifest) return null;
  const indexed = await fetchIndexedTrenchV5Token(chainId, token);
  if (indexed) {
    const [enriched] = await withTrenchMarkets(chainId, indexed.quoteToken.address as Address, [indexed]);
    return enriched;
  }
  const runtime = await verifyTrenchV5Runtime(chainId);
  const [log] = await newestLaunchLogs(runtime, token);
  if (!log) return null;
  const pool = await enrichLaunchLog(runtime, log);
  if (!pool) return null;
  const [enriched] = await withTrenchMarkets(chainId, runtime.numeraire, [pool]);
  return enriched;
}

export type TrenchV5LaunchInput = {
  name: string;
  symbol: string;
  salt: Hex;
  creator: Address;
};

export type TrenchV5LaunchPreview = {
  runtime: VerifiedTrenchV5Runtime;
  feeAmount: bigint;
  feeAsset: Address;
  feeNative: boolean;
  balance: bigint | null;
  allowance: bigint | null;
  needsApproval: boolean;
  startFdvRaw: bigint;
  graduationFdvRaw: bigint;
  expectedTerminalProceeds: bigint;
  tokenAddress: Address | null;
  curveTokenId: bigint | null;
};

function normalizedLaunch(input: TrenchV5LaunchInput): TrenchV5LaunchInput {
  const name = input.name.trim();
  const symbol = input.symbol.trim().toUpperCase();
  if (name.length < 1 || name.length > 64) throw new Error("Token name must be 1–64 characters.");
  if (!/^[A-Z0-9]{1,10}$/.test(symbol)) throw new Error("Symbol must be 1–10 letters or numbers.");
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.salt)) throw new Error("Launch salt must be 32 bytes.");
  return { ...input, name, symbol };
}

export async function previewTrenchV5Launch(
  publicClient: PublicClient,
  chainId: number,
  rawInput: TrenchV5LaunchInput,
): Promise<TrenchV5LaunchPreview> {
  const input = normalizedLaunch(rawInput);
  const runtime = await verifyTrenchV5Runtime(chainId);
  if (await publicClient.getChainId() !== chainId) throw new Error("Wallet RPC is on the wrong network.");
  const [
    paused,
    feeAmount,
    feeAsset,
    feeNative,
    startFdvRaw,
    graduationFdvRaw,
    expectedTerminalProceeds,
  ] = await Promise.all([
    publicClient.readContract({ address: runtime.manifest.factory, abi: trenchV5FactoryAbi, functionName: "paused" }),
    publicClient.readContract({ address: runtime.manifest.factory, abi: trenchV5FactoryAbi, functionName: "LAUNCH_FEE_AMOUNT" }),
    publicClient.readContract({ address: runtime.manifest.factory, abi: trenchV5FactoryAbi, functionName: "LAUNCH_FEE_ASSET" }),
    publicClient.readContract({ address: runtime.manifest.factory, abi: trenchV5FactoryAbi, functionName: "LAUNCH_FEE_NATIVE" }),
    publicClient.readContract({ address: runtime.manifest.factory, abi: trenchV5FactoryAbi, functionName: "ACTUAL_START_FDV_RAW" }),
    publicClient.readContract({ address: runtime.manifest.factory, abi: trenchV5FactoryAbi, functionName: "ACTUAL_GRADUATION_FDV_RAW" }),
    publicClient.readContract({ address: runtime.manifest.factory, abi: trenchV5FactoryAbi, functionName: "EXPECTED_TERMINAL_PROCEEDS" }),
  ]);
  if (paused) throw new Error("V5 launches are paused.");

  let balance: bigint | null = null;
  let allowance: bigint | null = null;
  if (!feeNative) {
    [balance, allowance] = await Promise.all([
      publicClient.readContract({ address: feeAsset, abi: erc20ApprovalAbi, functionName: "balanceOf", args: [input.creator] }),
      publicClient.readContract({
        address: feeAsset,
        abi: erc20ApprovalAbi,
        functionName: "allowance",
        args: [input.creator, runtime.manifest.factory],
      }),
    ]);
    if (balance < feeAmount) throw new Error("Your launch-fee token balance is too low.");
  }
  const needsApproval = !feeNative && (allowance ?? 0n) < feeAmount;
  if (needsApproval) {
    return {
      runtime, feeAmount, feeAsset, feeNative, balance, allowance,
      needsApproval, startFdvRaw, graduationFdvRaw, expectedTerminalProceeds,
      tokenAddress: null, curveTokenId: null,
    };
  }
  const simulation = await publicClient.simulateContract({
    address: runtime.manifest.factory,
    abi: trenchV5FactoryAbi,
    functionName: "launch",
    args: [input.name, input.symbol, input.salt],
    value: feeNative ? feeAmount : 0n,
    account: input.creator,
  });
  const [tokenAddress, curveTokenId] = simulation.result;
  return {
    runtime, feeAmount, feeAsset, feeNative, balance, allowance,
    needsApproval, startFdvRaw, graduationFdvRaw, expectedTerminalProceeds,
    tokenAddress, curveTokenId,
  };
}

export type TrenchV5LaunchStep = "approve" | "approve-confirm" | "launch" | "launch-confirm";
export type TrenchV5LaunchResult = {
  tokenAddress: Address;
  curveTokenId: bigint;
  transactionHash: Hash;
};

export async function executeTrenchV5Launch(
  publicClient: PublicClient,
  walletClient: WalletClient,
  chainId: number,
  rawInput: TrenchV5LaunchInput,
  onStep?: (step: TrenchV5LaunchStep) => void,
): Promise<TrenchV5LaunchResult> {
  const input = normalizedLaunch(rawInput);
  let preview = await previewTrenchV5Launch(publicClient, chainId, input);
  if (preview.needsApproval) {
    onStep?.("approve");
    const approveHash = await walletClient.writeContract({
      address: preview.feeAsset,
      abi: erc20ApprovalAbi,
      functionName: "approve",
      args: [preview.runtime.manifest.factory, preview.feeAmount],
      account: input.creator,
      chain: walletClient.chain,
    });
    onStep?.("approve-confirm");
    const approvalReceipt = await publicClient.waitForTransactionReceipt({ hash: approveHash });
    if (approvalReceipt.status !== "success") throw new Error("Launch-fee approval reverted.");
    preview = await previewTrenchV5Launch(publicClient, chainId, input);
  }

  onStep?.("launch");
  const simulation = await publicClient.simulateContract({
    address: preview.runtime.manifest.factory,
    abi: trenchV5FactoryAbi,
    functionName: "launch",
    args: [input.name, input.symbol, input.salt],
    value: preview.feeNative ? preview.feeAmount : 0n,
    account: input.creator,
  });
  const transactionHash = await walletClient.writeContract(simulation.request);
  onStep?.("launch-confirm");
  const receipt = await publicClient.waitForTransactionReceipt({ hash: transactionHash });
  if (receipt.status !== "success") throw new Error("V5 launch reverted.");

  const event = preview.runtime.manifest.engine === "v3-single-sided" ? V3_LAUNCH : V4_LAUNCH;
  const events = parseEventLogs({ abi: [event], eventName: "LaunchCreated", logs: receipt.logs });
  const created = events[0]?.args as unknown as { token?: Address; curveTokenId?: bigint };
  if (!created?.token || created.curveTokenId === undefined) {
    throw new Error("Launch confirmed, but the V5 LaunchCreated event was missing.");
  }
  return { tokenAddress: created.token, curveTokenId: created.curveTokenId, transactionHash };
}
