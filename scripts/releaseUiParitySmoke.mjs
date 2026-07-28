// Browser-level release gate for the two live Hydeout engines.
//
// Run after `npm run build`:
//   PW_DIR=<playwright-core package directory> node scripts/releaseUiParitySmoke.mjs
//
// This deliberately checks rendered production assets, not source strings alone. It covers the
// cross-engine UI gaps that lower-level contract and formatting smokes cannot see.
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { preview } from "vite";

const PW_DIR = process.env.PW_DIR;
if (!PW_DIR) throw new Error("PW_DIR is required (path to a playwright-core package directory).");
const playwright = await import(pathToFileURL(`${PW_DIR}/index.js`).href);
const chromium = playwright.chromium ?? playwright.default?.chromium;

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const GRUMPY = "0x8aa67e0D40e9dE58ad10919A8d88FFAf2747EC69";
const LILHOODIE = "0x8a76FeeF3bb0140c122d146caCef6B1A4Ac145f7";
const FILTERS = ["24h Volume", "New", "Top Liquidity", "Top MCap"];
const server = await preview({
  root: ROOT,
  preview: { host: "127.0.0.1", port: 4399, strictPort: true },
});
const base = server.resolvedUrls?.local?.[0] ?? "http://127.0.0.1:4399/";
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
});

let passed = 0;
let failed = 0;
const pass = (label) => { passed += 1; console.log(`  ✓ ${label}`); };
const fail = (label, detail) => { failed += 1; console.log(`  ✗ ${label} — ${detail}`); };

async function check(label, action) {
  try {
    const result = await action();
    if (result === false) throw new Error("condition was false");
    pass(label);
  } catch (error) {
    fail(label, error instanceof Error ? error.message : String(error));
  }
}

async function bodyText(page) {
  return (await page.locator("body").innerText()).replace(/\s+/g, " ");
}

async function checkNoOverflow(page, label) {
  await check(label, async () => page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth + 1,
  ));
}

