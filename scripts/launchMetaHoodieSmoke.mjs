// Focused coverage (kami audit 23697 #2): the /api/launch-meta creator verifier must resolve HOODIE
// launcher-launcher tokens via HoodieLaunchCreated@engine, in addition to the WETH factory's LaunchCreated,
// WITHOUT weakening the signer==creator check. Mock client → no real RPC. Imports the REAL server modules.
import { getAddress } from "viem";
import { OWNSTACK } from "../api/_ownstack.js";
import { onchainCreator } from "../api/launch-meta.js";

let pass = 0, fail = 0;
const check = (label, ok) => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${label}`); };

const cfg = OWNSTACK[4663];
check("4663 config present", !!cfg);
check("4663 hoodieEngine pinned", cfg.hoodieEngine === "0x8062951c99CfFA5365f979D5139Cf96b5c77CFCc");
check("4663 hoodieDeploymentBlock == 15652257", cfg.hoodieDeploymentBlock === 15652257n);

const WETH_CREATOR = getAddress("0x1111111111111111111111111111111111111111");
const HOODIE_CREATOR = getAddress("0x2222222222222222222222222222222222222222");
const TOKEN = "0x3333333333333333333333333333333333333333";

// Mock client keyed off the cfg UNDER TEST: WETH logs when queried at that cfg's factory, else HOODIE logs.
const mock = (c, wethLogs, hoodieLogs) => ({
  getLogs: async ({ address }) => (address.toLowerCase() === c.factory.toLowerCase() ? wethLogs : hoodieLogs),
});

// (a) WETH launch → WETH creator (HOODIE source not consulted).
check("WETH source → WETH creator",
  (await onchainCreator(cfg, TOKEN, mock(cfg, [{ args: { creator: WETH_CREATOR } }], []))) === WETH_CREATOR);
// (b) HOODIE launch (no WETH log) → HOODIE creator from the engine.
check("HOODIE source → HOODIE creator",
  (await onchainCreator(cfg, TOKEN, mock(cfg, [], [{ args: { creator: HOODIE_CREATOR } }]))) === HOODIE_CREATOR);
// (c) neither source → null (rejects → 404, signer check never bypassed).
check("no source → null", (await onchainCreator(cfg, TOKEN, mock(cfg, [], []))) === null);

// (d) 46630 has no HOODIE engine → the HOODIE branch is skipped (WETH-only), returns null here.
const cfg46630 = OWNSTACK[46630];
check("46630 has no hoodieEngine", !cfg46630.hoodieEngine);
check("46630 → HOODIE branch skipped → null",
  (await onchainCreator(cfg46630, TOKEN, mock(cfg46630, [], [{ args: { creator: HOODIE_CREATOR } }]))) === null);

console.log(`\n${fail === 0 ? "ALL GREEN" : "FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
