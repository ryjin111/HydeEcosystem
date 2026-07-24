// Runs both V3 multichain UI plumbing harnesses. No test runner in-repo; esbuild (JS API, cross-platform)
// bundles the transitive imports, then Node runs each. Usage: `node scripts/verify-v3ui-all.mjs`
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";

const runNode = (file) => spawnSync(process.execPath, [file], { stdio: "inherit" }).status ?? 1;
const bundle = (entry, out) =>
  build({ entryPoints: [entry], bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "warning" });

const tmpFmt = "scripts/.tmp-fmt.mjs";
const tmpReg = "scripts/.tmp-registry.mjs";
let failed = 0;

await bundle("scripts/verify-v3ui.mts", tmpFmt);
await bundle("scripts/verify-v3registry.mts", tmpReg);

console.log("── formatting fixtures ──");
failed += runNode(tmpFmt) ? 1 : 0;
console.log("\n── registry / engine fixtures ──");
failed += runNode(tmpReg) ? 1 : 0;

for (const f of [tmpFmt, tmpReg]) {
  try {
    rmSync(f);
  } catch {
    /* ignore */
  }
}
console.log(`\n${failed === 0 ? "ALL PASS" : `${failed} SUITE(S) FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
