import type { ReactNode } from "react";
import { Card, SectionLabel } from "./ui/kit";

/**
 * TokenPosition — the FROZEN per-wallet PnL contract (kami 23486 + kuro 23488). @kuro's
 * `useTokenPosition(token)` returns this; shiro's card renders every state honestly. All monetary
 * values are raw `bigint` + their decimals/unit so formatting stays lossless in the UI.
 *
 * Honesty guarantees encoded here (kami v4): covered-only basis/PnL (never whole-balance),
 * `uncoveredUnits` carry NO fabricated basis, `realizedPnl`/`markPrice` are `null` when they can't
 * be proven, and `markStatus` carries mark provenance (a `live` mark renders as spot, never TWAP).
 */
export type TokenPosition = {
  balance: bigint;                 // units held (always)
  tokenDecimals: number;           // for balance / coveredUnits / uncoveredUnits
  quoteDecimals: number;           // for markPrice / value / basis / pnl (WETH = 18)
  quoteSymbol: string;             // honest unit from the pool numeraire (e.g. "WETH"), not hardcoded

  markPrice: bigint | null;        // price in quote; null when unavailable
  markStatus: "live" | "twap" | "estimated" | "exit" | "unavailable";
  asOfBlock: bigint | null;
  currentValue: bigint | null;     // balance × markPrice; null when mark unavailable

  basisStatus: "complete" | "partial" | "unknown";
  coveredUnits: bigint;
  uncoveredUnits: bigint;          // acquired via plain transfer / ambiguous tx → no basis
  coveredCostBasis: bigint | null; // covered units only
  coveredAvgBasisPerToken: bigint | null;
  unrealizedPnl: bigint | null;    // (coveredUnits × markPrice) − coveredCostBasis
  realizedPnl: bigint | null;      // number ONLY when covered history proves the full sell set

  scannedFromBlock: bigint;
  scannedThroughBlock: bigint;
  historyComplete: boolean;
  loading: boolean;
};

/* ── lossless bigint formatting ─────────────────────────────────────────────── */
function fmtBig(v: bigint, decimals: number, maxFrac = 4): string {
  const neg = v < 0n;
  const x = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const whole = (x / base).toLocaleString("en-US");
  const frac = (x % base).toString().padStart(decimals, "0").slice(0, maxFrac).replace(/0+$/, "");
  return `${neg ? "−" : ""}${whole}${frac ? "." + frac : ""}`;
}
/** Signed money for PnL (+/−), abs-formatted with unit. */
function fmtSigned(v: bigint, decimals: number, unit: string, maxFrac = 4): string {
  const sign = v > 0n ? "+" : v < 0n ? "−" : "";
  const abs = v < 0n ? -v : v;
  return `${sign}${fmtBig(abs, decimals, maxFrac)} ${unit}`.trim();
}
const pnlColor = (v: bigint | null): string => (v == null ? "#8A93A2" : v > 0n ? "#34C77B" : v < 0n ? "#E5484D" : "#8A93A2");
/** % to one decimal via bigint fixed-point (kami 23491 — no `Number()`, lossless & overflow-safe).
 *  pnl & basis share units/decimals so the ratio is scale-independent; basis = cost paid (≥ 0). */
function pnlPct(pnl: bigint | null, basis: bigint | null): string | null {
  if (pnl == null || basis == null) return null;
  const absBasis = basis < 0n ? -basis : basis;
  if (absBasis === 0n) return null;
  // tenths of a percent = pnl / basis * 1000, rounded half-away-from-zero, all in bigint
  const scaled = pnl * 1000n;
  const half = absBasis / 2n;
  const tenths = (scaled >= 0n ? scaled + half : scaled - half) / absBasis;
  const sign = tenths > 0n ? "+" : tenths < 0n ? "−" : "";
  const abs = tenths < 0n ? -tenths : tenths;
  return `${sign}${(abs / 10n).toString()}.${(abs % 10n).toString()}%`;
}
const MARK_LABEL: Record<TokenPosition["markStatus"], string | null> = {
  live: "spot", twap: "TWAP", estimated: "est.", exit: "exit sim", unavailable: null,
};

function Row({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-pcs-textDim">{label}</span>
      <span className="font-mono tabular-nums font-medium" style={{ color: color ?? "#E8ECF1" }}>{value}</span>
    </div>
  );
}

