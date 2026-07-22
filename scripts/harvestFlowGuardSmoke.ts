// Deterministic proof that the harvest full-flow gate is FAIL-CLOSED on malformed RPC output (kami 23937):
// an empty/missing/truncated eth_simulateV1 response must return ok:false ("simulation unavailable"), never
// authorize a broadcast (the old `findIndex(...) === -1` on `[]` read as success). Drives the REAL
// `simulateHarvestFlow` with a scripted client — no chain. The first request is readFeeState's (4 green,
// zero rawFees → the flow plans [collect, claim], 2 calls); the SECOND is the malformed bundle under test.
//
// Build+run: node_modules/.bin/esbuild scripts/harvestFlowGuardSmoke.ts --bundle --platform=node
//   --format=esm --outfile=<tmp>.mjs && node <tmp>.mjs
import { simulateHarvestFlow } from "../src/utils/hoodieFees";

const TOKEN = "0x8a76FeeF3bb0140c122d146caCef6B1A4Ac145f7" as `0x${string}`;
const WALLET = "0x800557e7882b42ee49594fa2790300A9697a0e4D" as `0x${string}`;
const green = { status: "0x1", returnData: "0x" + "00".repeat(32) };
const feeReadOk = [{ calls: [green, green, green, green] }]; // readFeeState: all green, rawFees 0

// Client that returns feeReadOk to the first request (readFeeState) then `bundle` to the second (the gate).
const seqClient = (bundle: unknown) => {
  let i = 0;
  return { request: async () => (i++ === 0 ? feeReadOk : bundle) } as never;
};

let pass = 0, fail = 0;
const expect = async (label: string, bundle: unknown, wantOk: boolean) => {
  const r = await simulateHarvestFlow({ client: seqClient(bundle), token: TOKEN, wallet: WALLET, chainId: 4663 }).catch(() => ({ ok: false, reason: "threw" }));
  r.ok === wantOk ? (pass++, console.log(`  ✓ ${label} → ok:${r.ok}${r.ok ? "" : ` (${(r as { reason?: string }).reason})`}`))
                  : (fail++, console.log(`  ✗ ${label} → ok:${r.ok} want ok:${wantOk}`));
};

// rawFees 0 → planned flow is [collect, claim] = 2 calls; the gate must match that length.
await expect("empty calls []", [{ calls: [] }], false);
await expect("missing calls key", [{}], false);
await expect("truncated (1 of 2 calls)", [{ calls: [green] }], false);
await expect("no block result []", [], false);
await expect("extra block results", [{ calls: [green, green] }, { calls: [green, green] }], false);
await expect("well-formed 2 green calls", [{ calls: [green, green] }], true);

console.log(`\nharvestFlowGuard: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
