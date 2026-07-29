// Rendered production smoke for fresh token price + wrong-chain handoff.
// Run after `npm run build`:
//   PW_DIR=<playwright-core package directory> node scripts/tokenChainPriceSmoke.mjs
import { fileURLToPath, pathToFileURL } from "node:url";
import { preview } from "vite";

const PW_DIR = process.env.PW_DIR;
if (!PW_DIR) throw new Error("PW_DIR is required (path to a playwright-core package directory).");
const playwright = await import(pathToFileURL(`${PW_DIR}/index.js`).href);
const chromium = playwright.chromium ?? playwright.default?.chromium;
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const LILHOODIE = "0x8a76FeeF3bb0140c122d146caCef6B1A4Ac145f7";
const server = await preview({
  root: ROOT,
  preview: { host: "127.0.0.1", port: 4402, strictPort: true },
});
const base = server.resolvedUrls?.local?.[0] ?? "http://127.0.0.1:4402/";
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(60_000);

const indexedPool = {
  address: LILHOODIE,
  chainId: 4663,
  baseToken: { address: LILHOODIE, name: "LILHOODIE", symbol: "LILHOODIE", decimals: 18 },
  quoteToken: {
    address: "0xC72c01AAB5f5678dc1d6f5C6d2B417d91D402Ba3",
    name: "Hoodie",
    symbol: "HOODIE",
    decimals: 18,
  },
  launchEngine: "v4-hook",
  type: "v4",
  dollarLiquidity: null,
  volumeUsd: null,
  marketCapUsd: null,
  priceUsd: null,
  createdAt: "2026-07-24T00:00:00.000Z",
  progress: null,
  creator: "0x800557e7882b42ee49594fa2790300A9697a0e4D",
  creatorClaimable: null,
};

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
  // Keep launch membership deterministic; the price still comes from the live
  // DEXScreener request made by the built UI.
  await page.route("**/api/robinhood-launches", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ pools: [indexedPool] }),
  }));

  await page.goto(`${base}token/${LILHOODIE}?network=4663`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("token-price").waitFor();
  await page.waitForFunction(() => {
    const value = document.querySelector('[data-testid="token-price"]')?.textContent?.trim();
    return Boolean(value && value !== "—");
  });
  await check("LILHOODIE renders a fresh traded-pool USD price", async () => {
    const value = (await page.getByTestId("token-price").textContent())?.trim() ?? "";
    return value.startsWith("$") && value !== "—";
  });

  await page.goto(`${base}token/${LILHOODIE}?network=988`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("wrong-chain-token").waitFor();
  await check("Stable view identifies LILHOODIE's actual chain", async () => {
    const notice = await page.getByTestId("wrong-chain-token").innerText();
    return notice.includes("LILHOODIE lives on Robinhood Chain.")
      && notice.includes("You’re currently viewing Stable.")
      && await page.getByRole("link", { name: "View on Robinhood Chain" }).count() === 1;
  });
} finally {
  await browser.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
}

console.log(`\n${failures === 0 ? "Token chain/price smoke passed" : `${failures} token chain/price check(s) failed`}`);
process.exitCode = failures === 0 ? 0 : 1;
