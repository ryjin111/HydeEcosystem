import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useHydeLaunches } from "../hooks/useDopplerTokens";
import type { DopplerPool } from "../utils/dopplerConfig";

/* ─── helpers ─────────────────────────────────────────────────────────────── */
function fmtUsd(raw: string | null): string {
  const n = parseFloat(raw ?? "0");
  if (!n) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/* ─── Token card ──────────────────────────────────────────────────────────── */
function TokenCard({ pool, onTrade }: { pool: DopplerPool; onTrade: () => void }) {
  const bt = pool.baseToken;
  const isGraduated = pool.type === "v2";
  const liq = parseFloat(pool.dollarLiquidity ?? "0");
  const vol = parseFloat(pool.volumeUsd ?? "0");

  return (
    <div
      className="rounded-2xl p-4 flex flex-col gap-3 cursor-pointer transition group"
      style={{ background: "#0d1220", border: "1px solid rgba(0,212,255,0.08)" }}
      onMouseEnter={(e) => ((e.currentTarget as HTMLDivElement).style.borderColor = "rgba(0,212,255,0.25)")}
      onMouseLeave={(e) => ((e.currentTarget as HTMLDivElement).style.borderColor = "rgba(0,212,255,0.08)")}
    >
      {/* Header */}
      <div className="flex items-center gap-3">
        <div
          className="h-10 w-10 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0"
          style={{ background: "rgba(0,212,255,0.12)", color: "#00d4ff" }}
        >
          {bt.symbol.slice(0, 2).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-bold text-pcs-text text-sm truncate">{bt.name}</p>
          <p className="text-xs text-pcs-textDim">{bt.symbol}</p>
        </div>
        <span
          className="text-[9px] font-bold px-1.5 py-0.5 rounded-full uppercase tracking-wide flex-shrink-0"
          style={
            isGraduated
              ? { background: "rgba(0,212,255,0.10)", color: "#00d4ff" }
              : { background: "rgba(168,85,247,0.12)", color: "#a855f7" }
          }
        >
          {isGraduated ? "Graduated" : "Auction"}
        </span>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-xl px-3 py-2" style={{ background: "rgba(255,255,255,0.03)" }}>
          <p className="text-pcs-textDim mb-0.5">Liquidity</p>
          <p className="font-bold text-pcs-text">{fmtUsd(pool.dollarLiquidity)}</p>
        </div>
        <div className="rounded-xl px-3 py-2" style={{ background: "rgba(255,255,255,0.03)" }}>
          <p className="text-pcs-textDim mb-0.5">Volume</p>
          <p className="font-bold text-pcs-text">{fmtUsd(pool.volumeUsd)}</p>
        </div>
      </div>

      {/* Progress bar toward graduation (only for in-auction) */}
      {!isGraduated && liq > 0 && (
        <div>
          <div className="flex justify-between text-[9px] text-pcs-textDim mb-1">
            <span>Progress to graduation</span>
            <span>{Math.min(100, Math.round((liq / 10000) * 100))}%</span>
          </div>
          <div className="h-1 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.06)" }}>
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.min(100, (liq / 10000) * 100)}%`,
                background: "linear-gradient(90deg, #a855f7, #00d4ff)",
              }}
            />
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-pcs-textDim">{timeAgo(pool.createdAt)}</span>
        <button
          onClick={(e) => { e.stopPropagation(); onTrade(); }}
          className="text-xs font-semibold px-3 py-1.5 rounded-xl transition"
          style={{ background: "rgba(0,212,255,0.10)", color: "#00d4ff" }}
          onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(0,212,255,0.20)")}
          onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(0,212,255,0.10)")}
        >
          Trade →
        </button>
      </div>
    </div>
  );
}

/* ─── Page ────────────────────────────────────────────────────────────────── */
type SortMode = "trending" | "new" | "graduating";

function sortPools(pools: DopplerPool[], mode: SortMode): DopplerPool[] {
  const copy = [...pools];
  if (mode === "trending") {
    return copy.sort((a, b) => {
      const va = parseFloat(a.volumeUsd ?? "0");
      const vb = parseFloat(b.volumeUsd ?? "0");
      if (va !== vb) return vb - va;
      return parseFloat(b.dollarLiquidity ?? "0") - parseFloat(a.dollarLiquidity ?? "0");
    });
  }
  if (mode === "new") {
    return copy.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }
  // graduating: in-auction only, sorted by liquidity desc (closest to graduation first)
  return copy
    .filter((p) => p.type !== "v2")
    .sort((a, b) => parseFloat(b.dollarLiquidity ?? "0") - parseFloat(a.dollarLiquidity ?? "0"));
}

export function LaunchesPage() {
  const { pools, loading, refetch } = useHydeLaunches();
  const navigate = useNavigate();
  const [sort, setSort] = useState<SortMode>("trending");
  const [search, setSearch] = useState("");

  const displayed = useMemo(() => {
    const filtered = search
      ? pools.filter(
          (p) =>
            p.baseToken.symbol.toLowerCase().includes(search.toLowerCase()) ||
            p.baseToken.name.toLowerCase().includes(search.toLowerCase())
        )
      : pools;
    return sortPools(filtered, sort);
  }, [pools, sort, search]);

  const sortLabels: { mode: SortMode; label: string }[] = [
    { mode: "trending", label: "Trending" },
    { mode: "new", label: "New" },
    { mode: "graduating", label: "Graduating" },
  ];

  return (
    <div className="w-full max-w-6xl mx-auto px-4">
      {/* Header */}
      <div className="mb-6 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-pcs-text">Launches</h1>
          <p className="text-sm text-pcs-textDim mt-1">
            {loading
              ? "Loading…"
              : `${pools.length} token${pools.length !== 1 ? "s" : ""} launched on Optimism`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => navigate("/launchpad")}
            className="text-xs font-semibold px-4 py-2 rounded-xl transition"
            style={{ background: "rgba(0,212,255,0.12)", color: "#00d4ff", border: "1px solid rgba(0,212,255,0.20)" }}
            onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(0,212,255,0.20)")}
            onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(0,212,255,0.12)")}
          >
            + Launch Token
          </button>
          <button onClick={refetch} className="text-xs text-pcs-primary hover:underline" disabled={loading}>
            {loading ? "…" : "Refresh"}
          </button>
        </div>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap gap-2 mb-5">
        {/* Sort tabs */}
        <div
          className="flex rounded-xl overflow-hidden"
          style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(0,212,255,0.07)" }}
        >
          {sortLabels.map(({ mode, label }) => (
            <button
              key={mode}
              onClick={() => setSort(mode)}
              className="px-4 py-1.5 text-xs font-semibold transition"
              style={
                sort === mode
                  ? { background: "rgba(0,212,255,0.15)", color: "#00d4ff" }
                  : { color: "#6b7280" }
              }
            >
              {label}
            </button>
          ))}
        </div>

        {/* Search */}
        <input
          type="text"
          placeholder="Search token…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 min-w-[140px] rounded-xl px-3 py-1.5 text-xs text-pcs-text outline-none"
          style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(0,212,255,0.08)" }}
        />
      </div>

      {/* Grid */}
      {loading && displayed.length === 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="h-44 rounded-2xl animate-pulse"
              style={{ background: "rgba(255,255,255,0.03)" }}
            />
          ))}
        </div>
      ) : displayed.length === 0 ? (
        <div
          className="rounded-2xl p-10 text-center"
          style={{ background: "#0d1220", border: "1px solid rgba(0,212,255,0.08)" }}
        >
          <p className="text-pcs-textDim text-sm">
            {search ? "No tokens match your search." : "No launches yet — be the first!"}
          </p>
          {!search && (
            <button
              onClick={() => navigate("/launchpad")}
              className="mt-4 px-5 py-2 rounded-xl text-sm font-semibold"
              style={{ background: "rgba(0,212,255,0.10)", color: "#00d4ff" }}
            >
              Launch a Token
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {displayed.map((pool) => (
            <TokenCard
              key={pool.address}
              pool={pool}
              onTrade={() => navigate(`/swap?out=${pool.baseToken.address}`)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
