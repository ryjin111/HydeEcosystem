// Creator-fee harvest engine for 4663 HOODIE-stack launches (gojo 23892/23899/23904/23907).
// Pipeline (all permissionless, funds always go to the immutable on-chain creator):
//   collect(token) [collector]  → notes accrued V4 fees into the vault as rawFees (swap-free, oracle-free)
//   settle(token, asset, amountIn, minOut, deadline) [vault] → splits a raw leg 90 creator / 5 Hyde into
//       creatorClaimable. Numeraire leg = pure reclassification (ungated, minOut 0). LT leg = the system's
//       only swap (TWAP-floored + deviation-gated).
//   claimCreator(token) [vault]  → sends creatorClaimable to creator (reverts NOTHING at 0).
//
// This module is React-free — the pure read/sim/step seam the harvest UI + gates drive. Both raw legs
// are settled: the numeraire leg is a pure reclassification, while the LT leg uses the vault's guarded
// LT→numeraire swap. The vault itself enforces the TWAP floor + spot-deviation bound when callerMinOut=0.
import {
  encodeFunctionData, type Address, type Hex, type PublicClient, type WalletClient,
} from "viem";
import {
  V4_CONTRACTS_BY_CHAIN, hydeCollectorAbi, hydeVaultAbi,
  MAINNET_HOODIE_FEE_VAULT, MAINNET_HOODIE_FEE_COLLECTOR, HYDE_CREATOR_BPS, HYDE_NET_BPS,
} from "./constants";
import { isClaimConfirmed, type ReplacedReason } from "./txStatus";

/** Canonical Multicall3 on Robinhood Chain. The harvest calls are all permissionless and pay only the
 * immutable on-chain recipients, so batching changes neither authority nor fee destinations. */
export const ROBINHOOD_MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as Address;

const multicall3Abi = [{
  type: "function",
  name: "aggregate3",
  stateMutability: "payable",
  inputs: [{
    name: "calls",
    type: "tuple[]",
    components: [
      { name: "target", type: "address" },
      { name: "allowFailure", type: "bool" },
      { name: "callData", type: "bytes" },
    ],
  }],
  outputs: [{
    name: "returnData",
    type: "tuple[]",
    components: [
      { name: "success", type: "bool" },
      { name: "returnData", type: "bytes" },
    ],
  }],
}] as const;

export function hoodieFeeContracts(chainId: number): { vault: Address; collector: Address; numeraire: Address } {
  const c = V4_CONTRACTS_BY_CHAIN[chainId];
  if (!c?.hoodieNumeraire) throw new Error(`HOODIE fees not configured on chain ${chainId}`);
  return { vault: MAINNET_HOODIE_FEE_VAULT, collector: MAINNET_HOODIE_FEE_COLLECTOR, numeraire: c.hoodieNumeraire };
}

/** Creator's share of a raw leg once settled: 90 of the 95% net (gojo — rawH 1049.82 → 994.61). */
export const creatorShare = (raw: bigint): bigint => (raw * HYDE_CREATOR_BPS) / HYDE_NET_BPS;

/** Which fee affordance a card shows — a pure, deterministic decision (kami's state test):
 *  - `claim`      : creatorClaimable > 0 → settled, ready → "Claim X" (safe, drain-guarded).
 *  - `awaiting`   : nothing settled but numeraire pending > 0 → "Fees awaiting settlement · ~X" + harvest.
 *  - `lt-pending` : only token-side (LT) fees remain → "Token-side fees ready" + settle/claim.
 *  - `none`       : nothing settled and nothing pending → "No settled fees yet".
 *  - `unavailable`: the fee read failed (null) → honest "Unavailable", never "you earned nothing". */
export type FeeDisplay = "claim" | "awaiting" | "lt-pending" | "none" | "unavailable";
export function feeDisplayState(claimable: bigint | null, pendingHoodie: bigint | null, rawLT: bigint | null = 0n): FeeDisplay {
  if (claimable == null) return "unavailable";
  if (claimable > 0n) return "claim";
  if ((pendingHoodie ?? 0n) > 0n) return "awaiting";
  if ((rawLT ?? 0n) > 0n) return "lt-pending";
  return "none";
}

