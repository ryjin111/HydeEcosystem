// Live-4663 gate for the CARD's own swap engine (src/utils/hoodieSwap.ts) — esbuild-bundled, not a
// mirror. Proves, against mainnet, the exact behaviours kami's freeze gate requires (23869):
//   1. simulateHoodieSwap BUY returns an ACCURATE quote via eth_simulateV1 (net output-token delta).
//   2. The preflight GATE blocks a tx that would revert (unachievable minOut → ok:false).
//   3. Both BUY and SELL execute green on live state (chained bundle using the card encoder both ways).
//
// Build+run: node_modules/.bin/esbuild scripts/hoodieSwapLiveSim.ts --bundle --platform=node
//   --format=esm --outfile=<tmp>.mjs && node <tmp>.mjs
import { createPublicClient, http, encodeFunctionData, formatUnits, maxUint160, maxUint256, maxUint48 } from "viem";
import { erc20Abi, permit2Abi, universalRouterExecuteAbi } from "../src/utils/constants";
import { buildHoodieSwap, simulateHoodieSwap, hoodieSwapContracts } from "../src/utils/hoodieSwap";

const RPC = "https://rpc.mainnet.chain.robinhood.com";
const CHAIN = 4663;
const TOKEN = "0x8a76FeeF3bb0140c122d146caCef6B1A4Ac145f7" as `0x${string}`; // LILHOODIE
const HOLDER = "0xcbacfD51fB04bB996565F4B03c53BD0932fA740c" as `0x${string}`; // real HOODIE holder
const client = createPublicClient({ transport: http(RPC) });
const { hoodie, universalRouter, permit2 } = hoodieSwapContracts(CHAIN);

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n: string, d: string) => { fail++; console.log(`  ✗ ${n} — ${d}`); };

// ── 1. Accurate BUY quote ────────────────────────────────────────────────────────────────────────
const buy = await simulateHoodieSwap({ client: client as never, user: HOLDER, token: TOKEN, decimals: 18, isBuy: true, amountIn: "1", amountOutQuoted: "0", slippagePercent: "0", chainId: CHAIN });
console.log("\n[1] BUY quote (1 HOODIE):", buy);
buy.ok && buy.out > 0n ? ok(`BUY simulate ok, out = ${formatUnits(buy.out, 18)} TOKEN`) : bad("BUY simulate ok & out>0", JSON.stringify(buy));
buy.ok && buy.out > 900000000000000000n && buy.out < 1000000000000000000n ? ok("BUY out ≈ 0.99 TOKEN (matches gojo golden 0.98999)") : bad("BUY out in (0.9, 1.0)", String(buy.out));

// ── 2. Preflight GATE blocks an unachievable minOut ──────────────────────────────────────────────
const greedy = await simulateHoodieSwap({ client: client as never, user: HOLDER, token: TOKEN, decimals: 18, isBuy: true, amountIn: "1", amountOutQuoted: "1000000", slippagePercent: "0", chainId: CHAIN });
console.log("\n[2] BUY with impossible minOut (1,000,000 TOKEN):", greedy);
!greedy.ok ? ok(`preflight BLOCKS unachievable minOut → "${greedy.reason}"`) : bad("preflight blocks impossible minOut", "sim returned ok=true (should revert)");

// ── 3. Live BUY then SELL both execute green (card encoder both directions) ───────────────────────
if (!buy.ok) { bad("SELL chain skipped — BUY quote failed", ""); }
else {
  const sellAmount = formatUnits(buy.out / 2n, 18); // sell half the just-bought TOKEN (like gojo's fork)
  const buyPayload = buildHoodieSwap({ token: TOKEN, decimals: 18, isBuy: true, recipient: HOLDER, amountIn: "1", amountOutQuoted: "0", slippagePercent: "0", chainId: CHAIN });
  const sellPayload = buildHoodieSwap({ token: TOKEN, decimals: 18, isBuy: false, recipient: HOLDER, amountIn: sellAmount, amountOutQuoted: "0", slippagePercent: "0", chainId: CHAIN });
  const erc20Approve = (spender: `0x${string}`) => encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, maxUint256] });
  const p2Approve = (t: `0x${string}`) => encodeFunctionData({ abi: permit2Abi, functionName: "approve", args: [t, universalRouter, maxUint160, Number(maxUint48)] });
  const exec = (p: { commands: `0x${string}`; inputs: `0x${string}`[] }) => encodeFunctionData({ abi: universalRouterExecuteAbi, functionName: "execute", args: [p.commands, p.inputs] });
  const balHoodie = encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [HOLDER] });

  const calls = [
    { from: HOLDER, to: hoodie, data: erc20Approve(permit2) },        // 0
    { from: HOLDER, to: permit2, data: p2Approve(hoodie) },           // 1
    { from: HOLDER, to: universalRouter, data: exec(buyPayload), value: "0x0" }, // 2 BUY
    { from: HOLDER, to: TOKEN, data: erc20Approve(permit2) },         // 3
    { from: HOLDER, to: permit2, data: p2Approve(TOKEN) },            // 4
    { from: HOLDER, to: hoodie, data: balHoodie },                    // 5 HOODIE before sell
    { from: HOLDER, to: universalRouter, data: exec(sellPayload), value: "0x0" }, // 6 SELL
    { from: HOLDER, to: hoodie, data: balHoodie },                    // 7 HOODIE after sell
  ];
  const res = await client.request({ method: "eth_simulateV1" as never, params: [{ blockStateCalls: [{ calls }], validation: false }, "latest"] as never }) as never as { calls: { status: string; returnData: `0x${string}` }[] }[];
  const c = res[0].calls;
  console.log("\n[3] chained buy→sell statuses:", c.map((x) => x.status).join(","));
  c[2].status === "0x1" ? ok("live BUY execute status 0x1") : bad("BUY execute 0x1", c[2].status);
  c[6].status === "0x1" ? ok("live SELL execute status 0x1") : bad("SELL execute 0x1", c[6].status);
  const sellOut = BigInt(c[7].returnData) - BigInt(c[5].returnData);
  sellOut > 0n ? ok(`live SELL returned ${formatUnits(sellOut, 18)} HOODIE (> 0)`) : bad("SELL HOODIE out > 0", String(sellOut));
}

console.log(`\nhoodieSwapLiveSim: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
