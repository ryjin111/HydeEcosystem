// Creator-fee harvest engine for 4663 HOODIE-stack launches (gojo 23892/23899/23904/23907).
// Pipeline (all permissionless, funds always go to the immutable on-chain creator):
//   collect(token) [collector]  → notes accrued V4 fees into the vault as rawFees (swap-free, oracle-free)
//   settle(token, asset, amountIn, minOut, deadline) [vault] → splits a raw leg 90 creator / 5 Hyde into
//       creatorClaimable. Numeraire leg = pure reclassification (ungated, minOut 0). LT leg = the system's
//       only swap (TWAP-floored + deviation-gated).
//   claimCreator(token) [vault]  → sends creatorClaimable to creator (reverts NOTHING at 0).
//
// This module is React-free — the pure read/sim/step seam the harvest UI + gates drive. v1 harvests the
// always-ungated NUMERAIRE leg (delivers e.g. LILHOODIE's ~994 HOODIE); the oracle-gated LT-leg swap
// (derived minOut) is surfaced but left to a follow-up (rawLT ~0 on LILHOODIE today).
import {
  encodeFunctionData, type Address, type Hex, type PublicClient, type WalletClient,
} from "viem";
import {
  V4_CONTRACTS_BY_CHAIN, hydeCollectorAbi, hydeVaultAbi,
  MAINNET_HOODIE_FEE_VAULT, MAINNET_HOODIE_FEE_COLLECTOR, HYDE_CREATOR_BPS, HYDE_NET_BPS,
} from "./constants";
import { isClaimConfirmed, type ReplacedReason } from "./txStatus";

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
 *  - `lt-pending` : only token-side (LT) fees remain → "Token-side fees pending" (LT settle is a follow-up;
 *                   NOT harvestable in v1, and NOT "nothing" — kami 23916 #4).
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
  rawLT: bigint;          // rawFees[LT] AFTER collect — needs the oracle-gated LT settle (v1 defers)
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
  if (/over_raw/i.test(raw)) return "fees changed — refresh and retry";
  if (/nothing/i.test(raw)) return "nothing to harvest";
  if (/oracle_not_ready/i.test(raw)) return "settlement warming up — try shortly";
  return "harvest simulation failed";
}

/** INITIAL full-flow gate (kami 23916 #1): one eth_simulateV1 bundle of the planned collect→settle→claim
 *  on the CONFIGURED public RPC — fail fast BEFORE any wallet tx, with an honest reason. `readFeeState`
 *  throws (→ Unavailable) if the fee reads fail; a red step here returns ok:false + reason (no broadcast). */
export async function simulateHarvestFlow(args: { client: PublicClient; token: Address; wallet: Address; chainId: number }): Promise<{ ok: boolean; reason?: string }> {
  const { vault, collector, numeraire } = hoodieFeeContracts(args.chainId);
  const fs = await readFeeState({ client: args.client, token: args.token, chainId: args.chainId, from: args.wallet });
  const dl = BigInt(Math.floor(Date.now() / 1000) + 600);
  const calls = [readCall(collector, collectData(args.token), args.wallet)];
  if (fs.rawNumeraire > 0n) calls.push(readCall(vault, settleData(args.token, numeraire, fs.rawNumeraire, 0n, dl), args.wallet));
  calls.push(readCall(vault, claimData(args.token), args.wallet));
  const res = await args.client.request({
    method: "eth_simulateV1" as never,
    params: [{ blockStateCalls: [{ calls }], validation: false }, "latest"] as never,
  }) as never as { calls: { status: string; returnData: Hex; error?: { message?: string } }[] }[];
  // FAIL-CLOSED: an empty/missing/truncated result must NOT read as success (kami 23937 — `findIndex`
  // returns -1 on `[]`). Require exactly one block whose calls array matches the planned length; anything
  // else = simulation unavailable, never authorize a broadcast.
  const cc = Array.isArray(res) && res.length === 1 ? res[0]?.calls : undefined;
  if (!Array.isArray(cc) || cc.length !== calls.length) return { ok: false, reason: "harvest simulation unavailable" };
  const bad = cc.findIndex((x) => x.status !== "0x1");
  if (bad === -1) return { ok: true };
  return { ok: false, reason: revertReason((cc[bad].error?.message ?? cc[bad].returnData ?? "").toString()) };
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
 * Run the harvest. An INITIAL full-flow sim gates the whole thing (fail fast, honest reason, no tx). Each
 * step then RE-READS fresh state, SIMULATES the exact call right before broadcasting (kami 23916 #1 — a red
 * sim aborts with no tx), and SKIPS if already advanced (permissionless collapse → clean resume). A step's
 * failure marks THAT step `failed` and rethrows, so the UI resumes at the right place (kami #2). Returns
 * whether a claim landed and whether token-side (LT) fees remain (kami #4).
 */
export async function runHarvest(args: {
  publicClient: PublicClient; walletClient: WalletClient; token: Address; wallet: Address; chainId: number; onStep: StepCb;
}): Promise<HarvestResult> {
  const { vault, collector, numeraire } = hoodieFeeContracts(args.chainId);
  const { publicClient: pc, walletClient: wc, token, wallet, onStep } = args;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);

  // Initial full-flow gate — fail fast before any wallet tx (kami #1).
  const pre = await simulateHarvestFlow({ client: pc, token, wallet, chainId: args.chainId });
  if (!pre.ok) throw new Error(pre.reason ?? "harvest simulation failed");

  // Preflight the EXACT call (eth_call, no state change) then broadcast; a red sim aborts with no tx, and
  // any error marks THIS step `failed` before rethrowing so the stepper shows the truth (kami #1/#2).
  const doStep = async (name: HarvestStep, to: Address, data: Hex) => {
    onStep(name, "confirming");
    try {
      await pc.call({ account: wallet, to, data }); // reverts throw → no broadcast
      await send(wc, pc, to, data, wallet);
      onStep(name, "done");
    } catch (e) {
      onStep(name, "failed");
      throw e;
    }
  };

  // 1. Collect — only if there are uncollected in-position fees (else skip; never a redundant tx).
  const rawNumBefore = await readRaw(pc, token, numeraire, args.chainId);
  const projected = (await readFeeState({ client: pc, token, chainId: args.chainId, from: wallet })).rawNumeraire; // throws → Unavailable
  if (projected > rawNumBefore) await doStep("collect", collector, collectData(token));
  else onStep("collect", "skipped");

  // 2. Settle the numeraire leg with a FRESH amountIn (gojo 23907 — avoids OVER_RAW).
  const freshRawNum = await readRaw(pc, token, numeraire, args.chainId);
  if (freshRawNum > 0n) await doStep("settle", vault, settleData(token, numeraire, freshRawNum, 0n, deadline));
  else onStep("settle", "skipped");

  // 3. Claim — fresh read; skip if nothing settled (a race may have claimed already).
  const claimable = await readClaimable(pc, token, args.chainId);
  let claimed = false;
  if (claimable > 0n) { await doStep("claim", vault, claimData(token)); claimed = true; }
  else onStep("claim", "skipped");

  // Token-side (LT) fees left over → not fully harvested; the UI surfaces an LT-pending state (kami #4).
  // A FAILED read is `null` (unknown), never coerced to "no remainder" (kami 23937) — the UI then avoids
  // asserting fully-harvested. The authoritative post-harvest state comes from the refetch (readFeeState).
  let ltPending: boolean | null;
  try { ltPending = (await readRaw(pc, token, token, args.chainId)) > 0n; }
  catch { ltPending = null; }
  return { claimed, ltPending };
}
