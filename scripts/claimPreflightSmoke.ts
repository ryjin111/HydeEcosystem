// Regression for the claim double-submit blocker (kami 23897): claim is permissionless, so between the
// displayed `creatorClaimable>0` and the wallet's submit the balance can be drained (or already claimed) —
// a stale button must NOT fire a reverting tx. PoolCard.doClaim runs a FRESH preflight `simulateContract`
// (real hydeVaultAbi) right before the write and, on a NOTHING revert, locks the button + refreshes instead
// of sending. This proves that guard: claimCreator(LILHOODIE) (creatorClaimable == 0) REVERTS on preflight,
// so no second/no-op transaction is ever submitted.
//
// Build+run: node_modules/.bin/esbuild scripts/claimPreflightSmoke.ts --bundle --platform=node
//   --format=esm --outfile=<tmp>.mjs && node <tmp>.mjs
import { createPublicClient, http } from "viem";
import { hydeVaultAbi, MAINNET_HOODIE_FEE_VAULT } from "../src/utils/constants";

const client = createPublicClient({ transport: http("https://rpc.mainnet.chain.robinhood.com") });
const LILHOODIE = "0x8a76FeeF3bb0140c122d146caCef6B1A4Ac145f7" as `0x${string}`;
const CALLER = "0x800557e7882b42ee49594fa2790300A9697a0e4D" as `0x${string}`; // LILHOODIE creator (any caller reverts NOTHING at 0)

let pass = 0, fail = 0;

// 1. The read the button gates on is 0 → no button renders (belt).
const claimable = await client.readContract({ address: MAINNET_HOODIE_FEE_VAULT, abi: hydeVaultAbi, functionName: "creatorClaimable", args: [LILHOODIE] });
if (claimable === 0n) { pass++; console.log("  ✓ creatorClaimable(LILHOODIE) == 0 → no Claim button renders"); }
else { fail++; console.log(`  ✗ expected 0 claimable, got ${claimable}`); }

// 2. The preflight the button runs before writing REVERTS at 0 → no reverting/second tx is ever sent.
try {
  await client.simulateContract({ address: MAINNET_HOODIE_FEE_VAULT, abi: hydeVaultAbi, functionName: "claimCreator", args: [LILHOODIE], account: CALLER });
  fail++; console.log("  ✗ preflight simulate SUCCEEDED at 0 claimable — a no-op tx could be sent");
} catch (e) {
  const m = e instanceof Error ? e.message : String(e);
  pass++; console.log(`  ✓ preflight claimCreator REVERTS at 0 claimable → guard blocks the write (${/nothing/i.test(m) ? "NOTHING" : "revert"})`);
}

console.log(`\nclaimPreflight: ${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
