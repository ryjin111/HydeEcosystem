// Board — HYDEOUT_DESIGN_SPEC §2.A (board-first, pump.fun-behavior, Hyde skin).
// Real feed via useHydeLaunches — NOTHING simulated (§3.4): market cap / holders / 24h vol are
// not in the adapter, so they are HIDDEN, never faked. Curve % + graduation + createdAt are
// source-true. Trending-only Hyde-blue neon (clint 21135) stays
// DORMANT (no card flagged, no "Sort: Trending") until the adapter exposes a real market-velocity
// signal — the CSS is kept ready (kami 21204.1/21210). Fee copy = 95% creator (LIVE rail, §3.9).
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useHydeLaunches } from "../hooks/useDopplerTokens";
import { TokenImage } from "../components/TokenImage";
import type { DopplerPool } from "../utils/dopplerConfig";
import { fetchLaunchMeta } from "../utils/launchMeta";

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

type SortKey = "new" | "top";
type Filter = "new" | "almost" | "graduated";

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

// NOTE (kami 21204.1): "Trending" is DORMANT. `progress ÷ age` is still curve-derived, not observed
// market velocity — so no card is flagged trending and there is no "Sort: Trending" until the adapter
// exposes real volume/trades/holder-delta. The neon CSS + `trending` card prop stay in place (unused)
// so re-enabling is a one-line change once a real velocity signal exists.

