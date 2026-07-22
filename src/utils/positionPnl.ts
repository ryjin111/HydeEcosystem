/* ── "Your Position" PnL — pure, honest, covered-only reducer ─────────────────────
 * Frozen interface + semantics agreed with kami (23482/23489) for the token page's
 * Your Position card. This file holds ONLY pure logic (no RPC/React) so the honesty-
 * critical accounting is deterministically unit-testable (see scripts/positionPnlSmoke.mjs).
 * The `useTokenPosition` hook does the I/O (logs/balance/mark) and calls `computePosition`.
 *
 * HONESTY RULES (kami's frozen v4 semantics — every one enforced below):
 *  • Covered-only basis: a held unit has a basis ONLY if its acquiring tx is a single,
 *    cleanly-reconciled Swap on the SELECTED pool (wallet net token delta ↔ opposite-signed
 *    WETH delta). Gifts/airdrops (no WETH leg) and router/multihop-ambiguous txs (≠1 pool
 *    Swap, or non-reconciling deltas) are UNCOVERED — never priced, never fabricated.
 *  • unrealizedPnl compares COVERED value vs COVERED basis only — never whole-balance.
 *  • realizedPnl is a number ONLY when the scan is complete AND no ambiguity touched the
 *    token (`historyComplete`); otherwise null (an unpriced/ambiguous sell could exist).
 *  • basisStatus 'complete' ⟺ historyComplete && every held unit is covered.
 *  • Mark price carries provenance (markStatus/asOfBlock), never a silent page price.
 *  • `balance` (the ERC-20 read) is the source of truth for held units; covered units are
 *    reconciled DOWN to it (a wallet can't have covered-basis for more than it holds).
 *
 * Units: all bigints are base units. `markPrice` and `coveredAvgBasisPerToken` are quote-wei
 * per ONE WHOLE token (= per 10^tokenDecimals base units). Value math scales by tokenDecimals.
 */

// "exit" = the mark is the net-of-slippage sell-sim exit value (gojo/kami — not a spot mark; labelled
// "exit sim" so a large position never reads as a phantom spot value it can't actually exit at).
export type MarkStatus = "live" | "twap" | "estimated" | "exit" | "unavailable";
export type BasisStatus = "complete" | "partial" | "unknown";

/** The frozen `useTokenPosition(token)` return shape (kami-signed 23489). */
export type TokenPosition = {
  balance: bigint;
  tokenDecimals: number;
  quoteDecimals: number;
  quoteSymbol: string;

  markPrice: bigint | null; // quote-wei per WHOLE token
  markStatus: MarkStatus;
  asOfBlock: bigint | null;
  currentValue: bigint | null; // quote-wei value of `balance` at markPrice

  basisStatus: BasisStatus;
  coveredUnits: bigint;
  uncoveredUnits: bigint;
  coveredCostBasis: bigint | null; // quote-wei cost of the currently-held covered units
  coveredAvgBasisPerToken: bigint | null; // quote-wei per WHOLE token
  unrealizedPnl: bigint | null; // coveredValue − coveredCostBasis
  realizedPnl: bigint | null; // null unless historyComplete

  scannedFromBlock: bigint;
  scannedThroughBlock: bigint;
  historyComplete: boolean;
  loading: boolean;
};

/** One wallet-scoped tx aggregate the reducer consumes (the hook builds these from raw logs). */
export type WalletTxMove = {
  blockNumber: bigint;
  /** Stable intra-block order key (e.g. min logIndex in the tx) — sorts settlement order. */
  orderKey: bigint;
  /** Wallet's NET token change in this tx: + acquired, − disposed (base units). */
  tokenDelta: bigint;
  /** Wallet's NET QUOTE (pool numeraire — WETH / TSLA / …) change in this tx: + received, − paid. */
  quoteDelta: bigint;
  /** Count of Swap events for the SELECTED pool in this tx (≠1 ⇒ ambiguous ⇒ uncovered). */
  poolSwapCount: number;
  /** True if the tx contains ANY PoolManager Swap on a pool OTHER than the selected one (multihop / router
   *  hop). Even a single selected-pool swap is then NOT a clean single-pool trade ⇒ uncovered (kami 23497). */
  hasOtherSwap: boolean;
};

export type PositionInputs = {
  balance: bigint;
  tokenDecimals: number;
  quoteDecimals: number;
  quoteSymbol: string;
  markPrice: bigint | null;
  markStatus: MarkStatus;
  asOfBlock: bigint | null;
  moves: WalletTxMove[];
  scannedFromBlock: bigint;
  scannedThroughBlock: bigint;
  /** True iff the scan's fromBlock is at/before the token's inception (pool creation) block. */
  reachedInception: boolean;
  /** True iff the scan's throughBlock == the block the balance/mark snapshot was pinned to (no tail gap).
   *  `historyComplete` (⇒ realizedPnl as a number, basisStatus 'complete') requires this AND reachedInception
   *  AND zero ambiguity — an un-scanned recent tx could hide a sell (kami 23497 tail-coverage). */
  reachedThroughBlock: boolean;
};