export function YourPositionCard({
  connected,
  position,
  symbol,
}: {
  connected: boolean;
  position: TokenPosition | null; // null before the hook resolves for a connected wallet
  symbol: string;
}) {
  const sym = symbol ? `$${symbol}` : "this token";

  let body: ReactNode;
  if (!connected) {
    body = <p className="mt-3 text-sm text-pcs-textDim">Connect your wallet to track your position &amp; PnL.</p>;
  } else if (position == null || position.loading) {
    body = (
      <div className="mt-3 space-y-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-4 rounded animate-pulse" style={{ background: "rgba(255,255,255,0.05)" }} />
        ))}
      </div>
    );
  } else if (position.balance === 0n && position.coveredUnits === 0n && position.uncoveredUnits === 0n) {
    body = <p className="mt-3 text-sm text-pcs-textDim">You don&rsquo;t hold {sym} right now.</p>;
  } else {
    const p = position;
    const markLabel = MARK_LABEL[p.markStatus];
    const pct = pnlPct(p.unrealizedPnl, p.coveredCostBasis);
    body = (
      <div className="mt-3 space-y-2">
        <Row label="Holdings" value={`${fmtBig(p.balance, p.tokenDecimals)} ${sym}`.trim()} />
        <div className="flex items-center justify-between text-xs">
          <span className="text-pcs-textDim">
            Value
            {markLabel && p.currentValue != null && (
              <span className="ml-1.5 rounded px-1 py-px text-[9px] font-semibold uppercase tracking-wide"
                style={{ background: "rgba(255,255,255,0.06)", color: "#8A93A2" }}>{markLabel}</span>
            )}
          </span>
          <span className="font-mono tabular-nums font-medium" style={{ color: p.currentValue != null ? "#E8ECF1" : "#8A93A2" }}>
            {/* A held position whose exit sim couldn't resolve shows an explicit terminal state, not a bare
                "—" that reads like zero value (shiro). */}
            {p.currentValue != null ? `${fmtBig(p.currentValue, p.quoteDecimals)} ${p.quoteSymbol}` : p.balance > 0n ? "Live exit value unavailable" : "—"}
          </span>
        </div>
        <Row
          label="Avg cost"
          value={p.coveredAvgBasisPerToken != null ? `${fmtBig(p.coveredAvgBasisPerToken, p.quoteDecimals, 6)} ${p.quoteSymbol}` : "basis n/a"}
          color={p.coveredAvgBasisPerToken != null ? "#E8ECF1" : "#8A93A2"}
        />

        <div className="my-1 h-px" style={{ background: "#22252D" }} />

        {/* Unrealized — the live headline */}
        <div className="flex items-center justify-between">
          <span className="text-xs text-pcs-textDim">Unrealized PnL</span>
          <span className="font-mono tabular-nums text-sm font-semibold" style={{ color: pnlColor(p.unrealizedPnl) }}>
            {p.unrealizedPnl != null
              ? `${fmtSigned(p.unrealizedPnl, p.quoteDecimals, p.quoteSymbol)}${pct ? `  (${pct})` : ""}`
              : "—"}
          </span>
        </div>
        <Row
          label="Realized PnL"
          value={p.realizedPnl != null ? fmtSigned(p.realizedPnl, p.quoteDecimals, p.quoteSymbol) : "—"}
          color={pnlColor(p.realizedPnl)}
        />

        {/* Honesty footnotes */}
        {p.uncoveredUnits > 0n && (
          <p className="pt-1 text-[11px] text-pcs-textDim leading-relaxed">
            {fmtBig(p.uncoveredUnits, p.tokenDecimals)} {sym} received by transfer have no on-chain cost basis —
            held in your balance but excluded from PnL.
          </p>
        )}
        {p.basisStatus === "partial" && (
          <p className="pt-1 text-[11px]" style={{ color: "#E0A32E" }}>
            Some trades couldn&rsquo;t be reconciled on-chain — cost &amp; PnL cover verified history only.
          </p>
        )}
        {p.realizedPnl == null && p.basisStatus !== "unknown" && (
          <p className="pt-0.5 text-[11px] text-pcs-textDim">Realized PnL hidden — the full sell history can&rsquo;t be proven yet.</p>
        )}
        <p className="pt-0.5 text-[10px] text-pcs-textDim">
          Avg-cost basis, in {p.quoteSymbol}
          {p.asOfBlock != null ? ` · as of block ${p.asOfBlock.toString()}` : ""}.
        </p>
      </div>
    );
  }

  return (
    <Card variant="panel" data-testid="your-position">
      <SectionLabel>Your Position</SectionLabel>
      {body}
    </Card>
  );
}
