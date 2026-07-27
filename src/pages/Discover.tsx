// Board — every launch is tagged with its contract engine at the adapter boundary. Market stage
// (`type`) is intentionally not used for economics: V3 and V4 have different truthful fee splits.
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useHydeLaunches } from "../hooks/useDopplerTokens";
import { TokenImage } from "../components/TokenImage";
import type { DopplerPool } from "../utils/dopplerConfig";
import { fetchLaunchMeta } from "../utils/launchMeta";
import { chainEngineCapabilities, ENGINE_META, type LaunchEngine } from "../utils/chainRegistry";

// Spec palette (§1) — kept local for pixel control against the mock.
const C = {
  surface: "#121419",
  elevated: "#171A21",
  hairline: "#22252D",
  text: "#E8EBF0",
  muted: "#8A93A2",
  faint: "#5B6472",
  blue: "#2E9FE6",
  blueH: "#54B4F0",
  green: "#34C77B",
  amber: "#E0A32E",
};

type SortKey = "new" | "mcap";
type Filter = "all" | LaunchEngine;

function LaunchLink({ p, className, children }: { p: DopplerPool; className?: string; children: ReactNode }) {
  if (p.chainId === 988) {
    return (
      <a
        href={`https://stablescan.xyz/address/${p.address}`}
        target="_blank"
        rel="noopener noreferrer"
        className={className}
      >
        {children}
      </a>
    );
  }
  return <Link to={`/token/${p.address}`} className={className}>{children}</Link>;
}

