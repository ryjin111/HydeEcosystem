import { useNavigate, useSearchParams } from "react-router-dom";
import { useHydeLaunches } from "../hooks/useDopplerTokens";
import type { DopplerPool } from "../utils/dopplerConfig";
import { LaunchTokenForm } from "../components/LaunchTokenForm";

const ROBINHOOD_CHAIN_ID = 4663;

/* ─── helpers ─────────────────────────────────────────────────────────────── */

/** Compact USD — only ever called with a real number (tiles that lack data aren't rendered). */
function fmtUsd(n: number): string {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toPrecision(2)}`; // sub-$1 curve prices keep significant digits
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

/** Bigger launch card (clint 21605): the token NAME + $TICKER read in full (no more "A…" crush),
 *  with MCAP shown large. The per-card "ROBINHOOD CHAIN" pill is dropped — every launch is on the
 *  same chain (stated in the page/footer), and repeating it was what squeezed the name column.
 *  Metrics are honesty-gated: MCAP/Liquidity render ONLY when the DEXScreener pair is real
 *  (graduated + indexed); curve-stage tokens show the on-chain curve % instead — never a fake $. */
export function PoolCard({ pool, onTrade }: { pool: DopplerPool; onTrade: (addr: string, chainId: number) => void }) {
  const bt = pool.baseToken;
  const chainLabel = CHAIN_LABELS[pool.chainId] ?? `chain ${pool.chainId}`;
  const graduated = pool.type === "v2";
  const liq = pool.dollarLiquidity != null ? parseFloat(pool.dollarLiquidity) : null;
  const vol = pool.volumeUsd != null ? parseFloat(pool.volumeUsd) : null;
  const hasMcap = pool.marketCapUsd != null && pool.marketCapUsd > 0;
  const hasLiq = liq != null && liq > 0;
  const hasVol = vol != null && vol > 0;
  // A DEXScreener pair exists (real seed mcap) but no trades yet — the clustered pre-trade
  // seed caps get a "new" marker so identical-looking values don't read as a placeholder (shiro).
  const untraded = hasMcap && !hasVol;

  return (
    <div
      className="rounded-2xl p-5 flex flex-col gap-4 border transition hover:border-pcs-primary/40"
      style={{ background: "#121419", borderColor: "#22252D" }}
    >
      {/* Token identity — name gets the full width; only the status pill sits beside it */}
      <div className="flex items-start gap-3">
        <div
          className="h-12 w-12 rounded-full flex items-center justify-center text-base font-bold flex-shrink-0"
          style={{ background: "rgba(46,159,230,0.14)", color: "#54B4F0" }}
        >
          {bt.symbol.slice(0, 2).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-display text-[15px] font-semibold text-pcs-text truncate leading-tight">{bt.name}</p>
          <p className="text-xs text-pcs-textDim mt-0.5">${bt.symbol}</p>
        </div>
        <span
          className="text-[10px] font-semibold px-2 py-0.5 rounded-full uppercase tracking-wide flex-shrink-0"
          style={{
            background: graduated ? "rgba(52,199,123,0.12)" : "rgba(46,159,230,0.14)",
            color: graduated ? "#34C77B" : "#54B4F0",
          }}
        >
          {graduated ? "Graduated" : "Live"}
        </span>
      </div>

      {/* Market metrics — ALWAYS rendered so every card has the same silhouette (shiro: no empty
          gaps). All $ values are real, sourced from the DEXScreener pair; never fabricated. */}
      {hasMcap ? (
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-xl px-3 py-2.5" style={{ background: "rgba(255,255,255,0.03)" }}>
            <p className="text-[10px] uppercase tracking-wide text-pcs-textDim mb-0.5">Market cap</p>
            <p className="text-base font-semibold text-pcs-text tabular-nums">
              {fmtUsd(pool.marketCapUsd as number)}
              {untraded && <span className="ml-1.5 text-[10px] font-medium text-pcs-textDim uppercase tracking-wide">· new</span>}
            </p>
          </div>
          <div className="rounded-xl px-3 py-2.5" style={{ background: "rgba(255,255,255,0.03)" }}>
            {hasLiq ? (
              <>
                <p className="text-[10px] uppercase tracking-wide text-pcs-textDim mb-0.5">Liquidity</p>
                <p className="text-base font-semibold text-pcs-text tabular-nums">{fmtUsd(liq as number)}</p>
              </>
            ) : (
              <>
                <p className="text-[10px] uppercase tracking-wide text-pcs-textDim mb-0.5">24h volume</p>
                <p className="text-base font-semibold text-pcs-text tabular-nums">
                  {hasVol ? fmtUsd(vol as number) : <span className="text-pcs-textDim font-medium">No trades yet</span>}
                </p>
              </>
            )}
          </div>
        </div>
      ) : (
        // No DEXScreener pair yet (brand-new / not indexed). Honest fallback, same height as the
        // grid above so the card silhouette stays consistent — not a fabricated number.
        <div className="rounded-xl px-3 py-2.5" style={{ background: "rgba(255,255,255,0.03)" }}>
          <p className="text-[10px] uppercase tracking-wide text-pcs-textDim mb-0.5">Market cap</p>
          <p className="text-sm font-medium text-pcs-textDim">New launch · not yet indexed</p>
        </div>
      )}

      {/* Curve progress — real % of the launch inventory BOUGHT, on-chain. "Bought" reads clearer than
          "sold" (it's buyers pulling tokens off the curve); the tooltip flags it's a live two-way level
          — rises on net buys, dips on net sells — so the breathing isn't a surprise (shiro 21736). */}
      {!graduated && pool.progress !== null && (
        <div title="% of the launch curve bought so far — rises on net buys, dips on net sells (a live level, not a one-way counter)">
          <div className="flex justify-between text-[10px] text-pcs-textDim mb-1">
            <span>Curve bought</span>
            <span className="tabular-nums">{pool.progress < 1 && pool.progress > 0 ? "<1" : Math.round(pool.progress)}%</span>
          </div>
          <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.06)" }}>
            <div
              className="h-full rounded-full"
              style={{ width: `${Math.max(pool.progress, pool.progress > 0 ? 2 : 0)}%`, background: "#2E9FE6" }}
            />
          </div>
        </div>
      )}

      {/* Footer — chain lives here (subtle) instead of a per-card pill that crushed the name */}
      <div className="flex items-center justify-between mt-auto">
        <span className="text-xs text-pcs-textDim truncate">{chainLabel} · {timeAgo(pool.createdAt)}</span>
        <button
          onClick={() => onTrade(bt.address, pool.chainId)}
          className="text-xs font-semibold px-4 py-2 rounded-lg transition flex-shrink-0"
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

const RH_TESTNET_ID = 46630;

export function LaunchpadPage({ chainId = ROBINHOOD_CHAIN_ID }: { chainId?: number }) {
  // Tab is URL-driven (?tab=launch|explore) so the sidebar "Launch a Token" reliably lands on the
  // form even when the user is already on /launchpad viewing Explore. Default = launch.
  const [searchParams, setSearchParams] = useSearchParams();
  const tab: "explore" | "launch" = searchParams.get("tab") === "explore" ? "explore" : "launch";
  const setTab = (t: "explore" | "launch") => setSearchParams({ tab: t });
  // Network-aware: on Robinhood Testnet this reads the LIVE own-stack factory; else the Doppler rail.
  const isTestnet = chainId === RH_TESTNET_ID;
  const { pools, loading, refetch } = useHydeLaunches(chainId);
  const navigate = useNavigate();

  const handleTrade = (tokenAddress: string, chainId: number) => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(tokenAddress)) return;
    // All Hyde launches are on Robinhood Chain (4663) — gate anything else
    if (chainId !== ROBINHOOD_CHAIN_ID) return;
    navigate(`/swap?out=${tokenAddress}`);
  };

  return (
    <div className="max-w-6xl mx-auto px-4 w-full">
      {/* Testnet indicator — unmistakable; nothing can read as mainnet/real money (shiro #1). */}
      {isTestnet && (
        <div
          className="mb-4 flex items-center gap-2.5 rounded-xl px-4 py-2.5 text-sm"
          style={{ background: "rgba(224,163,46,0.10)", border: "1px solid rgba(224,163,46,0.35)", color: "#E0A32E" }}
        >
          <span className="text-base">🧪</span>
          <span>
            <span className="font-semibold">TESTNET — Robinhood 46630.</span> The LIVE Hyde own-stack sandbox
            (our own contracts · custody-locked LP). Play money only — no real funds.
          </span>
        </div>
      )}

      {/* Header */}
      <div className="mb-8">
        <h1 className="font-display text-2xl font-semibold text-pcs-text">Launchpad</h1>
        <p className="text-sm text-pcs-textSub mt-1">
          {isTestnet
            ? "Live launches on the Hyde own-stack (Robinhood Testnet) — your factory, your custody-locked liquidity."
            : "Live token launches on Robinhood Chain — Hyde own-stack launching soon."}
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
          <div className="flex items-start justify-between mb-4">
            <div>
              <p className="text-sm text-pcs-textDim">
                {loading
                  ? "Loading…"
                  : `${pools.length} token${pools.length !== 1 ? "s" : ""} launched ${isTestnet ? "on the Hyde own-stack" : "on Robinhood Chain"}`}
              </p>
              {/* Source attribution. Mainnet $ figures are DEXScreener-priced; testnet isn't third-party
                  indexed, so it's pure on-chain reads (curve % live; no fabricated price). */}
              <p className="text-[11px] text-pcs-textDim/70 mt-0.5">
                {isTestnet ? "Live on-chain reads · own-stack factory (not third-party indexed)" : "Market data via DEXScreener"}
              </p>
            </div>
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
