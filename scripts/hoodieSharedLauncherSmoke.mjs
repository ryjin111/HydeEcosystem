// Focused smoke (clint 23759/23771 · kami 23760/23767/23769): HOODIE must use exactly ONE shared launcher,
// users create NOTHING, every launch is 1 tx. We REUSE the existing registered launcher clint used to launch
// LILHOODIE (kami's decision — no second mint). Proves (a) the frontend-pinned launcher is LIVE + registered
// + correctly wired on-chain (engine allowlist, engine/owner wiring), and (b) drift-guards that EVERY
// per-user / two-step / createLauncher path is gone from the launch util + form. Node strips .ts on import.
import { readFileSync } from "node:fs";
import { createPublicClient, http } from "viem";

const RPC = "https://rpc.mainnet.chain.robinhood.com";
const META = "0x101Fe0c0328De00F6F6f928B79d512E899fE2fC0";
const ENGINE = "0x8062951c99CfFA5365f979D5139Cf96b5c77CFCc";
const DEPLOYER = "0x800557e7882b42ee49594fa2790300A9697a0e4D";
// The ONE shared launcher = the existing registered clone clint launched LILHOODIE through (kami 23767).
const LAUNCHER = "0x004E6Fa435757B80adB17ADd67524CcAF4c4305B";

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`); };
const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

const metaAbi = [{ type: "function", name: "launcherOwner", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ type: "address" }] }];
const engineAbi = [
  { type: "function", name: "launchFeeAmount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "isLauncher", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ type: "bool" }] },
];
const launcherAbi = [
  { type: "function", name: "engine", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
];

// ── RPC: the pinned launcher is LIVE, registered, and correctly wired (so 1-tx launches route through it) ──
const c = createPublicClient({ transport: http(RPC) });
const [code, isReg, launcherEngine, launcherOwner, metaOwner, fee, paused] = await Promise.all([
  c.getCode({ address: LAUNCHER }),
  c.readContract({ address: ENGINE, abi: engineAbi, functionName: "isLauncher", args: [LAUNCHER] }),
  c.readContract({ address: LAUNCHER, abi: launcherAbi, functionName: "engine" }),
  c.readContract({ address: LAUNCHER, abi: launcherAbi, functionName: "owner" }),
  c.readContract({ address: META, abi: metaAbi, functionName: "launcherOwner", args: [LAUNCHER] }),
  c.readContract({ address: ENGINE, abi: engineAbi, functionName: "launchFeeAmount" }),
  c.readContract({ address: ENGINE, abi: engineAbi, functionName: "paused" }),
]);
check("shared launcher is deployed (has code)", !!code && code !== "0x");
check("engine.isLauncher(shared) == true (registered/allowlisted)", isReg === true);
check("launcher.engine() == the HOODIE engine", eq(launcherEngine, ENGINE), launcherEngine);
check("launcher.owner() == Hydeout deployer", eq(launcherOwner, DEPLOYER), launcherOwner);
check("metaFactory.launcherOwner(shared) == Hydeout deployer", eq(metaOwner, DEPLOYER), metaOwner);
check("engine not paused", paused === false);
check("engine.launchFeeAmount == 0.0004 ETH", fee === 400000000000000n, `${fee}`);

// ── drift: the frontend pins that exact launcher ────────────────────────────────────────────────────────
const constantsSrc = src("../src/utils/constants.ts");
check("constants pins hoodieSharedLauncher == the live registered launcher", constantsSrc.includes(`hoodieSharedLauncher: "${LAUNCHER}"`));

// ── drift: hoodieLaunch.ts is a SINGLE-tx shared-launcher util (no per-user launcher anywhere) ───────────
const launchSrc = src("../src/utils/hoodieLaunch.ts");
check("launch util uses the shared launcher + predictNextFor", launchSrc.includes("hoodieSharedLauncher") && launchSrc.includes("predictNextFor"));
check("launch util launches via hoodieLauncherAbi.launch", launchSrc.includes("hoodieLauncherAbi") && launchSrc.includes('functionName: "launch"'));
check("launch util has NO createLauncher path", !launchSrc.includes("createLauncher"));
check("launch util has NO per-user salt / launcherFor / metaFactory", !launchSrc.includes("HOODIE_LAUNCHER_SALT") && !launchSrc.includes("launcherFor") && !launchSrc.includes("hoodieMetaFactoryAbi"));
check("HoodieLaunchStep has no createLauncher step", !/HoodieLaunchStep\s*=\s*[^;]*createLauncher/.test(launchSrc));

// ── drift: the form has zero per-user / two-step traces + routes HOODIE through its own path (kami 23760/23764) ──
const formSrc = src("../src/components/LaunchTokenForm.tsx");
for (const bad of ["createLauncher", "your own launcher", "your own HoodieLauncher", "deploy your", "2 txs", "two-step", "in-app soon", "live on deploy"]) {
  check(`form has NO "${bad}"`, !formSrc.includes(bad));
}
check("form HOODIE path calls simulate/executeHoodieLaunch (never the WETH factory path)", formSrc.includes("simulateHoodieLaunch") && formSrc.includes("executeHoodieLaunch"));
check("form shows the LIVE · HOODIE PAIR badge", formSrc.includes("LIVE · HOODIE PAIR"));
check("form launch button is single-flow (Launch HOODIE-paired)", formSrc.includes("Launch HOODIE-paired"));

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exitCode = fail ? 1 : 0; // natural exit — process.exit() trips a libuv teardown assert on Windows