function ageOf(iso: string): string {
  const t = new Date(iso).getTime();
  if (!t) return "—";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function compactUsd(value: number | null): string {
  if (value == null || !Number.isFinite(value) || value < 0) return "Not indexed";
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(value >= 10_000_000_000 ? 1 : 2)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(value >= 10_000_000 ? 1 : 2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}K`;
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function priceUsd(value: number | null): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return "Not indexed";
  if (value >= 1) return `$${value.toLocaleString("en-US", { maximumFractionDigits: 4 })}`;
  return `$${value.toLocaleString("en-US", { maximumSignificantDigits: 5 })}`;
}

// NOTE (kami 21204.1): "Trending" is DORMANT. `progress ÷ age` is still curve-derived, not observed
// market velocity — so no card is flagged trending and there is no "Sort: Trending" until the adapter
// exposes real volume/trades/holder-delta. The neon CSS + `trending` card prop stay in place (unused)
// so re-enabling is a one-line change once a real velocity signal exists.

/* ── small pieces ─────────────────────────────────────────────────────────── */
function CreatorFeeChip({ engine }: { engine: LaunchEngine }) {
  const meta = ENGINE_META[engine];
  return (
    <span
      className="rounded-md px-1.5 py-0.5 font-mono text-[10px] tabular-nums"
      style={{ background: "rgba(52,199,123,0.10)", color: C.green, border: `1px solid ${C.green}30` }}
    >
      {meta.creatorShare}% creator
    </span>
  );
}

function EngineBadge({ engine }: { engine: LaunchEngine }) {
  const isV4 = engine === "v4-hook";
  return (
    <span
      className="rounded-md px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[0.08em]"
      style={isV4
        ? { background: "rgba(42,212,166,0.10)", color: "#4FE3BE", border: "1px solid rgba(42,212,166,0.25)" }
        : { background: "rgba(46,159,230,0.10)", color: C.blueH, border: `1px solid ${C.blue}40` }}
    >
      {isV4 ? "V4 hook" : "V3 single-sided"}
    </span>
  );
}

function CurveBar({ pct, tone = C.blue }: { pct: number; tone?: string }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full" style={{ background: C.hairline }}>
      <div className="h-full rounded-full transition-[width] duration-300" style={{ width: `${Math.min(100, pct)}%`, background: tone }} />
    </div>
  );
}

/* ── coin card ────────────────────────────────────────────────────────────── */
function LaunchTokenImage({
  p,
  className,
  style,
}: {
  p: DopplerPool;
  className: string;
  style?: CSSProperties;
}) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    fetchLaunchMeta(p.chainId, p.baseToken.address).then((meta) => {
      if (!cancelled) setSrc(meta?.image || null);
    });
    return () => { cancelled = true; };
  }, [p.baseToken.address, p.chainId]);

  return <TokenImage src={src} symbol={p.baseToken.symbol || "?"} className={className} style={style} />;
}

export function CoinCard({ p, trending }: { p: DopplerPool; trending?: boolean }) {
  const sym = p.baseToken.symbol || "?";
  const hasMarketCap = p.marketCapUsd != null && Number.isFinite(p.marketCapUsd);
  const hasPrice = p.priceUsd != null && Number.isFinite(p.priceUsd) && p.priceUsd > 0;
  return (
    <LaunchLink p={p} className="group block min-w-0 outline-none">
      <article className="min-w-0">
        <div
          className="relative aspect-square overflow-hidden rounded-xl border bg-pcs-card transition duration-200 group-hover:-translate-y-0.5 group-hover:border-pcs-primary/40 group-focus-visible:ring-2 group-focus-visible:ring-pcs-primary/50"
          style={{
            borderColor: trending ? C.blue : C.hairline,
            boxShadow: trending
              ? "0 0 0 1px rgba(46,159,230,.45), 0 0 20px -3px rgba(46,159,230,.5)"
              : "0 12px 30px rgba(0,0,0,.16)",
          }}
        >
          <LaunchTokenImage
            p={p}
            className="h-full w-full text-4xl transition duration-300 group-hover:scale-[1.025]"
          />
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/45 via-transparent to-black/10" />

          <div className="absolute left-2.5 top-2.5">
            <EngineBadge engine={p.launchEngine} />
          </div>

          <span
            className="absolute right-2.5 top-2.5 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[9px] font-semibold uppercase tracking-[0.08em] backdrop-blur-md"
            style={{ background: "rgba(4,12,11,0.72)", color: C.green, border: `1px solid ${C.green}40` }}
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: C.green }} />
            Live
          </span>

        {trending && (
          <span
              className="absolute bottom-2.5 left-2.5 rounded-md px-2 py-1 text-[9px] font-semibold tracking-wide backdrop-blur-md"
              style={{ background: "rgba(46,159,230,0.22)", color: C.blueH, border: `1px solid ${C.blue}55` }}
          >
              Trending
          </span>
        )}
          {p.progress != null && (
            <div className="absolute inset-x-2.5 bottom-2.5">
              <div className="mb-1 flex items-center justify-between font-mono text-[9px] text-white/75">
                <span>Launch progress</span>
                <span>{p.progress.toFixed(0)}%</span>
              </div>
              <CurveBar pct={p.progress} tone="#2AD4A6" />
            </div>
          )}
        </div>

        <div className="px-0.5 pb-1 pt-3">
          <div className="flex min-w-0 items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className="truncate text-sm font-semibold text-pcs-text transition group-hover:text-pcs-primaryBright">
                {p.baseToken.name}
              </h3>
              <p className="mt-0.5 truncate font-code text-[11px] text-pcs-textDim">${sym}</p>
            </div>
            <CreatorFeeChip engine={p.launchEngine} />
          </div>

          <dl className="mt-3 grid grid-cols-2 gap-2 border-y border-pcs-border/80 py-2.5">
            <div className="min-w-0">
              <dt className="text-[9px] uppercase tracking-[0.12em] text-pcs-textDim">Market cap</dt>
              <dd className={`mt-1 truncate font-code text-xs font-semibold ${hasMarketCap ? "text-pcs-text" : "text-pcs-textDim"}`}>
                {compactUsd(p.marketCapUsd)}
              </dd>
            </div>
            <div className="min-w-0 border-l border-pcs-border/80 pl-2">
              <dt className="text-[9px] uppercase tracking-[0.12em] text-pcs-textDim">Price</dt>
              <dd className={`mt-1 truncate font-code text-xs font-semibold ${hasPrice ? "text-pcs-text" : "text-pcs-textDim"}`}>
                {priceUsd(p.priceUsd)}
              </dd>
            </div>
          </dl>

          <div className="mt-2.5 flex items-center justify-between gap-2">
            <span className="text-[10px] text-pcs-textDim">Deployed {ageOf(p.createdAt)} ago</span>
            <span className="text-[10px] font-semibold text-pcs-primary transition group-hover:text-pcs-primaryBright">
              {p.chainId === 988 ? "Explorer ↗" : "Open →"}
            </span>
          </div>
        </div>
      </article>
    </LaunchLink>
  );
}

/* ── Latest launch feature — chronological, never presented as market momentum. ── */
function LatestSignal({ p }: { p: DopplerPool }) {
  const sym = p.baseToken.symbol || "?";
  const meta = ENGINE_META[p.launchEngine];
  return (
    <LaunchLink p={p} className="block">
      <div
        className="trench-feature-card relative overflow-hidden rounded-[14px] p-5"
        style={{
          background: `linear-gradient(145deg, ${C.elevated}, ${C.surface})`,
          border: "1px solid rgba(42,212,166,0.28)",
        }}
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <span className="protocol-kicker"><span className="live-ping" />Latest signal</span>
          <EngineBadge engine={p.launchEngine} />
        </div>
        <div className="flex items-center gap-4">
          <LaunchTokenImage p={p} className="h-16 w-16 shrink-0 rounded-2xl text-2xl" style={{ border: `1px solid ${C.hairline}` }} />
          <div className="min-w-0 flex-1">
            <p className="truncate font-display text-xl font-bold" style={{ color: C.text }}>
              {p.baseToken.name} <span className="font-mono text-sm" style={{ color: C.muted }}>${sym}</span>
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <CreatorFeeChip engine={p.launchEngine} />
              <span className="font-mono text-[11px] tabular-nums" style={{ color: C.faint }}>{ageOf(p.createdAt)} ago</span>
            </div>
          </div>
        </div>
        <p className="mt-4 text-xs leading-5" style={{ color: C.muted }}>
          {meta.subtitle} <span style={{ color: C.green }}>{meta.feeSplitLabel}.</span>
        </p>
      </div>
    </LaunchLink>
  );
}

/* ── Engine route panel — the buttons filter the board and explain the economics. ── */
function EngineRoutes({
  engines,
  counts,
  selected,
  onSelect,
}: {
  engines: LaunchEngine[];
  counts: Record<LaunchEngine, number>;
  selected: Filter;
  onSelect: (engine: LaunchEngine) => void;
}) {
  return (
    <div className="rounded-[14px] p-3" style={{ background: C.surface, border: `1px solid ${C.hairline}` }}>
      <p className="commandbar-label mb-2 px-1">{engines.length === 1 ? "Selected chain route" : "Launcher routes"}</p>
      <div className="space-y-2">
        {engines.map((engine) => {
          const meta = ENGINE_META[engine];
          const active = selected === engine;
          return (
            <button
              key={engine}
              type="button"
              onClick={() => onSelect(engine)}
              className={`engine-route-button w-full rounded-xl p-3 text-left ${active ? "engine-route-button-active" : ""}`}
            >
              <span className="flex items-center justify-between gap-2">
                <strong className="text-xs text-pcs-text">{meta.title}</strong>
                <span className="font-code text-[10px] text-pcs-textDim">{counts[engine]} launches</span>
              </span>
              <span className="mt-1 block text-[11px] leading-4 text-pcs-textSub">{meta.feeSplitLabel}</span>
              <span className="mt-1 block text-[10px] leading-4 text-pcs-textDim">{meta.trustLine}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ── recent-launches strip — chronological launch events only. ───────────── */
function RecentLaunches({ pools }: { pools: DopplerPool[] }) {
  const items = useMemo(
    () => [...pools].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 12),
    [pools],
  );
  if (items.length === 0) return null;
  return (
    <div className="trench-signal-strip flex items-center gap-3 overflow-x-auto rounded-[13px] px-3 py-2" style={{ background: C.surface, border: `1px solid ${C.hairline}` }}>
      <span className="shrink-0 text-[10px] font-semibold tracking-wide" style={{ color: C.faint }}>RECENT</span>
      {items.map((p) => (
        <span key={p.address} className="shrink-0 whitespace-nowrap font-mono text-[11px]" style={{ color: C.muted }}>
          🚀 <span style={{ color: C.blue }}>${p.baseToken.symbol}</span>
          <span style={{ color: C.faint }}> · {p.launchEngine === "v4-hook" ? "V4" : "V3"} · {ageOf(p.createdAt)} ago</span>
        </span>
      ))}
    </div>
  );
}

/* ── board ────────────────────────────────────────────────────────────────── */
export function DiscoverPage({ chainId = 4663 }: { chainId?: number }) {
  const { pools, loading, error, refetch } = useHydeLaunches(chainId);
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<SortKey>("new");
  const [q, setQ] = useState("");
  const capabilities = useMemo(() => chainEngineCapabilities(chainId), [chainId]);
  const supportedEngines = useMemo(
    () => [...new Set(capabilities.map((capability) => capability.engine))],
    [capabilities],
  );
  const chainName = capabilities[0]?.name ?? `Chain ${chainId}`;

  useEffect(() => {
    if (filter !== "all" && !supportedEngines.includes(filter)) setFilter("all");
  }, [filter, supportedEngines]);

  const featured = useMemo(
    () => [...pools].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0] ?? null,
    [pools],
  );

  const counts = useMemo(
    () => ({
      "v4-hook": pools.filter((p) => p.launchEngine === "v4-hook").length,
      "v3-single-sided": pools.filter((p) => p.launchEngine === "v3-single-sided").length,
    }),
    [pools],
  );

  const shown = useMemo(() => {
    let list = filter === "all" ? pools : pools.filter((p) => p.launchEngine === filter);
    if (q.trim()) {
      const needle = q.trim().toLowerCase();
      list = list.filter((p) => p.baseToken.name.toLowerCase().includes(needle) || p.baseToken.symbol.toLowerCase().includes(needle));
    }
    const sorted = [...list];
    if (sort === "mcap") sorted.sort((a, b) => (b.marketCapUsd ?? -1) - (a.marketCapUsd ?? -1));
    else sorted.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return sorted;
  }, [pools, filter, sort, q]);

  const FILTERS: { id: Filter; label: string; count: number }[] = [
    { id: "all", label: "All Launches", count: pools.length },
    ...supportedEngines.map((engine) => ({
      id: engine,
      label: engine === "v4-hook" ? "V4 Hook" : "V3 Single-sided",
      count: counts[engine],
    })),
  ];

  return (
    <div className="hyde-page hyde-discover mx-auto w-full max-w-[1240px] space-y-4" data-depth-label="Market trench · signal board">
      <section className="trench-board-header">
        <div className="relative z-[1] max-w-2xl">
          <p className="protocol-kicker"><span className="live-ping" />{chainName} · engine-aware discovery</p>
          <h1 className="mt-3 font-display text-3xl font-semibold tracking-[-0.035em] text-pcs-text sm:text-4xl">
            Know the launcher <span className="trench-title-accent">before the token.</span>
          </h1>
          <p className="mt-3 max-w-xl text-sm leading-6 text-pcs-textSub">
            Every card identifies its V3 or V4 contract route, creator share, and liquidity behavior.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            {supportedEngines.map((engine) => {
              const meta = ENGINE_META[engine];
              return (
                <span key={engine} className="hero-proof">
                  <strong>{engine === "v4-hook" ? "V4" : "V3"}</strong> {meta.creatorShare}% creator
                  {meta.lockedLpShare > 0 ? ` · ${meta.lockedLpShare}% auto LP` : " · locked principal"}
                </span>
              );
            })}
          </div>
        </div>
        <div className="trench-board-guardian" aria-hidden="true">
          <span className="sonar-ring sonar-ring-one" />
          <span className="sonar-ring sonar-ring-two" />
          <img src="/logo/trademark-shark-light.png" alt="" />
        </div>
      </section>

      <RecentLaunches pools={pools} />

      {/* Latest launch + engine filter panel. */}
      <div className="grid gap-3 lg:grid-cols-[1fr_320px]">
        {error ? (
          <div className="rounded-[14px] p-8 text-center text-sm" style={{ background: C.surface, border: `1px solid ${C.hairline}`, color: C.muted }}>
            Launch data is temporarily unavailable.
          </div>
        ) : loading ? (
          <div className="rounded-[14px] p-8 text-center text-sm" style={{ background: C.surface, border: `1px solid ${C.hairline}`, color: C.muted }}>
            Loading the board…
          </div>
        ) : featured ? (
          <LatestSignal p={featured} />
        ) : (
          <div className="rounded-[14px] p-8 text-center text-sm" style={{ background: C.surface, border: `1px solid ${C.hairline}`, color: C.muted }}>
            No live launches yet — <Link to="/launchpad?tab=launch" style={{ color: C.blue }}>be the first</Link>.
          </div>
        )}
        <EngineRoutes
          engines={supportedEngines}
          counts={counts}
          selected={filter}
          onSelect={(engine) => setFilter((current) => current === engine ? "all" : engine)}
        />
      </div>

      {/* filters + sort + search */}
      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            className="rounded-lg px-3 py-1.5 text-xs font-medium transition"
            style={
              filter === f.id
                ? { background: "#2AD4A6", color: "#04120D" }
                : { background: C.surface, color: C.muted, border: `1px solid ${C.hairline}` }
            }
          >
            {f.label} <span className="font-mono tabular-nums opacity-70">{f.count}</span>
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2">
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="rounded-lg px-2.5 py-1.5 text-xs"
            style={{ background: C.surface, color: C.text, border: `1px solid ${C.hairline}` }}
          >
            <option value="new">Sort: New</option>
            <option value="mcap">Sort: Market cap</option>
          </select>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name or ticker"
            className="rounded-lg px-3 py-1.5 text-xs outline-none"
            style={{ background: C.surface, color: C.text, border: `1px solid ${C.hairline}`, minWidth: 180 }}
          />
        </div>
      </div>

      {/* grid */}
      {error ? (
        <div className="rounded-[13px] py-10 text-center text-sm" style={{ background: C.surface, border: `1px solid ${C.hairline}`, color: C.muted }}>
          <p>Launch data is temporarily unavailable.</p>
          <button type="button" onClick={refetch} className="mt-3 rounded-md px-3 py-1.5 text-xs font-semibold" style={{ color: C.blueH, border: `1px solid ${C.blue}45` }}>
            Retry
          </button>
        </div>
      ) : loading ? (
        <div className="py-10 text-center text-sm" style={{ color: C.muted }}>Loading launches…</div>
      ) : shown.length === 0 ? (
        <div className="rounded-[13px] py-10 text-center text-sm" style={{ background: C.surface, border: `1px solid ${C.hairline}`, color: C.muted }}>
          {pools.length === 0 ? "No launches yet — be the first." : "No launches match this filter."}
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,220px))] gap-x-4 gap-y-6">
          {shown.map((p) => (
            // `trending` stays false everywhere until a real market-velocity signal exists (kami 21204.1);
            // the neon styling in CoinCard remains dormant/ready.
            <CoinCard key={p.address} p={p} />
          ))}
        </div>
      )}
    </div>
  );
}
