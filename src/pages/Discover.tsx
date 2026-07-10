// Discover board (Wave A screen 1) — HYDEOUT_DESIGN_SPEC §2.A. Real feed via
// useHydeLaunches (no fabricated values); graduation bars + Auction/Graduated
// status + live Blockscout verify badge are all source-true. ONE amber CTA
// (Launch). Honest loading/empty states. No protocol/config touched.
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useHydeLaunches } from "../hooks/useDopplerTokens";
import { useVerifiedStatus } from "../hooks/useVerifiedStatus";
import { Card, Button, Stat, Progress, Pill, Badge, VerifiedBadge, LiveTicker, SectionLabel } from "../components/ui/kit";
import type { DopplerPool } from "../utils/dopplerConfig";

type Filter = "all" | "live" | "graduating" | "graduated";

function ageOf(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function TokenCard({ p }: { p: DopplerPool }) {
  const verify = useVerifiedStatus(p.address);
  const graduated = p.type === "v2";
  const sym = p.baseToken.symbol || "?";
  return (
    <Link to={`/token/${p.address}`} className="block">
      <Card variant="token" interactive>
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-pcs-primary/40 to-pcs-cardLight font-display text-lg font-bold text-pcs-text">
            {sym.slice(0, 1).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold text-pcs-text">
              {p.baseToken.name} <span className="font-mono text-xs text-pcs-textSub">${sym}</span>
            </p>
            <p className="font-mono text-xs text-pcs-textDim">{ageOf(p.createdAt)} ago</p>
          </div>
          <Badge tone={graduated ? "success" : "accent"}>{graduated ? "Graduated" : "Auction"}</Badge>
        </div>
        <div className="mt-3 flex items-center justify-between">
          <VerifiedBadge status={verify} />
          {p.progress != null && <span className="font-mono text-[11px] text-pcs-primaryBright">{p.progress.toFixed(1)}%</span>}
        </div>
        {p.progress != null && <Progress className="mt-2" pct={p.progress} />}
      </Card>
    </Link>
  );
}

export function DiscoverPage() {
  const { pools, loading } = useHydeLaunches();
  const [filter, setFilter] = useState<Filter>("all");

  const stats = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    return {
      total: pools.length,
      live: pools.filter((p) => p.type === "v4").length,
      graduated: pools.filter((p) => p.type === "v2").length,
      today: pools.filter((p) => p.createdAt.slice(0, 10) === today).length,
    };
  }, [pools]);

  const shown = useMemo(() => {
    switch (filter) {
      case "live": return pools.filter((p) => p.type === "v4");
      case "graduating": return pools.filter((p) => p.type === "v4" && (p.progress ?? 0) >= 50 && (p.progress ?? 0) < 100);
      case "graduated": return pools.filter((p) => p.type === "v2");
      default: return pools;
    }
  }, [pools, filter]);

  const FILTERS: { id: Filter; label: string }[] = [
    { id: "all", label: "All" }, { id: "live", label: "Live" },
    { id: "graduating", label: "Graduating" }, { id: "graduated", label: "Graduated" },
  ];

  return (
    <div className="mx-auto w-full max-w-[1200px] space-y-6">
      {/* hero */}
      <Card variant="hero">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="font-display text-3xl font-bold text-pcs-text sm:text-4xl">Launch, trade, and earn</h1>
            <p className="mt-1 text-pcs-textSub">Fair token launches on a source-verified Doppler · Rehype stack. Robinhood Chain.</p>
          </div>
          <Link to="/launchpad"><Button variant="primary" size="lg">Launch a Token</Button></Link>
        </div>
        <div className="mt-6 grid grid-cols-2 gap-6 sm:grid-cols-4">
          <Stat label="Total Launched" value={loading ? "—" : stats.total.toLocaleString()} />
          <Stat label="Live Auctions" value={loading ? "—" : stats.live.toLocaleString()} />
          <Stat label="Graduated" value={loading ? "—" : stats.graduated.toLocaleString()} />
          <Stat label="Launched Today" value={loading ? "—" : stats.today.toLocaleString()} />
        </div>
      </Card>

      {/* filters */}
      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <Pill key={f.id} active={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}</Pill>
        ))}
      </div>

      {/* grid */}
      {loading ? (
        <div className="py-16 text-center text-pcs-textSub">Loading launches…</div>
      ) : shown.length === 0 ? (
        <Card variant="panel">
          <p className="py-8 text-center text-pcs-textSub">
            {pools.length === 0 ? "No launches yet — be the first." : "No launches match this filter."}
          </p>
        </Card>
      ) : (
        <div>
          <SectionLabel>{shown.length} {filter === "all" ? "launches" : filter}</SectionLabel>
          <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {shown.map((p) => <TokenCard key={p.address} p={p} />)}
          </div>
        </div>
      )}

      {/* floating live-trades ticker — feed wired later; honest empty for now */}
      <LiveTicker trades={[]} floating />
    </div>
  );
}
