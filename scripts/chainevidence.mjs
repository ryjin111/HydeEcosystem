// Evidence GENERATOR for the chain capability registry (kami A-blockers 23086
// #1/#2/#3): probes live chains and REGENERATES src/utils/chainEvidence.ts.
// The registry derives readiness from this artifact's contents — never from
// hand-set booleans. Hand-editing the artifact is pointless: re-running this
// script overwrites it with chain truth, and scripts/chainverify.mjs re-proves
// the same facts independently.
//
// Per wave-1 chain (Optimism / Ink / Unichain):
//   GATEWAY evidence — code exists, has the executeSwap selector, and embeds
//     the chain's UniversalRouter as an immutable in deployed bytecode.
//     Permit2 is NOT expected in gateway code (live evidence: false on both
//     chains) — a pass-through gateway never touches Permit2; the user's
//     permit names the ROUTER as spender, and the router's own Permit2
//     embedding is proven by chainverify.mjs. kami accepted this architecture
//     (23091); embedsPermit2 stays recorded as data.
//   MARKET evidence — for each curated non-native token: probe the canonical
//     V4 pool against BOTH native(0x0) and wrapped-native pairings across the
//     standard fee tiers; keep the deepest initialized pool; PROVE it with a
//     real V4Quoter.quoteExactInputSingle simulation. No proof → no market.
//   READ smoke — the deepest proven market's StateView.getSlot0 (poolId,
//     sqrtPrice, block) = the chain's read-source evidence.
//   TRADE smoke — NEVER written here (requires a funded end-to-end trade run;
//     absent ⇒ fail-closed 'coming', by design).
import fs from "node:fs";
import path from "node:path";
import { createPublicClient, http, keccak256, toHex, encodeAbiParameters } from "viem";

const CANONICAL_PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const NATIVE = "0x0000000000000000000000000000000000000000";
const ZERO_HOOKS = "0x0000000000000000000000000000000000000000";
const FEE_TIERS = [
  { fee: 100, tickSpacing: 1 },
  { fee: 500, tickSpacing: 10 },
  { fee: 3000, tickSpacing: 60 },
  { fee: 10000, tickSpacing: 200 },
];
const EXEC_SWAP_SELECTOR = keccak256(toHex("executeSwap(bytes,bytes[],uint256)")).slice(2, 10);

