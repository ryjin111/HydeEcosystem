// WETH-ONLY CONTAINMENT matrix (kami 24005+24008, shiro 24007) — proves BOTH directions against the
// PRODUCTION preview bundle:
//   (A) HOODIE is FULLY LIVE — its token page buy AND sell are reachable with NO containment copy, and a
//       HOODIE-pair launch is reachable (normal disconnected flow, not the paused banner). This is the
//       regression that matters this revision: after ripping out the stack-wide flag, HOODIE must stay live.
//   (B) WETH is CONTAINED — WETH token page shows trading-unavailable + external 'Trade on live pair' removed;
//       the default (WETH-pair) launch shows the paused banner with no enabled Preview/Launch button.
//   (C) bare /swap discovery is NOT globally gated (kami 24008) — it shows the normal exchange copy, never the
//       WETH pause notice.
// No cosmetic price/FDV clamp on either stack — the honest number stays.
//
// Run: GATE_BASE=http://localhost:4199 PW_DIR=<playwright pkg dir> node scripts/containmentMatrixSmoke.mjs
import { pathToFileURL } from "node:url";
const PW_DIR = process.env.PW_DIR;
const _pw = await import(pathToFileURL(`${PW_DIR}/index.js`).href);
const chromium = _pw.chromium ?? _pw.default?.chromium;
const BASE = process.env.GATE_BASE || "http://localhost:4199";
const HOODIE = "0x8a76FeeF3bb0140c122d146caCef6B1A4Ac145f7"; // LILHOODIE (HOODIE pair — fully live, sane ~$4k FDV)
const WETH = "0x70b427b5d8d863BCe9013Cef1341BAD1d607147C";   // HYDE (WETH pair — contained, broken ~$1.9T FDV)
const NO_SELL = "Trading temporarily unavailable — launch price under review."; // WETH-only pause copy
const WETH_LAUNCH_PAUSED = /weth-paired launches are paused/i;

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, d) => { fail++; console.log(`  ✗ ${n} — ${d}`); };
const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();

try {
  // ══ (A) HOODIE token page — FULLY LIVE (buy + sell reachable, NO containment copy, price truthful) ══
  await page.goto(`${BASE}/swap?out=${HOODIE}`, { waitUntil: "networkidle", timeout: 45000 });
  try { await page.locator('[data-testid="hoodie-swap"]').waitFor({ state: "visible", timeout: 30000 }); ok("HOODIE swap card mounts (HOODIE live)"); }
  catch { console.log("NO_LIVE_DATA: HOODIE card didn't mount"); await browser.close(); process.exit(2); }
  const buyAction = (await page.locator('[data-testid="hoodie-action"]').innerText()).trim();
  // HOODIE buy must NOT be containment-paused — disconnected renders the NORMAL action ("Connect wallet"),
  // never the removed "Buying paused" button.
  (!/buying paused/i.test(buyAction)) ? ok(`HOODIE Buy is live (no "Buying paused"): "${buyAction}"`) : bad("HOODIE buy live", `paused: "${buyAction}"`);
  const hbody = await page.locator("body").innerText();
  (!hbody.includes(NO_SELL) && !/new launches paused|buying & new launches/i.test(hbody))
    ? ok("HOODIE page has NO containment/pause copy") : bad("HOODIE no pause copy", "pause copy present on HOODIE page");
  // Sell side reachable (holders can exit) — not containment-blocked.
  await page.locator('[data-testid="hoodie-side-sell"]').click(); await page.waitForTimeout(200);
  const sellAction = (await page.locator('[data-testid="hoodie-action"]').innerText()).trim();
  (!/buying paused/i.test(sellAction)) ? ok(`HOODIE Sell is live: "${sellAction}"`) : bad("HOODIE sell live", `"${sellAction}"`);
  // Price/FDV stays truthful (no clamp).
  /\$[0-9]/.test(hbody) ? ok("on-chain price/FDV still shown (no cosmetic clamp)") : bad("price shown", "no $ value");

  // ══ (A2) HOODIE launch reachable — switch to HOODIE PAIR → normal flow (no paused banner) ══
  await page.goto(`${BASE}/launchpad?tab=launch`, { waitUntil: "networkidle", timeout: 45000 });
  await page.waitForTimeout(700);
  // Default pair is WETH → assert the WETH paused banner is showing FIRST (part B), then flip to HOODIE.
  const defBody = await page.locator("body").innerText();
  WETH_LAUNCH_PAUSED.test(defBody) ? ok("default (WETH) launch shows paused banner") : bad("WETH launch paused", "banner missing on default");
  // No enabled Preview/Launch button on the WETH default (iterate EVERY enabled button — kami 24000).
  let wethEnabled = null;
  for (const b of await page.$$("button")) {
    if (await b.isDisabled().catch(() => false)) continue;
    const t = (await b.innerText().catch(() => "")).trim();
    if (/preview launch|launch token|launch hoodie/i.test(t)) { wethEnabled = t; break; }
  }
  !wethEnabled ? ok("WETH launch: no enabled Preview/Launch button (ALL enabled buttons checked)") : bad("WETH no launch button", `enabled: "${wethEnabled}"`);
  // Flip to HOODIE PAIR — paused banner must clear and the normal disconnected launch flow must render.
  await page.getByRole("button", { name: /hoodie pair/i }).click(); await page.waitForTimeout(300);
  const hLaunchBody = await page.locator("body").innerText();
  !WETH_LAUNCH_PAUSED.test(hLaunchBody) ? ok("HOODIE-pair launch has NO paused banner (HOODIE launch live)") : bad("HOODIE launch live", "paused banner still shown for HOODIE pair");
  /connect wallet to launch|preview launch/i.test(hLaunchBody) ? ok("HOODIE-pair launch shows the normal flow (Connect/Preview)") : bad("HOODIE launch flow", "normal launch flow missing");

  // ══ (B) WETH token page — CONTAINED (trading unavailable, external link removed) ══
  await page.goto(`${BASE}/swap?out=${WETH}`, { waitUntil: "networkidle", timeout: 45000 });
  await page.waitForTimeout(1200);
  const wbody = await page.locator("body").innerText();
  wbody.includes(NO_SELL) ? ok("WETH pair shows 'Trading temporarily unavailable'") : bad("WETH no-sell copy", "missing");
  !/trade on live pair/i.test(wbody) ? ok("WETH external 'Trade on live pair ↗' link removed") : bad("WETH external link removed", "still present");

  // ══ (C) bare /swap discovery — NOT globally gated (shows normal exchange copy, not the WETH pause) ══
  await page.goto(`${BASE}/swap`, { waitUntil: "networkidle", timeout: 45000 });
  await page.waitForTimeout(600);
  const sbody = await page.locator("body").innerText();
  !sbody.includes(NO_SELL) ? ok("bare /swap is NOT globally gated (no WETH pause notice)") : bad("bare /swap not gated", "WETH pause notice leaked to bare /swap");
} finally { await browser.close(); }
console.log(`\ncontainmentMatrix (WETH-only): ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
