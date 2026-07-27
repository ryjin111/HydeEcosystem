import { useNavigate } from "react-router-dom";
import { useHydeLaunches } from "../hooks/useDopplerTokens";
import { chainEngineCapabilities, ENGINE_META } from "../utils/chainRegistry";

const ROBINHOOD_CHAIN_ID = 4663;

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="sonar-metric rounded-2xl p-4" style={{ background: "#121419", border: "1px solid #22252D" }}>
      <p className="text-xs text-pcs-textDim">{label}</p>
      <p className="mt-1.5 font-display text-3xl font-bold text-pcs-text tabular-nums">{value}</p>
      <p className="mt-2 text-[11px] leading-relaxed text-pcs-textDim">{detail}</p>
    </div>
  );
}

function timeAgo(iso: string): string {
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "block time unavailable";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function StatsPage({ chainId = ROBINHOOD_CHAIN_ID }: { chainId?: number }) {
  if (chainId !== ROBINHOOD_CHAIN_ID) {
    const capability = chainEngineCapabilities(chainId)[0];
    const meta = capability ? ENGINE_META[capability.engine] : null;
    return (
      <div className="hyde-page hyde-stats mx-auto w-full max-w-6xl px-4" data-depth-label="Protocol sonar · live reads">
        <h1 className="font-display text-2xl font-semibold text-pcs-text">Hydeout Stats</h1>
        <div className="mt-4 rounded-2xl p-6 text-center" style={{ background: "#121419", border: "1px solid #22252D" }}>
          <p className="text-sm font-semibold text-pcs-text">{meta?.title ?? "Unsupported launch route"}</p>
          <p className="mt-2 text-sm text-pcs-textSub">
            {meta
              ? `${meta.feeSplitLabel}. Chain-scoped launch statistics will appear when its indexed event reader is live.`
              : "This chain has no configured Hydeout launcher."}
          </p>
        </div>
      </div>
    );
  }

  return <MainnetStats />;
}

function MainnetStats() {
  const navigate = useNavigate();
  const { pools, loading, error, refetch } = useHydeLaunches(ROBINHOOD_CHAIN_ID);
  const wethPaired = pools.filter((p) => p.quoteToken.symbol.toUpperCase() === "WETH").length;
  const hoodiePaired = pools.filter((p) => p.quoteToken.symbol.toUpperCase() === "HOODIE").length;
  const v4Launches = pools.filter((p) => p.launchEngine === "v4-hook").length;

  return (
    <div className="hyde-page hyde-stats mx-auto w-full max-w-6xl px-4" data-depth-label="Protocol sonar · live reads">
      <div className="mb-5">
        <h1 className="font-display text-2xl font-semibold text-pcs-text">Hydeout Stats</h1>
        <p className="mt-1 text-sm text-pcs-textSub">
          Live own-stack launch activity on Robinhood Chain. Doppler tokens are excluded.
        </p>
      </div>

      <div className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-pcs-textDim">
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: "#34C77B" }} />
        Live · WETH factory + HOODIE engine
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric
          label="Tracked own-stack launches"
          value={loading || error ? "—" : pools.length.toLocaleString("en-US")}
          detail="Recent on-chain launch events loaded from Hydeout's two production stacks."
        />
        <Metric
          label="V4 hook launches"
          value={loading || error ? "—" : v4Launches.toLocaleString("en-US")}
          detail="90% creator · 5% Hyde · 5% auto-compounding locked LP."
        />
        <Metric
          label="WETH-paired V4"
          value={loading || error ? "—" : wethPaired.toLocaleString("en-US")}
          detail="V4 launches paired against wrapped ETH."
        />
        <Metric
          label="HOODIE-paired V4"
          value={loading || error ? "—" : hoodiePaired.toLocaleString("en-US")}
          detail="V4 launches paired against the HOODIE numeraire."
        />
      </div>

      <div className="mb-3 mt-7 flex items-center justify-between">
        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-pcs-textDim">Recent own-stack launches</h2>
        <p className="text-[11px] text-pcs-textDim">on-chain events · newest first</p>
      </div>

      <div className="overflow-hidden rounded-2xl" style={{ background: "#121419", border: "1px solid #22252D" }}>
        {error ? (
          <div className="px-4 py-8 text-center">
            <p className="text-sm font-medium text-pcs-textSub">Stats data is temporarily unavailable.</p>
            <p className="mt-1 text-xs text-pcs-textDim">No launch totals are shown until the indexed source responds.</p>
            <button type="button" onClick={refetch} className="mt-4 rounded-md border border-pcs-border px-3 py-1.5 text-xs font-semibold text-pcs-primary">
              Retry
            </button>
          </div>
        ) : loading ? (
          <div className="px-4 py-8 text-center text-sm text-pcs-textDim">Loading on-chain launches…</div>
        ) : pools.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <p className="text-sm font-medium text-pcs-textSub">No own-stack launches yet.</p>
            <p className="mt-1 text-xs text-pcs-textDim">The first WETH or HOODIE launch will appear here from its on-chain event.</p>
          </div>
        ) : (
          pools.map((pool, index) => (
            <button
              key={`${pool.chainId}-${pool.address}`}
              onClick={() => navigate(`/token/${pool.address}`)}
              className="grid w-full grid-cols-[1fr_92px_96px] items-center gap-3 px-4 py-3 text-left transition hover:bg-white/[0.03]"
              style={{ borderBottom: index < pools.length - 1 ? "1px solid #16191F" : "none" }}
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-pcs-text">{pool.baseToken.name}</span>
                <span className="block truncate font-mono text-[11px] text-pcs-textDim">${pool.baseToken.symbol}</span>
              </span>
              <span className="text-right text-[11px] font-semibold text-pcs-textSub">
                {ENGINE_META[pool.launchEngine].title.split(" · ")[0]} · /{pool.quoteToken.symbol}
              </span>
              <span className="text-right text-xs text-pcs-textDim">{timeAgo(pool.createdAt)}</span>
            </button>
          ))
        )}
      </div>

      <p className="mt-6 text-[11px] leading-relaxed text-pcs-textDim">
        Only metrics directly supported by the current own-stack event reader are shown. Creator payouts,
        V4 auto-compounded LP, protocol revenue, and all-time volume remain hidden until dedicated on-chain
        aggregators are deployed; this page does not estimate them.
      </p>
    </div>
  );
}

export default StatsPage;
