// Live-4663 gate for the fee-harvest READ (src/utils/hoodieFees.ts readFeeState) — esbuild-bundled, the
// real app fn. Proves the "Fees awaiting settlement · ~X HOODIE" figure is the true collect-sim output
// (not fabricated): for LILHOODIE it must surface gojo's ~994 numeraire pending (23899), with rawLT ~0.
//
// Build+run: node_modules/.bin/esbuild scripts/feesReadSmoke.ts --bundle --platform=node --format=esm
//   --outfile=<tmp>.mjs && node <tmp>.mjs
import { createPublicClient, http, formatUnits } from "viem";
import { readFeeState } from "../src/utils/hoodieFees";

const client = createPublicClient({ transport: http("https://rpc.mainnet.chain.robinhood.com") });
const LILHOODIE = "0x8a76FeeF3bb0140c122d146caCef6B1A4Ac145f7" as `0x${string}`;

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n: string, d: string) => { fail++; console.log(`  ✗ ${n} — ${d}`); };

const s = await readFeeState({ client: client as never, token: LILHOODIE, chainId: 4663 });
console.log("fee state:", { claimable: formatUnits(s.claimable, 18), rawNumeraire: formatUnits(s.rawNumeraire, 18), rawLT: formatUnits(s.rawLT, 18), pendingHoodie: formatUnits(s.pendingHoodie, 18) });

const pending = Number(formatUnits(s.pendingHoodie, 18));
pending > 900 && pending < 1100 ? ok(`pending numeraire ≈ ${pending.toFixed(2)} HOODIE (matches gojo ~994)`) : bad("pending ≈ 994 HOODIE", String(pending));
Number(formatUnits(s.rawLT, 18)) < 1 ? ok("rawLT ~0 (today's harvest is all the ungated numeraire leg)") : bad("rawLT ~0", formatUnits(s.rawLT, 18));
s.claimable === 0n ? ok("nothing settled yet (creatorClaimable 0 → awaiting-settlement state, not 'Claim')") : bad("claimable == 0", String(s.claimable));

console.log(`\nfeesRead: ${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
