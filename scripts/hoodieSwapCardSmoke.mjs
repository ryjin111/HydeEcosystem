// Browser render-state gate for the HOODIE swap card against the PRODUCTION `vite preview` bundle.
// Verifies (no wallet needed): the card mounts on the token page, shows the segmented Buy/Sell, defaults
// to the honest unconnected "Connect wallet" state, HIDES the launch-protection row for an EXPIRED token
// (LILHOODIE — shiro 23867), toggles Buy↔Sell (pay symbol flips HOODIE↔token), and logs NO console errors.
// The connected-wallet Buy/Sell/approve/quote logic is proven separately on live chain by
// hoodieSwapLiveSim.ts; shiro's look-gate covers the connected visual pass.
//
// Run: GATE_BASE=http://localhost:4199 PW_DIR=<playwright pkg dir> node scripts/hoodieSwapCardSmoke.mjs

import { pathToFileURL } from "node:url";
const PW_DIR = process.env.PW_DIR;
const _pw = await import(pathToFileURL(`${PW_DIR}/index.js`).href);
const chromium = _pw.chromium ?? _pw.default?.chromium;

const BASE = process.env.GATE_BASE || "http://localhost:4199";
const LILHOODIE = "0x8a76FeeF3bb0140c122d146caCef6B1A4Ac145f7";

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n, d) => { fail++; console.log(`  ✗ ${n} — ${d}`); };

const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));

try {
  await page.goto(`${BASE}/swap?out=${LILHOODIE}`, { waitUntil: "networkidle", timeout: 45000 });
  const card = page.locator('[data-testid="hoodie-swap"]');
  try {
    await card.waitFor({ state: "visible", timeout: 30000 });
    ok("HoodieSwapCard mounts on the HOODIE-pair token page");
  } catch {
    console.log("NO_LIVE_DATA: card did not mount within 30s (live launch feed unreachable?).");
    await browser.close();
    process.exit(2);
  }

  // Segmented Buy / Sell
  const buySeg = page.locator('[data-testid="hoodie-side-buy"]');
  const sellSeg = page.locator('[data-testid="hoodie-side-sell"]');
  (await buySeg.count()) === 1 && (await sellSeg.count()) === 1 ? ok("segmented Buy + Sell controls present") : bad("Buy+Sell segments present", "missing");

  // Honest unconnected state
  const action = page.locator('[data-testid="hoodie-action"]');
  const actionTxt = (await action.innerText()).trim();
  /connect wallet/i.test(actionTxt) ? ok(`action defaults to honest "Connect wallet" (unconnected)`) : bad("Connect wallet default", actionTxt);

  // Launch-protection row HIDDEN for the expired LILHOODIE (shiro 23867) — scoped to the card, not the
  // static Trust panel below (which always carries the protection copy).
  (await card.locator('[data-testid="hoodie-protection"]').count()) === 0
    ? ok("launch-protection row hidden for expired token (no 'ended' chrome)")
    : bad("protection row hidden when expired", "row is present");

  // Pay symbol defaults to HOODIE on Buy
  const paySym = page.locator('[data-testid="hoodie-pay-sym"]');
  const buyPay = (await paySym.innerText()).trim();
  buyPay.toUpperCase() === "HOODIE" ? ok(`Buy pays HOODIE (pay chip = "${buyPay}")`) : bad("Buy pays HOODIE", buyPay);

  // Toggle to Sell → pay symbol flips to the token (exact-match: the token symbol may CONTAIN "hoodie").
  await sellSeg.click();
  await page.waitForTimeout(200);
  const sellPay = (await paySym.innerText()).trim();
  (sellPay.toUpperCase() !== "HOODIE" && sellPay.length > 0) ? ok(`Sell pays the token (pay chip flips to "${sellPay}")`) : bad("Sell pays the token", sellPay);

  // No console errors
  const realErrors = errors.filter((e) => !/favicon|preload|manifest|Download the React DevTools/i.test(e));
  realErrors.length === 0 ? ok("no console/page errors on the token page") : bad("no console errors", realErrors.slice(0, 3).join(" | ").slice(0, 200));
} finally {
  await browser.close();
}

console.log(`\nhoodieSwapCardSmoke: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
