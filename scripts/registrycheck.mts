// Registry execution proof (kami 23091 + 23093): re-encodes every evidence
// market's poolId through the APP'S OWN v4Encoding sort+encode path, prints
// the fail-closed capability derivation for all 7 chains, and EXECUTES the
// native-intent guard both ways (positive: address(0) builds; negative: an
// intended-native side encoded as WETH must REFUSE). Nonzero exit on ANY
// failure — CI-meaningful, not print-only.
// Run:  npx esbuild scripts/registrycheck.mts --bundle --format=esm --platform=node --outfile=scripts/registrycheck.bundle.mjs --external:viem && node scripts/registrycheck.bundle.mjs

import { chainCapabilities } from "../src/utils/chainRegistry.ts";
import { CHAIN_EVIDENCE } from "../src/utils/chainEvidence.ts";
import { buildSwapTemplatePayload, evidencePoolIdMatches, reencodeEvidencePoolId, NATIVE_CURRENCY } from "../src/utils/v4Encoding.ts";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
};

// ── 1. every evidence poolId reproduced by the app encoder ──
let bad = 0, total = 0;
for (const [cid, ev] of Object.entries(CHAIN_EVIDENCE)) {
  for (const m of ev.markets) {
    total++;
    if (!evidencePoolIdMatches(m)) {
      bad++;
      console.log(`MISMATCH chain ${cid} ${m.symbol}: evidence ${m.poolId} vs reencoded ${reencodeEvidencePoolId(m)}`);
    }
  }
}
check(`poolId reencode: ${total - bad}/${total} evidence markets reproduced by the app encoder`, bad === 0 && total > 0);

// ── 2. native-intent guard, executed both ways (OP USDC market, fee 500) ──
const OP_USDC = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85";
const OP_WETH = "0x4200000000000000000000000000000000000006";
const swapBase = {
  fee: 500,
  recipient: "0x50c439df72e889fb7933dba26e87a92db1f65345" as `0x${string}`,
  amountIn: "0.001",
  amountOutQuoted: "1.86",
  slippagePercent: "0.5",
  decimalsIn: 18,
  decimalsOut: 6,
  chainId: 10,
};

// positive: native intent + address(0) → must BUILD (and the internal
// evidence assert also proves the encoded pool == the proven OP USDC pool)
try {
  const built = buildSwapTemplatePayload({
    ...swapBase,
    tokenIn: NATIVE_CURRENCY,
    tokenOut: OP_USDC as `0x${string}`,
    nativeIn: true,
    nativeOut: false,
  });
  check("positive: native(0x0)→USDC on OP builds (evidence-asserted pool)", built.commands.length > 2);
} catch (e) {
  check("positive: native(0x0)→USDC on OP builds (evidence-asserted pool)", false, (e as Error).message);
}

// negative (kami 23093's exact regression class): intended-native side arrives
// REWRITTEN to WETH → must REFUSE, loudly
try {
  buildSwapTemplatePayload({
    ...swapBase,
    tokenIn: OP_WETH as `0x${string}`, // the rewrite: native intent, WETH address
    tokenOut: OP_USDC as `0x${string}`,
    nativeIn: true,
    nativeOut: false,
  });
  check("negative: intended-native rewritten to WETH is REFUSED", false, "payload built — guard did not fire");
} catch (e) {
  check("negative: intended-native rewritten to WETH is REFUSED", (e as Error).message.includes("native-intent drift"), (e as Error).message.slice(0, 90));
}

// documented non-case: WETH→USDC with NO native intent = a legitimately
// distinct (unproven) pool — allowed to build, carries no evidence claim
try {
  buildSwapTemplatePayload({
    ...swapBase,
    tokenIn: OP_WETH as `0x${string}`,
    tokenOut: OP_USDC as `0x${string}`,
    nativeIn: false,
    nativeOut: false,
  });
  check("non-case: explicit WETH↔USDC (no native intent) still builds — distinct pool, no evidence claim", true);
} catch (e) {
  check("non-case: explicit WETH↔USDC (no native intent) still builds — distinct pool, no evidence claim", false, (e as Error).message);
}

// ── 3. fail-closed capability derivation ──
for (const c of chainCapabilities()) {
  console.log(`${c.shortName.padEnd(4)} ${c.name.padEnd(16)} status=${c.status} role=${c.role} markets=${c.browse.markets.length} trade=${c.trade ? "ready" : "null"} smoke=r:${c.smoke.read}/t:${c.smoke.trade} logo=${c.logo}`);
  if (c.status === "live" && !(c.smoke.read && c.smoke.trade)) {
    check(`${c.shortName}: 'live' without smoke evidence — derivation broken`, false);
  }
}

console.log(`\nregistrycheck: ${failures === 0 ? "ALL GREEN" : failures + " FAILURE(S)"}`);
process.exitCode = failures === 0 ? 0 : 1;
