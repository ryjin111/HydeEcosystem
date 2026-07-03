// Headless smoke: the Robinhood (4663) launch lane, LIVE against mainnet RPC.
// Read-only (eth_call) — no key, no gas. Mirrors src/utils/dopplerLaunch.ts exactly;
// if this goes red, the launch button is broken.
import { createPublicClient, http, defineChain, parseEther } from "viem";
import { DopplerSDK, MulticurveBuilder, getAddresses } from "@whetstone-research/doppler-sdk/evm";

const robinhood = defineChain({
  id: 4663, name: "Robinhood Chain",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
});
const publicClient = createPublicClient({ chain: robinhood, transport: http() });

const A = getAddresses(4663);
let pass = 0, fail = 0;
const check = (label, ok, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`); };

// 1. SDK map agrees with our on-chain-derived + eth_getCode-verified config
check("sdk WETH == derived WETH", A.weth.toLowerCase() === "0x0bd7d308f8e1639fab988df18a8011f41eacad73");
check("sdk poolManager == derived PoolManager", A.poolManager.toLowerCase() === "0x8366a39cc670b4001a1121b8f6a443a643e40951");
check("sdk airlock == config Airlock", A.airlock.toLowerCase() === "0xeb7c034704ef8dcd2d32324c1545f62fb4ad0862");
check("dopplerERC20V1Factory present", !!A.dopplerERC20V1Factory && A.dopplerERC20V1Factory !== "0x0000000000000000000000000000000000000000", A.dopplerERC20V1Factory);
check("rehypeDopplerHook present", !!A.rehypeDopplerHook, A.rehypeDopplerHook);
check("v2MigratorSplit present", !!A.v2MigratorSplit, A.v2MigratorSplit);
check("noOpGovernanceFactory present", !!A.noOpGovernanceFactory, A.noOpGovernanceFactory);

// 2. Build params EXACTLY as src/utils/dopplerLaunch.ts does
const CREATOR = "0x000000000000000000000000000000000000dEaD"; // dummy EOA — read-only sim
const WAD = 10n ** 18n;
const params = MulticurveBuilder.forChain(4663)
  .tokenConfig({ type: "dopplerERC20V1", name: "Hyde Smoke", symbol: "SMOKE", tokenURI: "" })
  .saleConfig({ initialSupply: parseEther("1000000000"), numTokensToSell: parseEther("1000000000"), numeraire: A.weth })
  .withMarketCapPresets()
  .withRehypeDopplerHook({
    hookAddress: A.rehypeDopplerHook,
    buybackDestination: CREATOR,
    feeRoutingMode: "routeToBeneficiaryFees",
    feeDistributionInfo: {
      assetFeesToAssetBuybackWad: 0n, assetFeesToNumeraireBuybackWad: 0n, assetFeesToBeneficiaryWad: WAD, assetFeesToLpWad: 0n,
      numeraireFeesToAssetBuybackWad: 0n, numeraireFeesToNumeraireBuybackWad: 0n, numeraireFeesToBeneficiaryWad: WAD, numeraireFeesToLpWad: 0n,
    },
    startFee: 30000, endFee: 10000, durationSeconds: 3600,
  })
  .withGovernance({ type: "noOp" })
  .withMigration({ type: "uniswapV2Split" })
  .withUserAddress(CREATOR)
  .build();
check("params built (1B supply, 100% to curve)", !!params && !!params.token);

// 3. LIVE simulate on 4663 — predicted token + poolId + gas, zero spend
try {
  const sdk = new DopplerSDK({ publicClient, chainId: 4663 });
  const sim = await sdk.factory.simulateCreateMulticurve(params);
  check("simulateCreateMulticurve (LIVE 4663)", /^0x[0-9a-fA-F]{40}$/.test(sim.tokenAddress), `token=${sim.tokenAddress}`);
  check("poolId predicted", typeof sim.poolId === "string" && sim.poolId.length > 2, `poolId=${sim.poolId.slice(0, 20)}…`);
  check("gas estimate sane", sim.gasEstimate === undefined || (sim.gasEstimate > 1_000_000n && sim.gasEstimate < 30_000_000n), String(sim.gasEstimate ?? "n/a"));
} catch (e) {
  check("simulateCreateMulticurve (LIVE 4663)", false, e.message?.replace(/\n/g, " ").slice(0, 200));
}

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exitCode = fail ? 1 : 0; // natural exit — process.exit() trips a libuv teardown assert on Windows

// ─── tokenURI metadata lane (lane #2) ───────────────────────────────────────
// Same self-contained data-URI metadata the form builds — proven against the
// live chain, then decoded back to verify round-trip integrity.
function buildTokenURI({ name, symbol, imageUrl, description }) {
  if (!imageUrl && !description) return "";
  const metadata = { name: name.trim(), symbol: symbol.trim() };
  if (imageUrl) metadata.image = imageUrl.trim();
  if (description) metadata.description = description.trim();
  const json = JSON.stringify(metadata);
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 8192)));
  return `data:application/json;base64,${btoa(binary)}`;
}

const uri = buildTokenURI({ name: "Hyde Smoke", symbol: "SMOKE", imageUrl: "https://example.com/logo.png", description: "smoke-test metadata" });
const decoded = JSON.parse(Buffer.from(uri.split(",")[1], "base64").toString("utf8"));
check("tokenURI round-trip", decoded.image === "https://example.com/logo.png" && decoded.description === "smoke-test metadata", uri.slice(0, 48) + "…");

try {
  const paramsWithMeta = MulticurveBuilder.forChain(4663)
    .tokenConfig({ type: "dopplerERC20V1", name: "Hyde Smoke", symbol: "SMOKE", tokenURI: uri })
    .saleConfig({ initialSupply: parseEther("1000000000"), numTokensToSell: parseEther("1000000000"), numeraire: A.weth })
    .withMarketCapPresets()
    .withRehypeDopplerHook({
      hookAddress: A.rehypeDopplerHook, buybackDestination: CREATOR, feeRoutingMode: "routeToBeneficiaryFees",
      feeDistributionInfo: {
        assetFeesToAssetBuybackWad: 0n, assetFeesToNumeraireBuybackWad: 0n, assetFeesToBeneficiaryWad: WAD, assetFeesToLpWad: 0n,
        numeraireFeesToAssetBuybackWad: 0n, numeraireFeesToNumeraireBuybackWad: 0n, numeraireFeesToBeneficiaryWad: WAD, numeraireFeesToLpWad: 0n,
      },
      startFee: 30000, endFee: 10000, durationSeconds: 3600,
    })
    .withGovernance({ type: "noOp" })
    .withMigration({ type: "uniswapV2Split" })
    .withUserAddress(CREATOR)
    .build();
  const sdk2 = new DopplerSDK({ publicClient, chainId: 4663 });
  const sim2 = await sdk2.factory.simulateCreateMulticurve(paramsWithMeta);
  check("simulate WITH metadata tokenURI (LIVE 4663)", /^0x[0-9a-fA-F]{40}$/.test(sim2.tokenAddress), `token=${sim2.tokenAddress}`);
} catch (e) {
  check("simulate WITH metadata tokenURI (LIVE 4663)", false, e.message?.replace(/\n/g, " ").slice(0, 160));
}

// ─── Drift guard vs src/utils/dopplerLaunch.ts (lesson: audit 16961) ─────────
import { readFileSync } from "node:fs";
const launchSrc = readFileSync(new URL("../src/utils/dopplerLaunch.ts", import.meta.url), "utf8");
const launchNeedles = [
  ["dopplerERC20V1 token type", 'type: "dopplerERC20V1"'],
  ["data-URI metadata marker", "data:application/json;base64,"],
  ["startFee 3%", "START_FEE = 30_000"],
  ["endFee 1%", "END_FEE = 10_000"],
  ["fee routing to beneficiary", 'feeRoutingMode: "routeToBeneficiaryFees"'],
  ["noOp governance", 'withGovernance({ type: "noOp" })'],
  ["V2 split migration", 'withMigration({ type: "uniswapV2Split" })'],
  ["1B supply", 'parseEther("1000000000")'],
  ["100% to curve", "LAUNCH_TOKENS_FOR_SALE = LAUNCH_TOTAL_SUPPLY"],
];
for (const [label, needle] of launchNeedles) {
  check(`drift guard: dopplerLaunch contains ${label}`, launchSrc.includes(needle));
}

console.log(`\nFINAL ${pass}/${pass + fail} checks passed`);
process.exitCode = fail ? 1 : 0;
