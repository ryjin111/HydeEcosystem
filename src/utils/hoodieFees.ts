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
 *  - `claim`     : creatorClaimable > 0 → settled, ready → "Claim X" (safe, drain-guarded).
 *  - `awaiting`  : nothing settled but pending > 0 → "Fees awaiting settlement · ~X" + Collect & Claim.
 *  - `none`      : nothing settled and nothing pending → "No settled fees yet".
 *  - `unavailable`: the fee read failed (null) → honest "Unavailable", never "you earned nothing". */
export type FeeDisplay = "claim" | "awaiting" | "none" | "unavailable";
export function feeDisplayState(claimable: bigint | null, pendingHoodie: bigint | null): FeeDisplay {
  if (claimable == null) return "unavailable";
  if (claimable > 0n) return "claim";
  if ((pendingHoodie ?? 0n) > 0n) return "awaiting";
  return "none";
}

export type FeeState = {
  claimable: bigint;      // creatorClaimable — settled, ready to claim NOW
  rawNumeraire: bigint;   // rawFees[numeraire] AFTER a (simulated) collect — settle-able, ungated
  rawLT: bigint;          // rawFees[LT] AFTER collect — needs the oracle-gated LT settle (v1 defers)
  pendingHoodie: bigint;  // ~creator HOODIE awaiting settlement from the numeraire leg
};

const readCall = (to: Address, data: Hex, from: Address) => ({ from, to, data });

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
  const rawNumeraire = c[1].status === "0x1" ? BigInt(c[1].returnData || "0x0") : 0n;
  const rawLT = c[2].status === "0x1" ? BigInt(c[2].returnData || "0x0") : 0n;
  const claimable = c[3].status === "0x1" ? BigInt(c[3].returnData || "0x0") : 0n;
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

async function send(walletClient: WalletClient, publicClient: PublicClient, to: Address, data: Hex, account: Address): Promise<void> {
  const hash = await walletClient.sendTransaction({ to, data, account, chain: walletClient.chain, value: 0n });
  // Same receipt trap as the claim (kami 23902/23908): viem resolves reverted AND replacement receipts —
  // a cancellation self-tx mines "success". Only the original success or a repriced speed-up counts.
  let replaced: ReplacedReason | null = null;
  const receipt = await publicClient.waitForTransactionReceipt({ hash, onReplaced: (r) => { replaced = r.reason as ReplacedReason; } });
  if (!isClaimConfirmed(receipt.status, replaced)) throw new Error(replaced === "cancelled" ? "CANCELLED" : "REVERTED");
}

/**
 * Run the harvest. Each step RE-READS fresh chain state first and SKIPS if already advanced (permissionless
 * collapse), so a re-click cleanly resumes from the first not-done step — never re-collects, never sends a
 * reverting tx. v1: numeraire leg only (ungated); the LT leg is reported via `onStep('settle','skipped',
 * 'lt-pending')` when rawLT>0 so the UI can flag it. Returns true if anything was delivered/claimed.
 */
export async function runHarvest(args: {
  publicClient: PublicClient; walletClient: WalletClient; token: Address; wallet: Address; chainId: number; onStep: StepCb;
}): Promise<boolean> {
  const { vault, collector, numeraire } = hoodieFeeContracts(args.chainId);
  const { publicClient: pc, walletClient: wc, token, wallet, onStep } = args;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);

  // 1. Collect — only if a sim shows in-position fees beyond what's already collected.
  const rawNumBefore = await readRaw(pc, token, numeraire, args.chainId);
  const projected = await readFeeState({ client: pc, token, chainId: args.chainId, from: wallet }).then((s) => s.rawNumeraire).catch(() => rawNumBefore);
  if (projected > rawNumBefore) {
    onStep("collect", "confirming");
    await send(wc, pc, collector, encodeFunctionData({ abi: hydeCollectorAbi, functionName: "collect", args: [token] }), wallet);
    onStep("collect", "done");
  } else {
    onStep("collect", "skipped");
  }

  // 2. Settle the numeraire leg with a FRESH amountIn (gojo 23907 — avoids OVER_RAW). LT leg flagged only.
  const freshRawNum = await readRaw(pc, token, numeraire, args.chainId);
  if (freshRawNum > 0n) {
    onStep("settle", "confirming");
    await send(wc, pc, vault, encodeFunctionData({ abi: hydeVaultAbi, functionName: "settle", args: [token, numeraire, freshRawNum, 0n, deadline] }), wallet);
    onStep("settle", "done");
  } else {
    const rawLt = await readRaw(pc, token, token, args.chainId).catch(() => 0n);
    onStep("settle", "skipped", rawLt > 0n ? "lt-pending" : undefined);
  }

  // 3. Claim — fresh read; skip if nothing settled (someone may have claimed in a race).
  const claimable = await readClaimable(pc, token, args.chainId);
  if (claimable > 0n) {
    onStep("claim", "confirming");
    await send(wc, pc, vault, encodeFunctionData({ abi: hydeVaultAbi, functionName: "claimCreator", args: [token] }), wallet);
    onStep("claim", "done");
    return true;
  }
  onStep("claim", "skipped");
  return false;
}