export type FeeState = {
  claimable: bigint;      // creatorClaimable — settled, ready to claim NOW
  rawNumeraire: bigint;   // rawFees[numeraire] AFTER a (simulated) collect — settle-able, ungated
  rawLT: bigint;          // rawFees[LT] AFTER collect — settled through the vault's guarded LT swap
  pendingHoodie: bigint;  // ~creator HOODIE awaiting settlement from the numeraire leg
};

const readCall = (to: Address, data: Hex, from: Address) => ({ from, to, data });

// Step calldata (shared by the sim gate, the per-step preflight, and the broadcast — one source, no drift).
const collectData = (token: Address): Hex => encodeFunctionData({ abi: hydeCollectorAbi, functionName: "collect", args: [token] });
const settleData = (token: Address, asset: Address, amountIn: bigint, minOut: bigint, deadline: bigint): Hex =>
  encodeFunctionData({ abi: hydeVaultAbi, functionName: "settle", args: [token, asset, amountIn, minOut, deadline] });
const claimData = (token: Address): Hex => encodeFunctionData({ abi: hydeVaultAbi, functionName: "claimCreator", args: [token] });

/** Classify a settle/collect/claim revert into an honest user reason (gojo 23904/23907). */
function revertReason(raw: string): string {
  if (/settle_dev|deviation/i.test(raw)) return "price unstable — try again shortly";
  if (/slippage_floor/i.test(raw)) return "price moved — try again";
  if (/no_output/i.test(raw)) return "fees are still too small to settle";
  if (/partial_fill/i.test(raw)) return "not enough active liquidity to settle";
  if (/over_raw/i.test(raw)) return "fees changed — refresh and retry";
  if (/nothing/i.test(raw)) return "nothing to harvest";
  if (/oracle_not_ready/i.test(raw)) return "settlement warming up — try shortly";
  return "harvest simulation failed";
}

/** Exact one-transaction gate: build the same Multicall3 payload the wallet would submit, then eth_call it
 *  from the connected wallet. A red simulation fails before the wallet is opened; no approximate/mirrored
 *  calldata is used. */
export async function simulateHarvestFlow(args: { client: PublicClient; token: Address; wallet: Address; chainId: number }): Promise<{ ok: boolean; reason?: string }> {
  const plan = await buildHarvestPlan(args.client, args.token, args.wallet, args.chainId);
  return simulateHarvestPlan(args.client, args.wallet, plan);
}

/** One eth_simulateV1 bundle on the CONFIGURED public RPC: [collect] then read rawFees(num/LT) +
 *  creatorClaimable — so the pending figure reflects everything a collect would surface, without a tx
 *  (gojo did exactly this to read the real ~994). Never a fabricated number. */
export async function readFeeState(args: { client: PublicClient; token: Address; chainId: number; from?: Address }): Promise<FeeState> {
  const { vault, collector, numeraire } = hoodieFeeContracts(args.chainId);
  const from = args.from ?? ("0x000000000000000000000000000000000000dEaD" as Address);
  const collect = encodeFunctionData({ abi: hydeCollectorAbi, functionName: "collect", args: [args.token] });
  const rawNum = encodeFunctionData({ abi: hydeVaultAbi, functionName: "rawFees", args: [args.token, numeraire] });
  const rawLt = encodeFunctionData({ abi: hydeVaultAbi, functionName: "rawFees", args: [args.token, args.token] });
  const cc = encodeFunctionData({ abi: hydeVaultAbi, functionName: "creatorClaimable", args: [args.token] });
  const calls = [
    readCall(collector, collect, from),
    readCall(vault, rawNum, from),
    readCall(vault, rawLt, from),
    readCall(vault, cc, from),
  ];
  const res = await args.client.request({
    method: "eth_simulateV1" as never,
    params: [{ blockStateCalls: [{ calls }], validation: false }, "latest"] as never,
  }) as never as { calls: { status: string; returnData: Hex }[] }[];
  const c = res?.[0]?.calls;
  if (!c || c.length < 4) throw new Error("fee sim unavailable");
  // ANY failed sub-call — collect (calls[0]) included — makes the whole state UNAVAILABLE. Never coerce a
  // failed read to 0 (kami/gojo 23916/23928 #3): a false 0 recreates the "No settled fees yet"
  // false-negative on real fees. The caller shows "Unavailable", never "you earned nothing".
  if (c.some((x) => x.status !== "0x1")) throw new Error("fee read reverted");
  const rawNumeraire = BigInt(c[1].returnData || "0x0");
  const rawLT = BigInt(c[2].returnData || "0x0");
  const claimable = BigInt(c[3].returnData || "0x0");
  return { claimable, rawNumeraire, rawLT, pendingHoodie: creatorShare(rawNumeraire) };
}

