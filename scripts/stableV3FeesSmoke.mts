// Live read-only Stable mainnet fee smoke. Simulates the exact permissionless collect through the same
// code used by the UI and verifies the immutable 95/5 accounting without broadcasting.
import { createPublicClient, defineChain, http } from "viem";
import { quoteStableV3CreatorFees } from "../src/utils/stableV3Fees.ts";

const chain = defineChain({
  id: 988,
  name: "Stable",
  nativeCurrency: { name: "USDT0", symbol: "USDT0", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.stable.xyz"] } },
});
const client = createPublicClient({ chain, transport: http() });
const token = "0x8aa67e0D40e9dE58ad10919A8d88FFAf2747EC69";
const caller = "0x800557e7882b42ee49594fa2790300A9697a0e4D";
const quote = await quoteStableV3CreatorFees({
  publicClient: client,
  chainId: 988,
  token,
  caller,
});

const creatorShare = (amount: bigint) => amount - ((amount * 500n) / 10_000n);
if (quote.creatorToken !== creatorShare(quote.grossToken)) throw new Error("token-side 95/5 split mismatch");
if (quote.creatorNumeraire !== creatorShare(quote.grossNumeraire)) throw new Error("numeraire-side 95/5 split mismatch");
if (quote.creator.toLowerCase() !== caller.toLowerCase()) throw new Error(`unexpected creator ${quote.creator}`);

console.log("PASS — Stable V3 creator fee collect simulation");
console.log(`  creator: ${quote.creator}`);
console.log(`  gross token: ${quote.grossToken}`);
console.log(`  gross numeraire: ${quote.grossNumeraire}`);
