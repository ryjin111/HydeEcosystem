// Deterministic regression for the connected-PnL card body decision (kami 23949 #2/#3). Exercises the REAL
// `positionCardState` (esbuild-bundled) so an adapter error → terminal "error" (never endless loading), and
// a closed position with proven realized PnL → "closed-realized" (never hidden), across the full matrix.
//
// Build+run: node_modules/.bin/esbuild scripts/positionStateMatrixSmoke.ts --bundle --platform=node
//   --format=esm --outfile=<tmp>.mjs && node <tmp>.mjs
import { positionCardState } from "../src/utils/positionPnl";

// Minimal position shape — positionCardState only reads loading/balance/covered/uncovered/realizedPnl.
const P = (o: Partial<{ loading: boolean; balance: bigint; coveredUnits: bigint; uncoveredUnits: bigint; realizedPnl: bigint | null }>) =>
  ({ loading: false, balance: 0n, coveredUnits: 0n, uncoveredUnits: 0n, realizedPnl: null, ...o } as never);

let pass = 0, fail = 0;
const t = (label: string, got: string, want: string) => got === want ? (pass++, console.log(`  ✓ ${label} → ${got}`)) : (fail++, console.log(`  ✗ ${label} → got ${got} want ${want}`));

t("disconnected", positionCardState(false, false, P({ balance: 100n })), "connect");
t("adapter error (terminal, not loading)", positionCardState(true, true, null), "error");
t("null position → loading", positionCardState(true, false, null), "loading");
t("position.loading → loading", positionCardState(true, false, P({ loading: true })), "loading");
t("no holdings, no realized → closed", positionCardState(true, false, P({})), "closed");
t("no holdings + realized PnL → closed-realized", positionCardState(true, false, P({ realizedPnl: -2199n })), "closed-realized");
t("held balance → active", positionCardState(true, false, P({ balance: 109391n, coveredUnits: 109391n })), "active");
t("zero balance but uncovered units → active", positionCardState(true, false, P({ uncoveredUnits: 50n })), "active");
t("error takes priority over a stale position", positionCardState(true, true, P({ balance: 100n })), "error");

console.log(`\npositionStateMatrix: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