function cmp(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/* ── log → per-tx move grouping (pure, so the honesty-critical reconciliation is testable) ────────
 * The hook maps its viem logs onto these minimal shapes and calls `buildMoves`; keeping the grouping
 * pure means a bug in the wallet-delta accumulation (the input to covered/uncovered classification)
 * is caught by scripts/positionPnlSmoke.mjs, not only by a live render. */
export type RawTransfer = { txHash: string; blockNumber: bigint; logIndex: bigint; from: string; to: string; value: bigint };
/** A PoolManager Swap, carrying WHICH pool it hit — so a tx's Swaps split into selected vs other-pool. */
export type RawSwap = { txHash: string; poolId: string };

/** Aggregate the wallet's NET token/quote deltas per tx and split this tx's Swaps into selected-pool vs
 *  other-pool (multihop). Self-transfers (from==to==wallet) net to zero. `poolSwapCount` = SELECTED-pool
 *  Swaps in the tx (≠1 ⇒ ambiguous); `hasOtherSwap` = any Swap on a different pool (kami 23497). The
 *  `quoteXfers`/`quoteDelta` are the pool's NUMERAIRE — WETH for own-stack, but arbitrary on 4663 Doppler
 *  (e.g. TSLA); the caller supplies whichever ERC-20 is the pool's non-launched currency. */
export function buildMoves(
  tokenXfers: RawTransfer[],
  quoteXfers: RawTransfer[],
  allSwaps: RawSwap[],
  wallet: string,
  selectedPoolId: string,
): WalletTxMove[] {
  const w = wallet.toLowerCase();
  const sel = selectedPoolId.toLowerCase();
  const selectedCount = new Map<string, number>();
  const otherCount = new Map<string, number>();
  for (const s of allSwaps) {
    const bucket = s.poolId.toLowerCase() === sel ? selectedCount : otherCount;
    bucket.set(s.txHash, (bucket.get(s.txHash) ?? 0) + 1);
  }

  type Agg = { blockNumber: bigint; orderKey: bigint; tokenDelta: bigint; quoteDelta: bigint };
  const byTx = new Map<string, Agg>();
  const touch = (h: string, b: bigint, li: bigint): Agg => {
    let a = byTx.get(h);
    if (!a) {
      a = { blockNumber: b, orderKey: li, tokenDelta: 0n, quoteDelta: 0n };
      byTx.set(h, a);
    } else if (li < a.orderKey) a.orderKey = li;
    return a;
  };
  for (const x of tokenXfers) {
    const a = touch(x.txHash, x.blockNumber, x.logIndex);
    if (x.to.toLowerCase() === w) a.tokenDelta += x.value;
    if (x.from.toLowerCase() === w) a.tokenDelta -= x.value;
  }
  for (const x of quoteXfers) {
    const a = touch(x.txHash, x.blockNumber, x.logIndex);
    if (x.to.toLowerCase() === w) a.quoteDelta += x.value;
    if (x.from.toLowerCase() === w) a.quoteDelta -= x.value;
  }
  return [...byTx.entries()].map(([h, a]) => ({
    blockNumber: a.blockNumber,
    orderKey: a.orderKey,
    tokenDelta: a.tokenDelta,
    quoteDelta: a.quoteDelta,
    poolSwapCount: selectedCount.get(h) ?? 0,
    hasOtherSwap: (otherCount.get(h) ?? 0) > 0,
  }));
}

/** Pure covered-only WAC accounting. Deterministic; no I/O. */
export function computePosition(inp: PositionInputs): TokenPosition {
  const wholeScale = 10n ** BigInt(inp.tokenDecimals);

  // Settlement order: block, then intra-block order key.
  const moves = [...inp.moves].sort((a, b) =>
    a.blockNumber === b.blockNumber ? cmp(a.orderKey, b.orderKey) : cmp(a.blockNumber, b.blockNumber),
  );

  let coveredQty = 0n; // covered units currently in the WAC pool (base units)
  let coveredCost = 0n; // quote-wei cost basis of coveredQty
  let realized = 0n; // quote-wei realized PnL booked on covered sells
  let uncoveredHeld = 0n; // units acquired via uncovered paths, still notionally held
  let anyAmbiguity = false; // any token-moving tx that wasn't a clean single-pool swap

  for (const m of moves) {
    if (m.tokenDelta === 0n) continue; // pure-WETH tx (e.g. claim) — irrelevant to token position

    const isCleanSwap =
      m.poolSwapCount === 1 &&
      !m.hasOtherSwap && // exactly ONE swap total, on the selected pool — no other-pool/multihop hop (kami #3)
      m.quoteDelta !== 0n &&
      ((m.tokenDelta > 0n && m.quoteDelta < 0n) || (m.tokenDelta < 0n && m.quoteDelta > 0n));

    if (!isCleanSwap) {
      // UNCOVERED: gift/airdrop (no quote leg), OR multihop / other-pool hop, OR non-reconciling.
      anyAmbiguity = true;
      if (m.tokenDelta > 0n) {
        uncoveredHeld += m.tokenDelta;
      } else {
        // Uncovered disposal: drain uncovered first, then covered pool at WAC WITHOUT booking
        // realized (proceeds are unpriced/ambiguous). historyComplete is already false.
        let out = -m.tokenDelta;
        const fromUncovered = out < uncoveredHeld ? out : uncoveredHeld;
        uncoveredHeld -= fromUncovered;
        out -= fromUncovered;
        if (out > 0n && coveredQty > 0n) {
          const fromCovered = out < coveredQty ? out : coveredQty;
          const costOut = (coveredCost * fromCovered) / coveredQty;
          coveredCost -= costOut;
          coveredQty -= fromCovered;
        }
      }
      continue;
    }

    if (m.tokenDelta > 0n) {
      // Covered BUY: cost = WETH paid.
      coveredQty += m.tokenDelta;
      coveredCost += -m.quoteDelta;
    } else {
      // Covered SELL: book realized against the covered portion at WAC; pro-rate proceeds.
      const sold = -m.tokenDelta;
      const sellFromCovered = sold < coveredQty ? sold : coveredQty;
      if (sellFromCovered > 0n) {
        const costOut = (coveredCost * sellFromCovered) / coveredQty;
        const proceedsCovered = (m.quoteDelta * sellFromCovered) / sold;
        realized += proceedsCovered - costOut;
        coveredCost -= costOut;
        coveredQty -= sellFromCovered;
      }
      const soldFromUncovered = sold - sellFromCovered;
      if (soldFromUncovered > 0n) {
        // Selling more than the covered pool held ⇒ dips into uncovered inventory ⇒ ambiguous.
        anyAmbiguity = true;
        uncoveredHeld = uncoveredHeld > soldFromUncovered ? uncoveredHeld - soldFromUncovered : 0n;
      }
    }
  }

  // Reconcile to the on-chain balance (source of truth). Covered can't exceed what's held.
  const coveredHeld = coveredQty < 0n ? 0n : coveredQty;
  const coveredUnits = coveredHeld > inp.balance ? inp.balance : coveredHeld;
  const uncoveredUnits = inp.balance - coveredUnits;

  const historyComplete = inp.reachedInception && inp.reachedThroughBlock && !anyAmbiguity;

  let basisStatus: BasisStatus;
  if (historyComplete && coveredUnits === inp.balance && inp.balance >= 0n) basisStatus = "complete";
  else if (coveredUnits > 0n) basisStatus = "partial";
  else basisStatus = "unknown";

  // Cost basis of the CURRENTLY-HELD covered units (pro-rate the WAC pool down to coveredUnits).
  const coveredCostBasis =
    coveredHeld > 0n ? (coveredCost * coveredUnits) / coveredHeld : coveredUnits === 0n && basisStatus === "complete" ? 0n : null;

  const coveredAvgBasisPerToken =
    coveredUnits > 0n && coveredCostBasis !== null ? (coveredCostBasis * wholeScale) / coveredUnits : null;

  // Mark / valuation.
  const currentValue = inp.markPrice !== null ? (inp.balance * inp.markPrice) / wholeScale : null;
  const coveredValue = inp.markPrice !== null ? (coveredUnits * inp.markPrice) / wholeScale : null;
  const unrealizedPnl =
    coveredValue !== null && coveredCostBasis !== null && coveredUnits > 0n ? coveredValue - coveredCostBasis : null;

  return {
    balance: inp.balance,
    tokenDecimals: inp.tokenDecimals,
    quoteDecimals: inp.quoteDecimals,
    quoteSymbol: inp.quoteSymbol,
    markPrice: inp.markPrice,
    markStatus: inp.markStatus,
    asOfBlock: inp.asOfBlock,
    currentValue,
    basisStatus,
    coveredUnits,
    uncoveredUnits,
    coveredCostBasis,
    coveredAvgBasisPerToken,
    unrealizedPnl,
    realizedPnl: historyComplete ? realized : null,
    scannedFromBlock: inp.scannedFromBlock,
    scannedThroughBlock: inp.scannedThroughBlock,
    historyComplete,
    loading: false,
  };
}