/** Fresh single reads (no collect) — used right before each broadcast step so a permissionless advance by
 *  anyone between steps can't brick a tx with a stale value (gojo 23907: settle amountIn > rawFees reverts
 *  OVER_RAW). */
export async function readRaw(client: PublicClient, token: Address, asset: Address, chainId: number): Promise<bigint> {
  const { vault } = hoodieFeeContracts(chainId);
  return client.readContract({ address: vault, abi: hydeVaultAbi, functionName: "rawFees", args: [token, asset] }) as Promise<bigint>;
}
export async function readClaimable(client: PublicClient, token: Address, chainId: number): Promise<bigint> {
  const { vault } = hoodieFeeContracts(chainId);
  return client.readContract({ address: vault, abi: hydeVaultAbi, functionName: "creatorClaimable", args: [token] }) as Promise<bigint>;
}

export type HarvestStep = "collect" | "settle" | "claim";
export type StepStatus = "confirming" | "done" | "skipped" | "failed";
type StepCb = (step: HarvestStep, status: StepStatus, detail?: string) => void;

type BatchCall = { target: Address; allowFailure: false; callData: Hex };
type HarvestPlan = {
  calls: BatchCall[];
  data: Hex;
  steps: Record<HarvestStep, boolean>;
};

/** Build one atomic collect→settle(all legs)→claim payload from the projected post-collect state. Every
 * sub-call is allowFailure=false, so the batch either completes in full or changes nothing. */
async function buildHarvestPlan(
  client: PublicClient,
  token: Address,
  wallet: Address,
  chainId: number,
): Promise<HarvestPlan> {
  const { vault, collector, numeraire } = hoodieFeeContracts(chainId);
  const [rawNumBefore, rawLTBefore, projected] = await Promise.all([
    readRaw(client, token, numeraire, chainId),
    readRaw(client, token, token, chainId),
    readFeeState({ client, token, chainId, from: wallet }),
  ]);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const needsCollect =
    projected.rawNumeraire > rawNumBefore
    || projected.rawLT > rawLTBefore;
  const needsSettle = projected.rawNumeraire > 0n || projected.rawLT > 0n;
  const needsClaim = projected.claimable > 0n || needsSettle;
  const calls: BatchCall[] = [];

  if (needsCollect) {
    calls.push({ target: collector, allowFailure: false, callData: collectData(token) });
  }
  if (projected.rawNumeraire > 0n) {
    calls.push({
      target: vault,
      allowFailure: false,
      callData: settleData(token, numeraire, projected.rawNumeraire, 0n, deadline),
    });
  }
  if (projected.rawLT > 0n) {
    calls.push({
      target: vault,
      allowFailure: false,
      callData: settleData(token, token, projected.rawLT, 0n, deadline),
    });
  }
  if (needsClaim) {
    calls.push({ target: vault, allowFailure: false, callData: claimData(token) });
  }

  const data = encodeFunctionData({
    abi: multicall3Abi,
    functionName: "aggregate3",
    args: [calls],
  });
  return {
    calls,
    data,
    steps: { collect: needsCollect, settle: needsSettle, claim: needsClaim },
  };
}

