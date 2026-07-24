// V3 multichain UI plumbing — headless fixtures (no test runner in-repo; Node 24 strips TS).
// Imports the REAL formatters (no mirror — drift-safe). Run: `node scripts/verify-v3ui.mts`.
// Covers kami's gate (24245): 6-dec (USDT0, $-pegged) vs 18-dec (WETH, native) formatting fixtures.
import { formatPrice, formatFdv } from "../src/utils/format.ts";
import type { NumeraireInfo } from "../src/utils/chainRegistry.ts";

const USDT0: NumeraireInfo = { address: "0xUSDT0", symbol: "USDT0", decimals: 6, displayDecimals: 4, usdPegged: true };
const WETH: NumeraireInfo = { address: "0xWETH", symbol: "WETH", decimals: 18, displayDecimals: 8, usdPegged: false };

let pass = 0;
let fail = 0;
function eq(label: string, got: string, want: string) {
  if (got === want) {
    pass++;
    console.log(`  ✓ ${label} → ${got}`);
  } else {
    fail++;
    console.error(`  ✗ ${label} → got "${got}", want "${want}"`);
  }
}

console.log("FDV (the $1.9T-class number the UI must not garble):");
eq("USDT0 6-dec FDV 5000", formatFdv(5000, USDT0), "$5,000");
eq("WETH 18-dec FDV 2.6067", formatFdv(2.6067, WETH), "2.6067 WETH");
eq("USDT0 FDV Infinity → em-dash (error, NOT $0)", formatFdv(Infinity, USDT0), "—");
eq("WETH FDV NaN → em-dash", formatFdv(NaN, WETH), "—");
eq("USDT0 price NaN → em-dash", formatPrice(NaN, USDT0), "—");

console.log("Price — number path:");
eq("USDT0 sub-cent 0.000005 (sig-figs, not $0.00)", formatPrice(0.000005, USDT0), "$0.000005");
eq("USDT0 whole 5", formatPrice(5, USDT0), "$5");
eq("WETH tiny 0.0000123", formatPrice(0.0000123, WETH), "0.0000123 WETH");

console.log("Price — bigint/decimals path (raw→human uses numeraire.decimals):");
eq("USDT0 raw 5_000000 (6-dec) → $5", formatPrice(5_000000n, USDT0), "$5");
eq("USDT0 raw 5000 (6-dec) → $0.005 sub-cent", formatPrice(5000n, USDT0), "$0.005");
eq("WETH raw 12300000000000 (18-dec) → 0.0000123 WETH", formatPrice(12_300_000_000_000n, WETH), "0.0000123 WETH");

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
