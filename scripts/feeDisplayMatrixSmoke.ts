// Deterministic regression for the fee affordance decision (kami 23913 state test). Exercises the REAL
// `feeDisplayState` (esbuild-bundled) across the claimable × pending matrix, so the card always shows the
// honest state: settled→Claim, unsettled-but-pending→awaiting-settlement (never "you earned nothing" on
// real fees), settled-zero→none, failed read→unavailable.
//
// Build+run: node_modules/.bin/esbuild scripts/feeDisplayMatrixSmoke.ts --bundle --platform=node
//   --format=esm --outfile=<tmp>.mjs && node <tmp>.mjs
import { feeDisplayState } from "../src/utils/hoodieFees";

const cases: { claimable: bigint | null; pending: bigint; want: string; note: string }[] = [
  { claimable: null, pending: 0n,     want: "unavailable", note: "vault read failed" },
  { claimable: null, pending: 100n,   want: "unavailable", note: "read failed even if pending computed" },
  { claimable: 100n, pending: 0n,     want: "claim",       note: "settled, ready → Claim" },
  { claimable: 100n, pending: 50n,    want: "claim",       note: "settled takes priority over pending" },
  { claimable: 0n,   pending: 994n,   want: "awaiting",    note: "LILHOODIE: real ~994 pending, unsettled" },
  { claimable: 0n,   pending: 0n,     want: "none",        note: "genuinely nothing settled" },
];

let pass = 0, fail = 0;
for (const c of cases) {
  const got = feeDisplayState(c.claimable, c.pending);
  if (got === c.want) { pass++; console.log(`  ✓ claimable=${c.claimable} pending=${c.pending} → ${got}  (${c.note})`); }
  else { fail++; console.log(`  ✗ claimable=${c.claimable} pending=${c.pending} → got ${got} want ${c.want}`); }
}
console.log(`\nfeeDisplayMatrix: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
