import { useDopplerPools } from "../hooks/useDopplerTokens";
import type { DopplerPool } from "../utils/dopplerConfig";

export type { DopplerPool };

function fmtVol(raw: string | null): string {
  const n = parseFloat(raw ?? "0");
  if (!n) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function TokenPill({
  pool,
  rank,
  active,
  onSelect,
}: {
  pool: DopplerPool;
  rank: number;
  active: boolean;
  onSelect: (pool: DopplerPool) => void;
}) {
  const bt = pool.baseToken;
  const vol = parseFloat(pool.volumeUsd ?? "0");
  const displayVal = vol > 0 ? fmtVol(pool.volumeUsd) : fmtVol(pool.dollarLiquidity);
  const label = vol > 0 ? "vol" : "liq";
  const isGraduated = pool.type === "v2";

  return (
    <button
      onClick={() => onSelect(pool)}
      className="flex items-center gap-2 px-3 py-2 rounded-xl flex-shrink-0 transition text-left"
      style={{
        background: active ? "rgba(0,212,255,0.12)" : "rgba(255,255,255,0.04)",
        border: `1px solid ${active ? "rgba(0,212,255,0.35)" : "rgba(0,212,255,0.08)"}`,
      }}
      onMouseEnter={(e) => {
        if (!active) {
          (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,212,255,0.08)";
          (e.currentTarget as HTMLButtonElement).style.borderColor = "rgba(0,212,255,0.22)";
        }
      }}
      onMouseLeave={(e) => {
        if (!active) {
          (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.04)";
          (e.currentTarget as HTMLButtonElement).style.borderColor = "rgba(0,212,255,0.08)";
        }
      }}
    >
      <span className="text-[10px] font-bold text-pcs-textDim w-3">{rank}</span>
      <div
        className="h-6 w-6 rounded-full flex items-center justify-center text-[9px] font-bold flex-shrink-0"
        style={{ background: "rgba(0,212,255,0.15)", color: "#00d4ff" }}
      >
        {bt.symbol.slice(0, 2).toUpperCase()}
      </div>
      <div className="flex flex-col leading-none">
        <div className="flex items-center gap-1">
          <span className="text-xs font-bold text-pcs-text">{bt.symbol}</span>
          {isGraduated && (
            <span
              className="text-[8px] font-bold px-1 py-0.5 rounded"
              style={{ background: "rgba(0,212,255,0.12)", color: "#00d4ff" }}
            >
              V2
            </span>
          )}
        </div>
        <span className="text-[10px] text-pcs-textDim mt-0.5">
          {displayVal} <span className="opacity-60">{label}</span>
        </span>
      </div>
    </button>
  );
}

type Props = {
  chainId: number;
  selected?: string; // active pool address
  onSelect: (pool: DopplerPool) => void;
};

export function TrendingCarousel({ chainId, selected, onSelect }: Props) {
  const { pools, loading } = useDopplerPools(chainId);

  const sorted = [...pools].sort((a, b) => {
    const va = parseFloat(a.volumeUsd ?? "0");
    const vb = parseFloat(b.volumeUsd ?? "0");
    if (va !== vb) return vb - va;
    return parseFloat(b.dollarLiquidity ?? "0") - parseFloat(a.dollarLiquidity ?? "0");
  });

  if (loading && pools.length === 0) {
    return (
      <div className="flex gap-2 overflow-x-auto pb-1 mb-4" style={{ scrollbarWidth: "none" }}>
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="h-10 w-28 rounded-xl flex-shrink-0 animate-pulse"
            style={{ background: "rgba(255,255,255,0.04)" }}
          />
        ))}
      </div>
    );
  }

  if (sorted.length === 0) return null;

  return (
    <div className="mb-4">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[11px] font-semibold uppercase tracking-widest text-pcs-textDim">
          Trending
        </span>
        <span
          className="text-[9px] font-bold px-1.5 py-0.5 rounded"
          style={{ background: "rgba(0,212,255,0.08)", color: "#00d4ff" }}
        >
          Ink
        </span>
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1" style={{ scrollbarWidth: "none" }}>
        {sorted.map((pool, i) => (
          <TokenPill
            key={pool.address}
            pool={pool}
            rank={i + 1}
            active={selected === pool.address}
            onSelect={onSelect}
          />
        ))}
      </div>
    </div>
  );
}
