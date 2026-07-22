// Deterministic unit test for the honesty-critical Your Position reducer (src/utils/positionPnl.ts).
// Node 24 strips the .ts types on import — no build step. Red here = the covered-only / provenance
// semantics kami froze (23482/23489/23497) are broken. Proves the ACCOUNTING; real 4663 receipt/RPC
// fixtures (gojo's pinned Doppler pool) prove the hook's log→move plumbing separately.
import { computePosition, buildMoves } from "../src/utils/positionPnl.ts";

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
};
const eq = (label, got, want) => check(label, got === want, `got ${got} want ${want}`);

const D = 18, WS = 10n ** 18n;
// numeraire-generic: `quote` is the pool's non-launched currency (WETH own-stack, TSLA on clint's 4663 token).
const base = {
  tokenDecimals: D, quoteDecimals: 18, quoteSymbol: "WETH",
  scannedFromBlock: 0n, scannedThroughBlock: 100n, reachedThroughBlock: true,
};
const mk = 6n * 10n ** 16n; // mark: 0.06 quote / token
// move factory: (block, tokenΔ, quoteΔ, selectedSwaps=1, hasOtherSwap=false)
const buy = (b, tok, q, swaps = 1, other = false) => ({
  blockNumber: b, orderKey: 0n, tokenDelta: tok, quoteDelta: q, poolSwapCount: swaps, hasOtherSwap: other,
});

/* 1) Clean buy, held, scan complete → complete basis, realized 0 (a number). */
{
  const r = computePosition({ ...base, balance: 100n * WS, markPrice: mk, markStatus: "live", asOfBlock: 100n,
    reachedInception: true, moves: [buy(10n, 100n * WS, -5n * WS)] });
  eq("1 basisStatus complete", r.basisStatus, "complete");
  eq("1 coveredCostBasis 5", r.coveredCostBasis, 5n * WS);
  eq("1 currentValue 6", r.currentValue, 6n * WS);
  eq("1 unrealized +1", r.unrealizedPnl, 1n * WS);
  eq("1 realized 0 (number)", r.realizedPnl, 0n);
  eq("1 historyComplete", r.historyComplete, true);
}

/* 2) Buy 100@5 then sell 40 for 3 → realized +1, remaining 60 covered. */
{
  const r = computePosition({ ...base, balance: 60n * WS, markPrice: mk, markStatus: "live", asOfBlock: 100n,
    reachedInception: true, moves: [buy(10n, 100n * WS, -5n * WS), buy(20n, -40n * WS, 3n * WS)] });
  eq("2 realized +1", r.realizedPnl, 1n * WS);
  eq("2 coveredCostBasis 3", r.coveredCostBasis, 3n * WS);
  eq("2 unrealized +0.6", r.unrealizedPnl, 6n * 10n ** 17n);
}

/* 3) Gift-in 50 (no quote leg) + clean buy 100@5 → partial, covered-only PnL, realized null. */
{
  const r = computePosition({ ...base, balance: 150n * WS, markPrice: mk, markStatus: "live", asOfBlock: 100n,
    reachedInception: true, moves: [buy(10n, 50n * WS, 0n, 0), buy(20n, 100n * WS, -5n * WS)] });
  eq("3 basisStatus partial", r.basisStatus, "partial");
  eq("3 uncoveredUnits 50", r.uncoveredUnits, 50n * WS);
  eq("3 unrealized covered-only +1", r.unrealizedPnl, 1n * WS); // 6 (covered value) − 5, NOT 9−5
  eq("3 realized null (ambiguity)", r.realizedPnl, null);
}

/* 4) Multihop: 2 selected-pool swaps in the tx → uncovered, unknown, all null. */
{
  const r = computePosition({ ...base, balance: 100n * WS, markPrice: mk, markStatus: "live", asOfBlock: 100n,
    reachedInception: true, moves: [buy(10n, 100n * WS, -5n * WS, 2)] });
  eq("4 basisStatus unknown", r.basisStatus, "unknown");
  eq("4 coveredCostBasis null", r.coveredCostBasis, null);
  eq("4 realized null", r.realizedPnl, null);
}

/* 5) All-clean, but scan didn't reach inception → can't be complete, realized null. */
{
  const r = computePosition({ ...base, balance: 100n * WS, markPrice: mk, markStatus: "live", asOfBlock: 100n,
    reachedInception: false, moves: [buy(10n, 100n * WS, -5n * WS)] });
  eq("5 basisStatus partial (not complete)", r.basisStatus, "partial");
  eq("5 historyComplete false", r.historyComplete, false);
  eq("5 realized null", r.realizedPnl, null);
}

