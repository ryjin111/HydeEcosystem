// Deterministic proof for the current one-transaction harvest gate. The implementation reads raw balances,
// projects collect with eth_simulateV1, then eth_call-preflights the exact Multicall3 wallet payload.
import { simulateHarvestFlow } from "../src/utils/hoodieFees";

const TOKEN = "0x8a76FeeF3bb0140c122d146caCef6B1A4Ac145f7" as `0x${string}`;
const WALLET = "0x800557e7882b42ee49594fa2790300A9697a0e4D" as `0x${string}`;
const word = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}`;
const green = (value = 0n) => ({ status: "0x1", returnData: word(value) });

function client(projectedRawLT: bigint, callFailure?: string, malformedRead = false) {
  return {
    readContract: async () => 0n,
    request: async () => malformedRead
      ? []
      : [{ calls: [green(), green(), green(projectedRawLT), green()] }],
    call: async () => {
      if (callFailure) throw new Error(callFailure);
      return { data: "0x" };
    },
  } as never;
}

let pass = 0;
let fail = 0;
async function expect(label: string, scriptedClient: never, wantOk: boolean, reason?: RegExp) {
  const result = await simulateHarvestFlow({
    client: scriptedClient,
    token: TOKEN,
    wallet: WALLET,
    chainId: 4663,
  }).catch((error) => ({ ok: false, reason: error instanceof Error ? error.message : String(error) }));
  const reasonOk = !reason || reason.test(result.reason || "");
  if (result.ok === wantOk && reasonOk) {
    pass += 1;
    console.log(`  ✓ ${label} → ok:${result.ok}${result.reason ? ` (${result.reason})` : ""}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${label} → ok:${result.ok}, reason:${result.reason || "none"}`);
  }
}

await expect("no projected fees fails closed", client(0n), false, /nothing to harvest/i);
await expect("exact projected flow passes eth_call", client(100n), true);
await expect("wallet payload revert fails closed", client(100n, "execution reverted"), false, /harvest simulation failed/i);
await expect("malformed fee projection fails closed", client(0n, undefined, true), false);

console.log(`\nharvestFlowGuard: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
