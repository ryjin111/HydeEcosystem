// Verification gate for the token-page cleanup + global trending ticker bundle
// (clint 23798/23812; kami 23800/23802). Real browser checks against the PRODUCTION `vite preview`
// bundle. Also includes kami's caret regression (23813): landing on /swap must NOT auto-focus an input.
//
// Run: GATE_BASE=http://localhost:4199 PW_DIR=<playwright pkg dir> node scripts/uiCleanupTickerSmoke.mjs

import { pathToFileURL } from "node:url";
const PW_DIR = process.env.PW_DIR;
const _pw = await import(pathToFileURL(`${PW_DIR}/index.js`).href);
const chromium = _pw.chromium ?? _pw.default?.chromium;

const BASE = process.env.GATE_BASE || "http://localhost:4199";
const LILHOODIE = "0x8a76FeeF3bb0140c122d146caCef6B1A4Ac145f7";
const SWAP_RE = /\/swap\?out=0x[0-9a-fA-F]{40}/;

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, d) => { fail++; console.log(`  ✗ ${n} — ${d}`); };

const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();

try {
  // ── Global trending ticker on the landing (and every page) ──────────────────
  await page.goto(`${BASE}/`, { waitUntil: "networkidle", timeout: 45000 });
  const ticker = page.locator('[data-testid="trending-ticker"]');
  try {
    await ticker.waitFor({ state: "visible", timeout: 30000 });
    ok("global trending ticker renders at the top of the app shell");
  } catch {
    console.log("NO_LIVE_DATA: ticker did not render within 30s (live launch feed unreachable?).");
    await browser.close();
    process.exit(2);
  }
  // 🔥 TRENDING anchor + Robinhood L2 chip
  const anchorTxt = await ticker.innerText();
  if (/TRENDING/.test(anchorTxt) && /Robinhood L2/.test(anchorTxt)) ok("ticker shows the 🔥 TRENDING anchor + Robinhood L2 chip");
  else bad("ticker anchor/chip present", JSON.stringify(anchorTxt.slice(0, 80)));

  // A ticker item routes to /swap?out=
  const tItem = ticker.locator('button[aria-label^="Trade "]').first();
  await tItem.click();
  await page.waitForTimeout(300);
  if (SWAP_RE.test(page.url())) ok(`ticker item click routes to ${new URL(page.url()).pathname}${new URL(page.url()).search}`);
  else bad("ticker item routes to /swap?out=", `url=${page.url()}`);

  // ── Token page cleanup — Auction / Graduation / Verified / "auction curve" all GONE ─────
  await page.goto(`${BASE}/swap?out=${LILHOODIE}`, { waitUntil: "networkidle", timeout: 45000 });
  await page.waitForTimeout(1200); // let the token detail resolve
  const body = (await page.locator("body").innerText()).toLowerCase();
  const banned = [
    "auction", "graduation", "graduate", "verified", "auction curve", "geckoterminal",
    "5% doppler", "coming · hyde stack", "first hour", "no max-wallet",
  ];
  const hits = banned.filter((w) => body.includes(w));
  if (hits.length === 0) ok('no "Auction"/"Graduation"/"Verified"/"auction curve"/"GeckoTerminal" text on the token page');
  else bad("stale auction/graduation/verified/geckoterminal copy removed", `still present: ${hits.join(", ")}`);
  if (body.includes("live") && body.includes("liquidity locked")) ok('token page shows truthful "LIVE" + "Liquidity locked" state');
  else bad("truthful LIVE/locked-liquidity state present", `live=${body.includes("live")} locked=${body.includes("liquidity locked")}`);
  // Beautified chart empty state (kami 23829)
  if (body.includes("chart warming up") && body.includes("price history begins with on-chain swaps")) ok('chart "warming up" empty state present with honest copy');
  else bad("chart warming-up empty state present", `warming=${body.includes("chart warming up")}`);

  // Live own-stack economics + time-boxed protections, read directly from both 4663 deployments.
  const trustFacts = [
    "90% creator · 5% hyde · 5% locked liquidity",
    "swap fee decays 3%→1% over 5 minutes",
    "1% max-wallet for 5 minutes",
    "selling remains unrestricted",
  ];
  const missingTrust = trustFacts.filter((fact) => !body.includes(fact));
  if (missingTrust.length === 0) ok("TRUST panel shows live 90/5/5 economics + five-minute launch protections");
  else bad("TRUST panel live economics/protections", `missing: ${missingTrust.join(", ")}`);

  // ── Caret regression (kami 23813): landing on /swap must NOT auto-focus an input ──────────
  const activeTag = await page.evaluate(() => document.activeElement?.tagName || "NONE");
  if (activeTag !== "INPUT" && activeTag !== "TEXTAREA") ok(`no input auto-focused on /swap (activeElement=${activeTag}) — no blinking caret`);
  else bad("no caret grab on /swap navigation", `activeElement=${activeTag}`);
} catch (e) {
  bad("harness", e.message);
} finally {
  await browser.close();
}

console.log(`\nuiCleanupTickerSmoke: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
