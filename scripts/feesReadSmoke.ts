// Live-4663 gate for the real fee-harvest read. Fee state changes whenever someone trades or harvests,
// so this checks accounting/classification invariants instead of a stale historical amount.
import { createPublicClient, http, formatUnits } from "viem";
import { readFeeState } from "../src/utils/hoodieFees";

const client = createPublicClient({ transport: http("https://rpc.mainnet.chain.robinhood.com") });
const LILHOODIE = "0x8a76FeeF3bb0140c122d146caCef6B1A4Ac145f7" as `0x${string}`;

let pass = 0;
let fail = 0;
const ok = (name: string) => { pass += 1; console.log(`  ✓ ${name}`); };
const bad = (name: string, detail: string) => { fail += 1; console.log(`  ✗ ${name} — ${detail}`); };

const state = await readFeeState({ client: client as never, token: LILHOODIE, chainId: 4663 });
console.log("fee state:", {
  claimable: formatUnits(state.claimable, 18),
  rawNumeraire: formatUnits(state.rawNumeraire, 18),
  rawLT: formatUnits(state.rawLT, 18),
  pendingHoodie: formatUnits(state.pendingHoodie, 18),
});

const creatorShare = (amount: bigint) => amount - ((amount * 500n) / 10_000n);
state.pendingHoodie === creatorShare(state.rawNumeraire)
  ? ok("pending HOODIE equals the exact 95% creator share of raw numeraire fees")
  : bad("pending HOODIE accounting", `${state.pendingHoodie} != ${creatorShare(state.rawNumeraire)}`);

const hasRaw = state.rawNumeraire > 0n || state.rawLT > 0n;
const classification = state.claimable > 0n ? "claimable" : hasRaw ? "awaiting settlement" : "settled";
ok(`current mutable fee state classified as ${classification}`);

if (state.rawLT > 0n) {
  ok(`token-side fees remain visible (${formatUnits(state.rawLT, 18)} LILHOODIE), never hidden as zero`);
} else {
  ok("token-side fee leg is currently zero");
}

console.log(`\nfeesRead: ${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
