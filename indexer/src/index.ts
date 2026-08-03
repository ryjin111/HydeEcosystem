import { ponder } from "ponder:registry";
import { creatorFeeEvent, launch, poolSwap, tokenHolder } from "ponder:schema";
import type { Address } from "viem";
import { erc20MetadataAbi, trenchGraduatorAbi } from "../abis/trenchV5";
import { indexerChainById, LEGACY_SOURCES } from "./chains";

const WAD = 1_000_000_000_000_000_000n;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

function lower(address: Address): Address {
  return address.toLowerCase() as Address;
}

function curveState(state: number): "curve-active" | "graduation-signaled" | "graduated" {
  if (state === 3) return "graduated";
  if (state === 2) return "graduation-signaled";
  return "curve-active";
}

type Progress = {
  sold: bigint;
  curveAllocation: bigint;
  progressWad: bigint;
  quotePrincipal: bigint;
  minimumProceeds: bigint;
  signaledAt: bigint;
  finalizableAt: bigint;
  state: number;
};

function successful<T>(result: { status: string; result?: unknown } | undefined, fallback: T): T {
  return result?.status === "success" ? result.result as T : fallback;
}

async function storeLaunch(
  context: any,
  event: any,
  engine: "v3-single-sided" | "v4-hook",
) {
  const chain = indexerChainById(context.chain.id);
  if (!chain) throw new Error(`Unsupported Hydeout indexer chain ${context.chain.id}`);
  const token = lower(event.args.token as Address);
  const reads = await context.client.multicall({
    allowFailure: true,
    contracts: [
      { address: token, abi: erc20MetadataAbi, functionName: "name" },
      { address: token, abi: erc20MetadataAbi, functionName: "symbol" },
      { address: token, abi: erc20MetadataAbi, functionName: "decimals" },
      { address: chain.graduator, abi: trenchGraduatorAbi, functionName: "curveProgress", args: [token] },
    ],
  });
  const progress = successful<Progress | null>(reads[3], null);
  const initial = {
    sold: progress?.sold ?? 0n,
    curveAllocation: progress?.curveAllocation ?? 0n,
    progressWad: progress?.progressWad ?? 0n,
    quotePrincipal: progress?.quotePrincipal ?? 0n,
    minimumProceeds: progress?.minimumProceeds ?? 0n,
    signaledAt: progress?.signaledAt ?? 0n,
    finalizableAt: progress?.finalizableAt ?? 0n,
  };

  await context.db
    .insert(launch)
    .values({
      chainId: chain.id,
      token,
      creator: lower(event.args.creator as Address),
      poolAddress: engine === "v3-single-sided" ? lower(event.args.pool as Address) : null,
      poolId: engine === "v4-hook" ? event.args.poolId : null,
      name: successful<string>(reads[0], "Unknown token"),
      symbol: successful<string>(reads[1], "TOKEN"),
      decimals: Number(successful<number>(reads[2], 18)),
      engine,
      numeraire: lower(chain.numeraire),
      quoteSymbol: chain.quoteSymbol,
      quoteDecimals: chain.quoteDecimals,
      protocolVersion: "v5-trench",
      source: engine === "v3-single-sided" ? "trench-v3-factory" : "trench-v4-factory",
      curveState: curveState(progress?.state ?? 1),
      ...initial,
      creatorClaimableToken: 0n,
      creatorClaimableNumeraire: 0n,
      createdAt: BigInt(event.block.timestamp),
      createdBlock: event.block.number,
      createdTransaction: event.transaction.hash,
      lastUpdatedBlock: event.block.number,
    })
    .onConflictDoUpdate({
      name: successful<string>(reads[0], "Unknown token"),
      symbol: successful<string>(reads[1], "TOKEN"),
      curveState: curveState(progress?.state ?? 1),
      progressWad: initial.progressWad,
      sold: initial.sold,
      quotePrincipal: initial.quotePrincipal,
      lastUpdatedBlock: event.block.number,
    });
}

type LegacyLaunchConfig = {
  engine: "v3-single-sided" | "v4-hook";
  source: string;
  token: Address;
  creator: Address;
  poolAddress?: Address;
  poolId?: `0x${string}`;
  numeraire: Address;
  quoteSymbol: string;
  quoteDecimals: number;
};

