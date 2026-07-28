// Read-only Stable mainnet launchpad smoke. It proves the frontend client can reach the deployed stack
// and validate every runtime/binding/config guard without making a mutable wallet balance a release gate.
import { createPublicClient, defineChain, formatUnits, http } from "viem";
import {
  previewStableV3Launch,
  stableUsdt0Abi,
  STABLE_V3_CHAIN_ID,
} from "../src/utils/stableV3Launch.ts";
import { v3ChainRow } from "../src/utils/chainRegistry.ts";

const chain = defineChain({
  id: STABLE_V3_CHAIN_ID,
  name: "Stable",
  nativeCurrency: { name: "USDT0", symbol: "USDT0", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.stable.xyz"] } },
});
const client = createPublicClient({ chain, transport: http() });

// This account has no special role. Preview performs all deployment checks before its honest balance guard.
const creator = "0x800557e7882b42ee49594fa2790300A9697a0e4D";
const input = {
  name: "Hydeout UI Smoke",
  symbol: "HYSMOKE",
  creator,
  salt: `0x${"42".repeat(32)}` as `0x${string}`,
};

try {
  const preview = await previewStableV3Launch(client, STABLE_V3_CHAIN_ID, input);
  if (preview.feeAmount !== 1_000_000n) throw new Error(`fee mismatch: ${preview.feeAmount}`);
  if (preview.balance < preview.feeAmount) throw new Error(`preview accepted an underfunded wallet: ${preview.balance}`);
  if (preview.needsApproval && preview.tokenAddress !== null) throw new Error("unapproved preview must not fabricate a token address");
  if (!preview.needsApproval && preview.tokenAddress === null) throw new Error("fully simulated preview must return the token address");
  console.log("PASS — Stable V3 runtime, bindings, balance, allowance, and launch simulation");
  console.log(`  fee: ${preview.feeAmount} raw USDT0`);
  console.log(`  approval required: ${preview.needsApproval}`);
  console.log(`  simulated token: ${preview.tokenAddress ?? "assigned after approval"}`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (!/You need 1 USDT0 to launch; wallet balance is/i.test(message)) throw error;
  const row = v3ChainRow(STABLE_V3_CHAIN_ID)!;
  const balance = await client.readContract({
    address: row.numeraire.address as `0x${string}`,
    abi: stableUsdt0Abi,
    functionName: "balanceOf",
    args: [creator],
  });
  if (balance >= 1_000_000n) throw new Error(`unexpected balance guard with ${balance} raw USDT0`);
  console.log("PASS — Stable V3 runtime and deployment bindings; mutable smoke wallet is honestly underfunded");
  console.log(`  wallet balance: ${formatUnits(balance, row.numeraire.decimals)} USDT0`);
  console.log("  funded launch execution remains covered by scripts/chainevidence-v3.mjs");
}
