// Token / trade page (Wave A screen 2) — HYDEOUT_DESIGN_SPEC §2.B. Real feed via
// useHydeLaunches (honest 404 if not on the board). Chart = real DEXScreener
// embed when the token has a robinhood/uniswap pair, else a designed full-size
// fallback (never a collapsed hole). Swap = the EXISTING verified V4SwapCard
// (reskin/reuse only — no trade-logic change). Top holders via Blockscout, fail
// neutral. Restrictions copy = 3%→1% anti-snipe decay ONLY. No protocol touched.
import { useEffect, useMemo, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useAccount } from "wagmi";
import { formatUnits } from "viem";
import {
  ArrowTopRightOnSquareIcon,
  ArrowsRightLeftIcon,
  SignalIcon,
  UserGroupIcon,
} from "@heroicons/react/24/outline";
import type { NetworkConfig, TokenInfo } from "../utils/constants";
import { isGatewayLive, V4_CONTRACTS_BY_CHAIN } from "../utils/constants";
import { WETH_CONTAINMENT } from "../utils/containment";
import { useHydeLaunches, useHydeToken } from "../hooks/useDopplerTokens";
import { useTokenPosition } from "../hooks/useTokenPosition";
import { V4SwapCard } from "../components/V4SwapCard";
import { HoodieSwapCard } from "../components/HoodieSwapCard";
import { StableV3SwapCard } from "../components/StableV3SwapCard";
import { YourPositionCard } from "../components/YourPositionCard";
import { TokenImage } from "../components/TokenImage";
import { LaunchMetadataEditor } from "../components/LaunchMetadataEditor";
import { fetchLaunchMeta, type LaunchMeta } from "../utils/launchMeta";
import { chainV3Capability, ENGINE_META } from "../utils/chainRegistry";
import { Card, Button, Stat, SectionLabel } from "../components/ui/kit";

type Props = { network: NetworkConfig; tokens: TokenInfo[]; onAddCustomToken: (t: { address: `0x${string}`; symbol: string; name: string; decimals: number }) => void };

// DEXScreener / GeckoTerminal / Blockscout below index Robinhood MAINNET only. On any other chain
// (e.g. the 46630 testnet own-stack) they must NOT run — a same-looking address could otherwise
// surface a mainnet pair/chart/holders and even mark a testnet token "Graduated" (kami A-blocker #2).
const ROBINHOOD_MAINNET_ID = 4663;

// resolve the DEXScreener robinhood pair (fail neutral → null; never a wrong pair)
function useDexPair(address?: string, chainId?: number): { pair: string | null; checked: boolean } {
  const [pair, setPair] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    setChecked(false); setPair(null);
    if (!address || chainId !== ROBINHOOD_MAINNET_ID) { setChecked(true); return; } // mainnet-only source
    let cancelled = false;
    fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        // only robinhood/uniswap pairs; if several, pick highest USD liquidity
        // (the canonical/graduated pair) — deterministic, never a constructed addr.
        const cands: { pairAddress?: string; liquidity?: { usd?: number } }[] =
          (d?.pairs ?? []).filter((x: { chainId?: string; dexId?: string }) => x.chainId === "robinhood" && x.dexId === "uniswap");
        cands.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
        if (!cancelled) { setPair(cands[0]?.pairAddress ?? null); setChecked(true); }
      })
      .catch(() => { if (!cancelled) setChecked(true); });
    return () => { cancelled = true; };
  }, [address, chainId]);
  return { pair, checked };
}

/** Compact USD for MCAP/volume/liquidity — only called with a real number ≥ ~1. */
function fmtUsd(n: number): string {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toLocaleString("en-US", { maximumSignificantDigits: 3 })}`;
}

/** Token price — compact so it never overflows its column (shiro layout-break fix). Micro-cap
 *  prices use the DEX subscript-zero convention ($0.0₆204 = 0.000000204), not a long decimal that
 *  collided with the next stat, and never scientific notation. */
const SUBSCRIPT = "₀₁₂₃₄₅₆₇₈₉";
const subNum = (k: number): string => String(k).split("").map((d) => SUBSCRIPT[+d]).join("");
function fmtPrice(n: number): string {
  if (n >= 1) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 4 })}`;
  if (n >= 0.0001) return `$${parseFloat(n.toPrecision(4))}`;
  const exp = Math.floor(Math.log10(n)); // negative
  const zeros = -exp - 1;                // leading zeros after the decimal point
  const sig = String(Math.round((n / Math.pow(10, exp)) * 100) / 100).replace(".", ""); // 3 sig figs
  return `$0.0${subNum(zeros)}${sig}`;
}