async function simulateHarvestPlan(
  client: PublicClient,
  wallet: Address,
  plan: HarvestPlan,
): Promise<{ ok: boolean; reason?: string }> {
  if (plan.calls.length === 0) return { ok: false, reason: "nothing to harvest" };
  try {
    await client.call({ account: wallet, to: ROBINHOOD_MULTICALL3, data: plan.data });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: revertReason(e instanceof Error ? e.message : String(e)) };
  }
}

/** The step a Resume should continue at = the first not-done/not-skipped step (null when all done). Drives a
 *  truthful "Resume — <step>" label instead of a hardcoded one (kami 23916 #2). Pure, deterministically tested. */
export function nextHarvestStep(steps: Record<HarvestStep, StepStatus | "idle">): HarvestStep | null {
  return (["collect", "settle", "claim"] as HarvestStep[]).find((s) => steps[s] !== "done" && steps[s] !== "skipped") ?? null;
}

async function send(walletClient: WalletClient, publicClient: PublicClient, to: Address, data: Hex, account: Address): Promise<void> {
  const hash = await walletClient.sendTransaction({ to, data, account, chain: walletClient.chain, value: 0n });
  // Same receipt trap as the claim (kami 23902/23908): viem resolves reverted AND replacement receipts —
  // a cancellation self-tx mines "success". Only the original success or a repriced speed-up counts.
  let replaced: ReplacedReason | null = null;
  const receipt = await publicClient.waitForTransactionReceipt({ hash, onReplaced: (r) => { replaced = r.reason as ReplacedReason; } });
  if (!isClaimConfirmed(receipt.status, replaced)) throw new Error(replaced === "cancelled" ? "CANCELLED" : "REVERTED");
}

// `ltPending`: true = token-side fees remain · false = none · null = the LT read FAILED (unknown) — never
// coerce a failed read to "no remainder" (kami 23937), so the UI can't imply fully-harvested when unsure.
export type HarvestResult = { claimed: boolean; ltPending: boolean | null };

/**
 * Run the harvest as ONE atomic Multicall3 transaction. The exact wallet payload is eth_call-preflighted;
 * all planned steps share one confirmation and either all complete or all revert. Funds still move only to
 * the vault's immutable creator/Hyde recipients.
 */
export async function runHarvest(args: {
  publicClient: PublicClient; walletClient: WalletClient; token: Address; wallet: Address; chainId: number; onStep: StepCb;
}): Promise<HarvestResult> {
  const { publicClient: pc, walletClient: wc, token, wallet, onStep } = args;
  const plan = await buildHarvestPlan(pc, token, wallet, args.chainId);
  const pre = await simulateHarvestPlan(pc, wallet, plan);
  if (!pre.ok) throw new Error(pre.reason ?? "harvest simulation failed");

  (["collect", "settle", "claim"] as HarvestStep[]).forEach((step) => {
    onStep(step, plan.steps[step] ? "confirming" : "skipped");
  });
  try {
    await send(wc, pc, ROBINHOOD_MULTICALL3, plan.data, wallet);
    (["collect", "settle", "claim"] as HarvestStep[]).forEach((step) => {
      if (plan.steps[step]) onStep(step, "done");
    });
  } catch (e) {
    (["collect", "settle", "claim"] as HarvestStep[]).forEach((step) => {
      if (plan.steps[step]) onStep(step, "failed");
    });
    throw e;
  }

  // Token-side (LT) fees left over → the guarded settlement may have been raced or a fresh fee arrived.
  // A FAILED read is `null` (unknown), never coerced to "no remainder" (kami 23937) — the UI then avoids
  // asserting fully-harvested. The authoritative post-harvest state comes from the refetch (readFeeState).
  let ltPending: boolean | null;
  try { ltPending = (await readRaw(pc, token, token, args.chainId)) > 0n; }
  catch { ltPending = null; }
  return { claimed: plan.steps.claim, ltPending };
}
