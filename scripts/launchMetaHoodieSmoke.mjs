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

// (e) Stable V3 resolves the creator from canonical pad + locker state without a historical log scan.
const cfg988 = OWNSTACK[988];
const STABLE_CREATOR = getAddress("0x4444444444444444444444444444444444444444");
const stablePosition = (creator = STABLE_CREATOR, registered = true) => [
  creator,
  "0x5555555555555555555555555555555555555555",
  "0x6666666666666666666666666666666666666666",
  "0x7777777777777777777777777777777777777777",
  1n,
  10_000,
  0n,
  false,
  registered,
];
const stableMock = (isHydeToken = true, registered = true) => ({
  getLogs: async () => { throw new Error("Stable creator verification must not scan logs"); },
  readContract: async ({ address, functionName }) => {
    if (address.toLowerCase() === cfg988.v3Pad.toLowerCase() && functionName === "isHydeToken") {
      return isHydeToken;
    }
    if (address.toLowerCase() === cfg988.v3Locker.toLowerCase() && functionName === "positionOf") {
      return stablePosition(STABLE_CREATOR, registered);
    }
    throw new Error("unexpected Stable read");
  },
});
check("988 config pins the Stable V3 pad", cfg988.v3Pad === "0xE79F17Fe61F9c76824D74C496f122f0AB483ec6A");
check("988 config pins the Stable V3 locker", cfg988.v3Locker === "0xE43314319675eF26724a7d4381D95ac31c246d90");
check("988 V3 source → Stable creator",
  (await onchainCreator(cfg988, TOKEN, stableMock())) === STABLE_CREATOR);
check("988 rejects token absent from canonical pad",
  (await onchainCreator(cfg988, TOKEN, stableMock(false, true))) === null);
check("988 rejects unregistered locker position",
  (await onchainCreator(cfg988, TOKEN, stableMock(true, false))) === null);

console.log(`\n${fail === 0 ? "ALL GREEN" : "FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