type Holder = { address: string; value: string };
function useTopHolders(address?: string, chainId?: number): { holders: Holder[]; loading: boolean } {
  const [holders, setHolders] = useState<Holder[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    setHolders([]);
    if (!address || chainId !== ROBINHOOD_MAINNET_ID) { setLoading(false); return; } // mainnet-only source
    let cancelled = false;
    setLoading(true);
    fetch(`https://robinhoodchain.blockscout.com/api/v2/tokens/${address}/holders`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const items = (d?.items ?? []).slice(0, 8).map((h: { address?: { hash?: string }; value?: string }) => ({ address: h.address?.hash ?? "", value: h.value ?? "0" }));
        if (!cancelled) setHolders(items);
      })
      .catch(() => { /* fail neutral → empty */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [address, chainId]);
  return { holders, loading };
}

const short = (a: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");

function fmtTokenAmount(value: string, decimals: number): string {
  try {
    const amount = Number(formatUnits(BigInt(value), decimals));
    if (!Number.isFinite(amount)) return "—";
    if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(amount >= 10_000_000 ? 1 : 2)}M`;
    if (amount >= 1_000) return `${(amount / 1_000).toFixed(amount >= 100_000 ? 1 : 2)}K`;
    return amount.toLocaleString("en-US", { maximumFractionDigits: amount < 1 ? 4 : 2 });
  } catch {
    return "—";
  }
}

function timeAgo(iso: string): string | null {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t) || new Date(iso).getUTCFullYear() <= 2020) return null; // unindexed create time → omit
  const m = Math.floor((Date.now() - t) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
// Own-stack Hyde launches are a fixed 1,000,000,000 supply (protocol constant — not fabricated).
const OWN_STACK_SUPPLY = "1,000,000,000";

/**
 * TokenDetail — the full token-detail layout rendered by the canonical /token/:address route.
 * Legacy /swap?out links redirect here, and the trade widget stays embedded beside token data.
 */
export function TokenDetail({ address, network, tokens, onAddCustomToken }: Props & { address: string }) {
  // Chain-scoped to the active network (clint #4): testnet and mainnet each read only their configured
  // own-stack launch sources — never cross-chain data.
  const { pools } = useHydeLaunches(network.id);
  const { pair } = useDexPair(address, network.id);
  const { holders, loading: holdersLoading } = useTopHolders(address, network.id);
  const [copied, setCopied] = useState(false);
  const [feedTab, setFeedTab] = useState<"trades" | "holders">("trades"); // coin-mockup: Trades/Holders tabs
  // Off-chain metadata (own-stack tokens store no tokenURI) — fetched by (chain, address); fail-neutral.
  const [meta, setMeta] = useState<LaunchMeta | null>(null);
  useEffect(() => {
    let cancelled = false;
    setMeta(null);
    if (address) fetchLaunchMeta(network.id, address).then((m) => { if (!cancelled) setMeta(m); });
    return () => { cancelled = true; };
  }, [address, network.id]);

  // Prefer the board pool (richer: precise graduation %); else read the token
  // directly by address so launches OUTSIDE the newest-60 page still render.
  const boardPool = useMemo(() => pools.find((p) => p.address.toLowerCase() === address.toLowerCase()), [pools, address]);
  const { pool: fetchedPool, loading: tokenLoading, error: tokenError } = useHydeToken(address, network.id);
  const pool = boardPool ?? fetchedPool;

  // HOODIE-numeraire own-stack pool → live in-app Buy/Sell + per-wallet PnL via the canonical UniversalRouter
  // (the Hyde gateway isn't deployed on 4663). Detected by the pool's quote token matching the configured
  // $HOODIE numeraire — inherently mainnet-only (only 4663 has `hoodieNumeraire` set). WETH pairs keep the
  // gateway-gated / reference-only rail below, untouched. Computed (+ position hook called) BEFORE the early
  // returns so hook order stays stable; `pool?` guards the still-loading case.
  const hoodieNumeraire = V4_CONTRACTS_BY_CHAIN[network.id]?.hoodieNumeraire;
  const isHoodiePair = !!hoodieNumeraire && pool?.quoteToken?.address?.toLowerCase() === hoodieNumeraire.toLowerCase();
  const { address: walletAddress, isConnected } = useAccount();
  const { position, error: positionError } = useTokenPosition(pool?.address ?? "", network.id, isHoodiePair);

  if (tokenLoading && !boardPool) {
    return (
      <div className="hyde-page hyde-token mx-auto w-full max-w-[1200px]" data-depth-label="Token depth · on-chain signal">
        <div className="py-12 text-center text-pcs-textSub">Loading token…</div>
      </div>
    );
  }
  if (tokenError && !boardPool) {
    return (
      <div className="hyde-page hyde-token mx-auto w-full max-w-[1200px]" data-depth-label="Token depth · on-chain signal">
        <Card variant="panel" className="mx-auto max-w-lg text-center">
          <p className="py-5 text-pcs-textSub">Token data is temporarily unavailable.</p>
          <Link to="/discover"><Button variant="secondary">Back to Discover</Button></Link>
        </Card>
      </div>
    );
  }
  if (!pool) {
    return (
      <div className="hyde-page hyde-token mx-auto w-full max-w-[1200px]" data-depth-label="Token depth · on-chain signal">
        <Card variant="panel" className="mx-auto max-w-lg text-center">
          <p className="py-5 text-pcs-textSub">This isn’t a Hydeout launch token.</p>
          <Link to="/discover"><Button variant="secondary">Back to Discover</Button></Link>
        </Card>
      </div>
    );
  }

  const sym = pool.baseToken.symbol || "?";
  const engineMeta = ENGINE_META[pool.launchEngine];
  const isV4Launch = pool.launchEngine === "v4-hook";
  const stableV3SwapReady = chainV3Capability(network.id)?.trade?.engine === "v3-single-sided";
  // WETH-only containment (kami 24019): a non-HOODIE (WETH-paired) token while WETH_CONTAINMENT is active.
  // Its chart/Trades empty-states must NOT claim "trading is live on-chain" (contradicts the amber pause card),
  // and the green LIVE badge is swapped for a paused one. HOODIE pages keep the live copy unchanged.
  const wethContained = isV4Launch && !isHoodiePair && WETH_CONTAINMENT.active;
  const creatorAddr = (pool as { creator?: string }).creator;
  const launchedAgo = timeAgo(pool.createdAt);

  return (
    <div className="hyde-page hyde-token mx-auto w-full max-w-[1200px]" data-depth-label="Token depth · on-chain signal">
      {/* Breadcrumb (coin-mockup) */}
      <nav className="mb-3 flex items-center gap-1.5 text-xs text-pcs-textDim">
        <Link to="/discover" className="transition hover:text-pcs-textSub">Board</Link>
        <span aria-hidden>›</span>
        <span className="truncate text-pcs-textSub">{pool.baseToken.name}</span>
      </nav>

      <div className="grid gap-4 lg:grid-cols-[1fr,380px]">
        {/* ---------- main ---------- */}
        <div className="min-w-0 space-y-4">
          {/* Header — image · name · by creator · time · address · right-aligned price (coin-mockup) */}
          <Card>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                {meta?.image ? (
                  <TokenImage src={meta.image} symbol={sym} className="h-14 w-14 rounded-xl text-2xl" style={{ border: "1px solid #22252D" }} />
                ) : (
                  <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-gradient-to-br from-pcs-primary/40 to-pcs-cardLight font-display text-2xl font-bold text-pcs-text">{sym.slice(0, 1).toUpperCase()}</div>
                )}
                <div className="min-w-0">
                  <h1 className="truncate font-display text-2xl font-bold text-pcs-text">{pool.baseToken.name} <span className="font-mono text-sm text-pcs-textSub">${sym}</span></h1>
                  {/* Own-stack Hyde/HOODIE launch — no auction curve / graduation / "Verified" badge. */}
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-pcs-textDim">
                    {creatorAddr && <span>by {short(creatorAddr)}</span>}
                    {launchedAgo && <span>· {launchedAgo}</span>}
                    <button type="button" onClick={() => { navigator.clipboard?.writeText(pool.address); setCopied(true); setTimeout(() => setCopied(false), 1200); }} className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono transition hover:text-pcs-textSub" style={{ border: "1px solid #22252D" }}>{copied ? "Copied" : short(pool.address)} ⧉</button>
                    <span className="rounded-md border border-pcs-primary/25 bg-pcs-primary/10 px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wide text-pcs-primaryBright">
                      {engineMeta.title}
                    </span>
                    <span className="rounded-md px-1.5 py-0.5 text-[10px] font-semibold" style={{ background: "rgba(52,199,123,0.12)", color: "#34C77B", border: "1px solid #34C77B40" }}>LIVE</span>
                  </div>
                </div>
              </div>
              <div className="shrink-0 text-right">
                <div className="font-mono text-xl font-bold text-pcs-text">{pool.priceUsd != null && pool.priceUsd > 0 ? fmtPrice(pool.priceUsd) : "—"}</div>
                <a href={`${network.explorerUrl}/address/${pool.address}`} target="_blank" rel="noreferrer" className="text-[11px] text-pcs-textDim transition hover:text-pcs-textSub">Explorer ↗</a>
              </div>
            </div>
            {meta?.description?.trim() && (
              <p className="mt-3 text-xs text-pcs-textSub leading-relaxed">{meta.description}</p>
            )}
          </Card>

          {!isV4Launch && creatorAddr && walletAddress?.toLowerCase() === creatorAddr.toLowerCase() && (
            <LaunchMetadataEditor
              chainId={network.id}
              token={pool.address}
              symbol={sym}
              creator={creatorAddr}
              initialMeta={meta}
              onSaved={setMeta}
            />
          )}

        {/* Chart — self-hosted price history (candles from on-chain PoolManager Swap events) is a
            separate post-swap task (gojo/kami 23826-23829); no GeckoTerminal dependency/ETA on 4663.
            Until that feed ships, an honest "warming up" state: LIVE on-chain, a NEUTRAL decorative
            shimmer skeleton (never fabricated candles/axes/numbers), no external-indexer claim, and no
            CTA to a not-yet-enabled swap. */}
        <Card className="p-0 overflow-hidden">
          {/* Timeframe chrome (coin-mockup) — NON-interactive until a price-history feed exists, so they're
              not dead controls that change nothing (kami 23949 #6). "1h" shown as the eventual default. */}
          <div className="flex items-center gap-1 px-4 pt-4" title="Price history begins with on-chain swaps">
            {(["5m", "1h", "24h", "7d"] as const).map((tf) => (
              <span key={tf} aria-disabled className="select-none rounded-lg px-2.5 py-1 text-[11px] font-semibold opacity-70"
                style={tf === "1h" ? { background: "rgba(46,159,230,0.10)", color: "#54B4F0" } : { color: "#5D6470" }}>{tf}</span>
            ))}
          </div>
          <div
            className="relative flex h-[250px] flex-col items-center justify-center gap-3 px-6 text-center"
            style={{ background: "radial-gradient(120% 90% at 50% 0%, rgba(46,159,230,0.05), transparent 60%), #0E1013" }}
          >
            <div
              className="pointer-events-none absolute inset-0 opacity-[0.05]"
              style={{ backgroundImage: "linear-gradient(#fff 1px, transparent 1px), linear-gradient(90deg, #fff 1px, transparent 1px)", backgroundSize: "34px 34px" }}
            />
            <span
              className="relative z-10 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-semibold tracking-wide"
              style={wethContained
                ? { background: "rgba(232,163,61,0.10)", color: "#E0A32E", border: "1px solid rgba(232,163,61,0.28)" }
                : { background: "rgba(52,199,123,0.12)", color: "#34C77B", border: "1px solid #34C77B40" }}
            >
              {!wethContained && <span className="hyde-pulse inline-block h-1.5 w-1.5 rounded-full" style={{ background: "#34C77B" }} />}
              {wethContained ? "PAUSED · PRICE UNDER REVIEW" : "LIVE · LOCKED LIQUIDITY"}
            </span>
            <div className="relative z-10 flex h-16 items-end gap-1.5" aria-hidden="true">
              {[9, 5, 12, 7, 14, 6, 11, 8, 13, 5, 10, 7].map((h, i) => (
                <span key={i} className="hyde-shimmer w-2 rounded-sm" style={{ height: `${h * 4}px`, background: "rgba(255,255,255,0.06)", animationDelay: `${i * 90}ms` }} />
              ))}
            </div>
            <div className="relative z-10">
              <p className="font-display text-sm font-semibold text-pcs-text">{wethContained ? "Chart paused" : "Chart warming up"}</p>
              <p className="mt-1 max-w-sm text-xs text-pcs-textSub">{wethContained ? "Trading is paused while this pool’s launch price is under review." : "Trading is live on-chain. Price history begins with on-chain swaps."}</p>
            </div>
          </div>
          {/* Curve/liquidity label — own-stack launches straight into a locked-liquidity pool (no graduation). */}
          <div className="flex items-center gap-2 border-t px-4 py-2.5" style={{ borderColor: "#1C1F26" }}>
            <span className="inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full" style={{ background: "#34C77B" }} />
            <p className="font-mono text-[11px] text-pcs-textDim">
              {isV4Launch
                ? "V4 hook liquidity locked · 5% of fees auto-compounds into locked LP."
                : "V3 single-sided liquidity · principal permanently locked."}
            </p>
          </div>
        </Card>

        {/* Honest activity surface: the trade tape remains explicit about indexing, while holders are a
            Blockscout snapshot rather than an implied total holder count. */}
        <Card className="token-activity-panel overflow-hidden p-0">
          <div className="flex flex-col gap-3 border-b border-pcs-border px-4 pb-3 pt-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <SignalIcon className="h-4 w-4 text-pcs-primary" />
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-pcs-textSub">On-chain activity</p>
              </div>
              <p className="mt-1 text-[11px] text-pcs-textDim">Live pool context and indexed wallet distribution.</p>
            </div>
            <div className="token-feed-tabs" role="tablist" aria-label="Token activity">
              {(["trades", "holders"] as const).map((tab) => {
                const active = feedTab === tab;
                const Icon = tab === "trades" ? ArrowsRightLeftIcon : UserGroupIcon;
                return (
                  <button
                    key={tab}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setFeedTab(tab)}
                    className={`token-feed-tab ${active ? "token-feed-tab-active" : ""}`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {tab === "trades" ? "Trades" : "Top holders"}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="min-h-[178px] p-4">
            {feedTab === "trades" ? (
              <div className="token-feed-empty">
                <div className="token-feed-radar" aria-hidden="true">
                  <ArrowsRightLeftIcon className="h-5 w-5" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-pcs-text">
                    {wethContained ? "Trade feed paused" : "Trade tape warming up"}
                  </p>
                  <p className="mt-1 max-w-md text-xs leading-5 text-pcs-textDim">
                    {wethContained
                      ? "Activity is hidden while this pool’s launch price is under review."
                      : "Swaps are live on-chain. Indexed activity will appear here when the trade feed is connected."}
                  </p>
                </div>
                {!wethContained && (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-pcs-primary/20 bg-pcs-primary/[0.06] px-2.5 py-1 font-code text-[9px] uppercase tracking-wider text-pcs-primary">
                    <span className="hyde-pulse h-1.5 w-1.5 rounded-full bg-pcs-primary" />
                    Pool live
                  </span>
                )}
              </div>
            ) : holdersLoading ? (
              <div className="space-y-2">
                {[0, 1, 2].map((row) => (
                  <div key={row} className="h-[46px] animate-pulse rounded-lg border border-pcs-border bg-white/[0.02]" />
                ))}
              </div>
            ) : holders.length === 0 ? (
              <div className="token-feed-empty">
                <div className="token-feed-radar" aria-hidden="true">
                  <UserGroupIcon className="h-5 w-5" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-pcs-text">Holder snapshot unavailable</p>
                  <p className="mt-1 max-w-md text-xs leading-5 text-pcs-textDim">
                    No holder rows were returned by the selected chain’s explorer.
                  </p>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                {holders.map((holder, index) => (
                  <a
                    key={holder.address + index}
                    href={`${network.explorerUrl}/address/${holder.address}`}
                    target="_blank"
                    rel="noreferrer"
                    className="token-holder-row group"
                  >
                    <span className={`token-holder-rank ${index < 3 ? "token-holder-rank-top" : ""}`}>
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-code text-xs text-pcs-text">{short(holder.address)}</span>
                      <span className="mt-0.5 block text-[10px] uppercase tracking-wider text-pcs-textDim">
                        Wallet on {network.name}
                      </span>
                    </span>
                    <span className="text-right">
                      <span className="block font-code text-xs font-semibold tabular-nums text-pcs-text">
                        {fmtTokenAmount(holder.value, pool.baseToken.decimals)}
                      </span>
                      <span className="mt-0.5 block font-code text-[9px] uppercase tracking-wider text-pcs-textDim">{sym}</span>
                    </span>
                    <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5 text-pcs-textDim transition group-hover:text-pcs-primary" />
                  </a>
                ))}
                <p className="pt-1 text-right font-code text-[9px] uppercase tracking-wider text-pcs-textDim">
                  Snapshot via chain explorer
                </p>
              </div>
            )}
          </div>
        </Card>
      </div>

      {/* ---------- right rail ---------- */}
      <div className="min-w-0 space-y-4">
        {/* Rail-aware trade widget (§3.2). When the router genuinely goes live, the reused
           V4SwapCard executes; otherwise the primary action routes to the live pair and the
           in-app Buy/Sell is shown REFERENCE-ONLY (dimmed, non-interactive) — never implying
           Hyde submits/pre-fills an order it can't carry. Graduation is NEVER cited as a reason. */}
        {!isV4Launch && stableV3SwapReady ? (
          <StableV3SwapCard
            network={network}
            token={{ address: pool.address as `0x${string}`, symbol: sym, name: pool.baseToken.name, decimals: pool.baseToken.decimals }}
          />
        ) : isV4Launch && isHoodiePair ? (
          <HoodieSwapCard
            network={network}
            token={{ address: pool.address as `0x${string}`, symbol: sym, name: pool.baseToken.name, decimals: pool.baseToken.decimals }}
          />
        ) : isV4Launch && isGatewayLive(network.id) && !WETH_CONTAINMENT.active ? (
          <V4SwapCard network={network} tokens={tokens} onAddCustomToken={onAddCustomToken} forceTokenOut={pool.address.toLowerCase()} />
        ) : (
          <Card variant="panel">
            <SectionLabel>Trade</SectionLabel>
            {/* WETH CONTAINMENT (kami 24005/24008): this branch is the non-HOODIE (WETH-paired) path — its preset
                seeded the ~$1.9T pool. No audited in-app sell → the whole external trade link is removed (routing
                users to the broken pool is the same harm); price/FDV stays truthful. HOODIE pairs never reach here. */}
            {isV4Launch && WETH_CONTAINMENT.active ? (
              <p className="mt-3 rounded-lg px-2.5 py-2 text-center text-sm leading-relaxed" style={{ background: "rgba(232,163,61,0.08)", border: "1px solid rgba(232,163,61,0.28)", color: "#E0A32E" }}>
                {WETH_CONTAINMENT.noSell}
              </p>
            ) : isV4Launch && pair ? (
              <>
                <a
                  href={`https://dexscreener.com/robinhood/${pair}`}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-3 block rounded-xl py-2.5 text-center text-sm font-semibold transition hover:opacity-90"
                  style={{ background: "#2E9FE6", color: "#04121C" }}
                >
                  Trade on live pair ↗
                </a>
                <p className="mt-2 text-xs text-pcs-textSub">Trading is live on this token’s pair.</p>
              </>
            ) : (
              <>
                <p className="mt-2 text-sm text-pcs-textSub">
                  {isV4Launch
                    ? "In-app swap for this token is coming shortly. It trades live now on its locked-liquidity pool, on-chain."
                    : "This token trades through its canonical Stable V3 pool. In-app execution is temporarily unavailable because the verified router gate did not pass."}
                </p>
                {!isV4Launch && pool.poolAddress && (
                  <a
                    href={`${network.explorerUrl.replace(/\/$/, "")}/address/${pool.poolAddress}`}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-3 block rounded-xl border border-pcs-primary/30 bg-pcs-primary/[0.09] py-2.5 text-center text-sm font-semibold text-pcs-primaryBright transition hover:bg-pcs-primary/[0.13]"
                  >
                    View canonical V3 pool ↗
                  </a>
                )}
              </>
            )}
            {/* Disabled Buy/Sell preview removed (kami 23517) — it read as a working swap; the live-pair
                link above is the single trade action until the native swap actually executes. */}
          </Card>
        )}

        {/* Market — consolidated stats (coin-mockup): real feed values or an honest "—", never fabricated. */}
        <Card variant="panel">
          <SectionLabel>Market</SectionLabel>
          <div className="mt-3 space-y-2 text-xs">
            {([
              ["Market cap", pool.marketCapUsd != null && pool.marketCapUsd > 0 ? fmtUsd(pool.marketCapUsd) : "—"],
              ["Price", pool.priceUsd != null && pool.priceUsd > 0 ? fmtPrice(pool.priceUsd) : "—"],
              ["24h volume", pool.volumeUsd != null && parseFloat(pool.volumeUsd) > 0 ? fmtUsd(parseFloat(pool.volumeUsd)) : "—"],
              ["Liquidity", pool.dollarLiquidity != null && parseFloat(pool.dollarLiquidity) > 0 ? fmtUsd(parseFloat(pool.dollarLiquidity)) : "—"],
              ["Total supply", OWN_STACK_SUPPLY],
            ] as [string, string][]).map(([label, value]) => (
              <div key={label} className="flex items-center justify-between">
                <span className="text-pcs-textDim">{label}</span>
                <span className="font-mono tabular-nums text-pcs-text">{value}</span>
              </div>
            ))}
          </div>
        </Card>

        {/* Your Position — per-wallet covered-only PnL for HOODIE launches; net-of-slippage exit-sim mark,
            honest about uncovered/unprovable basis. Only for HOODIE pairs (the reconcilable own-stack pool). */}
        {isHoodiePair && <YourPositionCard connected={isConnected} position={position} error={positionError} symbol={sym} />}

        {/* Trust card — the Hyde stack is LIVE now (no Doppler rail, no COMING/future-tense; kami 23836). */}
        <Card variant="panel">
          <SectionLabel>Trust</SectionLabel>
          <div className="mt-2 space-y-2 text-xs">
            <div className="flex items-center gap-2">
              <span className="rounded-md px-1.5 py-0.5 text-[10px] font-semibold" style={{ background: "rgba(52,199,123,0.12)", color: "#34C77B", border: "1px solid #34C77B40" }}>HYDE STACK · LIVE</span>
            </div>
            <p className="font-mono text-[11px] text-pcs-text">{engineMeta.feeSplitLabel}</p>
            <p className="text-[11px] leading-relaxed text-pcs-textSub">{engineMeta.trustLine}</p>
            {isV4Launch && (
              <p className="text-[11px] leading-relaxed text-pcs-textDim">
                <span className="font-semibold text-pcs-textSub">Launch protection:</span> swap fee decays 3%→1% over 5 minutes; 1% max-wallet for 5 minutes. Selling remains unrestricted.
              </p>
            )}
          </div>
        </Card>

      </div>
      </div>
    </div>
  );
}

/** Canonical /token/:address entry: resolves the param and renders TokenDetail with embedded trading. */
export function TokenPage(props: Props) {
  const { address = "" } = useParams();
  return <TokenDetail address={address} {...props} />;
}