async function storeLegacyLaunch(context: any, event: any, config: LegacyLaunchConfig) {
  const chain = indexerChainById(context.chain.id);
  if (!chain) throw new Error(`Unsupported Hydeout indexer chain ${context.chain.id}`);
  const token = lower(config.token);
  const reads = await context.client.multicall({
    allowFailure: true,
    contracts: [
      { address: token, abi: erc20MetadataAbi, functionName: "name" },
      { address: token, abi: erc20MetadataAbi, functionName: "symbol" },
      { address: token, abi: erc20MetadataAbi, functionName: "decimals" },
    ],
  });
  const name = successful<string>(reads[0], "Unknown token");
  const symbol = successful<string>(reads[1], "TOKEN");

  await context.db
    .insert(launch)
    .values({
      chainId: chain.id,
      token,
      creator: lower(config.creator),
      poolAddress: config.poolAddress ? lower(config.poolAddress) : null,
      poolId: config.poolId ?? null,
      name,
      symbol,
      decimals: Number(successful<number>(reads[2], 18)),
      engine: config.engine,
      numeraire: lower(config.numeraire),
      quoteSymbol: config.quoteSymbol,
      quoteDecimals: config.quoteDecimals,
      protocolVersion: "legacy-instant",
      source: config.source,
      curveState: "curve-active",
      progressWad: 0n,
      sold: 0n,
      curveAllocation: 0n,
      quotePrincipal: 0n,
      minimumProceeds: 0n,
      signaledAt: 0n,
      finalizableAt: 0n,
      creatorClaimableToken: 0n,
      creatorClaimableNumeraire: 0n,
      createdAt: BigInt(event.block.timestamp),
      createdBlock: event.block.number,
      createdTransaction: event.transaction.hash,
      lastUpdatedBlock: event.block.number,
    })
    .onConflictDoUpdate({ name, symbol, lastUpdatedBlock: event.block.number });
}

async function updateGraduation(context: any, event: any, state: "graduation-signaled" | "graduated") {
  const chainId = context.chain.id as number;
  const token = lower(event.args.token as Address);
  const row = await context.db.find(launch, { chainId, token });
  if (!row) return;
  await context.db.update(launch, { chainId, token }).set({
    curveState: state,
    progressWad: state === "graduated" ? WAD : row.progressWad,
    signaledAt: state === "graduation-signaled" ? BigInt(event.args.signaledAt) : row.signaledAt,
    finalizableAt: state === "graduation-signaled" ? BigInt(event.args.finalizableAt) : row.finalizableAt,
    quotePrincipal: state === "graduated" ? BigInt(event.args.quotePrincipal) : row.quotePrincipal,
    lastUpdatedBlock: event.block.number,
  });
}

async function recordCreatorFee(context: any, event: any, kind: "credited" | "claimed") {
  const chainId = context.chain.id as number;
  const token = lower(event.args.token as Address);
  const asset = lower(event.args.asset as Address);
  const row = await context.db.find(launch, { chainId, token });
  if (!row) return;
  const amount = BigInt(kind === "credited" ? event.args.creatorCut : event.args.amount);
  const tokenSide = asset === token;
  const current = tokenSide ? row.creatorClaimableToken : row.creatorClaimableNumeraire;
  const next = kind === "credited" ? current + amount : current > amount ? current - amount : 0n;

  await context.db.update(launch, { chainId, token }).set({
    ...(tokenSide ? { creatorClaimableToken: next } : { creatorClaimableNumeraire: next }),
    lastUpdatedBlock: event.block.number,
  });
  await context.db.insert(creatorFeeEvent).values({
    id: event.id,
    chainId,
    token,
    asset,
    creator: row.creator,
    kind,
    amount,
    blockNumber: event.block.number,
    timestamp: BigInt(event.block.timestamp),
    transactionHash: event.transaction.hash,
  });
}

async function updateHolderBalance(
  context: any,
  chainId: number,
  token: Address,
  holder: Address,
  delta: bigint,
  blockNumber: bigint,
) {
  if (holder === ZERO_ADDRESS || delta === 0n) return;
  await context.db
    .insert(tokenHolder)
    .values({
      chainId,
      token,
      holder,
      balance: delta > 0n ? delta : 0n,
      lastUpdatedBlock: blockNumber,
    })
    .onConflictDoUpdate((row: typeof tokenHolder.$inferSelect) => ({
      balance: delta > 0n ? row.balance + delta : row.balance > -delta ? row.balance + delta : 0n,
      lastUpdatedBlock: blockNumber,
    }));
}

async function recordTransfer(context: any, event: any) {
  const chainId = context.chain.id as number;
  const token = lower(event.log.address as Address);
  const from = lower(event.args.from as Address);
  const to = lower(event.args.to as Address);
  if (from === to) return;
  const value = BigInt(event.args.value);
  await updateHolderBalance(context, chainId, token, from, -value, event.block.number);
  await updateHolderBalance(context, chainId, token, to, value, event.block.number);
}

