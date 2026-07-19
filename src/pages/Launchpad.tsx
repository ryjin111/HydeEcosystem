import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAccount } from "wagmi";
import { formatEther } from "viem";
import { useHydeLaunches } from "../hooks/useDopplerTokens";
import type { DopplerPool } from "../utils/dopplerConfig";
import { LaunchTokenForm } from "../components/LaunchTokenForm";
import { TokenImage } from "../components/TokenImage";
import { fetchLaunchMeta } from "../utils/launchMeta";

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

/** Creator-claimable WETH (vault wei as a decimal string) → BigInt, fail-neutral to 0n for sorting. */
function claimableBig(wei: string | null | undefined): bigint {
  try { return BigInt(wei ?? "0"); } catch { return 0n; }
}

/** Claimable WETH display. Honest: null read = "Unavailable"; a real "0" = settled-zero (legit, not
 *  fabricated); otherwise the WETH amount (kami acceptance — never invent a value). */
function fmtClaimable(wei: string | null | undefined): string {
  if (wei == null) return "Unavailable";
  try {
    const n = parseFloat(formatEther(BigInt(wei)));
    if (n === 0) return "0 WETH";
    return `${n < 0.0001 ? n.toExponential(2) : n.toFixed(4)} WETH`;
  } catch {
    return "Unavailable";
  }
}

/* ─── Pool card (Explore tab) ─────────────────────────────────────────────── */

const CHAIN_LABELS: Record<number, string> = {
  4663: "Robinhood Chain",
  46630: "Robinhood Testnet",
};

/** Bigger launch card (clint 21605): the token NAME + $TICKER read in full (no more "A…" crush),
 *  with MCAP shown large. The per-card "ROBINHOOD CHAIN" pill is dropped — every launch is on the
 *  same chain (stated in the page/footer), and repeating it was what squeezed the name column.
 *  Metrics are honesty-gated: MCAP/Liquidity render ONLY when the DEXScreener pair is real
 *  (graduated + indexed); curve-stage tokens show the on-chain curve % instead — never a fake $. */
