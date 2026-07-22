// Deterministic proof of the fail-CLOSED read (kami 23916 #3 / gojo matrix A): when a fee sub-call reverts,
// `readFeeState` must THROW (→ the UI shows "Unavailable"), never coerce the failed read to 0 (which would
// recreate the "No settled fees yet" false-negative on real fees). Uses a mocked eth_simulateV1 response —
// no chain — and drives the REAL `readFeeState`.
//
// Build+run: node_modules/.bin/esbuild scripts/feesFailClosedSmoke.ts --bundle --platform=node
//   --format=esm --outfile=<tmp>.mjs && node <tmp>.mjs
import { readFeeState } from "../src/utils/hoodieFees";

const TOKEN = "0x8a76FeeF3bb0140c122d146caCef6B1A4Ac145f7" as `0x${string}`;
// A client that only implements `request` (eth_simulateV1) with a scripted calls result.
const clientWith = (statuses: string[]) => ({
  request: async () => [{ calls: statuses.map((status) => ({ status, returnData: "0x" + "00".repeat(32) })) }],
}) as never;

let pass = 0, fail = 0;
const expectThrow = async (label: string, statuses: string[]) => {
  try {
    await readFeeState({ client: clientWith(statuses), token: TOKEN, chainId: 4663 });
    fail++; console.log(`  ✗ ${label} — resolved (should throw → Unavailable)`);
  } catch { pass++; console.log(`  ✓ ${label} → throws (→ Unavailable, never 0)`); }
};
const expectOk = async (label: string, statuses: string[]) => {
  try { await readFeeState({ client: clientWith(statuses), token: TOKEN, chainId: 4663 }); pass++; console.log(`  ✓ ${label} → resolves`); }
  catch (e) { fail++; console.log(`  ✗ ${label} — threw: ${String((e as Error).message).slice(0, 40)}`); }
};

// calls = [collect, rawFees(num), rawFees(LT), creatorClaimable]
await expectThrow("collect (calls[0]) reverted", ["0x0", "0x1", "0x1", "0x1"]);
await expectThrow("rawFees numeraire reverted", ["0x1", "0x0", "0x1", "0x1"]);
await expectThrow("creatorClaimable reverted", ["0x1", "0x1", "0x1", "0x0"]);
await expectOk("all sub-calls green", ["0x1", "0x1", "0x1", "0x1"]);

console.log(`\nfeesFailClosed: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