/* ── small pieces ─────────────────────────────────────────────────────────── */
function CreatorFeeChip() {
  // Static + source-true on the current rail (§3.9): creators earn 95% of the swap fee.
  return (
    <span
      className="rounded-md px-1.5 py-0.5 font-mono text-[10px] tabular-nums"
      style={{ background: "rgba(52,199,123,0.10)", color: C.green, border: `1px solid ${C.green}30` }}
    >
      95% creator
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
  const graduated = p.type === "v2";
  const sym = p.baseToken.symbol || "?";
  return (
    <LaunchLink p={p} className="group relative block">
      <div
        className="relative rounded-[13px] p-[14px] transition-colors"
        style={{
          background: C.surface,
          border: `1px solid ${trending ? C.blue : C.hairline}`,
          // Trending-only neon (mock recipe) — soft blue outer border + faint inner sheen, scarce.
          boxShadow: trending
            ? "0 0 0 1px rgba(46,159,230,.45), 0 0 20px -3px rgba(46,159,230,.5), inset 0 0 26px -16px rgba(84,180,240,.65)"
            : "none",
        }}
      >
        {trending && (
          <span
            className="absolute right-2.5 top-2.5 rounded-md px-1.5 py-0.5 text-[10px] font-semibold tracking-wide"
            style={{ background: "rgba(46,159,230,0.14)", color: C.blueH, border: `1px solid ${C.blue}55` }}
          >
            🔥 Trending
          </span>
        )}
        <div className="flex items-center gap-3">
          <LaunchTokenImage p={p} className="h-11 w-11 shrink-0 rounded-xl text-base" style={{ border: `1px solid ${C.hairline}` }} />
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold" style={{ color: C.text }}>
              {p.baseToken.name} <span className="font-mono text-xs" style={{ color: C.muted }}>${sym}</span>
            </p>
            <p className="font-mono text-[11px] tabular-nums" style={{ color: C.faint }}>{ageOf(p.createdAt)} ago</p>
          </div>
          <span
            className="rounded-md px-1.5 py-0.5 text-[10px] font-semibold"
            style={
              graduated
                ? { background: "rgba(52,199,123,0.12)", color: C.green, border: `1px solid ${C.green}40` }
                : { background: "rgba(46,159,230,0.10)", color: C.blue, border: `1px solid ${C.blue}35` }
            }
          >
            {graduated ? "Graduated" : "Live"}
          </span>
        </div>

        <div className="mt-3 flex items-center justify-between gap-2">
          <CreatorFeeChip />
          {p.progress != null && (
            <span className="font-mono text-[11px] tabular-nums" style={{ color: graduated ? C.green : C.blueH }}>
              {p.progress.toFixed(1)}%
            </span>
          )}
        </div>
        {p.progress != null && <div className="mt-2"><CurveBar pct={p.progress} tone={graduated ? C.green : C.blue} /></div>}

        <span
          className="mt-3 block rounded-md py-1.5 text-center text-[11px] font-semibold transition group-hover:brightness-110"
          style={{ background: C.elevated, color: C.blueH, border: `1px solid ${C.blue}45` }}
        >
          {p.chainId === 988 ? "View on StableScan ↗" : "Open & trade →"}
        </span>
      </div>
    </LaunchLink>
  );
}

/* ── Closest-to-Graduation hero (honest: highest real curve %, not a "hot/king" signal) ── */
function ClosestToGraduation({ p }: { p: DopplerPool }) {
  const sym = p.baseToken.symbol || "?";
  return (
    <LaunchLink p={p} className="block">
      <div
        className="relative overflow-hidden rounded-[14px] p-5"
        style={{
          background: `linear-gradient(160deg, ${C.elevated}, ${C.surface})`,
          border: `1px solid ${C.blue}55`,
          boxShadow: "0 0 0 1px rgba(46,159,230,.30), 0 0 30px -8px rgba(46,159,230,.45)",
        }}
      >
        <div className="mb-3 text-[11px] font-semibold tracking-wide" style={{ color: C.blueH }}>
          {p.progress != null ? "🎯 Closest to Graduation" : "Newest launch"}
        </div>
        <div className="flex items-center gap-4">
          <LaunchTokenImage p={p} className="h-16 w-16 shrink-0 rounded-2xl text-2xl" style={{ border: `1px solid ${C.hairline}` }} />
          <div className="min-w-0 flex-1">
            <p className="truncate font-display text-xl font-bold" style={{ color: C.text }}>
              {p.baseToken.name} <span className="font-mono text-sm" style={{ color: C.muted }}>${sym}</span>
            </p>
            <div className="mt-1 flex items-center gap-2">
              <CreatorFeeChip />
              <span className="font-mono text-[11px] tabular-nums" style={{ color: C.faint }}>{ageOf(p.createdAt)} ago</span>
            </div>
          </div>
        </div>
        {p.progress != null && (
          <div className="mt-4">
            <div className="mb-1 flex items-center justify-between font-mono text-[11px] tabular-nums" style={{ color: C.muted }}>
              <span>Bonding curve → graduation</span>
              <span style={{ color: C.blueH }}>{p.progress.toFixed(1)}%</span>
            </div>
            <CurveBar pct={p.progress} />
          </div>
        )}
      </div>
    </LaunchLink>
  );
}

/* ── Almost Graduated column ──────────────────────────────────────────────── */
function AlmostGraduated({ pools, unavailable = false }: { pools: DopplerPool[]; unavailable?: boolean }) {
  return (
    <div className="rounded-[14px] p-4" style={{ background: C.surface, border: `1px solid ${C.hairline}` }}>
      <h3 className="mb-3 text-[13px] font-semibold" style={{ color: C.text }}>Almost graduated</h3>
      {unavailable ? (
        <p className="py-4 text-center text-xs" style={{ color: C.faint }}>Launch data unavailable.</p>
      ) : pools.length === 0 ? (
        <p className="py-4 text-center text-xs" style={{ color: C.faint }}>None near the milestone right now.</p>
      ) : (
        <div className="space-y-3">
          {pools.map((p) => (
            <LaunchLink key={p.address} p={p} className="block">
              <div className="flex items-center gap-2">
                <LaunchTokenImage p={p} className="h-7 w-7 shrink-0 rounded-lg text-[10px]" />
                <span className="min-w-0 flex-1 truncate text-xs" style={{ color: C.text }}>${p.baseToken.symbol}</span>
                <span className="font-mono text-[11px] tabular-nums" style={{ color: C.blueH }}>{(p.progress ?? 0).toFixed(0)}%</span>
              </div>
              <div className="mt-1.5"><CurveBar pct={p.progress ?? 0} /></div>
            </LaunchLink>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── recent-launches strip ──────────────────────────────────────────────────
   Only real data: `createdAt` is the real launch time; "graduated" is a real current STATUS, not a
   timed event (we have no graduation-timestamp/event feed). So this is labelled "RECENT" status —
   not a live buy/sell/graduation event tape (kami 21204.3). No fabricated trades. */
function RecentLaunches({ pools }: { pools: DopplerPool[] }) {
  const items = useMemo(
    () => [...pools].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 12),
    [pools],
  );
  if (items.length === 0) return null;
  return (
    <div className="flex items-center gap-3 overflow-x-auto rounded-[13px] px-3 py-2" style={{ background: C.surface, border: `1px solid ${C.hairline}` }}>
      <span className="shrink-0 text-[10px] font-semibold tracking-wide" style={{ color: C.faint }}>RECENT</span>
      {items.map((p) => (
        <span key={p.address} className="shrink-0 whitespace-nowrap font-mono text-[11px]" style={{ color: C.muted }}>
          🚀 <span style={{ color: C.blue }}>${p.baseToken.symbol}</span>
          <span style={{ color: C.faint }}> · {ageOf(p.createdAt)} ago</span>
          {p.type === "v2" && <span style={{ color: C.green }}> · 🎓 graduated</span>}
        </span>
      ))}
    </div>
  );
}

/* ── board ────────────────────────────────────────────────────────────────── */
export function DiscoverPage({ chainId = 4663 }: { chainId?: number }) {
  const { pools, loading, error, refetch } = useHydeLaunches(chainId);
  const [filter, setFilter] = useState<Filter>("new");
  const [sort, setSort] = useState<SortKey>("new");
  const [q, setQ] = useState("");

  // King = the live coin closest to graduation (highest real curve progress). An honest "furthest
  // along" highlight — not a fabricated velocity/volume metric (kami 21204.1).
  const king = useMemo(() => {
    const live = pools.filter((p) => p.type === "v4");
    if (live.length === 0) return null;
    const withProgress = live.filter((p) => p.progress != null);
    if (withProgress.length > 0) {
      return [...withProgress].sort((a, b) => (b.progress ?? 0) - (a.progress ?? 0))[0];
    }
    return [...live].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
  }, [pools]);

  const almost = useMemo(
    () => pools.filter((p) => p.type === "v4" && (p.progress ?? 0) >= 50 && (p.progress ?? 0) < 100)
      .sort((a, b) => (b.progress ?? 0) - (a.progress ?? 0)).slice(0, 5),
    [pools],
  );

  const counts = useMemo(
    () => ({
      new: pools.filter((p) => p.type === "v4").length,
      almost: pools.filter((p) => p.type === "v4" && (p.progress ?? 0) >= 50 && (p.progress ?? 0) < 100).length,
      graduated: pools.filter((p) => p.type === "v2").length,
    }),
    [pools],
  );

  const shown = useMemo(() => {
    let list = pools.filter((p) => {
      if (filter === "graduated") return p.type === "v2";
      if (filter === "almost") return p.type === "v4" && (p.progress ?? 0) >= 50 && (p.progress ?? 0) < 100;
      return p.type === "v4"; // "new"
    });
    if (q.trim()) {
      const needle = q.trim().toLowerCase();
      list = list.filter((p) => p.baseToken.name.toLowerCase().includes(needle) || p.baseToken.symbol.toLowerCase().includes(needle));
    }
    const sorted = [...list];
    if (sort === "top") sorted.sort((a, b) => (b.progress ?? 0) - (a.progress ?? 0));
    else sorted.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()); // new
    return sorted;
  }, [pools, filter, sort, q]);

  const FILTERS: { id: Filter; label: string }[] = [
    { id: "new", label: "New" },
    { id: "almost", label: "Almost Graduated" },
    { id: "graduated", label: "Graduated" },
  ];

  return (
    <div className="mx-auto w-full max-w-[1240px] space-y-5">
      <RecentLaunches pools={pools} />

      {/* King of the Hill + Almost graduated */}
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        {error ? (
          <div className="rounded-[14px] p-8 text-center text-sm" style={{ background: C.surface, border: `1px solid ${C.hairline}`, color: C.muted }}>
            Launch data is temporarily unavailable.
          </div>
        ) : loading ? (
          <div className="rounded-[14px] p-8 text-center text-sm" style={{ background: C.surface, border: `1px solid ${C.hairline}`, color: C.muted }}>
            Loading the board…
          </div>
        ) : king ? (
          <ClosestToGraduation p={king} />
        ) : (
          <div className="rounded-[14px] p-8 text-center text-sm" style={{ background: C.surface, border: `1px solid ${C.hairline}`, color: C.muted }}>
            No live launches yet — <Link to="/launchpad?tab=launch" style={{ color: C.blue }}>be the first</Link>.
          </div>
        )}
        <AlmostGraduated pools={almost} unavailable={Boolean(error)} />
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
                ? { background: C.blue, color: "#04121C" }
                : { background: C.surface, color: C.muted, border: `1px solid ${C.hairline}` }
            }
          >
            {f.label} <span className="font-mono tabular-nums opacity-70">{counts[f.id]}</span>
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
            <option value="top">Sort: Top (curve)</option>
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
        <div className="py-16 text-center text-sm" style={{ color: C.muted }}>Loading launches…</div>
      ) : shown.length === 0 ? (
        <div className="rounded-[13px] py-10 text-center text-sm" style={{ background: C.surface, border: `1px solid ${C.hairline}`, color: C.muted }}>
          {pools.length === 0 ? "No launches yet — be the first." : "No launches match this filter."}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
