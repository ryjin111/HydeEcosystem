// Real-pointer gate for the whole-card-clickable launch card (clint 23774; kami 23788 a11y restructure).
// Uses REAL Playwright pointer/keyboard events (NOT programmatic node .click()) against the PRODUCTION
// `vite preview` bundle — the click-through class of bug our team gate exists for.
//
// Structure under test (kami 23788): the card wrapper is NON-interactive; a single absolute full-card
// native <button aria-label="Trade …"> overlay is the one focus/click control; the address-copy <button>
// is a SIBLING raised above the overlay by z-index. So: clicking/Entering the card trades; clicking OR
// pressing Enter on copy copies and NEVER navigates; the visual "Trade →" span is pointer-events-none and
// falls through to the overlay.
//
// Run: GATE_BASE=http://localhost:4199 PW_DIR=<playwright pkg dir> node scripts/clickCardPointerSmoke.mjs
// Cards render from live on-chain launches (useHydeLaunches); if none render, reports NO_LIVE_CARDS and
// exits non-zero rather than falsely passing.

import { pathToFileURL } from "node:url";
// Playwright isn't a repo dep — resolve it from the globally cached module (PW_DIR = its package dir).
const PW_DIR = process.env.PW_DIR;
const _pw = await import(pathToFileURL(`${PW_DIR}/index.js`).href);
const chromium = _pw.chromium ?? _pw.default?.chromium;

const BASE = process.env.GATE_BASE || "http://localhost:4199";
const SWAP_RE = /\/swap\?out=0x[0-9a-fA-F]{40}/;
const OVERLAY = 'button[aria-label^="Trade "]'; // the full-card native overlay control
const COPY = 'button[aria-label^="Copy contract address"]';

let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log(`  ✓ ${name}`); };
const bad = (name, detail) => { fail++; console.log(`  ✗ ${name} — ${detail}`); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
const page = await ctx.newPage();

const gotoGrid = async () => {
  await page.goto(`${BASE}/`, { waitUntil: "networkidle", timeout: 45000 });
  await page.locator(OVERLAY).first().waitFor({ state: "visible", timeout: 30000 });
};

try {
  await page.goto(`${BASE}/`, { waitUntil: "networkidle", timeout: 45000 });
  try {
    await page.locator(OVERLAY).first().waitFor({ state: "visible", timeout: 30000 });
  } catch {
    console.log("NO_LIVE_CARDS: no launch card rendered on the Landing grid within 30s (live data unreachable?).");
    await browser.close();
    process.exit(2);
  }

  // 1) Whole-card body click over the image area (away from the copy control) -> navigates to /swap.
  const overlay = page.locator(OVERLAY).first();
  await overlay.click({ position: { x: 40, y: 18 } }); // top image area; overlay is topmost here
  await page.waitForTimeout(300);
  if (SWAP_RE.test(page.url())) ok(`card body click -> ${new URL(page.url()).pathname}${new URL(page.url()).search}`);
  else bad("card body click navigates to /swap", `url=${page.url()}`);

  // 2) Copy control click must NOT navigate — copy sits above the overlay (z-index), no stopPropagation.
  await gotoGrid();
  await page.locator(COPY).first().click();
  await page.waitForTimeout(300);
  if (!/\/swap/.test(page.url())) ok("copy-address click copies WITHOUT navigating");
  else bad("copy click must not navigate", `url=${page.url()}`);

  // 3) Keyboard: focus the overlay and press Enter -> navigates (native button Enter/Space).
  await gotoGrid();
  await page.locator(OVERLAY).first().focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  if (SWAP_RE.test(page.url())) ok("keyboard Enter on focused card overlay -> /swap");
  else bad("keyboard Enter navigates to /swap", `url=${page.url()}`);

  // 4) KEYBOARD-COPY (kami 23788): focus copy, press Enter -> copies, must NOT navigate.
  await gotoGrid();
  const copy = page.locator(COPY).first();
  await copy.focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  const copyFeedback = await copy.innerText().catch(() => "");
  const navigated = /\/swap/.test(page.url());
  const copied = /copied|copy failed/i.test(copyFeedback); // activated (ok or clipboard-denied) — either proves the button fired
  if (!navigated && copied) ok("keyboard Enter on copy copies WITHOUT navigating");
  else bad("keyboard Enter on copy must copy without navigating", `navigated=${navigated} feedback=${JSON.stringify(copyFeedback)}`);

  // 5) The visual "Trade →" affordance is pointer-events-none: clicking over the footer where it sits
  //    lands on the overlay (Playwright confirms the overlay is the hit target there — the span doesn't
  //    block it) and trades (clint's original "click the Trade area" intent, now via the overlay).
  await gotoGrid();
  const ov5 = page.locator(OVERLAY).first();
  const ob = await ov5.boundingBox();
  await ov5.click({ position: { x: ob.width - 30, y: ob.height - 22 } }); // footer / Trade→ region
  await page.waitForTimeout(300);
  if (SWAP_RE.test(page.url())) ok("click over the 'Trade →' affordance hits overlay -> /swap");
  else bad("'Trade →' affordance routes via overlay", `url=${page.url()}`);
} catch (e) {
  bad("harness", e.message);
} finally {
  await browser.close();
}

console.log(`\nclickCardPointerSmoke: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
