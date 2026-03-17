import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useDopplerPools } from "../hooks/useDopplerTokens";
import type { DopplerPool } from "../utils/dopplerConfig";
import { ClankerLaunchForm } from "../components/ClankerLaunchForm";

const OPTIMISM_CHAIN_ID = 10;

/* ─── helpers ─────────────────────────────────────────────────────────────── */

function fmtLiquidity(raw: string | null): string {
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

/* ─── Pool card (Explore tab) ─────────────────────────────────────────────── */

const CHAIN_LABELS: Record<number, string> = {
  57073: "Ink",
  10: "Optimism",
};

function PoolCard({ pool, onTrade }: { pool: DopplerPool; onTrade: (addr: string, chainId: number) => void }) {
  const bt = pool.baseToken;
  const chainLabel = CHAIN_LABELS[pool.chainId] ?? `chain ${pool.chainId}`;
  return (
    <div
      className="rounded-2xl p-4 flex flex-col gap-3 border transition hover:border-pcs-primary/40"
      style={{ background: "#0d1220", borderColor: "rgba(0,212,255,0.10)" }}
    >
      {/* Token identity */}
      <div className="flex items-center gap-3">
        <div
          className="h-10 w-10 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0"
          style={{ background: "rgba(0,212,255,0.12)", color: "#00d4ff" }}
        >
          {bt.symbol.slice(0, 2).toUpperCase()}
        </div>
        <div className="min-w-0">
          <p className="font-semibold text-pcs-text truncate">{bt.name}</p>
          <p className="text-xs text-pcs-textDim">{bt.symbol}</p>
        </div>
        <div className="ml-auto flex items-center gap-1.5 flex-shrink-0">
          <span
            className="text-[10px] font-semibold px-2 py-0.5 rounded-full uppercase tracking-wide"
            style={{ background: "rgba(255,255,255,0.06)", color: "#9ca3af" }}
          >
            {chainLabel}
          </span>
          <span
            className="text-[10px] font-semibold px-2 py-0.5 rounded-full uppercase tracking-wide"
            style={{
              background: pool.type === "v4" ? "rgba(168,85,247,0.15)" : "rgba(0,212,255,0.10)",
              color: pool.type === "v4" ? "#a855f7" : "#00d4ff",
            }}
          >
            {pool.type}
          </span>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-xl px-3 py-2" style={{ background: "rgba(255,255,255,0.03)" }}>
          <p className="text-pcs-textDim mb-0.5">Liquidity</p>
          <p className="font-semibold text-pcs-text">{fmtLiquidity(pool.dollarLiquidity)}</p>
        </div>
        <div className="rounded-xl px-3 py-2" style={{ background: "rgba(255,255,255,0.03)" }}>
          <p className="text-pcs-textDim mb-0.5">Volume</p>
          <p className="font-semibold text-pcs-text">{fmtLiquidity(pool.volumeUsd)}</p>
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-pcs-textDim">{timeAgo(pool.createdAt)}</span>
        <button
          onClick={() => onTrade(bt.address, pool.chainId)}
          className="text-xs font-semibold px-3 py-1.5 rounded-xl transition"
          style={{ background: "rgba(0,212,255,0.10)", color: "#00d4ff" }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(0,212,255,0.18)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "rgba(0,212,255,0.10)")}
        >
          Trade →
        </button>
      </div>
    </div>
  );
}

/* ─── Page ────────────────────────────────────────────────────────────────── */

export function LaunchpadPage() {
  const [tab, setTab] = useState<"explore" | "launch">("explore");
  const { pools, loading, refetch } = useDopplerPools(OPTIMISM_CHAIN_ID);
  const navigate = useNavigate();

  const handleTrade = (tokenAddress: string, _chainId: number) => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(tokenAddress)) return;
    navigate(`/swap?out=${tokenAddress}`);
  };

  return (
    <div className="max-w-6xl mx-auto px-4 w-full">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-pcs-text">Launchpad</h1>
        <p className="text-sm text-pcs-textDim mt-1">
          Instant token launches on Optimism — earn trading fees from day one.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 p-1 rounded-2xl w-fit" style={{ background: "rgba(255,255,255,0.04)" }}>
        {(["explore", "launch"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className="px-5 py-2 rounded-xl text-sm font-semibold transition capitalize"
            style={
              tab === t
                ? { background: "rgba(0,212,255,0.15)", color: "#00d4ff" }
                : { color: "#6b7280" }
            }
          >
            {t === "explore" ? "Explore Launches" : "Launch a Token"}
          </button>
        ))}
      </div>

      {/* Explore tab */}
      {tab === "explore" && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <p className="text-sm text-pcs-textDim">
              {loading ? "Loading…" : `${pools.length} token${pools.length !== 1 ? "s" : ""} launched on Optimism`}
            </p>
            <button
              onClick={refetch}
              className="text-xs text-pcs-primary hover:underline"
              disabled={loading}
            >
              {loading ? "Refreshing…" : "Refresh"}
            </button>
          </div>

          {!loading && pools.length === 0 && (
            <div
              className="rounded-2xl p-10 text-center"
              style={{ background: "#0d1220", border: "1px solid rgba(0,212,255,0.08)" }}
            >
              <p className="text-pcs-textDim text-sm">No launches found yet.</p>
              <p className="text-pcs-textDim text-xs mt-1">
                Be the first to launch a token on Optimism!
              </p>
              <button
                onClick={() => setTab("launch")}
                className="mt-4 px-5 py-2 rounded-xl text-sm font-semibold"
                style={{ background: "rgba(0,212,255,0.10)", color: "#00d4ff" }}
              >
                Launch a Token
              </button>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {pools.map((pool) => (
              <PoolCard
                key={`${pool.chainId}-${pool.address}-${pool.baseToken.address}`}
                pool={pool}
                onTrade={handleTrade}
              />
            ))}
          </div>
        </div>
      )}

      {/* Launch tab */}
      {tab === "launch" && <ClankerLaunchForm />}
    </div>
  );
}
