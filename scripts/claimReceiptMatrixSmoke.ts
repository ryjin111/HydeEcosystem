// Deterministic regression for the claim receipt-trust decision (kami 23902/23908). Exercises the REAL
// `isClaimConfirmed` (esbuild-bundled) across the full receipt-status × replacement-reason matrix, so a
// reverted receipt, a user CANCELLATION, or an unrelated replacement can never be mistaken for a claim —
// only the original success or a repriced speed-up counts.
//
// Build+run: node_modules/.bin/esbuild scripts/claimReceiptMatrixSmoke.ts --bundle --platform=node
//   --format=esm --outfile=<tmp>.mjs && node <tmp>.mjs
import { isClaimConfirmed } from "../src/utils/txStatus";

const cases: { status: "success" | "reverted"; reason: "repriced" | "cancelled" | "replaced" | null; want: boolean; note: string }[] = [
  { status: "success",  reason: null,        want: true,  note: "original tx mined" },
  { status: "success",  reason: "repriced",  want: true,  note: "speed-up (same to/value/input)" },
  { status: "success",  reason: "cancelled", want: false, note: "user cancellation self-tx (the trap)" },
  { status: "success",  reason: "replaced",  want: false, note: "unrelated same-nonce replacement" },
  { status: "reverted", reason: null,        want: false, note: "mined but reverted" },
  { status: "reverted", reason: "repriced",  want: false, note: "reverted after speed-up" },
  { status: "reverted", reason: "cancelled", want: false, note: "reverted cancellation" },
  { status: "reverted", reason: "replaced",  want: false, note: "reverted replacement" },
];

let pass = 0, fail = 0;
for (const c of cases) {
  const got = isClaimConfirmed(c.status, c.reason);
  if (got === c.want) { pass++; console.log(`  ✓ ${c.status} / ${c.reason ?? "—"} → ${got}  (${c.note})`); }
  else { fail++; console.log(`  ✗ ${c.status} / ${c.reason ?? "—"} → got ${got} want ${c.want}  (${c.note})`); }
}
console.log(`\nclaimReceiptMatrix: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
