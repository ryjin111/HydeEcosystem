import { useNavigate } from "react-router-dom";
import { useHydeLaunches, useHydeStats } from "../hooks/useDopplerTokens";
import type { DopplerPool } from "../utils/dopplerConfig";

/* Hydeout Stats — on-chain transparency (shiro mock 21675 · casper honesty rules).
 * Every $ / count is a REAL fetch or an honest "indexing" / "AT DEPLOY" state — NEVER a placeholder.
 * Two zones: LIVE NOW (real on-chain reads) + own-stack ("activates at deploy", never a number). */

const ROBINHOOD_CHAIN_ID = 4663;

function fmtInt(n: number): string {
  return n.toLocaleString("en-US");
}
function fmtUsd(n: number): string {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}
function ago(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

/* ── small building blocks ────────────────────────────────────────────────── */

function Tile({ label, sub, subTone, children }: { label: React.ReactNode; sub: React.ReactNode; subTone: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl p-5" style={{ background: "#121419", border: "1px solid #22252D" }}>
      <p className="text-xs text-pcs-textDim">{label}</p>
      <div className="mt-2 mb-2">{children}</div>
      <p className="text-[11px] leading-relaxed" style={{ color: subTone }}>{sub}</p>
    </div>
  );
}

function AtDeployCard({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="rounded-2xl p-5" style={{ background: "#101216", border: "1px solid #1C1F26" }}>
      <p className="text-sm font-medium text-pcs-text">{title}</p>
      <span
        className="mt-3 inline-block rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide"
        style={{ background: "rgba(224,163,46,0.14)", color: "#E0A32E", border: "1px solid rgba(224,163,46,0.3)" }}
      >
        At deploy
      </span>
      <p className="mt-2 text-[11px] leading-relaxed text-pcs-textDim">{detail}</p>
    </div>
  );
}

/* ── page ─────────────────────────────────────────────────────────────────── */

export function StatsPage() {
  const { pools } = useHydeLaunches();
  const { totalLaunched, updatedAt, loading: statsLoading } = useHydeStats();
  const navigate = useNavigate();

  // Zone-1 real reads from the loaded (tracked) board set — N is DYNAMIC, never hardcoded.
  const trackedN = pools.length;
  const trackedVol = pools.reduce((sum, p) => sum + (p.volumeUsd != null ? parseFloat(p.volumeUsd) : 0), 0);

  // Trending: rank the in-view set by real curve % (not all-time). Collapse by ticker so the same
  // symbol never shows twice — a permissionless launchpad has many distinct tokens sharing a ticker
  // (e.g. two different "$IT5" at different addresses); the top-list keeps the highest-curve one per
  // ticker (casper 21689). The full board (Launchpad) still lists every distinct address.
  const trending = (() => {
    const seen = new Set<string>();
    const out: DopplerPool[] = [];
    for (const p of pools.filter((p) => p.progress != null).sort((a, b) => (b.progress ?? 0) - (a.progress ?? 0))) {
      const key = p.baseToken.symbol.toUpperCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(p);
      if (out.length >= 8) break;
    }
    return out;
  })();

  const openToken = (p: DopplerPool) => {
    if (p.chainId === ROBINHOOD_CHAIN_ID) navigate(`/token/${p.address}`);
  };

  return (
    <div className="mx-auto w-full max-w-6xl px-4">
      {/* Header */}
      <div className="mb-8">
        <h1 className="font-display text-2xl font-semibold text-pcs-text">Hydeout Stats</h1>
        <p className="mt-1 text-sm text-pcs-textSub">
          On-chain transparency — real values, honestly sourced. Nothing shown until it&rsquo;s true.
        </p>
      </div>

      {/* ── ZONE 1 · LIVE NOW ─────────────────────────────────────────────── */}
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-pcs-textDim">
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: "#34C77B" }} />
          Live · Robinhood Chain
        </div>
        <p className="text-[11px] text-pcs-textDim">
          {statsLoading && updatedAt == null ? (
            "indexing…"
          ) : updatedAt != null ? (
            <>indexed · <span style={{ color: "#34C77B" }}>updated {ago(updatedAt)}</span></>
          ) : (
            "indexed"
          )}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {/* Total tokens launched — REAL unique on-chain count (deduped), honest indexing state */}
        <Tile
          label="Total tokens launched"
          subTone="#E0A32E"
          sub={<>indexed · on-chain Create events (unique, not the page list)</>}
        >
          {totalLaunched != null ? (
            <p className="font-display text-4xl font-bold text-pcs-text tabular-nums">{fmtInt(totalLaunched)}</p>
          ) : (
            <p className="font-display text-2xl font-semibold text-pcs-textDim">
              indexing <span className="tracking-widest">•••</span>
            </p>
          )}
        </Tile>

        {/* 24h volume — REAL sum across the tracked pools, N dynamic */}
        <Tile
          label={<>24h volume <span className="text-pcs-textDim">· tracked pools</span></>}
          subTone="#34C77B"
          sub={<><span style={{ color: "#34C77B" }}>live</span> · DEXScreener, across {trackedN || "…"} tracked pools (not all-time)</>}
        >
          {trackedN > 0 ? (
            <p className="font-display text-4xl font-bold text-pcs-text tabular-nums">{fmtUsd(trackedVol)}</p>
          ) : (
            <p className="font-display text-2xl font-semibold text-pcs-textDim">loading…</p>
          )}
        </Tile>

        {/* Paid to creators — own-stack ledger; honest indexing state (no cron yet) */}
        <Tile
          label="Paid to creators"
          subTone="#5B6472"
          sub={<>live-rail creators earn 95% · all-time needs the cron</>}
        >
          <p className="font-display text-2xl font-semibold text-pcs-textDim">
            indexing <span className="tracking-widest">•••</span>
          </p>
        </Tile>
      </div>

      {/* ── TRENDING · RECENT LAUNCHES ────────────────────────────────────── */}
      <div className="mb-3 mt-10 flex items-center justify-between">
        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-pcs-textDim">Trending · Recent launches</h2>
        <p className="text-[11px] text-pcs-textDim">ranked by curve % · in-view set (not all-time)</p>
      </div>

      <div className="overflow-hidden rounded-2xl" style={{ background: "#121419", border: "1px solid #22252D" }}>
        <div
          className="grid grid-cols-[32px_1fr_88px_96px] gap-2 px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wide text-pcs-textDim"
          style={{ borderBottom: "1px solid #1C1F26" }}
        >
          <span>#</span>
          <span>Token</span>
          <span className="text-right">Curve</span>
          <span className="text-right">24h vol</span>
        </div>
        {trending.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-pcs-textDim">Loading live launches…</div>
        ) : (
          trending.map((p, i) => {
            const vol = p.volumeUsd != null ? parseFloat(p.volumeUsd) : null;
            return (
              <button
                key={`${p.chainId}-${p.address}`}
                onClick={() => openToken(p)}
                className="grid w-full grid-cols-[32px_1fr_88px_96px] items-center gap-2 px-4 py-3 text-left transition hover:bg-white/[0.03]"
                style={{ borderBottom: i < trending.length - 1 ? "1px solid #16191F" : "none" }}
              >
                <span className="text-sm text-pcs-textDim tabular-nums">{i + 1}</span>
                <span className="flex min-w-0 items-center gap-2.5">
                  <span
                    className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-[10px] font-bold"
                    style={{ background: "rgba(46,159,230,0.14)", color: "#54B4F0" }}
                  >
                    {p.baseToken.symbol.slice(0, 2).toUpperCase()}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-pcs-text">{p.baseToken.name}</span>
                    <span className="block truncate font-mono text-[11px] text-pcs-textDim">${p.baseToken.symbol}</span>
                  </span>
                </span>
                <span className="text-right text-sm font-semibold text-pcs-text tabular-nums">
                  {p.progress! < 1 && p.progress! > 0 ? "<1" : Math.round(p.progress!)}%
                </span>
                <span className="text-right text-sm tabular-nums" style={{ color: vol != null && vol > 0 ? "#EDEFF3" : "#5B6472" }}>
                  {vol != null && vol > 0 ? fmtUsd(vol) : "—"}
                </span>
              </button>
            );
          })
        )}
      </div>

      {/* ── ZONE 2 · OWN STACK · LAUNCHING SOON ───────────────────────────── */}
      <h2 className="mb-3 mt-10 text-[11px] font-semibold uppercase tracking-wide text-pcs-textDim">
        Powered by our own stack · Launching soon
      </h2>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <AtDeployCard
          title="Total auto-injected LP"
          detail="The 5% permanently-locked auto-compound — own-stack only, $0 today. Flips to a live counter at deploy."
        />
        <AtDeployCard
          title="Hydeout fees"
          detail="Protocol's 5% — accrues only through the own-stack (live rail = 0% to Hyde)."
        />
        <AtDeployCard
          title="Our-stack launches"
          detail="Tokens launched through the Hyde factory — none until the own-stack ships."
        />
      </div>

      {/* Honesty footnote */}
      <p className="mt-8 text-[11px] leading-relaxed text-pcs-textDim">
        <span className="font-semibold text-pcs-textSub">Honesty scoping:</span> Live tiles are real on-chain reads
        (launch count from unique on-chain Create events — never the page cap), timestamped so a cached value can&rsquo;t
        read as live. Volume is live (board-scoped 24h via DEXScreener, source-labeled); creator-paid shows
        &ldquo;indexing&rdquo; until the stats-cron — never a fabricated &ldquo;$—&rdquo;. The own-stack tiles are genuinely $0
        today (5% auto-LP, Hyde&rsquo;s 5% fee, our-stack launches don&rsquo;t exist on the Doppler rail) — shown as
        &ldquo;at deploy,&rdquo; never a number, and they flip to real the moment the own-stack ships.
      </p>
    </div>
  );
}

export default StatsPage;
