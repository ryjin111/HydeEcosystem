// Rendered production smoke for Arbitrum's live Hyde launch rail and
// fail-closed execution-only features.
// Run after `npm run build`:
//   PW_DIR=<playwright-core package directory> node scripts/arbitrumUiSmoke.mjs
import { fileURLToPath, pathToFileURL } from "node:url";
import { preview } from "vite";

const PW_DIR = process.env.PW_DIR;
if (!PW_DIR) throw new Error("PW_DIR is required (path to a playwright-core package directory).");
const playwright = await import(pathToFileURL(`${PW_DIR}/index.js`).href);
const chromium = playwright.chromium ?? playwright.default?.chromium;
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const server = await preview({
  root: ROOT,
  preview: { host: "127.0.0.1", port: 4401, strictPort: true },
});
const base = server.resolvedUrls?.local?.[0] ?? "http://127.0.0.1:4401/";
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(60_000);
let failures = 0;

async function check(label, action) {
  try {
    if (!(await action())) throw new Error("condition was false");
    console.log(`PASS  ${label}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${label} — ${error instanceof Error ? error.message : String(error)}`);
  }
}

try {
  await page.goto(`${base}?network=42161`, { waitUntil: "domcontentloaded" });
  await page.locator('select option[value="42161"]').first().waitFor({ state: "attached" });
  await check("Arbitrum is selected and no longer marked coming", async () => (
    (await page.locator("select").first().inputValue()) === "42161"
    && (await page.locator('select option[value="42161"]').first().textContent())
      ?.includes("Arbitrum One · 42161")
    && !(await page.locator('select option[value="42161"]').first().textContent())
      ?.includes("Coming")
  ));
  await page.getByText("Live launch protocol", { exact: true }).waitFor();
  await check("home exposes the verified Arbitrum V4 launch rail", async () => {
    const text = (await page.locator("body").innerText()).toLowerCase();
    return text.includes("live on arbitrum one.")
      && text.includes("90% of fees to creators")
      && text.includes("launch a token");
  });

  await page.goto(`${base}launchpad?tab=launch&network=42161`, { waitUntil: "domcontentloaded" });
  await page.getByText("Launch a Token", { exact: true }).first().waitFor();
  await check("Arbitrum launch form is live and WETH-only", async () => {
    const text = await page.locator("body").innerText();
    return text.includes("Launch on Arbitrum One")
      && text.includes("WETH")
      && !text.includes("HOODIE PAIR")
      && await page.locator('input[placeholder="e.g. HydeToken"]').count() > 0;
  });
  await check("no coming-soon launch control remains", async () => (
    await page.getByRole("button", { name: /Coming soon/i }).count()
  ) === 0);

  await page.goto(`${base}add-liquidity?network=42161`, { waitUntil: "domcontentloaded" });
  await page.getByText("Adding liquidity isn’t live on Arbitrum One yet.").waitFor();
  await check("liquidity controls are fail-closed", async () => {
    const text = await page.locator("body").innerText();
    return text.includes("Adding liquidity isn’t live on Arbitrum One yet.")
      && text.includes("launch contracts are live")
      && text.includes("execution gateway")
      && await page.getByText("Add", { exact: true }).count() === 0;
  });

  await page.goto(`${base}profile?network=42161`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Connect wallet" }).waitFor();
  await check("Arbitrum profile is live and wallet-scoped", async () => {
    const text = await page.locator("body").innerText();
    return text.includes("Your launches, positions, and fees")
      && text.includes("Connect wallet")
      && !text.includes("isn’t live on Arbitrum One yet");
  });
} finally {
  await browser.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
}

console.log(`\n${failures === 0 ? "Arbitrum UI smoke passed" : `${failures} Arbitrum UI smoke check(s) failed`}`);
process.exitCode = failures === 0 ? 0 : 1;
