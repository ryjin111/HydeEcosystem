// Read-only Stable mainnet launchpad smoke. It proves the frontend client can reach the deployed stack,
// validate every runtime/binding/config guard, and prepare the approval-aware preview without broadcasting.
// Bundle before running because Node does not load the app's TypeScript modules directly.
import { createPublicClient, defineChain, http } from "viem";
import { previewStableV3Launch, STABLE_V3_CHAIN_ID } from "../src/utils/stableV3Launch.ts";

const chain = defineChain({
  id: STABLE_V3_CHAIN_ID,
  name: "Stable",
  nativeCurrency: { name: "USDT0", symbol: "USDT0", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.stable.xyz"] } },
});
const client = createPublicClient({ chain, transport: http() });

// The deployment wallet retains >1 ERC-20 USDT0 and has no special role in the pad. Preview is eth_call only.
const creator = "0x800557e7882b42ee49594fa2790300A9697a0e4D";
const preview = await previewStableV3Launch(client, STABLE_V3_CHAIN_ID, {
  name: "Hydeout UI Smoke",
  symbol: "HYSMOKE",
  creator,
  salt: `0x${"42".repeat(32)}`,
});

if (preview.feeAmount !== 1_000_000n) throw new Error(`fee mismatch: ${preview.feeAmount}`);
if (preview.balance < preview.feeAmount) throw new Error(`smoke wallet balance fell below launch fee: ${preview.balance}`);
if (preview.needsApproval && preview.tokenAddress !== null) throw new Error("unapproved preview must not fabricate a token address");
if (!preview.needsApproval && preview.tokenAddress === null) throw new Error("fully simulated preview must return the token address");

console.log("PASS — Stable V3 launch client read-only smoke");
console.log(`  fee: ${preview.feeAmount} raw USDT0`);
console.log(`  balance: ${preview.balance} raw USDT0`);
console.log(`  approval required: ${preview.needsApproval}`);
console.log(`  simulated token: ${preview.tokenAddress ?? "assigned after approval"}`);
