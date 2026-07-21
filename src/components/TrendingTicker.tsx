import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useHydeLaunches } from "../hooks/useDopplerTokens";
import type { DopplerPool } from "../utils/dopplerConfig";

// Global DexScreener-style trending ticker — a thin, full-width strip pinned under the header on
// EVERY page (clint 23798/23812: move Trending off the token page to the top, dexscreener-style).
// rank · icon · symbol · %move; the whole item routes to /swap?out=. % change shows a neutral "—"
// until real 24h change data exists (kami 23802 — never a fabricated number). Auto-scroll marquee
// (pause-on-hover) kicks in only once there are enough tokens to fill the bar; with a few tokens it's
// a clean, static, manually-scrollable row (a lone token looping would read as broken).

function byVolThenLiq(a: DopplerPool, b: DopplerPool): number {
  const va = parseFloat(a.volumeUsd ?? "0"), vb = parseFloat(b.volumeUsd ?? "0");
  if (va !== vb) return vb - va;
  return parseFloat(b.dollarLiquidity ?? "0") - parseFloat(a.dollarLiquidity ?? "0");
}

function TickerItem({ pool, rank, onClick }: { pool: DopplerPool; rank: number; onClick: () => void }) {
  const bt = pool.baseToken;
  return (
    <button
      onClick={onClick}
      aria-label={`Trade ${bt.symbol}`}
      className="flex flex-shrink-0 items-center gap-1.5 rounded-md px-2 py-1 transition hover:bg-white/[0.05]"
    >
      <span className="font-mono text-[10px] text-pcs-textDim">#{rank}</span>
      <span
        className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full text-[7px] font-bold"
        style={{ background: "rgba(46,159,230,0.16)", color: "#54B4F0" }}
      >
        {bt.symbol.slice(0, 2).toUpperCase()}
      </span>
      <span className="text-[11px] font-bold text-pcs-text">{bt.symbol}</span>
      {/* % change — neutral dash until real change data exists (kami 23802); never a fabricated number */}
      <span className="font-mono text-[10px] text-pcs-textDim">—</span>
    </button>
  );
}

export function TrendingTicker({ chainId }: { chainId: number }) {
  const { pools, loading } = useHydeLaunches(chainId);
  const navigate = useNavigate();
  const items = useMemo(() => [...pools].sort(byVolThenLiq).slice(0, 20), [pools]);

  // No empty strip: render nothing until there's real data (honest — never a skeleton forever).
  if (items.length === 0 || (loading && items.length === 0)) return null;

  const marquee = items.length >= 6;
  const track = marquee ? [...items, ...items] : items; // duplicate for a seamless -50% loop

  return (
    <div
      data-testid="trending-ticker"
      className="sticky top-0 z-10 flex h-9 items-center gap-2.5 overflow-hidden px-3"
      style={{ background: "#0F1114", borderBottom: "1px solid #1C1F26" }}
    >
      {/* Left anchor — non-scrolling (DexScreener's logo anchor) */}
      <div className="flex flex-shrink-0 items-center gap-1.5">
        <span className="text-[11px] font-bold tracking-wide" style={{ color: "#E0A32E" }}>🔥 TRENDING</span>
        <span className="rounded px-1.5 py-0.5 text-[9px] font-bold" style={{ background: "rgba(46,159,230,0.10)", color: "#54B4F0" }}>Robinhood L2</span>
      </div>
      <span className="h-4 w-px flex-shrink-0" style={{ background: "#22252D" }} />

      {/* Track — marquee (auto-scroll, pause-on-hover) when full; static horizontal scroll otherwise */}
      <div className={`min-w-0 flex-1 ${marquee ? "overflow-hidden" : "overflow-x-auto no-scrollbar"}`}>
        <div className={`flex w-max items-center gap-1 ${marquee ? "hyde-marquee" : ""}`}>
          {track.map((pool, i) => (
            <TickerItem
              key={`${pool.address}-${i}`}
              pool={pool}
              rank={(i % items.length) + 1}
              onClick={() => navigate(`/swap?out=${pool.baseToken.address}`)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
