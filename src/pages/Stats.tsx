import { FARM_CONFIGS, POOL_CONFIGS } from "../utils/farmConfig";

/* ── helpers ──────────────────────────────────────────────────────────────── */
// Derive total TVL from farm + pool configs (placeholder numeric parse)
function parseTvl(s: string): number {
  const n = parseFloat(s.replace(/[$,KMB]/g, ""));
  if (s.includes("B")) return n * 1e9;
  if (s.includes("M")) return n * 1e6;
  if (s.includes("K")) return n * 1e3;
  return n;
}

function fmtTvl(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

const farmTvlTotal  = FARM_CONFIGS.reduce((s, f) => s + parseTvl(f.tvl), 0);
// Pool TVL placeholder: fixed amounts mapped from totalStaked strings
const poolTvlTotal  = 850 * 2400 + 620 * 2400 + 12_400_000 * 0.05; // rough ETH price placeholder

const totalTvl      = farmTvlTotal + poolTvlTotal;
const vol24h        = totalTvl * 0.04;   // ~4% of TVL as 24h volume (typical DEX placeholder)
const fees24h       = vol24h * 0.003;    // 0.3% fee tier
const activeFarms   = FARM_CONFIGS.length;
const activePools   = POOL_CONFIGS.length;

/* ── overview card ────────────────────────────────────────────────────────── */
function StatCard({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <div className="rounded-2xl p-4" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(0,212,255,0.08)" }}>
      <p className="text-[11px] font-semibold uppercase tracking-widest text-pcs-textDim mb-1">{label}</p>
      <p className={`text-2xl font-bold ${accent ?? "text-pcs-text"}`}>{value}</p>
      {sub && <p className="mt-0.5 text-[11px] text-pcs-textDim">{sub}</p>}
    </div>
  );
}

/* ── small badge ──────────────────────────────────────────────────────────── */
function ApiBadge({ label }: { label: string }) {
  return (
    <span className="ml-2 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-pcs-textDim" style={{ background: "rgba(0,212,255,0.06)", border: "1px solid rgba(0,212,255,0.1)" }}>
      {label}
    </span>
  );
}

/* ══════════════════════════════════════════════════════════════════════════ */
export function StatsPage() {
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
          Protocol overview — placeholder data, live values once contracts deploy
          <ApiBadge label="Testnet" />
        </p>
      </div>

      {/* ── overview cards ──────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <StatCard label="Total TVL"     value={fmtTvl(totalTvl)}  sub="Farms + Pools"    accent="text-pcs-text" />
        <StatCard label="Farm TVL"      value={fmtTvl(farmTvlTotal)} sub={`${activeFarms} active farms`} />
        <StatCard label="Pool TVL"      value={fmtTvl(poolTvlTotal)} sub={`${activePools} active pools`} />
        <StatCard label="24h Volume"    value={fmtTvl(vol24h)}    sub="Estimated"       accent="text-pcs-primary" />
        <StatCard label="24h Fees"      value={fmtTvl(fees24h)}   sub="0.3% avg fee"    accent="text-green-400" />
      </div>

      {/* ── farms table ─────────────────────────────────────────────────── */}
      <div>
        <h2 className="mb-3 text-sm font-bold text-pcs-text">
          Farms
          <ApiBadge label="Live when deployed" />
        </h2>
        <div className="rounded-2xl overflow-hidden" style={tableBg}>
          <table className="w-full border-collapse">
            <thead>
              <tr style={rowBorder}>
                <th className={`${thCls} pl-5`}>#</th>
                <th className={thCls}>Farm</th>
                <th className={thCls}>Fee</th>
                <th className={thCls}>Multiplier</th>
                <th className={thCls}>TVL</th>
                <th className={thCls}>APR</th>
                <th className={`${thCls} pr-5`}>Est. 24h Fees</th>
              </tr>
            </thead>
            <tbody>
              {FARM_CONFIGS.map((farm, i) => {
                const tvlNum   = parseTvl(farm.tvl);
                const dayFees  = fmtTvl(tvlNum * 0.04 * 0.003);
                return (
                  <tr key={farm.pid} className="hover:bg-white/[0.015] transition" style={i < FARM_CONFIGS.length - 1 ? rowBorder : undefined}>
                    <td className={`${tdCls} pl-5 text-pcs-textDim`}>{i + 1}</td>
                    <td className={tdCls}>
                      <div className="flex items-center gap-2">
                        <div className="relative flex shrink-0">
                          <img src={farm.tokenALogo} alt={farm.tokenASymbol} className="h-6 w-6 rounded-full ring-1 ring-pcs-bg" onError={e => { (e.target as HTMLImageElement).style.display = "none"; }} />
                          <img src={farm.tokenBLogo} alt={farm.tokenBSymbol} className="h-6 w-6 rounded-full ring-1 ring-pcs-bg -ml-1.5" onError={e => { (e.target as HTMLImageElement).style.display = "none"; }} />
                        </div>
                        <span className="font-semibold text-pcs-text">{farm.tokenASymbol}/{farm.tokenBSymbol}</span>
                      </div>
                    </td>
                    <td className={`${tdCls} text-pcs-textDim`}>{farm.feeTier}</td>
                    <td className={tdCls}>
                      <span className="rounded px-1.5 py-0.5 text-[11px] font-bold text-pcs-primary" style={{ background: "rgba(0,212,255,0.1)" }}>{farm.multiplier}</span>
                    </td>
                    <td className={`${tdCls} font-semibold text-pcs-text`}>{farm.tvl}</td>
                    <td className={`${tdCls} font-bold text-green-400`}>{farm.apr.toFixed(1)}%</td>
                    <td className={`${tdCls} pr-5 text-pcs-textDim`}>{dayFees}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: "1px solid rgba(0,212,255,0.07)" }}>
                <td colSpan={4} className={`${tdCls} pl-5 text-xs font-semibold text-pcs-textDim`}>Total</td>
                <td className={`${tdCls} font-bold text-pcs-text`}>{fmtTvl(farmTvlTotal)}</td>
                <td />
                <td className={`${tdCls} pr-5 font-semibold text-pcs-textDim`}>{fmtTvl(farmTvlTotal * 0.04 * 0.003)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* ── pools table ─────────────────────────────────────────────────── */}
      <div>
        <h2 className="mb-3 text-sm font-bold text-pcs-text">
          Pools
          <ApiBadge label="Live when deployed" />
        </h2>
        <div className="rounded-2xl overflow-hidden" style={tableBg}>
          <table className="w-full border-collapse">
            <thead>
              <tr style={rowBorder}>
                <th className={`${thCls} pl-5`}>#</th>
                <th className={thCls}>Pool</th>
                <th className={thCls}>Reward</th>
                <th className={thCls}>Total Staked</th>
                <th className={thCls}>APR</th>
                <th className={`${thCls} pr-5`}>Type</th>
              </tr>
            </thead>
            <tbody>
              {POOL_CONFIGS.map((pool, i) => (
                <tr key={pool.id} className="hover:bg-white/[0.015] transition" style={i < POOL_CONFIGS.length - 1 ? rowBorder : undefined}>
                  <td className={`${tdCls} pl-5 text-pcs-textDim`}>{i + 1}</td>
                  <td className={tdCls}>
                    <div className="flex items-center gap-2">
                      <div className="relative shrink-0">
                        <img src={pool.stakedLogo} alt={pool.stakedSymbol} className="h-6 w-6 rounded-full ring-1 ring-pcs-bg object-contain" onError={e => { (e.target as HTMLImageElement).style.display = "none"; }} />
                        <img src={pool.rewardLogo} alt={pool.rewardSymbol} className="h-3.5 w-3.5 rounded-full ring-1 ring-pcs-bg object-contain absolute -bottom-0.5 -right-0.5" onError={e => { (e.target as HTMLImageElement).style.display = "none"; }} />
                      </div>
                      <span className="font-semibold text-pcs-text">Stake {pool.stakedSymbol}</span>
                    </div>
                  </td>
                  <td className={`${tdCls} text-pcs-textDim`}>{pool.rewardSymbol}</td>
                  <td className={`${tdCls} font-semibold text-pcs-text`}>{pool.totalStaked}</td>
                  <td className={`${tdCls} font-bold text-green-400`}>{pool.apr.toFixed(1)}%</td>
                  <td className={`${tdCls} pr-5`}>
                    {pool.isAutoCompound
                      ? <span className="rounded px-1.5 py-0.5 text-[11px] font-bold text-pcs-primary" style={{ background: "rgba(0,212,255,0.1)" }}>Auto</span>
                      : <span className="rounded px-1.5 py-0.5 text-[11px] font-semibold text-pcs-textDim" style={{ background: "rgba(255,255,255,0.04)" }}>Manual</span>
                    }
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── swap overview ───────────────────────────────────────────────── */}
      <div>
        <h2 className="mb-3 text-sm font-bold text-pcs-text">
          Swap Overview
          <ApiBadge label="Live when deployed" />
        </h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: "Total Pairs",      value: `${FARM_CONFIGS.length}`,    sub: "Active pairs" },
            { label: "Avg Fee Tier",     value: "0.3%",                       sub: "Most common" },
            { label: "Est. Daily Vol",   value: fmtTvl(vol24h),               sub: "Based on TVL", accent: "text-pcs-primary" },
            { label: "Est. Daily Fees",  value: fmtTvl(fees24h),              sub: "Distributed to LPs", accent: "text-green-400" },
          ].map(c => (
            <div key={c.label} className="rounded-2xl p-4" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(0,212,255,0.08)" }}>
              <p className="text-[11px] font-semibold uppercase tracking-widest text-pcs-textDim mb-1">{c.label}</p>
              <p className={`text-xl font-bold ${c.accent ?? "text-pcs-text"}`}>{c.value}</p>
              <p className="mt-0.5 text-[11px] text-pcs-textDim">{c.sub}</p>
            </div>
          ))}
        </div>
      </div>

    </div>
  );
}