export function PoolCard({ pool, onTrade, showClaimable = false }: { pool: DopplerPool; onTrade: (addr: string, chainId: number) => void; showClaimable?: boolean }) {
  const bt = pool.baseToken;
  const chainLabel = CHAIN_LABELS[pool.chainId] ?? `chain ${pool.chainId}`;
  const graduated = pool.type === "v2";
  const hasMcap = pool.marketCapUsd != null && pool.marketCapUsd > 0;
  const hasPrice = pool.priceUsd != null && pool.priceUsd > 0;
  const hasVol = pool.volumeUsd != null && parseFloat(pool.volumeUsd) > 0;
  // A real seed mcap with no trades yet gets a "new" marker so identical pre-trade caps
  // don't read as a placeholder (shiro).
  const untraded = hasMcap && !hasVol;

  // Image-forward look (clint / pump-style): own-stack tokens carry their image in the launch-meta
  // index (fail-neutral read → monogram). Mainnet chains return null here and use the monogram too.
  const [image, setImage] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchLaunchMeta(pool.chainId, bt.address).then((m) => { if (!cancelled) setImage(m?.image || null); });
    return () => { cancelled = true; };
  }, [pool.chainId, bt.address]);

  // One-tap copy of the token's contract address (clint). Async + honest: success is shown only after
  // the Clipboard write actually resolves; an absent/rejected API shows "copy failed", never a false
  // "✓ copied" (kami).
  const [copyState, setCopyState] = useState<"idle" | "ok" | "fail">("idle");
  const copyAddr = async () => {
    try {
      await navigator.clipboard.writeText(bt.address);
      setCopyState("ok");
    } catch {
      setCopyState("fail");
    }
    setTimeout(() => setCopyState("idle"), 1400);
  };

  return (
    <div
      className="rounded-2xl overflow-hidden flex flex-col border transition hover:border-pcs-primary/40"
      style={{ background: "#121419", borderColor: "#22252D" }}
    >
      {/* Image-forward header — the token image leads the card (pump-style). TokenImage falls back to a
          colored monogram when there's no image or it fails to load; the status pill overlays it. */}
      <div className="relative">
        <TokenImage src={image} symbol={bt.symbol} className="h-40 w-full text-4xl" style={{ borderRadius: 0, borderWidth: 0 }} />
        <span
          className="absolute top-3 right-3 text-[10px] font-semibold px-2 py-0.5 rounded-full uppercase tracking-wide"
          style={{ background: graduated ? "rgba(52,199,123,0.92)" : "rgba(46,159,230,0.92)", color: "#0B0D10" }}
        >
          {graduated ? "Graduated" : "Live"}
        </span>
      </div>

      <div className="p-4 flex flex-col gap-3">
        {/* Name + ticker */}
        <div className="min-w-0">
          <p className="font-display text-[15px] font-semibold text-pcs-text truncate leading-tight">{bt.name}</p>
          <p className="text-xs text-pcs-textDim mt-0.5">${bt.symbol}</p>
        </div>

        {/* Contract address — truncated + one-tap copy (clint). Real keyboard-focusable button. */}
        <button
          onClick={copyAddr}
          title="Copy contract address"
          aria-label={`Copy contract address ${bt.address}`}
          className="flex items-center gap-1.5 w-fit rounded-md -mx-1 px-1 text-[11px] font-mono text-pcs-textDim hover:text-pcs-textSub transition focus:outline-none focus-visible:ring-2 focus-visible:ring-pcs-primary/70"
        >
          <span>{bt.address.slice(0, 6)}&hellip;{bt.address.slice(-4)}</span>
          <span
            className="text-[10px]"
            style={{ color: copyState === "ok" ? "#34C77B" : copyState === "fail" ? "#E8A33D" : undefined }}
          >
            {copyState === "ok" ? "✓ copied" : copyState === "fail" ? "copy failed" : "⧉"}
          </span>
        </button>

        {/* Market cap + price — real values only; honest "Not indexed" when unpriced, never $0.00 (kami). */}
        {hasMcap || hasPrice ? (
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-xl px-3 py-2" style={{ background: "rgba(255,255,255,0.03)" }}>
              <p className="text-[10px] uppercase tracking-wide text-pcs-textDim mb-0.5">Market cap</p>
              <p className="text-sm font-semibold text-pcs-text tabular-nums truncate">
                {hasMcap ? fmtUsd(pool.marketCapUsd as number) : <span className="text-pcs-textDim font-medium">Not indexed</span>}
                {untraded && hasMcap && <span className="ml-1 text-[9px] font-medium text-pcs-textDim uppercase">new</span>}
              </p>
            </div>
            <div className="rounded-xl px-3 py-2" style={{ background: "rgba(255,255,255,0.03)" }}>
              <p className="text-[10px] uppercase tracking-wide text-pcs-textDim mb-0.5">Price</p>
              <p className="text-sm font-semibold text-pcs-text tabular-nums truncate">
                {hasPrice ? fmtUsd(pool.priceUsd as number) : <span className="text-pcs-textDim font-medium">Not indexed</span>}
              </p>
            </div>
          </div>
        ) : (
          // Neither mcap nor price is third-party indexed (brand-new / testnet own-stack). Honest single
          // row — never a fabricated $0.00 (kami acceptance).
          <div className="rounded-xl px-3 py-2" style={{ background: "rgba(255,255,255,0.03)" }}>
            <p className="text-[10px] uppercase tracking-wide text-pcs-textDim mb-0.5">Market cap &middot; price</p>
            <p className="text-sm font-medium text-pcs-textDim">New launch &middot; not yet indexed</p>
          </div>
        )}

        {/* Claimable creator fees — shown only on My Launches. Real WETH from the vault; honest
            "Unavailable" for a null read, "0 WETH" for a real settled-zero — never fabricated (kami). */}
        {showClaimable && (
          <div
            className="flex items-center justify-between rounded-xl px-3 py-2"
            style={{ background: "rgba(52,199,123,0.06)", border: "1px solid rgba(52,199,123,0.22)" }}
          >
            <span className="text-[10px] uppercase tracking-wide text-pcs-textDim">Claimable fees</span>
            <span
              className="text-sm font-semibold tabular-nums"
              style={{ color: claimableBig(pool.creatorClaimable) > 0n ? "#34C77B" : "#7A828E" }}
            >
              {fmtClaimable(pool.creatorClaimable)}
            </span>
          </div>
        )}

        {/* Curve progress — real % of the launch inventory BOUGHT, on-chain (non-graduated). Tooltip
            flags it's a live two-way level (rises on net buys, dips on net sells) — shiro 21736. */}
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

        {/* Footer — chain + age + Trade */}
        <div className="flex items-center justify-between mt-1">
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
  const { address } = useAccount();

  // "My Launches" + claimable sort exist only on the own-stack (creator/creatorClaimable are null on
  // the Doppler rail), so the filter is testnet-only; on mainnet the board stays "all".
  const [view, setView] = useState<"all" | "mine">("all");
  const [sort, setSort] = useState<"claimable" | "mcap">("claimable");
  const effView = isTestnet ? view : "all";

  const mine = useMemo(
    () => (address ? pools.filter((p) => p.creator && p.creator.toLowerCase() === address.toLowerCase()) : []),
    [pools, address]
  );
  const shown = useMemo(() => {
    if (effView !== "mine") return pools; // "all" keeps the feed's recency order
    const arr = [...mine];
    if (sort === "claimable") {
      arr.sort((a, b) => {
        const av = claimableBig(a.creatorClaimable), bv = claimableBig(b.creatorClaimable);
        if (bv > av) return 1;
        if (bv < av) return -1;
        return a.address.localeCompare(b.address); // stable tie order
      });
    } else {
      arr.sort((a, b) => (b.marketCapUsd ?? 0) - (a.marketCapUsd ?? 0) || a.address.localeCompare(b.address));
    }
    return arr;
  }, [effView, mine, pools, sort]);

  const handleTrade = (tokenAddress: string, poolChainId: number) => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(tokenAddress)) return;
    // Hyde launches live on Robinhood mainnet (4663) OR the testnet own-stack (46630) — allow both;
    // the swap page trades on whichever network is selected in the dropdown (matches the board).
    if (poolChainId !== ROBINHOOD_CHAIN_ID && poolChainId !== RH_TESTNET_ID) return;
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
          {/* Filter (All | My Launches) + sort — own-stack only, since creator/claimable don't exist on
              the Doppler rail. Refresh on the right. */}
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <div className="flex flex-wrap items-center gap-3">
              {isTestnet && (
                <div className="flex gap-1 p-1 rounded-lg" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid #1C1F26" }}>
                  {(["all", "mine"] as const).map((v) => (
                    <button
                      key={v}
                      onClick={() => setView(v)}
                      className="px-3 py-1.5 rounded-md text-xs font-semibold transition"
                      style={effView === v ? { background: "rgba(46,159,230,0.14)", color: "#54B4F0" } : { color: "#5D6470" }}
                    >
                      {v === "all" ? "All launches" : "My Launches"}
                    </button>
                  ))}
                </div>
              )}
              {effView === "mine" && (
                <label className="flex items-center gap-1.5 text-xs text-pcs-textDim">
                  Sort
                  <select
                    value={sort}
                    onChange={(e) => setSort(e.target.value as "claimable" | "mcap")}
                    className="rounded-lg bg-pcs-card px-2 py-1 text-xs font-medium text-pcs-textSub outline-none cursor-pointer focus-visible:ring-2 focus-visible:ring-pcs-primary/70"
                    style={{ border: "1px solid #22252D" }}
                  >
                    <option value="claimable">Claimable fees</option>
                    <option value="mcap">Market cap</option>
                  </select>
                </label>
              )}
            </div>
            <button
              onClick={refetch}
              className="text-xs text-pcs-primary hover:underline"
              disabled={loading}
            >
              {loading ? "Refreshing…" : "Refresh"}
            </button>
          </div>

          {/* Count + source line — view-aware. Mainnet $ figures are DEXScreener-priced; testnet isn't
              third-party indexed, so it's pure on-chain reads (curve % live; no fabricated price). */}
          <p className="text-sm text-pcs-textDim">
            {loading
              ? "Loading…"
              : effView === "mine"
                ? `${shown.length} of your launch${shown.length !== 1 ? "es" : ""}`
                : `${pools.length} token${pools.length !== 1 ? "s" : ""} launched ${isTestnet ? "on the Hyde own-stack" : "on Robinhood Chain"}`}
          </p>
          <p className="text-[11px] text-pcs-textDim/70 mt-0.5 mb-4">
            {isTestnet ? "Live on-chain reads · own-stack factory (not third-party indexed)" : "Market data via DEXScreener"}
          </p>

          {/* Empty states — connect prompt (My Launches, disconnected) / no-launches / your-none */}
          {effView === "mine" && !address ? (
            <div className="rounded-2xl p-10 text-center" style={{ background: "#121419", border: "1px solid #22252D" }}>
              <p className="text-pcs-textDim text-sm">Connect your wallet to see your launches.</p>
            </div>
          ) : !loading && shown.length === 0 ? (
            <div className="rounded-2xl p-10 text-center" style={{ background: "#121419", border: "1px solid #22252D" }}>
              <p className="text-pcs-textDim text-sm">
                {effView === "mine" ? "You haven't launched any tokens yet." : "No launches found yet."}
              </p>
              <button onClick={() => setTab("launch")} className="btn-primary mt-4 px-5 py-2 text-sm">
                Launch a Token
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {shown.map((pool) => (
                <PoolCard
                  key={`${pool.chainId}-${pool.address}-${pool.baseToken.address}`}
                  pool={pool}
                  onTrade={handleTrade}
                  showClaimable={effView === "mine"}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Launch tab — network-aware: own-stack HydeTokenFactory on testnet, Doppler rail on mainnet */}
      {tab === "launch" && <LaunchTokenForm chainId={chainId} />}
    </div>
  );
}
