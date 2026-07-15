import { useNavigate, useSearchParams } from "react-router-dom";
import { useHydeLaunches } from "../hooks/useDopplerTokens";
import type { DopplerPool } from "../utils/dopplerConfig";
import { LaunchTokenForm } from "../components/LaunchTokenForm";

const ROBINHOOD_CHAIN_ID = 4663;

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
  4663: "Robinhood Chain",
};

export function PoolCard({ pool, onTrade }: { pool: DopplerPool; onTrade: (addr: string, chainId: number) => void }) {
  const bt = pool.baseToken;
  const chainLabel = CHAIN_LABELS[pool.chainId] ?? `chain ${pool.chainId}`;
  return (
    <div
      className="rounded-2xl p-4 flex flex-col gap-3 border transition hover:border-pcs-primary/40"
      style={{ background: "#121419", borderColor: "#22252D" }}
    >
      {/* Token identity */}
      <div className="flex items-center gap-3">
        <div
          className="h-10 w-10 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0"
          style={{ background: "rgba(46,159,230,0.14)", color: "#54B4F0" }}
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
              background: pool.type === "v4" ? "rgba(46,159,230,0.14)" : "rgba(52,199,123,0.12)",
              color: pool.type === "v4" ? "#54B4F0" : "#34C77B",
            }}
          >
            {pool.type}
          </span>
        </div>
      </div>

      {/* Stats — render only fields with real data. The current rail returns null for both, so the
          dead "—" rows are hidden entirely (honesty bar); they return when the data layer repoints. */}
      {(pool.dollarLiquidity != null || pool.volumeUsd != null) && (
        <div className="grid grid-cols-2 gap-2 text-xs">
          {pool.dollarLiquidity != null && (
            <div className="rounded-xl px-3 py-2" style={{ background: "rgba(255,255,255,0.03)" }}>
              <p className="text-pcs-textDim mb-0.5">Liquidity</p>
              <p className="font-semibold text-pcs-text">{fmtLiquidity(pool.dollarLiquidity)}</p>
            </div>
          )}
          {pool.volumeUsd != null && (
            <div className="rounded-xl px-3 py-2" style={{ background: "rgba(255,255,255,0.03)" }}>
              <p className="text-pcs-textDim mb-0.5">Volume</p>
              <p className="font-semibold text-pcs-text">{fmtLiquidity(pool.volumeUsd)}</p>
            </div>
          )}
        </div>
      )}

      {/* Curve progress — real % of the launch inventory sold, on-chain */}
      {pool.type !== "v2" && pool.progress !== null && (
        <div>
          <div className="flex justify-between text-[9px] text-pcs-textDim mb-1">
            <span>Curve sold</span>
            <span>{pool.progress < 1 && pool.progress > 0 ? "<1" : Math.round(pool.progress)}%</span>
          </div>
          <div className="h-1 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.06)" }}>
            <div
              className="h-full rounded-full"
              style={{ width: `${Math.max(pool.progress, pool.progress > 0 ? 2 : 0)}%`, background: "#2E9FE6" }}
            />
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-pcs-textDim">{timeAgo(pool.createdAt)}</span>
        <button
          onClick={() => onTrade(bt.address, pool.chainId)}
          className="text-xs font-semibold px-3 py-1.5 rounded-lg transition"
          style={{ background: "rgba(46,159,230,0.12)", color: "#54B4F0" }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(46,159,230,0.20)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "rgba(46,159,230,0.12)")}
        >
          Trade →
        </button>
      </div>
    </div>
  );
}

/* ─── Page ────────────────────────────────────────────────────────────────── */

export function LaunchpadPage() {
  // Tab is URL-driven (?tab=launch|explore) so the sidebar "Launch a Token" reliably lands on the
  // form even when the user is already on /launchpad viewing Explore. Default = launch.
  const [searchParams, setSearchParams] = useSearchParams();
  const tab: "explore" | "launch" = searchParams.get("tab") === "explore" ? "explore" : "launch";
  const setTab = (t: "explore" | "launch") => setSearchParams({ tab: t });
  const { pools, loading, refetch } = useHydeLaunches();
  const navigate = useNavigate();

  const handleTrade = (tokenAddress: string, chainId: number) => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(tokenAddress)) return;
    // All Hyde launches are on Robinhood Chain (4663) — gate anything else
    if (chainId !== ROBINHOOD_CHAIN_ID) return;
    navigate(`/swap?out=${tokenAddress}`);
  };

  return (
    <div className="max-w-6xl mx-auto px-4 w-full">
      {/* Header */}
      <div className="mb-8">
        <h1 className="font-display text-2xl font-semibold text-pcs-text">Launchpad</h1>
        <p className="text-sm text-pcs-textSub mt-1">
          Live token launches on Robinhood Chain — Hyde own-stack launching soon.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 p-1 rounded-xl w-fit" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid #1C1F26" }}>
        {(["launch", "explore"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className="px-5 py-2 rounded-lg text-sm font-semibold transition"
            style={
              tab === t
                ? { background: "rgba(46,159,230,0.14)", color: "#54B4F0" }
                : { color: "#5D6470" }
            }
          >
            {t === "explore" ? "Explore Launches" : "Launch a Token"}
          </button>
        ))}
      </div>

      {/* Explore tab */}
      {tab === "explore" && (
        <div>
          {/* Provenance lives in the page subtitle above (honest rail note); no fee split is stated for
              the live Doppler-rail tokens — the 90/5-locked story is future-tense on the Landing only. */}
          <div className="flex items-center justify-between mb-4">
            <p className="text-sm text-pcs-textDim">
              {loading ? "Loading…" : `${pools.length} token${pools.length !== 1 ? "s" : ""} launched on Robinhood Chain`}
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
              style={{ background: "#121419", border: "1px solid #22252D" }}
            >
              <p className="text-pcs-textDim text-sm">No launches found yet.</p>
              <p className="text-pcs-textDim text-xs mt-1">
                Be the first to launch a token on Robinhood Chain!
              </p>
              <button
                onClick={() => setTab("launch")}
                className="btn-primary mt-4 px-5 py-2 text-sm"
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
      {tab === "launch" && <LaunchTokenForm />}
    </div>
  );
}
