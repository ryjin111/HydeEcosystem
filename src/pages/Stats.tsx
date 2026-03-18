import { useHydeLaunches } from "../hooks/useDopplerTokens";
import type { DopplerPool } from "../utils/dopplerConfig";

/* ── helpers ──────────────────────────────────────────────────────────────── */
function fmtUsd(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  if (n > 0)    return `$${n.toFixed(2)}`;
  return "—";
}

function sumField(pools: DopplerPool[], field: "dollarLiquidity" | "volumeUsd"): number {
  return pools.reduce((acc, p) => acc + parseFloat(p[field] ?? "0"), 0);
}

/* ── overview card ────────────────────────────────────────────────────────── */
function StatCard({
  label, value, sub, accent, loading,
}: {
  label: string; value: string; sub?: string; accent?: string; loading?: boolean;
}) {
  return (
    <div className="rounded-2xl p-4" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(0,212,255,0.08)" }}>
      <p className="text-[11px] font-semibold uppercase tracking-widest text-pcs-textDim mb-1">{label}</p>
      <p className={`text-2xl font-bold ${accent ?? "text-pcs-text"} ${loading ? "opacity-40" : ""}`}>
        {loading ? "…" : value}
      </p>
      {sub && <p className="mt-0.5 text-[11px] text-pcs-textDim">{sub}</p>}
    </div>
  );
}

/* ── coming-soon box ─────────────────────────────────────────────────────── */
function ComingSoon({ icon, label, detail }: { icon: string; label: string; detail: string }) {
  return (
    <div
      className="rounded-2xl p-8 flex flex-col items-center gap-3 text-center"
      style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(0,212,255,0.07)" }}
    >
      <span className="text-2xl">{icon}</span>
      <div>
        <p className="text-sm font-bold text-pcs-text">{label}</p>
        <p className="text-xs text-pcs-textDim mt-0.5 max-w-xs">{detail}</p>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════ */
export function StatsPage() {
  const { pools, loading } = useHydeLaunches();

  const totalLiquidity = sumField(pools, "dollarLiquidity");
  const totalVolume    = sumField(pools, "volumeUsd");
  const inAuction      = pools.filter((p) => p.type !== "v2").length;
  const graduated      = pools.filter((p) => p.type === "v2").length;

  const thCls = "py-2.5 px-4 text-left text-[11px] font-semibold uppercase tracking-wide text-pcs-textDim";
  const tdCls = "py-3 px-4 text-sm";
  const tableBg = { background: "rgba(255,255,255,0.02)", border: "1px solid rgba(0,212,255,0.07)" };
  const rowBorder = { borderBottom: "1px solid rgba(0,212,255,0.05)" };

  return (
    <div className="w-full max-w-6xl mx-auto px-4 space-y-8">

      {/* ── header ──────────────────────────────────────────────────────── */}
      <div>
        <h1 className="text-2xl font-bold text-pcs-text">Stats</h1>
        <p className="mt-1 text-xs text-pcs-textDim">
          Live protocol data from the Doppler indexer · Ink Mainnet
        </p>
      </div>

      {/* ── overview cards ──────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="Total Launches"  value={String(pools.length)}       sub="All time"           loading={loading} />
        <StatCard label="Total Liquidity" value={fmtUsd(totalLiquidity)}     sub="Active pools"       accent="text-pcs-text"    loading={loading} />
        <StatCard label="Total Volume"    value={fmtUsd(totalVolume)}        sub="All pools"          accent="text-pcs-primary" loading={loading} />
        <StatCard label="Graduated"       value={`${graduated} / ${pools.length}`} sub="Migrated to V2" accent="text-green-400"  loading={loading} />
      </div>

      {/* ── token table ─────────────────────────────────────────────────── */}
      <div>
        <h2 className="mb-3 text-sm font-bold text-pcs-text">
          Doppler Launches · Ink Mainnet
        </h2>
        <div className="rounded-2xl overflow-hidden" style={tableBg}>
          {loading ? (
            <p className="py-8 text-center text-xs text-pcs-textDim">Loading…</p>
          ) : pools.length === 0 ? (
            <p className="py-8 text-center text-xs text-pcs-textDim">No launches found.</p>
          ) : (
            <table className="w-full border-collapse">
              <thead>
                <tr style={rowBorder}>
                  <th className={`${thCls} pl-5`}>#</th>
                  <th className={thCls}>Token</th>
                  <th className={thCls}>Type</th>
                  <th className={thCls}>Liquidity</th>
                  <th className={`${thCls} pr-5`}>Volume</th>
                </tr>
              </thead>
              <tbody>
                {pools.map((pool, i) => (
                  <tr
                    key={pool.address}
                    className="hover:bg-white/[0.015] transition"
                    style={i < pools.length - 1 ? rowBorder : undefined}
                  >
                    <td className={`${tdCls} pl-5 text-pcs-textDim`}>{i + 1}</td>
                    <td className={tdCls}>
                      <div className="flex items-center gap-2">
                        <div
                          className="h-6 w-6 rounded-full flex items-center justify-center text-[10px] font-bold flex-shrink-0"
                          style={{ background: "rgba(0,212,255,0.12)", color: "#00d4ff" }}
                        >
                          {pool.baseToken.symbol.slice(0, 2).toUpperCase()}
                        </div>
                        <div>
                          <span className="font-semibold text-pcs-text">{pool.baseToken.name}</span>
                          <span className="ml-1.5 text-pcs-textDim text-xs">{pool.baseToken.symbol}</span>
                        </div>
                      </div>
                    </td>
                    <td className={tdCls}>
                      <span
                        className="rounded px-1.5 py-0.5 text-[11px] font-bold uppercase"
                        style={
                          pool.type === "v2"
                            ? { background: "rgba(0,212,255,0.10)", color: "#00d4ff" }
                            : { background: "rgba(168,85,247,0.15)", color: "#a855f7" }
                        }
                      >
                        {pool.type === "v2" ? "Graduated" : "Auction"}
                      </span>
                    </td>
                    <td className={`${tdCls} font-semibold text-pcs-text`}>
                      {fmtUsd(parseFloat(pool.dollarLiquidity ?? "0"))}
                    </td>
                    <td className={`${tdCls} pr-5 text-pcs-textDim`}>
                      {fmtUsd(parseFloat(pool.volumeUsd ?? "0"))}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: "1px solid rgba(0,212,255,0.07)" }}>
                  <td colSpan={3} className={`${tdCls} pl-5 text-xs font-semibold text-pcs-textDim`}>
                    Total ({pools.length} launches · {inAuction} in auction)
                  </td>
                  <td className={`${tdCls} font-bold text-pcs-text`}>{fmtUsd(totalLiquidity)}</td>
                  <td className={`${tdCls} pr-5 font-semibold text-pcs-textDim`}>{fmtUsd(totalVolume)}</td>
                </tr>
              </tfoot>
            </table>
          )}
        </div>
      </div>

      {/* ── coming soon sections ─────────────────────────────────────────── */}
      <div>
        <h2 className="mb-3 text-sm font-bold text-pcs-text">Upcoming</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <ComingSoon
            icon="🌱"
            label="Farms"
            detail="HYDE farming rewards — TVL and APR data will appear here when MasterChef deploys."
          />
          <ComingSoon
            icon="💧"
            label="Pools"
            detail="Single-asset HYDE staking — staking stats will appear here when staking contracts deploy."
          />
        </div>
      </div>

    </div>
  );
}
