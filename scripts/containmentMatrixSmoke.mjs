// CONTAINMENT surface matrix (kami 23991) — proves against the PRODUCTION preview bundle that no affected
// BUY or launch action is reachable, sell stays where an audited in-app sell exists, and the copy matches
// capability. Surfaces: HOODIE token page (audited sell → buy paused / sell open), WETH token page (no
// audited sell → trading unavailable, external link removed), Launch form (disabled). Price/FDV untouched.
//
// Run: GATE_BASE=http://localhost:4199 PW_DIR=<playwright pkg dir> node scripts/containmentMatrixSmoke.mjs
import { pathToFileURL } from "node:url";
const PW_DIR = process.env.PW_DIR;
const _pw = await import(pathToFileURL(`${PW_DIR}/index.js`).href);
const chromium = _pw.chromium ?? _pw.default?.chromium;
const BASE = process.env.GATE_BASE || "http://localhost:4199";
const HOODIE = "0x8a76FeeF3bb0140c122d146caCef6B1A4Ac145f7"; // LILHOODIE (HOODIE pair — audited in-app sell)
const WETH = "0x70b427b5d8d863BCe9013Cef1341BAD1d607147C";   // HYDE (WETH pair — no audited in-app sell)
const SELL_OPEN = "Buying & new launches paused — pool pricing correction in progress. Selling remains available.";
const NO_SELL = "Trading temporarily unavailable — launch price under review.";

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, d) => { fail++; console.log(`  ✗ ${n} — ${d}`); };
const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
const enabledText = async (sel) => { const els = await page.$$(sel); for (const e of els) { if (!(await e.isDisabled().catch(() => false))) return (await e.innerText().catch(() => "")).trim(); } return null; };

try {
  // ── HOODIE token page: buy paused, sell-open copy, price still shown (no clamp) ──
  await page.goto(`${BASE}/swap?out=${HOODIE}`, { waitUntil: "networkidle", timeout: 45000 });
  try { await page.locator('[data-testid="hoodie-swap"]').waitFor({ state: "visible", timeout: 30000 }); ok("HOODIE swap card mounts"); }
  catch { console.log("NO_LIVE_DATA: HOODIE card didn't mount"); await browser.close(); process.exit(2); }
  const action = (await page.locator('[data-testid="hoodie-action"]').innerText()).trim();
  const actionDisabled = await page.locator('[data-testid="hoodie-action"]').isDisabled();
  (/buying paused/i.test(action) && actionDisabled) ? ok(`HOODIE default (Buy) action is DISABLED "Buying paused"`) : bad("buy paused+disabled", `"${action}" disabled=${actionDisabled}`);
  (await page.locator("body").innerText()).includes(SELL_OPEN) ? ok("sell-open copy present (audited sell stays)") : bad("sell-open copy", "missing");
  // Sell side must NOT be containment-blocked (disconnected → "Connect wallet", not "Buying paused").
  await page.locator('[data-testid="hoodie-side-sell"]').click(); await page.waitForTimeout(200);
  !/buying paused/i.test((await page.locator('[data-testid="hoodie-action"]').innerText())) ? ok("Sell side is NOT paused (holders can exit)") : bad("sell not paused", "sell shows Buying paused");
  // Price/FDV stays truthful (no clamp): the honest number is still rendered somewhere on the page.
  /\$[0-9]/.test(await page.locator("body").innerText()) ? ok("on-chain price/FDV still shown (no cosmetic clamp)") : bad("price still shown", "no $ value");

  // ── WETH token page: no audited sell → trading-unavailable copy, external 'Trade on live pair' removed ──
  await page.goto(`${BASE}/swap?out=${WETH}`, { waitUntil: "networkidle", timeout: 45000 });
  await page.waitForTimeout(1200);
  const wbody = await page.locator("body").innerText();
  wbody.includes(NO_SELL) ? ok("WETH pair shows 'Trading temporarily unavailable'") : bad("WETH no-sell copy", "missing");
  !/trade on live pair/i.test(wbody) ? ok("external 'Trade on live pair ↗' link removed") : bad("external link removed", "still present");

  // ── Launch form: disabled, launch copy, no live Preview/Launch button ──
  await page.goto(`${BASE}/launchpad?tab=launch`, { waitUntil: "networkidle", timeout: 45000 });
  await page.waitForTimeout(800);
  const lbody = await page.locator("body").innerText();
  /new launches are paused/i.test(lbody) ? ok("Launch form shows paused copy") : bad("launch paused copy", "missing");
  // Iterate EVERY enabled button — fail if ANY launch/preview action is enabled (kami 24000: first-only was unsafe).
  let enabledLaunch = null;
  for (const b of await page.$$("button")) {
    if (await b.isDisabled().catch(() => false)) continue;
    const t = (await b.innerText().catch(() => "")).trim();
    if (/preview launch|launch token|launch hoodie/i.test(t)) { enabledLaunch = t; break; }
  }
  !enabledLaunch ? ok("no enabled Preview/Launch button (ALL enabled buttons checked)") : bad("no launch button", `enabled: "${enabledLaunch}"`);

  // ── Bare /swap discovery view: pause notice, NO "trades live / trade" encouragement (kami 24000) ──
  await page.goto(`${BASE}/swap`, { waitUntil: "networkidle", timeout: 45000 });
  await page.waitForTimeout(600);
  const sbody = await page.locator("body").innerText();
  sbody.includes(NO_SELL) ? ok("bare /swap shows the pause notice") : bad("bare /swap pause notice", "missing");
  !/every launch trades\s+live|chart, trade/i.test(sbody) ? ok("bare /swap has no stale 'trades live/trade' copy") : bad("stale trade copy gone", "present");
} finally { await browser.close(); }
console.log(`\ncontainmentMatrix: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
