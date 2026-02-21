import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { NetworkConfig, TokenInfo } from "../utils/constants";
import { V4SwapCard } from "../components/V4SwapCard";
import { TrendingCarousel } from "../components/TrendingCarousel";
import type { DopplerPool } from "../components/TrendingCarousel";
import { useDopplerPools } from "../hooks/useDopplerTokens";

/* ─── DexScreener chart embed ─────────────────────────────────────────────── */
function TokenChart({ pool }: { pool: DopplerPool | null }) {
  if (!pool) {
    return (
      <div
        className="w-full h-[360px] rounded-2xl flex items-center justify-center"
        style={{ background: "#0d1220", border: "1px solid rgba(0,212,255,0.08)" }}
      >
        <p className="text-xs text-pcs-textDim">Select a token to view chart</p>
      </div>
    );
  }

  // Use token address — DexScreener finds the best pair on Ink automatically
  const src = `https://dexscreener.com/ink/${pool.baseToken.address}?embed=1&theme=dark&trades=0&info=0`;

  return (
    <div
      className="w-full rounded-2xl overflow-hidden"
      style={{ height: 360, border: "1px solid rgba(0,212,255,0.08)" }}
    >
      <iframe
        src={src}
        width="100%"
        height="100%"
        frameBorder="0"
        allow="clipboard-write"
        title={`${pool.baseToken.symbol} chart`}
      />
    </div>
  );
}

/* ─── Recently launched feed ─────────────────────────────────────────────── */
function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function fmtUsd(raw: string | null): string {
  const n = parseFloat(raw ?? "0");
  if (!n) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function RecentlyLaunched({
  chainId,
  onSelect,
}: {
  chainId: number;
  onSelect: (pool: DopplerPool) => void;
}) {
  const { pools, loading } = useDopplerPools(chainId);
  const navigate = useNavigate();

  const recent = [...pools]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 8);

  return (
    <div
      className="rounded-2xl overflow-hidden"
      style={{ background: "#0d1220", border: "1px solid rgba(0,212,255,0.08)" }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-2.5"
        style={{ borderBottom: "1px solid rgba(0,212,255,0.06)" }}
      >
        <span className="text-[11px] font-semibold uppercase tracking-widest text-pcs-textDim">
          Recently Launched
        </span>
        <button
          className="text-[10px] text-pcs-primary hover:underline"
          onClick={() => navigate("/launches")}
        >
          View all →
        </button>
      </div>

      {/* List */}
      {loading && recent.length === 0 ? (
        <div className="p-4 space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-9 rounded-xl animate-pulse"
              style={{ background: "rgba(255,255,255,0.04)" }}
            />
          ))}
        </div>
      ) : recent.length === 0 ? (
        <p className="p-4 text-xs text-pcs-textDim text-center">No launches yet</p>
      ) : (
        <div className="divide-y" style={{ borderColor: "rgba(0,212,255,0.04)" }}>
          {recent.map((pool) => (
            <div
              key={pool.address}
              className="flex items-center gap-2.5 px-4 py-2 hover:bg-white/[0.02] cursor-pointer transition"
              onClick={() => onSelect(pool)}
            >
              {/* Avatar */}
              <div
                className="h-7 w-7 rounded-full flex items-center justify-center text-[9px] font-bold flex-shrink-0"
                style={{ background: "rgba(0,212,255,0.12)", color: "#00d4ff" }}
              >
                {pool.baseToken.symbol.slice(0, 2).toUpperCase()}
              </div>

              {/* Name + time */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-bold text-pcs-text truncate">{pool.baseToken.symbol}</span>
                  <span
                    className="text-[8px] font-bold px-1 py-0.5 rounded flex-shrink-0"
                    style={
                      pool.type === "v2"
                        ? { background: "rgba(0,212,255,0.10)", color: "#00d4ff" }
                        : { background: "rgba(168,85,247,0.12)", color: "#a855f7" }
                    }
                  >
                    {pool.type === "v2" ? "V2" : "Auction"}
                  </span>
                </div>
                <span className="text-[10px] text-pcs-textDim">{pool.baseToken.name}</span>
              </div>

              {/* Stats */}
              <div className="text-right flex-shrink-0">
                <p className="text-[10px] font-semibold text-pcs-text">{fmtUsd(pool.dollarLiquidity)}</p>
                <p className="text-[9px] text-pcs-textDim">{timeAgo(pool.createdAt)} ago</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── Page ────────────────────────────────────────────────────────────────── */

type Props = {
  network: NetworkConfig;
  tokens: TokenInfo[];
  onAddCustomToken: (token: { address: `0x${string}`; symbol: string; name: string; decimals: number }) => void;
};

export function SwapPage({ network, tokens, onAddCustomToken }: Props) {
  const [selectedPool, setSelectedPool] = useState<DopplerPool | null>(null);

  const handleSelect = (pool: DopplerPool) => setSelectedPool(pool);

  return (
    <div className="w-full max-w-6xl mx-auto">
      {/* Trending carousel — full width */}
      <TrendingCarousel
        chainId={network.id}
        selected={selectedPool?.address}
        onSelect={handleSelect}
      />

      {/* Two-column layout */}
      <div className="flex flex-col lg:flex-row gap-5 items-start">
        {/* Left: Swap card */}
        <div className="w-full lg:w-[440px] flex-shrink-0">
          <V4SwapCard
            network={network}
            tokens={tokens}
            onAddCustomToken={onAddCustomToken}
            forceTokenOut={selectedPool?.baseToken.address}
          />
        </div>

        {/* Right: Chart + Recently Launched */}
        <div className="flex-1 min-w-0 flex flex-col gap-4 w-full">
          <TokenChart pool={selectedPool} />
          <RecentlyLaunched chainId={network.id} onSelect={handleSelect} />
        </div>
      </div>
    </div>
  );
}
