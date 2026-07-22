// Deterministic regressions for the harvest STATE decisions (kami 23913/23916). Exercises the REAL
// `feeDisplayState` + `nextHarvestStep` (esbuild-bundled) so the card always shows the honest state and a
// truthful resume:
//  - settled → Claim · unsettled numeraire pending → awaiting (never "you earned nothing" on real fees)
//  - token-side (LT) fees only → lt-pending (NOT "none" — kami #4) · settled-zero → none · failed read →
//    unavailable (feeDisplayState(null,…), which readFeeState now produces instead of coercing to 0 — kami #3)
//  - Resume label follows the first not-done/skipped step (kami #2).
//
// Build+run: node_modules/.bin/esbuild scripts/feeDisplayMatrixSmoke.ts --bundle --platform=node
//   --format=esm --outfile=<tmp>.mjs && node <tmp>.mjs
import { feeDisplayState, nextHarvestStep, type HarvestStep, type StepStatus } from "../src/utils/hoodieFees";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n: string, d: string) => { fail++; console.log(`  ✗ ${n} — ${d}`); };

// ── feeDisplayState(claimable, pendingHoodie, rawLT) ──────────────────────────────────────────────
const disp: { c: bigint | null; p: bigint; lt: bigint; want: string; note: string }[] = [
  { c: null, p: 0n,   lt: 0n,  want: "unavailable", note: "read failed → never 'none' (kami #3)" },
  { c: null, p: 100n, lt: 50n, want: "unavailable", note: "read failed even if others computed" },
  { c: 100n, p: 0n,   lt: 0n,  want: "claim",       note: "settled → Claim" },
  { c: 100n, p: 50n,  lt: 50n, want: "claim",       note: "settled beats pending/LT" },
  { c: 0n,   p: 994n, lt: 0n,  want: "awaiting",    note: "LILHOODIE: real ~994 pending" },
  { c: 0n,   p: 994n, lt: 50n, want: "awaiting",    note: "numeraire pending beats LT" },
  { c: 0n,   p: 0n,   lt: 50n, want: "lt-pending",  note: "token-side fees only → NOT none (kami #4)" },
  { c: 0n,   p: 0n,   lt: 0n,  want: "none",        note: "genuinely nothing" },
];
for (const t of disp) {
  const got = feeDisplayState(t.c, t.p, t.lt);
  got === t.want ? ok(`display c=${t.c} p=${t.p} lt=${t.lt} → ${got}  (${t.note})`) : bad(`display c=${t.c} p=${t.p} lt=${t.lt}`, `got ${got} want ${t.want}`);
}

// ── nextHarvestStep(steps) → first not-done/skipped step (resume target) ──────────────────────────
const S = (collect: StepStatus | "idle", settle: StepStatus | "idle", claim: StepStatus | "idle") => ({ collect, settle, claim });
const resume: { steps: Record<HarvestStep, StepStatus | "idle">; want: HarvestStep | null; note: string }[] = [
  { steps: S("failed", "idle", "idle"),    want: "collect", note: "collect failed → resume at collect" },
  { steps: S("done", "failed", "idle"),    want: "settle",  note: "settle failed → resume at settle" },
  { steps: S("done", "done", "failed"),    want: "claim",   note: "claim failed → resume at claim" },
  { steps: S("skipped", "done", "failed"), want: "claim",   note: "collect skipped, claim failed → claim" },
  { steps: S("done", "skipped", "done"),   want: null,      note: "all done/skipped → nothing to resume" },
];
for (const t of resume) {
  const got = nextHarvestStep(t.steps);
  got === t.want ? ok(`resume ${JSON.stringify(t.steps)} → ${got}  (${t.note})`) : bad(`resume`, `got ${got} want ${t.want}`);
}

console.log(`\nfeeDisplayMatrix: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
