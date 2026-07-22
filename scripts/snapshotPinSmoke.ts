// Deterministic regression for the position snapshot block-pin (kami 23949 #1): the exit-sim mark must run
// at the SAME block as the balance/log reads, not a later "latest". Drives the REAL `simulateHoodieSwap`
// with a scripted client and asserts the eth_simulateV1 block tag it sends == the pinned block (and that
// omitting blockTag falls back to "latest").
//
// Build+run: node_modules/.bin/esbuild scripts/snapshotPinSmoke.ts --bundle --platform=node
//   --format=esm --outfile=<tmp>.mjs && node <tmp>.mjs
import { toHex } from "viem";
import { simulateHoodieSwap } from "../src/utils/hoodieSwap";

const TOKEN = "0x8a76FeeF3bb0140c122d146caCef6B1A4Ac145f7" as `0x${string}`;
const USER = "0x800557e7882b42ee49594fa2790300A9697a0e4D" as `0x${string}`;
const green = { status: "0x1", returnData: "0x" + "00".repeat(32) };

// Client that records the eth_simulateV1 block-tag param and returns a well-formed 5-call block.
const spyClient = () => {
  const seen: unknown[] = [];
  return {
    client: { request: async (r: { params: unknown[] }) => { seen.push(r.params[1]); return [{ calls: [green, green, green, green, green] }]; } } as never,
    seen,
  };
};

let pass = 0, fail = 0;
const base = { token: TOKEN, user: USER, decimals: 18, isBuy: false, amountIn: "1", amountOutQuoted: "0", slippagePercent: "0", chainId: 4663 } as const;

{
  const { client, seen } = spyClient();
  await simulateHoodieSwap({ client, ...base, blockTag: 15718044n });
  seen[0] === toHex(15718044n) ? (pass++, console.log(`  ✓ blockTag pins eth_simulateV1 to ${seen[0]} (block 15718044)`)) : (fail++, console.log(`  ✗ pinned block: got ${seen[0]} want ${toHex(15718044n)}`));
}
{
  const { client, seen } = spyClient();
  await simulateHoodieSwap({ client, ...base });
  seen[0] === "latest" ? (pass++, console.log(`  ✓ no blockTag → "latest" (live quote path unchanged)`)) : (fail++, console.log(`  ✗ default: got ${seen[0]} want "latest"`));
}

console.log(`\nsnapshotPin: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