try {
  const desktop = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

  await desktop.goto(`${base}?network=4663`, { waitUntil: "domcontentloaded" });
  await desktop.getByRole("heading", { name: "Live market" }).waitFor();
  for (const label of FILTERS) {
    await check(`V4 home exposes ${label}`, async () => desktop.getByRole("button", { name: label, exact: true }).isVisible());
  }
  await check("V4 home defaults to 24h Volume", async () => (
    await desktop.getByRole("button", { name: "24h Volume", exact: true }).getAttribute("aria-pressed")
  ) === "true");
  await check("Home defaults to the all-chain Hydeout market", async () => (
    await desktop.getByRole("button", { name: "All chains", exact: true }).getAttribute("aria-pressed")
  ) === "true");
  await check("Home highlights Home, not Discover", async () => {
    const active = desktop.locator("aside a[aria-current='page']");
    return await active.count() === 1 && (await active.innerText()).trim() === "Home";
  });
  await check("V4 home shows the known creator and auto-LP split", async () => {
    const text = await bodyText(desktop);
    return text.includes("90–95%")
      && text.includes("V4 routes 90% of fees to creators")
      && text.includes("5% into locked auto-compounding LP");
  });
  await checkNoOverflow(desktop, "V4 home has no desktop horizontal overflow");
  await desktop.getByText("Grumpy Cat", { exact: true }).first().waitFor({ timeout: 60_000 });
  await desktop.getByText("LILHOODIE", { exact: true }).first().waitFor({ timeout: 60_000 });
  await check("Home renders tokens from both live chains together", async () => {
    const text = await bodyText(desktop);
    return text.includes("Grumpy Cat") && text.includes("LILHOODIE")
      && text.includes("STABLE") && text.includes("ROBINHOOD");
  });
  await desktop.screenshot({ path: ".tmp-release-audit-all-home.png", fullPage: true });

  await desktop.goto(`${base}launchpad?tab=launch&network=4663`, { waitUntil: "domcontentloaded" });
  await desktop.getByRole("button", { name: "HOODIE PAIR", exact: true }).waitFor({ timeout: 30_000 });
  await desktop.getByRole("button", { name: "HOODIE PAIR", exact: true }).click();
  await check("V4 live launch route includes image and description metadata", async () => (
    await desktop.getByText("Token Image", { exact: false }).first().isVisible()
      && await desktop.getByText("Description", { exact: false }).first().isVisible()
  ));
  await check("V4 launch shows 90/5/5 without V3 economics", async () => {
    const text = await bodyText(desktop);
    return text.includes("90% creator · 5% Hyde · 5% locked LP")
      && !text.includes("95% creator · 5% Hyde");
  });
  await check("V4 launch does not auto-focus a text field", async () => (
    await desktop.evaluate(() => !["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName ?? ""))
  ));
  await checkNoOverflow(desktop, "V4 launch has no desktop horizontal overflow");

  await desktop.goto(`${base}discover?network=4663`, { waitUntil: "domcontentloaded" });
  await desktop.getByText(/Hydeout aggregate/i).waitFor({ timeout: 30_000 });
  await check("Robinhood Discover identifies the V4 route", async () => (await bodyText(desktop)).includes("V4"));
  await check("Cross-chain Discover also exposes the V3 route", async () => (
    await desktop.getByRole("button", { name: /V3 Single-sided/ }).count()
  ) > 0);
  await check("Discover defaults to All chains", async () => (
    await desktop.getByRole("button", { name: /All chains/ }).getAttribute("aria-pressed")
  ) === "true");
  for (const label of FILTERS) {
    await check(`Discover exposes ${label}`, async () => desktop.getByRole("button", { name: label, exact: true }).isVisible());
  }
  await checkNoOverflow(desktop, "Robinhood Discover has no desktop horizontal overflow");

  await desktop.getByText("Grumpy Cat", { exact: true }).first().waitFor({ timeout: 60_000 });
  await desktop.getByText("LILHOODIE", { exact: true }).first().waitFor({ timeout: 60_000 });
  await desktop.screenshot({ path: ".tmp-release-audit-all-discover.png", fullPage: true });
  await desktop.getByRole("link", { name: /Grumpy Cat/ }).first().click();
  await desktop.waitForURL(new RegExp(`/token/${GRUMPY}\\?network=988$`, "i"));
  await check("A Stable aggregate card adopts network=988 before trading", async () => {
    await desktop.locator('[data-testid="stable-v3-swap"]').waitFor({ timeout: 30_000 });
    return desktop.url().endsWith("?network=988");
  });

  await desktop.goto(`${base}token/${LILHOODIE}?network=4663`, { waitUntil: "domcontentloaded" });
  await check("V4 token page mounts the built-in HOODIE swap", async () => {
    await desktop.locator('[data-testid="hoodie-swap"]').waitFor({ timeout: 30_000 });
    const text = await bodyText(desktop);
    return text.includes("BUY") && text.includes("SELL");
  });
  await check("V4 token page has no V3 economics leakage", async () => (
    !(await bodyText(desktop)).includes("95% creator · 5% Hyde")
  ));
  await checkNoOverflow(desktop, "V4 token page has no desktop horizontal overflow");
  await desktop.screenshot({ path: ".tmp-release-audit-v4-token.png", fullPage: true });

  await desktop.goto(`${base}?network=988`, { waitUntil: "domcontentloaded" });
  await desktop.getByRole("heading", { name: "Live market" }).waitFor();
  for (const label of FILTERS) {
    await check(`V3 home exposes ${label}`, async () => desktop.getByRole("button", { name: label, exact: true }).isVisible());
  }
  await check("V3 home defaults to 24h Volume", async () => (
    await desktop.getByRole("button", { name: "24h Volume", exact: true }).getAttribute("aria-pressed")
  ) === "true");
  await check("V3 ranking tabs are interactive", async () => {
    const liquidity = desktop.getByRole("button", { name: "Top Liquidity", exact: true });
    await liquidity.click();
    return await liquidity.getAttribute("aria-pressed") === "true";
  });
  await desktop.locator("#live-market").getByRole("button", { name: "Stable", exact: true }).click();
  await desktop.getByText("Grumpy Cat", { exact: true }).first().waitFor({ timeout: 60_000 });
  await check("V3 market rankings are backed by indexed values", async () => {
    const text = await bodyText(desktop);
    return text.toLowerCase().includes("market cap") && !text.includes("Not indexed");
  });
  await desktop.screenshot({ path: ".tmp-release-audit-v3-home.png", fullPage: true });

  await desktop.goto(`${base}launchpad?tab=launch&network=988`, { waitUntil: "domcontentloaded" });
  await desktop.getByText("Token image", { exact: true }).waitFor({ timeout: 30_000 });
  await check("Stable launch route is live, not coming soon", async () => (
    await desktop.getByText("Connect your wallet to run the launch pre-flight.", { exact: true }).isVisible()
      && await desktop.getByText("Launch on Stable — Coming soon", { exact: true }).count() === 0
  ));
  await check("Stable launch includes image metadata", async () => (
    await desktop.getByText("Token image", { exact: true }).isVisible()
  ));
  await check("Stable launch includes description metadata", async () => (
    await desktop.getByText("Description", { exact: true }).isVisible()
  ));
  await check("Stable launch does not auto-focus a text field", async () => (
    await desktop.evaluate(() => !["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName ?? ""))
  ));
  await checkNoOverflow(desktop, "Stable launch has no desktop horizontal overflow");
  await desktop.screenshot({ path: ".tmp-release-audit-v3-launch.png", fullPage: true });

  await desktop.goto(`${base}discover?network=988`, { waitUntil: "domcontentloaded" });
  await desktop.getByText(/Hydeout aggregate/i).waitFor({ timeout: 30_000 });
  await check("Stable Discover identifies the V3 route", async () => (await bodyText(desktop)).includes("V3"));
  await check("Stable Discover keeps V4 visible in All chains mode", async () => (
    await desktop.getByRole("button", { name: /V4 Hook/ }).count()
  ) > 0);
  await checkNoOverflow(desktop, "Stable Discover has no desktop horizontal overflow");

  await desktop.goto(`${base}swap?out=${GRUMPY}&network=988`, { waitUntil: "domcontentloaded" });
  await desktop.waitForURL(new RegExp(`/token/${GRUMPY}\\?network=988$`, "i"));
  await check("Legacy Stable swap redirect preserves network=988", async () => desktop.url().endsWith("?network=988"));
  await check("Stable token page mounts the built-in V3 swap", async () => {
    await desktop.locator('[data-testid="stable-v3-swap"]').waitFor({ timeout: 30_000 });
    const text = await bodyText(desktop);
    return text.includes("BUY") && text.includes("SELL") && text.includes("V3 · 1% pool");
  });
  await check("Stable token page exposes creator fee collection", async () => (
    await bodyText(desktop)
  ).includes("95% is paid directly in both pool assets"));
  await desktop.getByText("24h volume", { exact: true }).locator("..").getByText(/\$/).waitFor({ timeout: 30_000 });
  await check("Stable token page shows real price, market cap, liquidity, and 24h volume", async () => {
    for (const label of ["Market cap", "Price", "24h volume", "Liquidity"]) {
      const row = desktop.getByText(label, { exact: true }).locator("..");
      if (!(await row.innerText()).includes("$")) return false;
    }
    return true;
  });
  await check("Stable token page has no V4 economics leakage", async () => {
    const text = await bodyText(desktop);
    return !text.includes("90% creator · 5% Hyde · 5% locked liquidity");
  });
  await desktop.screenshot({ path: ".tmp-release-audit-v3-token.png", fullPage: true });

  for (const route of [
    "profile?network=988",
    "stats?network=988",
    "add-liquidity?network=988",
  ]) {
    await desktop.goto(`${base}${route}`, { waitUntil: "domcontentloaded" });
    await checkNoOverflow(desktop, `/${route.split("?")[0]} has no desktop horizontal overflow`);
  }

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  for (const route of [
    "?network=4663",
    "launchpad?tab=launch&network=4663",
    "discover?network=4663",
    `token/${LILHOODIE}?network=4663`,
    "profile?network=4663",
    "stats?network=4663",
  ]) {
    await mobile.goto(`${base}${route}`, { waitUntil: "domcontentloaded" });
    await checkNoOverflow(mobile, `Robinhood /${route.split("?")[0]} has no mobile horizontal overflow`);
  }
  for (const route of [
    "?network=988",
    "launchpad?tab=launch&network=988",
    "discover?network=988",
    `token/${GRUMPY}?network=988`,
    "profile?network=988",
    "stats?network=988",
  ]) {
    await mobile.goto(`${base}${route}`, { waitUntil: "domcontentloaded" });
    await checkNoOverflow(mobile, `Stable /${route.split("?")[0]} has no mobile horizontal overflow`);
  }
  await mobile.goto(`${base}?network=988`, { waitUntil: "domcontentloaded" });
  await mobile.getByRole("button", { name: "24h Volume", exact: true }).waitFor({ timeout: 30_000 });
  for (const label of FILTERS) {
    await check(`V3 mobile exposes ${label}`, async () => mobile.getByRole("button", { name: label, exact: true }).isVisible());
  }
  await mobile.screenshot({ path: ".tmp-release-audit-v3-home-mobile.png", fullPage: true });
  await mobile.goto(`${base}token/${GRUMPY}?network=988`, { waitUntil: "domcontentloaded" });
  await mobile.locator('[data-testid="stable-v3-swap"]').waitFor({ timeout: 30_000 });
  await mobile.screenshot({ path: ".tmp-release-audit-v3-token-mobile.png", fullPage: true });

  // Static guard for a connected-wallet-only branch that browser smoke cannot reach without signing.
  const launchpadSource = readFileSync(new URL("../src/pages/Launchpad.tsx", import.meta.url), "utf8");
  await check("Stable My Launches includes the V3 creator fee collector", async () => (
    launchpadSource.includes('pool.launchEngine === "v3-single-sided"')
      && launchpadSource.includes("<StableV3FeeCollector")
      && launchpadSource.includes("showClaimable")
  ));

  // Render the connected-only My Launches branch with a read-only EIP-1193 wallet shim. No transaction
  // is signed; this proves the real connected UI exposes the Stable fee collector above the card overlay.
  const walletContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await walletContext.addInitScript(({ account }) => {
    let chainId = "0x3dc";
    const listeners = new Map();
    window.ethereum = {
      isMetaMask: true,
      request: async ({ method, params }) => {
        if (method === "eth_chainId") return chainId;
        if (method === "eth_accounts" || method === "eth_requestAccounts") return [account];
        if (method === "wallet_switchEthereumChain") {
          chainId = params?.[0]?.chainId ?? chainId;
          for (const listener of listeners.get("chainChanged") ?? []) listener(chainId);
          return null;
        }
        if (method === "wallet_addEthereumChain") return null;
        return null;
      },
      on: (event, listener) => {
        const current = listeners.get(event) ?? [];
        current.push(listener);
        listeners.set(event, current);
      },
      removeListener: (event, listener) => {
        listeners.set(event, (listeners.get(event) ?? []).filter((item) => item !== listener));
      },
    };
  }, { account: "0x800557e7882b42ee49594fa2790300A9697a0e4D" });
  const walletPage = await walletContext.newPage();
  await walletPage.goto(`${base}launchpad?tab=mine&network=988`, { waitUntil: "domcontentloaded" });
  await walletPage.getByRole("button", { name: "Connect", exact: true }).click();
  await walletPage.getByText("Creator fees", { exact: true }).waitFor({ timeout: 60_000 });
  await check("Connected Stable My Launches renders creator-fee actions", async () => {
    const text = await bodyText(walletPage);
    return text.includes("95% is paid directly in both pool assets")
      && (text.includes("Collect creator fees") || text.includes("No fees available"));
  });
  await walletPage.screenshot({ path: ".tmp-release-audit-v3-my-launches.png", fullPage: true });
  await walletContext.close();
} finally {
  await browser.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
}

console.log(`\nreleaseUiParitySmoke: ${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
