// HOODIE-numeraire swap engine (own-stack Hyde tokens on 4663). The V4 Quoter reverts on the
// dynamic-fee hook pool and StateView shows 0 liquidity at the current tick (single-sided seed), so
// quoting/preflight run through `eth_simulateV1`: a stateful bundle
// [balanceOf(out) → token.approve(Permit2) → Permit2.approve(token,UR) → UR.execute → balanceOf(out)]
// that returns the recipient's NET output-token delta — an accurate fill that already prices the full
// trade impact (kami 23869; proven on live 4663: 1 HOODIE → 0.99 LILHOODIE, matches gojo's golden 23851).
//
// This module carries NO React — it's the pure encode/sim seam the swap gate exercises directly.
import {
  encodeFunctionData, encodeAbiParameters, parseAbiParameters, keccak256, parseUnits,
  maxUint256, maxUint160, maxUint48, type Address, type Hex, type PublicClient,
} from "viem";
import {
  V4_CONTRACTS_BY_CHAIN, HYDE_DYNAMIC_FEE, HYDE_TICK_SPACING,
  erc20Abi, permit2Abi, universalRouterExecuteAbi,
} from "./constants";
import { buildSwapTemplatePayload } from "./v4Encoding";

/** The fixed swap-lane addresses for a HOODIE pool on a chain. Throws if the chain isn't wired for
 *  HOODIE (no numeraire/hook) — the card only renders for HOODIE pairs, so this is a guard, not a path. */
export function hoodieSwapContracts(chainId: number): { hoodie: Address; hook: Address; universalRouter: Address; permit2: Address } {
  const c = V4_CONTRACTS_BY_CHAIN[chainId];
  if (!c?.hoodieNumeraire || !c?.hoodieHook) throw new Error(`HOODIE swap not configured on chain ${chainId}`);
  return { hoodie: c.hoodieNumeraire, hook: c.hoodieHook, universalRouter: c.universalRouter, permit2: c.permit2 };
}

/** poolId = keccak256(abi.encode(PoolKey)). All-static struct → tuple-encode the 5 fields. Currencies
 *  are sorted (token vs HOODIE) exactly as the pool was created; a wrong key would not resolve on-chain
 *  via hook.active(poolId) (self-checked in the card). */
export function hoodiePoolId(token: Address, chainId: number): Hex {
  const { hoodie, hook } = hoodieSwapContracts(chainId);
  const [c0, c1] = token.toLowerCase() < hoodie.toLowerCase() ? [token, hoodie] : [hoodie, token];
  return keccak256(encodeAbiParameters(
    parseAbiParameters("address,address,uint24,int24,address"),
    [c0, c1, HYDE_DYNAMIC_FEE, HYDE_TICK_SPACING, hook],
  ));
}

/** Build the UniversalRouter payload for a HOODIE buy/sell through the FROZEN encoder (sweep:false →
 *  commands=0x10, the proven ERC20-numeraire path). BUY = HOODIE→token, SELL = token→HOODIE; the encoder
 *  sorts currencies + sets zeroForOne. `amountOutQuoted`/`slippagePercent` set minOut (0/0 for a max-fill
 *  quote; the sim'd output + a tight buffer for the real submit). */
export function buildHoodieSwap(args: {
  token: Address; decimals: number; isBuy: boolean; recipient: Address;
  amountIn: string; amountOutQuoted: string; slippagePercent: string; chainId: number;
}): { commands: Hex; inputs: Hex[] } {
  const { hoodie, hook } = hoodieSwapContracts(args.chainId);
  const tokenIn = args.isBuy ? hoodie : args.token;
  const tokenOut = args.isBuy ? args.token : hoodie;
  return buildSwapTemplatePayload({
    tokenIn, tokenOut,
    fee: HYDE_DYNAMIC_FEE, tickSpacing: HYDE_TICK_SPACING, hooks: hook,
    recipient: args.recipient,
    amountIn: args.amountIn, amountOutQuoted: args.amountOutQuoted, slippagePercent: args.slippagePercent,
    // Numeraire (HOODIE) is 18; own-stack token decimals passed in. Per direction: BUY in=HOODIE/out=token, SELL in=token/out=HOODIE.
    decimalsIn: args.isBuy ? 18 : args.decimals,
    decimalsOut: args.isBuy ? args.decimals : 18,
    chainId: args.chainId, sweep: false,
  });
}

export type SwapSim = { ok: boolean; out: bigint; reason?: string };

