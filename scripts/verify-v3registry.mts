// V3 multichain registry plumbing — fail-closed derivation, engine-aware lookups, copy-gate fixtures.
// Bundled+run via esbuild (imports transitive app modules). Run all: `node scripts/verify-v3ui-all.mjs`.
// Covers kami 24254/24259: raw-fact evidence derived vs the row (no summary booleans); canonical Uniswap ≠
// app-available (needs deployed+signed Hyde launch); independently verified V3 trade path;
// mismatch/missing-proof fail-closed; V4-only/V3-only/both/neither lookups; no V4 copy in the V3 branch.
import {
  chainCapabilities,
  chainCapability,
  chainEngineCapability,
  chainEngineCapabilities,
  deriveV3Capability,
  V3_CANDIDATES,
  ENGINE_META,
} from "../src/utils/chainRegistry.ts";
import type { ChainCapability } from "../src/utils/chainRegistry.ts";
import type { V3ChainEvidence } from "../src/utils/chainEvidenceV3.ts";

let pass = 0;
let fail = 0;
function ok(label: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
const isUnsupported = (c: { status?: string }) => c.status === "unsupported";

const stableRow = V3_CANDIDATES[0];
const infraFor = (row: typeof stableRow) => ({
  chainId: row.id,
  numeraire: { address: row.numeraire.address, decimals: row.numeraire.decimals, symbol: row.numeraire.symbol },
  factory: { address: row.v3Factory, feeTier: row.feeTier, tickSpacing: 200, codeHash: "0xfeed", codeSize: 24535 },
  positionManager: { address: row.positionManager, factoryBinding: row.v3Factory, codeHash: "0xnpm", codeSize: 24384 },
  numeraireCode: { codeHash: "0xbeef", codeSize: 2227 },
  verifiedAtBlock: "32880344",
});
const signedLaunch = {
  implementation: stableRow.launchpad.implementation,
  pad: stableRow.launchpad.pad,
  locker: stableRow.launchpad.locker,
  implementationCodeSize: 4650,
  padCodeSize: 9264,
  lockerCodeSize: 3140,
  implementationCodeHash: stableRow.launchpad.implementationCodeHash,
  padCodeHash: stableRow.launchpad.padCodeHash,
  lockerCodeHash: stableRow.launchpad.lockerCodeHash,
  padLockerBinding: stableRow.launchpad.locker,
  lockerFactoryBinding: stableRow.launchpad.pad,
  deployTx: "0x" + "a".repeat(64),
  launchRoundTripFdv: "5000",
};
const signedTrade = {
  swapRouter: stableRow.swapRouter,
  quoter: stableRow.quoter,
  swapRouterCodeHash: stableRow.swapRouterCodeHash,
  quoterCodeHash: stableRow.quoterCodeHash,
  quoteSmoke: {
    tokenIn: stableRow.numeraire.address,
    tokenOut: "0x8aa67e0D40e9dE58ad10919A8d88FFAf2747EC69",
    fee: stableRow.feeTier,
    amountIn: "100000",
    amountOut: "19817710300606260025938",
    routerAmountOut: "19817710300606260025938",
    smokeAccount: "0x576d116ef6649bb177659a3ad2f34f6ba1fd9703",
    atBlock: "33443361",
  },
  tradeSmoke: { txHash: "0x" + "b".repeat(64), atBlock: "33305719" },
};

console.log("Real generated artifact (Stable launch + trade fully verified):");
const stableCap = chainCapabilities().find((c) => c.id === 988)!;
ok("Stable engine v3-single-sided, role launch+trade", stableCap.engine === "v3-single-sided" && stableCap.role === "launch+trade");
ok("numeraire = USDT0 6-dec USD-pegged", stableCap.numeraire.symbol === "USDT0" && stableCap.numeraire.decimals === 6 && stableCap.numeraire.usdPegged === true);
ok("canonical infra + Hyde deployment evidence → live", stableCap.status === "live");
ok("verified V3 trade config is exposed", stableCap.trade?.engine === "v3-single-sided" && stableCap.smoke.trade);
ok("V3 evidence EXPOSED (not discarded), infra present (kami #4)", !!stableCap.evidence && "infra" in stableCap.evidence && (stableCap.evidence as V3ChainEvidence).infra?.factory.tickSpacing === 200);

console.log("\nLaunch proof and trade proof fail independently:");
const rowWithMeta = { ...stableRow, explorer: "https://explorer.stable.example", nativeSymbol: "USDT0" };
const liveEv: V3ChainEvidence = { chainId: 988, generatedAtBlock: "1", infra: infraFor(stableRow), launch: signedLaunch, readSmoke: { verifiedAtBlock: "1" } };
const capLive = deriveV3Capability(rowWithMeta, liveEv);
ok("infra + signed launch + metadata + read smoke → live", capLive.status === "live");
ok("missing trade proof stays launch-only", capLive.trade === null && capLive.role === "launch");
const tradeLive = deriveV3Capability(rowWithMeta, { ...liveEv, trade: signedTrade });
ok("signed router + quoter + quote + funded tx → in-app V3 trade", tradeLive.trade?.engine === "v3-single-sided" && tradeLive.role === "launch+trade");
const badTradeHash = deriveV3Capability(rowWithMeta, {
  ...liveEv,
  trade: { ...signedTrade, quoterCodeHash: "0x" + "f".repeat(64) },
});
ok("trade runtime hash mismatch fails closed without disabling launch", badTradeHash.status === "live" && badTradeHash.trade === null && badTradeHash.role === "launch");

console.log("\nFail-closed: mismatch / missing-proof (kami #3):");
const wrongFactory: V3ChainEvidence = { ...liveEv, infra: { ...infraFor(stableRow), factory: { ...infraFor(stableRow).factory, address: "0x9999999999999999999999999999999999999999" } } };
ok("infra factory ≠ row → coming (derived equality, not a boolean)", deriveV3Capability(rowWithMeta, wrongFactory).status === "coming");
const wrongDecimals: V3ChainEvidence = { ...liveEv, infra: { ...infraFor(stableRow), numeraire: { address: stableRow.numeraire.address, decimals: 18, symbol: "USDT0" } } };
ok("infra numeraire decimals ≠ row → coming", deriveV3Capability(rowWithMeta, wrongDecimals).status === "coming");
const noDeployTx: V3ChainEvidence = { ...liveEv, launch: { ...signedLaunch, deployTx: undefined } };
ok("launch missing deploy-tx provenance → coming", deriveV3Capability(rowWithMeta, noDeployTx).status === "coming");
const badBinding: V3ChainEvidence = { ...liveEv, launch: { ...signedLaunch, padLockerBinding: "0x3333333333333333333333333333333333333333" } };
ok("launch pad↔locker cross-bind wrong → coming", deriveV3Capability(rowWithMeta, badBinding).status === "coming");
const badPadHash: V3ChainEvidence = { ...liveEv, launch: { ...signedLaunch, padCodeHash: "0x" + "f".repeat(64) } };
ok("launch pad runtime hash wrong → coming", deriveV3Capability(rowWithMeta, badPadHash).status === "coming");
const rowWithoutExplorer = { ...stableRow, explorer: "" };
ok("no metadata on row (explorer empty) → coming even if fully signed", deriveV3Capability(rowWithoutExplorer, liveEv).status === "coming");

console.log("\nEngine-aware lookups — V4-only / V3-only / both / neither (kami #1):");
const mk = (id: number, engine: "v4-hook" | "v3-single-sided") => ({ id, engine } as unknown as ChainCapability);
const synth: ChainCapability[] = [mk(1, "v4-hook"), mk(2, "v3-single-sided"), mk(3, "v4-hook"), mk(3, "v3-single-sided")];
ok("V4-only chain 1: V4 resolves", chainEngineCapability(1, "v4-hook", synth) === synth[0]);
ok("V4-only chain 1: V3 → unsupported", isUnsupported(chainEngineCapability(1, "v3-single-sided", synth)));
ok("V3-only chain 2: V3 resolves", chainEngineCapability(2, "v3-single-sided", synth) === synth[1]);
ok("V3-only chain 2: V4 → unsupported", isUnsupported(chainEngineCapability(2, "v4-hook", synth)));
ok("both chain 3: exposes 2 engines", chainEngineCapabilities(3, synth).length === 2);
ok("both chain 3: V4 and V3 both resolve", !isUnsupported(chainEngineCapability(3, "v4-hook", synth)) && !isUnsupported(chainEngineCapability(3, "v3-single-sided", synth)));
ok("neither chain 4: no engines, lookups unsupported", chainEngineCapabilities(4, synth).length === 0 && isUnsupported(chainEngineCapability(4, "v4-hook", synth)));
ok("unknown chain → unsupported (real registry)", chainCapability(999999).status === "unsupported");

console.log("\nEngine copy gate (no cross-engine leak, kami 24242):");
const v3meta = ENGINE_META["v3-single-sided"];
const v4meta = ENGINE_META["v4-hook"];
ok('V3 fee split = "95% creator • 5% Hyde"', v3meta.feeSplitLabel === "95% creator • 5% Hyde", v3meta.feeSplitLabel);
ok("V3 trust line = perma-lock", /permanently locked/i.test(v3meta.trustLine));
ok("V3 branch has NO V4 copy (90% / auto-compound / locked LP)", !/(90%|auto-compound|locked LP)/i.test(JSON.stringify(v3meta)));
ok("V4 fee split carries 90/5/5", /90%/.test(v4meta.feeSplitLabel));

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