async function recordV3Swap(context: any, event: any) {
  await context.db.insert(poolSwap).values({
    id: event.id,
    chainId: context.chain.id,
    poolAddress: lower(event.log.address as Address),
    sender: lower(event.args.sender as Address),
    recipient: lower(event.args.recipient as Address),
    amount0: BigInt(event.args.amount0),
    amount1: BigInt(event.args.amount1),
    blockNumber: event.block.number,
    timestamp: BigInt(event.block.timestamp),
    transactionHash: event.transaction.hash,
    logIndex: event.log.logIndex,
  }).onConflictDoNothing();
}

ponder.on("TrenchV3Factory:LaunchCreated", async ({ event, context }) => {
  await storeLaunch(context, event, "v3-single-sided");
});

ponder.on("TrenchV4Factory:LaunchCreated", async ({ event, context }) => {
  await storeLaunch(context, event, "v4-hook");
});

ponder.on("TrenchV3Graduator:GraduationSignaled", async ({ event, context }) => {
  await updateGraduation(context, event, "graduation-signaled");
});

ponder.on("TrenchV4Graduator:GraduationSignaled", async ({ event, context }) => {
  await updateGraduation(context, event, "graduation-signaled");
});

ponder.on("TrenchV3Graduator:Graduated", async ({ event, context }) => {
  await updateGraduation(context, event, "graduated");
});

ponder.on("TrenchV4Graduator:Graduated", async ({ event, context }) => {
  await updateGraduation(context, event, "graduated");
});

ponder.on("TrenchV3Locker:FeeCredited", async ({ event, context }) => {
  await recordCreatorFee(context, event, "credited");
});

ponder.on("TrenchV4Locker:FeeCredited", async ({ event, context }) => {
  await recordCreatorFee(context, event, "credited");
});

ponder.on("TrenchV3Locker:CreatorClaimed", async ({ event, context }) => {
  await recordCreatorFee(context, event, "claimed");
});

ponder.on("TrenchV4Locker:CreatorClaimed", async ({ event, context }) => {
  await recordCreatorFee(context, event, "claimed");
});

ponder.on("LegacyStableV3Pad:LaunchCreated", async ({ event, context }) => {
  await storeLegacyLaunch(context, event, {
    engine: "v3-single-sided",
    source: "legacy-stable-v3-pad",
    token: event.args.token,
    creator: event.args.creator,
    poolAddress: event.args.pool,
    numeraire: indexerChainById(context.chain.id)!.numeraire,
    quoteSymbol: "USDT0",
    quoteDecimals: 6,
  });
});

ponder.on("LegacyArbitrumV4Factory:LaunchCreated", async ({ event, context }) => {
  await storeLegacyLaunch(context, event, {
    engine: "v4-hook",
    source: "legacy-arbitrum-v4-factory",
    token: event.args.token,
    creator: event.args.creator,
    poolId: event.args.poolId,
    numeraire: indexerChainById(context.chain.id)!.numeraire,
    quoteSymbol: "WETH",
    quoteDecimals: 18,
  });
});

ponder.on("LegacyRobinhoodV4Factory:LaunchCreated", async ({ event, context }) => {
  await storeLegacyLaunch(context, event, {
    engine: "v4-hook",
    source: "legacy-robinhood-weth-factory",
    token: event.args.token,
    creator: event.args.creator,
    poolId: event.args.poolId,
    numeraire: indexerChainById(context.chain.id)!.numeraire,
    quoteSymbol: "WETH",
    quoteDecimals: 18,
  });
});

ponder.on("LegacyRobinhoodHoodieEngine:HoodieLaunchCreated", async ({ event, context }) => {
  await storeLegacyLaunch(context, event, {
    engine: "v4-hook",
    source: "legacy-robinhood-hoodie-engine",
    token: event.args.token,
    creator: event.args.creator,
    poolId: event.args.poolId,
    numeraire: LEGACY_SOURCES.robinhoodHoodieEngine.numeraire,
    quoteSymbol: LEGACY_SOURCES.robinhoodHoodieEngine.quoteSymbol,
    quoteDecimals: LEGACY_SOURCES.robinhoodHoodieEngine.quoteDecimals,
  });
});

for (const contract of [
  "TrenchV3Token",
  "TrenchV4Token",
  "LegacyStableToken",
  "LegacyArbitrumToken",
  "LegacyRobinhoodWethToken",
  "LegacyRobinhoodHoodieToken",
] as const) {
  ponder.on(`${contract}:Transfer`, async ({ event, context }) => {
    await recordTransfer(context, event);
  });
}

ponder.on("TrenchV3Pool:Swap", async ({ event, context }) => {
  await recordV3Swap(context, event);
});

ponder.on("LegacyStableV3Pool:Swap", async ({ event, context }) => {
  await recordV3Swap(context, event);
});
