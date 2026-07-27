import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useHydeLaunches } from "../hooks/useDopplerTokens";
import type { DopplerPool } from "../utils/dopplerConfig";
import { LaunchTokenForm } from "../components/LaunchTokenForm";

const ROBINHOOD_CHAIN_ID = 4663;

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

const CHAIN_LABELS: Record<number, string> = {
  4663: "Robinhood L2",
};

function PoolCard({ pool, onTrade }: { pool: DopplerPool; onTrade: (addr: string, chainId: number) => void }) {
  const bt = pool.baseToken;
  const chainLabel = CHAIN_LABELS[pool.chainId] ?? `chain ${pool.chainId}`;

  return (
    <article className="trench-pool-card group">
      <div className="pool-card-current" aria-hidden="true" />

      <div className="relative flex items-center gap-3">
        <div className="pool-token-mark">{bt.symbol.slice(0, 2).toUpperCase()}</div>
        <div className="min-w-0">
          <p className="truncate font-display font-semibold text-pcs-text">{bt.name}</p>
          <p className="font-code text-[11px] tracking-[0.16em] text-pcs-textDim">${bt.symbol}</p>
        </div>
        <div className="ml-auto flex flex-shrink-0 items-center gap-1.5">
          <span className="depth-chip">{chainLabel}</span>
          <span className={pool.type === "v4" ? "depth-chip depth-chip-live" : "depth-chip depth-chip-safe"}>
            {pool.type}
          </span>
        </div>
      </div>

      <div className="relative grid grid-cols-2 gap-2 text-xs">
        <div className="pool-stat">
          <p className="pool-stat-label">Liquidity</p>
          <p className="font-code font-semibold text-pcs-text">{fmtLiquidity(pool.dollarLiquidity)}</p>
        </div>
        <div className="pool-stat">
          <p className="pool-stat-label">Volume</p>
          <p className="font-code font-semibold text-pcs-text">{fmtLiquidity(pool.volumeUsd)}</p>
        </div>
      </div>

      {pool.type !== "v2" && pool.progress !== null && (
        <div className="relative">
          <div className="mb-1.5 flex justify-between text-[9px] uppercase tracking-[0.12em] text-pcs-textDim">
            <span>Curve depth</span>
            <span>{pool.progress < 1 && pool.progress > 0 ? "<1" : Math.round(pool.progress)}%</span>
          </div>
          <div className="curve-track">
            <div
              className="curve-fill"
              style={{ width: `${Math.max(pool.progress, pool.progress > 0 ? 2 : 0)}%` }}
            />
          </div>
        </div>
      )}

      <div className="relative flex items-center justify-between">
        <span className="text-xs text-pcs-textDim">{timeAgo(pool.createdAt)}</span>
        <button onClick={() => onTrade(bt.address, pool.chainId)} className="pool-trade-button">
          Enter market <span aria-hidden="true">↗</span>
        </button>
      </div>
    </article>
  );
}

export function LaunchpadPage() {
  const [tab, setTab] = useState<"explore" | "launch">("launch");
  const { pools, loading, refetch } = useHydeLaunches();
  const navigate = useNavigate();
  const totalLiquidity = useMemo(
    () => pools.reduce((sum, pool) => sum + (Number(pool.dollarLiquidity) || 0), 0),
    [pools],
  );

  const handleTrade = (tokenAddress: string, chainId: number) => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(tokenAddress)) return;
    if (chainId !== ROBINHOOD_CHAIN_ID) return;
    navigate(`/swap?out=${tokenAddress}`);
  };

  return (
    <div className="launchpad-shell mx-auto w-full max-w-7xl px-4">
      <section className="trench-hero">
        <div className="trench-grid" aria-hidden="true" />
        <div className="trench-bubbles" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
        </div>

        <div className="relative z-10 max-w-2xl">
          <div className="protocol-kicker">
            <span className="live-ping" />
            Hydeout protocol · depth 4,663
          </div>
          <h1 className="mt-5 font-display text-4xl font-semibold leading-[0.98] tracking-[-0.04em] text-pcs-text sm:text-5xl lg:text-6xl">
            Launch from
            <span className="block trench-title-accent">the deep.</span>
          </h1>
          <p className="mt-5 max-w-xl text-sm leading-6 text-pcs-textSub sm:text-base">
            Build quietly. Surface with impact. Launch a token on Robinhood Chain and earn fees from its first trade.
          </p>
          <div className="mt-7 flex flex-wrap gap-2">
            <span className="hero-proof"><strong>1B</strong> fair-curve supply</span>
            <span className="hero-proof"><strong>95%</strong> creator fees</span>
            <span className="hero-proof"><strong>0%</strong> Hydeout fee</span>
          </div>
        </div>

        <div className="trench-guardian" aria-hidden="true">
          <div className="sonar-ring sonar-ring-one" />
          <div className="sonar-ring sonar-ring-two" />
          <div className="sonar-ring sonar-ring-three" />
          <img src="/logo/lo.png" alt="" />
          <div className="guardian-readout">
            <span>Signal</span>
            <strong>Protected</strong>
          </div>
        </div>
      </section>

      <div className="launchpad-commandbar">
        <div>
          <p className="commandbar-label">Choose your route</p>
          <p className="text-sm text-pcs-textSub">
            Deploy a new asset or scan launches already moving through the current.
          </p>
        </div>
        <div className="launch-tabs" role="tablist" aria-label="Launchpad views">
          {(["launch", "explore"] as const).map((nextTab) => (
            <button
              key={nextTab}
              onClick={() => setTab(nextTab)}
              className={`launch-tab ${tab === nextTab ? "launch-tab-active" : ""}`}
              role="tab"
              aria-selected={tab === nextTab}
            >
              <span className="launch-tab-icon" aria-hidden="true">{nextTab === "launch" ? "↓" : "⌁"}</span>
              {nextTab === "explore" ? "Scan launches" : "Enter the trench"}
            </button>
          ))}
        </div>
      </div>

      {tab === "explore" && (
        <section className="explore-current">
          <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="commandbar-label">Live current</p>
              <h2 className="mt-1 font-display text-2xl font-semibold text-pcs-text">Signals from below</h2>
              <p className="mt-1 text-sm text-pcs-textDim">
                {loading
                  ? "Sounding the network…"
                  : `${pools.length} token${pools.length !== 1 ? "s" : ""} · ${fmtLiquidity(String(totalLiquidity))} visible liquidity`}
              </p>
            </div>
            <button onClick={refetch} className="sonar-refresh" disabled={loading}>
              <span className={loading ? "refresh-orbit refresh-orbit-active" : "refresh-orbit"} aria-hidden="true" />
              {loading ? "Scanning…" : "Run sonar"}
            </button>
          </div>

          {!loading && pools.length === 0 && (
            <div className="empty-trench">
              <div className="empty-sonar" aria-hidden="true"><span /></div>
              <p className="font-display text-lg font-semibold text-pcs-text">The trench is quiet.</p>
              <p className="mt-1 text-sm text-pcs-textDim">
                No launches surfaced yet. Yours can be the first signal.
              </p>
              <button onClick={() => setTab("launch")} className="btn-primary mt-5 px-5 py-2 text-sm">
                Enter the trench
              </button>
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {pools.map((pool) => (
              <PoolCard
                key={`${pool.chainId}-${pool.address}-${pool.baseToken.address}`}
                pool={pool}
                onTrade={handleTrade}
              />
            ))}
          </div>
        </section>
      )}

      {tab === "launch" && <LaunchTokenForm />}
    </div>
  );
}