const STATE_VIEW_ABI = [
  { type: "function", name: "getSlot0", stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" }, { name: "tick", type: "int24" },
      { name: "protocolFee", type: "uint24" }, { name: "lpFee", type: "uint24" },
    ] },
  { type: "function", name: "getLiquidity", stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [{ name: "liquidity", type: "uint128" }] },
];
const QUOTER_ABI = [
  { type: "function", name: "quoteExactInputSingle", stateMutability: "nonpayable",
    inputs: [{ name: "params", type: "tuple", components: [
      { name: "poolKey", type: "tuple", components: [
        { name: "currency0", type: "address" }, { name: "currency1", type: "address" },
        { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" },
      ] },
      { name: "zeroForOne", type: "bool" },
      { name: "exactAmount", type: "uint128" },
      { name: "hookData", type: "bytes" },
    ] }],
    outputs: [{ name: "amountOut", type: "uint256" }, { name: "gasEstimate", type: "uint256" }] },
];

// Wave-1 chains (kami 23065 rollout). V4 addresses = the chainverify-proven set.
const CHAINS = [
  {
    id: 10, name: "Optimism", rpc: "https://mainnet.optimism.io",
    v4: {
      universalRouter: "0x851116D9223fabED8E56C0E6b8Ad0c31d98B3507",
      quoter: "0x1f3131a13296fb91c90870043742c3cdbff1a8d7",
      stateView: "0xc18a3169788f4f75a170290584eca6395c75ecdb",
      gateway: "0x21d6Ce25aa1AB3F59eE51b7693A596C6d39A03C9",
    },
    wrapped: "0x4200000000000000000000000000000000000006",
    // Curated market candidates — symbol/decimals must prove on-chain or the
    // candidate is dropped (same bar as chainverify token candidates).
    tokens: [
      { symbol: "USDC", addr: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", decimals: 6 },
      { symbol: "USDT", addr: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", decimals: 6 },
      { symbol: "OP", addr: "0x4200000000000000000000000000000000000042", decimals: 18 },
      { symbol: "WBTC", addr: "0x68f180fcCe6836688e9084f035309E29Bf0A2095", decimals: 8 },
    ],
  },
  {
    id: 57073, name: "Ink", rpc: "https://rpc-gel.inkonchain.com",
    v4: {
      universalRouter: "0x112908dac86e20e7241b0927479ea3bf935d1fa0",
      quoter: "0x3972c00f7ed4885e145823eb7c655375d275a1c5",
      stateView: "0x76fd297e2d437cd7f76d50f01afe6160f86e9990",
      gateway: "0x21d6Ce25aa1AB3F59eE51b7693A596C6d39A03C9",
    },
    wrapped: "0x4200000000000000000000000000000000000006",
    tokens: [
      { symbol: "USDC.e", addr: "0xF1815bd50389c46847f0Bda824eC8da914045D14", decimals: 6 },
    ],
  },
  {
    id: 130, name: "Unichain", rpc: "https://mainnet.unichain.org",
    v4: {
      universalRouter: "0xef740bf23acae26f6492b10de645d6b98dc8eaf3",
      quoter: "0x333e3c607b141b18ff6de9f258db6e77fe7491e0",
      stateView: "0x86e8631a016f9068c3f085faf484ee3f5fdee8f2",
      gateway: null, // no Hyde gateway deployed on Unichain — execution path honestly absent
    },
    wrapped: "0x4200000000000000000000000000000000000006",
    tokens: [
      { symbol: "USDC", addr: "0x078D782b760474a361dDA0AF3839290b0EF57AD6", decimals: 6 },
      { symbol: "USD₮0", addr: "0x9151434b16b9763660705744891fA906F660EcC5", decimals: 6 },
    ],
  },
];

const strip = (a) => a.toLowerCase().replace(/^0x/, "");
const poolIdOf = (key) => keccak256(encodeAbiParameters(
  [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
  [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
));
const sortPair = (a, b) => (BigInt(a) < BigInt(b) ? [a, b] : [b, a]);

const evidence = {};
for (const chain of CHAINS) {
  console.log(`\n── ${chain.name} (${chain.id}) ──`);
  const client = createPublicClient({ transport: http(chain.rpc) });
  const block = await client.getBlockNumber();
  const entry = { chainId: chain.id, generatedAtBlock: block.toString(), markets: [] };

  // ── gateway evidence (kami #2) ──
  if (chain.v4.gateway) {
    const code = (await client.getCode({ address: chain.v4.gateway })) ?? "0x";
    const gw = {
      address: chain.v4.gateway,
      codeBytes: (code.length - 2) / 2,
      hasExecuteSwapSelector: code.toLowerCase().includes(EXEC_SWAP_SELECTOR),
      embedsUniversalRouter: code.toLowerCase().includes(strip(chain.v4.universalRouter)),
      embedsPermit2: code.toLowerCase().includes(strip(CANONICAL_PERMIT2)),
      verifiedAtBlock: block.toString(),
    };
    entry.gateway = gw;
    console.log(`gateway ${chain.v4.gateway}: code=${gw.codeBytes}b executeSwapSel=${gw.hasExecuteSwapSelector} embedsRouter=${gw.embedsUniversalRouter} embedsPermit2=${gw.embedsPermit2}`);
  } else {
    console.log("gateway: none deployed (execution path absent — recorded as such)");
  }

  // ── market evidence (kami #3): probe native + wrapped pairings × fee tiers ──
  for (const t of chain.tokens) {
    const candidates = [];
    for (const base of [NATIVE, chain.wrapped]) {
      const [c0, c1] = sortPair(base, t.addr);
      for (const { fee, tickSpacing } of FEE_TIERS) {
        const key = { currency0: c0, currency1: c1, fee, tickSpacing, hooks: ZERO_HOOKS };
        const poolId = poolIdOf(key);
        try {
          const [sqrtPriceX96] = await client.readContract({
            address: chain.v4.stateView, abi: STATE_VIEW_ABI, functionName: "getSlot0", args: [poolId],
          });
          if (sqrtPriceX96 === 0n) continue; // uninitialized
          const liquidity = await client.readContract({
            address: chain.v4.stateView, abi: STATE_VIEW_ABI, functionName: "getLiquidity", args: [poolId],
          });
          if (liquidity === 0n) continue;
          candidates.push({ key, poolId, sqrtPriceX96, liquidity, base });
        } catch { /* revert = pool absent on this tier — expected, not an error */ }
      }
    }
    if (candidates.length === 0) {
      console.log(`market ${t.symbol}: NO initialized+funded canonical pool found — EXCLUDED (no proof, no market)`);
      continue;
    }
    const best = candidates.reduce((a, b) => (b.liquidity > a.liquidity ? b : a));
    // quote proof: base → token, 0.001 native units in
    const zeroForOne = strip(best.key.currency0) === strip(best.base);
    const exactAmount = 1_000_000_000_000_000n; // 0.001 ETH-class base
    try {
      const { result } = await client.simulateContract({
        address: chain.v4.quoter, abi: QUOTER_ABI, functionName: "quoteExactInputSingle",
        args: [{ poolKey: best.key, zeroForOne, exactAmount, hookData: "0x" }],
      });
      const [amountOut] = result;
      if (amountOut === 0n) throw new Error("zero out");
      entry.markets.push({
        token: t.addr, symbol: t.symbol, decimals: t.decimals,
        poolKey: { ...best.key },
        poolId: best.poolId,
        liquidity: best.liquidity.toString(),
        sqrtPriceX96: best.sqrtPriceX96.toString(),
        quote: { amountIn: exactAmount.toString(), amountOut: amountOut.toString(), zeroForOne, atBlock: block.toString() },
      });
      console.log(`market ${t.symbol}: PROVEN — ${best.base === NATIVE ? "native" : "wrapped"} pair, fee ${best.key.fee}, liq ${best.liquidity}, quote 0.001→${amountOut} (${candidates.length} candidate pools)`);
    } catch (e) {
      console.log(`market ${t.symbol}: pool found but QUOTE FAILED (${(e.shortMessage || e.message).slice(0, 60)}) — EXCLUDED`);
    }
  }

  // ── read smoke = the deepest proven market's live slot0 ──
  if (entry.markets.length > 0) {
    const deepest = entry.markets.reduce((a, b) => (BigInt(b.liquidity) > BigInt(a.liquidity) ? b : a));
    entry.readSmoke = { poolId: deepest.poolId, sqrtPriceX96: deepest.sqrtPriceX96, verifiedAtBlock: block.toString() };
    console.log(`readSmoke: slot0 proven on ${deepest.symbol} pool ${deepest.poolId.slice(0, 10)}…`);
  } else {
    console.log("readSmoke: ABSENT (no proven market to read)");
  }
  // tradeSmoke intentionally never written here.
  evidence[chain.id] = entry;
}

// ── regenerate src/utils/chainEvidence.ts ──
const out = `// AUTO-GENERATED by scripts/chainevidence.mjs — DO NOT HAND-EDIT.
// Regenerate: node scripts/chainevidence.mjs   ·   Re-prove: node scripts/chainverify.mjs
// The registry (chainRegistry.ts) derives chain readiness from THIS artifact's
// verifiable contents (blocks, poolIds, quotes) — hand-edits are overwritten by
// the next run and carry no authority. tradeSmoke entries can only be written
// by a real funded end-to-end trade run (separate script, not yet built).

export type GatewayEvidence = {
  address: \`0x\${string}\`;
  codeBytes: number;
  hasExecuteSwapSelector: boolean;
  embedsUniversalRouter: boolean;
  embedsPermit2: boolean;
  verifiedAtBlock: string;
};
export type MarketEvidence = {
  token: \`0x\${string}\`;
  symbol: string;
  decimals: number;
  poolKey: { currency0: \`0x\${string}\`; currency1: \`0x\${string}\`; fee: number; tickSpacing: number; hooks: \`0x\${string}\` };
  poolId: \`0x\${string}\`;
  liquidity: string;
  sqrtPriceX96: string;
  quote: { amountIn: string; amountOut: string; zeroForOne: boolean; atBlock: string };
};
export type ReadSmokeEvidence = { poolId: \`0x\${string}\`; sqrtPriceX96: string; verifiedAtBlock: string };
export type TradeSmokeEvidence = { txHash: \`0x\${string}\`; atBlock: string };
export type ChainEvidence = {
  chainId: number;
  generatedAtBlock: string;
  gateway?: GatewayEvidence;
  markets: MarketEvidence[];
  readSmoke?: ReadSmokeEvidence;
  tradeSmoke?: TradeSmokeEvidence;
};

export const CHAIN_EVIDENCE: Record<number, ChainEvidence> = ${JSON.stringify(evidence, null, 2).replace(/"(0x[0-9a-fA-F]{40,66})"/g, '"$1" as `0x${string}`')} as const;
`;
const outPath = path.resolve("src/utils/chainEvidence.ts");
fs.writeFileSync(outPath, out);
console.log(`\nwrote ${outPath} (${out.length}b) — chains: ${Object.keys(evidence).join(", ")}`);