const REVERT_HINTS: [RegExp, string][] = [
  [/max ?wallet|exceeds.*wallet|wallet.*limit/i, "Exceeds the 1% launch max-wallet"],
  [/insufficient/i, "Insufficient balance for this trade"],
  [/slippage|minimum|min ?out|too little|amountout/i, "Price moved — raise slippage or lower the amount"],
];

/** Accurate quote + preflight via eth_simulateV1 on the CONFIGURED PUBLIC RPC (kami 23869 — never the
 *  wallet transport). Bundles the two Permit2 approvals inline so a quote works BEFORE the user has
 *  approved on-chain; output = recipient's net output-token balance delta across the execute. When
 *  `slippagePercent`/`amountOutQuoted` encode a real minOut, this doubles as the exact-call preflight:
 *  a revert (drift, max-wallet, thin liquidity) returns ok:false with an honest reason. */
export async function simulateHoodieSwap(args: {
  client: PublicClient; user: Address; token: Address; decimals: number; isBuy: boolean;
  amountIn: string; amountOutQuoted: string; slippagePercent: string; chainId: number;
}): Promise<SwapSim> {
  const { hoodie, universalRouter, permit2 } = hoodieSwapContracts(args.chainId);
  const inToken = args.isBuy ? hoodie : args.token;
  const outToken = args.isBuy ? args.token : hoodie;
  const { commands, inputs } = buildHoodieSwap({ ...args, recipient: args.user });

  const balOf = encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [args.user] });
  const approveInput = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [permit2, maxUint256] });
  const permit2Approve = encodeFunctionData({ abi: permit2Abi, functionName: "approve", args: [inToken, universalRouter, maxUint160, Number(maxUint48)] });
  const executeCall = encodeFunctionData({ abi: universalRouterExecuteAbi, functionName: "execute", args: [commands, inputs] });

  const calls = [
    { from: args.user, to: outToken, data: balOf },              // 0: output balance before
    { from: args.user, to: inToken, data: approveInput },        // 1: ERC20 → Permit2 (inline)
    { from: args.user, to: permit2, data: permit2Approve },      // 2: Permit2 → UniversalRouter (inline)
    { from: args.user, to: universalRouter, data: executeCall, value: "0x0" }, // 3: the swap
    { from: args.user, to: outToken, data: balOf },              // 4: output balance after
  ];

  let res: { calls: { status: string; returnData: Hex; error?: { message?: string } }[] }[];
  try {
    res = await args.client.request({
      // eth_simulateV1 — supported on the 4663 RPC (probed). validation:false skips nonce/balance/gas checks.
      method: "eth_simulateV1" as never,
      params: [{ blockStateCalls: [{ calls }], validation: false, traceTransfers: false }, "latest"] as never,
    }) as never;
  } catch (e) {
    return { ok: false, out: 0n, reason: `Quote unavailable (${String((e as Error)?.message ?? e).slice(0, 60)})` };
  }

  const block = res?.[0]?.calls;
  if (!block || block.length < 5) return { ok: false, out: 0n, reason: "Quote unavailable" };
  const exec = block[3];
  if (exec.status !== "0x1") {
    const raw = exec.error?.message ?? "";
    const hint = REVERT_HINTS.find(([re]) => re.test(raw))?.[1];
    return { ok: false, out: 0n, reason: hint ?? "Swap would revert at these settings" };
  }
  const before = BigInt(block[0].returnData || "0x0");
  const after = BigInt(block[4].returnData || "0x0");
  const out = after > before ? after - before : 0n;
  if (out === 0n) return { ok: false, out: 0n, reason: "No output at these settings" };
  return { ok: true, out };
}

/** Live launch-protection fee (pips, ÷1e6 = %). Decays startFee→baseFee linearly over the anti-snipe
 *  window; baseFee once elapsed (gojo 23855). */
export function launchFeePips(nowSec: number, launchTime: number, window: number, startFee: number, baseFee: number): number {
  const elapsed = nowSec - launchTime;
  if (elapsed >= window || window <= 0) return baseFee;
  if (elapsed < 0) return startFee;
  return Math.round(baseFee + ((startFee - baseFee) * (window - elapsed)) / window);
}

/** Parse a decimal input string to base units, tolerant of empty/partial entry (returns 0n). */
export function toUnits(v: string, decimals: number): bigint {
  try { return v && Number(v) > 0 ? parseUnits(v, decimals) : 0n; } catch { return 0n; }
}