/* 6) Mark unavailable → value/unrealized null, basis still computes. */
{
  const r = computePosition({ ...base, balance: 100n * WS, markPrice: null, markStatus: "unavailable", asOfBlock: null,
    reachedInception: true, moves: [buy(10n, 100n * WS, -5n * WS)] });
  eq("6 currentValue null", r.currentValue, null);
  eq("6 unrealized null", r.unrealizedPnl, null);
  eq("6 coveredCostBasis 5 (still computed)", r.coveredCostBasis, 5n * WS);
}

/* 7) NEW (kami #3): ONE selected swap BUT an other-pool hop in the same tx → uncovered. */
{
  const r = computePosition({ ...base, balance: 100n * WS, markPrice: mk, markStatus: "live", asOfBlock: 100n,
    reachedInception: true, moves: [buy(10n, 100n * WS, -5n * WS, 1, /*hasOtherSwap*/ true)] });
  eq("7 other-pool hop → unknown", r.basisStatus, "unknown");
  eq("7 uncoveredUnits 100", r.uncoveredUnits, 100n * WS);
  eq("7 realized null", r.realizedPnl, null);
}

/* 8) NEW (kami #4 tail): all-clean but scan didn't reach the snapshot block → not complete, realized null. */
{
  const r = computePosition({ ...base, reachedThroughBlock: false, balance: 100n * WS, markPrice: mk,
    markStatus: "live", asOfBlock: 100n, reachedInception: true, moves: [buy(10n, 100n * WS, -5n * WS)] });
  eq("8 tail gap → not complete", r.basisStatus, "partial");
  eq("8 historyComplete false", r.historyComplete, false);
  eq("8 realized null (tail)", r.realizedPnl, null);
}

/* ── buildMoves: log → per-tx grouping + selected/other swap split ─────────────── */
const W = "0xWaLLeT", POOL = "0xP001", SEL = "0xSelectedPool", OTHER = "0xOtherPool";
const xf = (txHash, block, logIndex, from, to, value) => ({ txHash, blockNumber: block, logIndex, from, to, value });

/* g1) Clean buy tx: token in + quote out + 1 selected swap → signed deltas, poolSwapCount 1, no other. */
{
  const m = buildMoves(
    [xf("0xA", 10n, 2n, POOL, W, 100n * WS)],
    [xf("0xA", 10n, 3n, W, POOL, 5n * WS)],
    [{ txHash: "0xA", poolId: SEL }],
    W, SEL,
  );
  eq("g1 one move", BigInt(m.length), 1n);
  eq("g1 tokenDelta +100", m[0].tokenDelta, 100n * WS);
  eq("g1 quoteDelta -5", m[0].quoteDelta, -5n * WS);
  eq("g1 orderKey min(2,3)", m[0].orderKey, 2n);
  eq("g1 poolSwapCount 1", BigInt(m[0].poolSwapCount), 1n);
  eq("g1 hasOtherSwap false", m[0].hasOtherSwap, false);
}

/* g2) Self-transfer (from==to==wallet, in BOTH filter lists) → nets 0, no double count. */
{
  const self = xf("0xB", 11n, 0n, W, W, 50n * WS);
  const m = buildMoves([self, self], [], [], W, SEL);
  eq("g2 self-transfer nets 0", m[0].tokenDelta, 0n);
}

/* g3) Multiple token legs summed; case-insensitive wallet match. */
{
  const m = buildMoves(
    [xf("0xC", 12n, 5n, POOL, "0xwallet", 30n * WS), xf("0xC", 12n, 1n, POOL, "0xWALLET", 70n * WS)],
    [], [], "0xWaLLeT", SEL,
  );
  eq("g3 summed tokenDelta 100", m[0].tokenDelta, 100n * WS);
  eq("g3 orderKey min(5,1)", m[0].orderKey, 1n);
}

/* g4) NEW: 1 selected swap + 1 OTHER-pool swap in the tx → poolSwapCount 1, hasOtherSwap TRUE. */
{
  const m = buildMoves(
    [xf("0xD", 13n, 0n, POOL, W, 10n * WS)],
    [xf("0xD", 13n, 1n, W, POOL, 1n * WS)],
    [{ txHash: "0xD", poolId: SEL }, { txHash: "0xD", poolId: OTHER }],
    W, SEL,
  );
  eq("g4 poolSwapCount 1 (selected)", BigInt(m[0].poolSwapCount), 1n);
  eq("g4 hasOtherSwap true", m[0].hasOtherSwap, true);
}

/* g5) Two selected-pool swaps in one tx → poolSwapCount 2. */
{
  const m = buildMoves(
    [xf("0xE", 14n, 0n, POOL, W, 10n * WS)],
    [], [{ txHash: "0xE", poolId: SEL }, { txHash: "0xE", poolId: SEL }], W, SEL,
  );
  eq("g5 poolSwapCount 2", BigInt(m[0].poolSwapCount), 2n);
}

console.log(`\n${fail === 0 ? "ALL GREEN" : "FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
