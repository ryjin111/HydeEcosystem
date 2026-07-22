// Browser gate for the "My Launches not reflecting" fix (clint 23887 / kami 23889): the My Launches tab
// was hidden off-testnet by a stale gate. On the default (mainnet) network, /launchpad?tab=mine must now
// render the real My Launches list (connect prompt when no wallet), NOT the "available on Robinhood
// Testnet" message. Run against the PRODUCTION vite preview bundle.
//
// Run: GATE_BASE=http://localhost:4199 PW_DIR=<playwright pkg dir> node scripts/myLaunchesSmoke.mjs

import { pathToFileURL } from "node:url";
const PW_DIR = process.env.PW_DIR;
const _pw = await import(pathToFileURL(`${PW_DIR}/index.js`).href);
const chromium = _pw.chromium ?? _pw.default?.chromium;
const BASE = process.env.GATE_BASE || "http://localhost:4199";

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, d) => { fail++; console.log(`  ✗ ${n} — ${d}`); };

const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
try {
  await page.goto(`${BASE}/launchpad?tab=mine`, { waitUntil: "networkidle", timeout: 45000 });
  await page.waitForTimeout(800);
  const body = (await page.locator("body").innerText());
  const low = body.toLowerCase();

  // The tab exists at all
  low.includes("my launches") ? ok("My Launches tab renders") : bad("My Launches tab", low.slice(0, 80));

  // Stale testnet-only gate is GONE on mainnet
  !/available on robinhood\s*testnet/i.test(body)
    ? ok("no stale 'My Launches is available on Testnet' message on mainnet")
    : bad("testnet-only gate removed", "still shows the testnet-only message");
  !/aren't attributed to a creator/i.test(body)
    ? ok("no stale 'not attributed to a creator' copy")
    : bad("stale creator-attribution copy removed", "still present");

  // Real My Launches list shell renders — disconnected → connect prompt (headless has no wallet)
  /connect your wallet to see your launches/i.test(body)
    ? ok("My Launches list renders (connect-wallet prompt, disconnected)")
    : bad("My Launches list renders", "connect prompt not found — list may not be rendering");
} finally {
  await browser.close();
}
console.log(`\nmyLaunches: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
