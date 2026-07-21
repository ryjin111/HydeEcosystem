// Token / trade page (Wave A screen 2) — HYDEOUT_DESIGN_SPEC §2.B. Real feed via
// useHydeLaunches (honest 404 if not on the board). Chart = real DEXScreener
// embed when the token has a robinhood/uniswap pair, else a designed full-size
// fallback (never a collapsed hole). Swap = the EXISTING verified V4SwapCard
// (reskin/reuse only — no trade-logic change). Top holders via Blockscout, fail
// neutral. Restrictions copy = 3%→1% anti-snipe decay ONLY. No protocol touched.
import { useEffect, useMemo, useState } from "react";
import { useParams, Link } from "react-router-dom";
import type { NetworkConfig, TokenInfo } from "../utils/constants";
import { isGatewayLive } from "../utils/constants";
import { useHydeLaunches, useHydeToken } from "../hooks/useDopplerTokens";
import { useVerifiedStatus } from "../hooks/useVerifiedStatus";
import { V4SwapCard } from "../components/V4SwapCard";
import { TokenImage } from "../components/TokenImage";
import { fetchLaunchMeta, type LaunchMeta } from "../utils/launchMeta";
import { Card, Button, Stat, Progress, Badge, VerifiedBadge, SectionLabel } from "../components/ui/kit";

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

// Resolve this token's canonical GeckoTerminal pool (deepest reserve) for the chart embed.
// GeckoTerminal indexes the 4663 Uniswap-V4 curve pools by poolId, so a chart exists ON the
// auction curve — earlier than the DEXScreener graduation-only pair. Fail-neutral → null.
function useGeckoPool(address?: string, chainId?: number): { gtPool: string | null; gtChecked: boolean } {
  const [gtPool, setGtPool] = useState<string | null>(null);
  const [gtChecked, setGtChecked] = useState(false);
  useEffect(() => {
    setGtChecked(false); setGtPool(null);
    if (!address || chainId !== ROBINHOOD_MAINNET_ID) { setGtChecked(true); return; } // mainnet-only source
    let cancelled = false;
    fetch(`https://api.geckoterminal.com/api/v2/networks/robinhood/tokens/${address}/pools`, { headers: { accept: "application/json" } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const pools: { attributes?: { address?: string; reserve_in_usd?: string } }[] = d?.data ?? [];
        // deepest-reserve pool = the canonical one to chart (deterministic, never constructed)
        const top = pools
          .slice()
          .sort((a, b) => Number(b.attributes?.reserve_in_usd ?? 0) - Number(a.attributes?.reserve_in_usd ?? 0))[0];
        if (!cancelled) { setGtPool(top?.attributes?.address ?? null); setGtChecked(true); }
      })
      .catch(() => { if (!cancelled) setGtChecked(true); });
    return () => { cancelled = true; };
  }, [address, chainId]);
  return { gtPool, gtChecked };
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

/**
 * TokenDetail — the full token-detail layout, address-as-prop so it can render BOTH as its own
 * route AND embedded inside the /swap?out=<token> page (kami 23471: /swap is the canonical token
 * page). The thin `TokenPage` wrapper below preserves the old /token/:address entry.
 */
export function TokenDetail({ address, network, tokens, onAddCustomToken }: Props & { address: string }) {
  // Chain-scoped to the active network (clint #4): testnet and mainnet each read only their configured
  // own-stack launch sources — never cross-chain data.
  const { pools } = useHydeLaunches(network.id);
  const verify = useVerifiedStatus(address, network.id);
  const { pair } = useDexPair(address, network.id);
  const { gtPool, gtChecked } = useGeckoPool(address, network.id);
  const { holders } = useTopHolders(address, network.id);
  const [copied, setCopied] = useState(false);
  const [chartLoad, setChartLoad] = useState(false); // don't auto-embed DEXScreener's raw UI
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
  const { pool: fetchedPool, loading: tokenLoading } = useHydeToken(address, network.id);
  const pool = boardPool ?? fetchedPool;

  if (tokenLoading && !boardPool) return <div className="py-20 text-center text-pcs-textSub">Loading token…</div>;
  if (!pool) {
    return (
      <Card variant="panel" className="mx-auto max-w-lg text-center">
        <p className="py-6 text-pcs-textSub">This isn’t a Hydeout launch token.</p>
        <Link to="/discover"><Button variant="secondary">Back to Discover</Button></Link>
      </Card>
    );
  }

  const sym = pool.baseToken.symbol || "?";
  // graduated if the board says so, or if it has an indexed Uniswap pair (a live pool)
  const graduated = pool.type === "v2" || !!pair;

  return (
    <div className="mx-auto grid w-full max-w-[1200px] gap-5 lg:grid-cols-[1fr,380px]">
      {/* ---------- main ---------- */}
      <div className="space-y-5">
        <Card>
          <div className="flex flex-wrap items-center gap-3">
            {meta?.image ? (
              <TokenImage src={meta.image} symbol={sym} className="h-12 w-12 rounded-xl text-xl" style={{ border: "1px solid #22252D" }} />
            ) : (
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-pcs-primary/40 to-pcs-cardLight font-display text-xl font-bold text-pcs-text">{sym.slice(0, 1).toUpperCase()}</div>
            )}
            <div className="min-w-0 flex-1">
              <h1 className="truncate font-display text-2xl font-bold text-pcs-text">{pool.baseToken.name} <span className="font-mono text-sm text-pcs-textSub">${sym}</span></h1>
              <div className="mt-1 flex items-center gap-2">
                <VerifiedBadge status={verify} />
                <Badge tone={graduated ? "success" : "accent"}>{graduated ? "Graduated" : "Auction"}</Badge>
              </div>
              {meta?.description?.trim() && (
                <p className="mt-2 text-xs text-pcs-textSub leading-relaxed">{meta.description}</p>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="ghost" size="sm" onClick={() => { navigator.clipboard?.writeText(pool.address); setCopied(true); setTimeout(() => setCopied(false), 1200); }}>{copied ? "Copied" : short(pool.address)}</Button>
              <a href={`${network.explorerUrl}/address/${pool.address}`} target="_blank" rel="noreferrer"><Button variant="ghost" size="sm">Explorer ↗</Button></a>
              {/* Collect Fees hidden until a real claim action is wired (kami 23487) — no dead /claim route. */}
            </div>
          </div>

          {/* Real market stats from the DEXScreener pair (via the board feed). Each cell shows a
              real value or an honest "—" when the source is null — never a fabricated number. */}
          <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="Market Cap" value={pool.marketCapUsd != null && pool.marketCapUsd > 0 ? fmtUsd(pool.marketCapUsd) : "—"} />
            <Stat label="Price" value={pool.priceUsd != null && pool.priceUsd > 0 ? fmtPrice(pool.priceUsd) : "—"} />
            <Stat label="24h Volume" value={pool.volumeUsd != null && parseFloat(pool.volumeUsd) > 0 ? fmtUsd(parseFloat(pool.volumeUsd)) : "—"} />
            <Stat label="Liquidity" value={pool.dollarLiquidity != null && parseFloat(pool.dollarLiquidity) > 0 ? fmtUsd(parseFloat(pool.dollarLiquidity)) : "—"} />
          </div>

          {graduated ? (
            <div className="mt-4">
              <Progress pct={100} showLabel />
              <p className="mt-1 font-mono text-[11px] text-pcs-textDim">Graduated — liquidity migrated to a Uniswap pool.</p>
            </div>
          ) : pool.progress != null ? (
            <div className="mt-4">
              <Progress pct={pool.progress} showLabel />
              <p className="mt-1 font-mono text-[11px] text-pcs-textDim">On the launch curve · {pool.progress.toFixed(1)}% to graduation.</p>
            </div>
          ) : (
            <p className="mt-4 font-mono text-[11px] text-pcs-textDim">On the launch curve.</p>
          )}
          {new Date(pool.createdAt).getUTCFullYear() > 2020 && (
            <p className="mt-3 font-mono text-[11px] text-pcs-textDim">Launched {new Date(pool.createdAt).toLocaleString()}</p>
          )}
        </Card>

        {/* Chart zone — the default is ALWAYS our kit-styled panel; the raw
           DEXScreener embed (which can flash its own connecting/error UI on this
           L2) is NEVER first-class — it loads only on an explicit click (kami's
           chart gate). Indexed tokens get load-inline + open-external; others get
           the designed fallback. */}
        <Card className="p-0 overflow-hidden">
          {chartLoad && gtPool ? (
            <iframe title="chart" src={`https://www.geckoterminal.com/robinhood/pools/${gtPool}?embed=1&info=0&swaps=0`} className="h-[460px] w-full border-0" allow="clipboard-write" />
          ) : (
            <div className="flex h-[460px] flex-col items-center justify-center gap-3 bg-pcs-input/40 px-6 text-center">
              <SectionLabel>Live chart</SectionLabel>
              {gtPool ? (
                <>
                  <p className="max-w-sm text-pcs-textSub">Live price chart for this pool on GeckoTerminal.</p>
                  <div className="flex flex-wrap items-center justify-center gap-2">
                    <Button variant="secondary" size="sm" onClick={() => setChartLoad(true)}>▶ Load live chart</Button>
                    <a href={`https://www.geckoterminal.com/robinhood/pools/${gtPool}`} target="_blank" rel="noreferrer"><Button variant="ghost" size="sm">Open on GeckoTerminal ↗</Button></a>
                  </div>
                </>
              ) : (
                <p className="max-w-sm text-pcs-textSub">{!gtChecked
                  ? "Checking for a live chart…"
                  : network.id === ROBINHOOD_MAINNET_ID
                    ? "The live chart appears once this pool is indexed on GeckoTerminal (usually within a few minutes of launch). Until then it trades on its Hyde auction curve."
                    : "No external price chart on testnet — GeckoTerminal indexes Robinhood mainnet only. This token trades live on its Hyde auction curve, on-chain."}</p>
              )}
            </div>
          )}
        </Card>
      </div>

      {/* ---------- right rail ---------- */}
      <div className="space-y-5">
        {/* Rail-aware trade widget (§3.2). When the router genuinely goes live, the reused
           V4SwapCard executes; otherwise the primary action routes to the live pair and the
           in-app Buy/Sell is shown REFERENCE-ONLY (dimmed, non-interactive) — never implying
           Hyde submits/pre-fills an order it can't carry. Graduation is NEVER cited as a reason. */}
        {isGatewayLive(network.id) ? (
          <V4SwapCard network={network} tokens={tokens} onAddCustomToken={onAddCustomToken} forceTokenOut={pool.address.toLowerCase()} />
        ) : (
          <Card variant="panel">
            <SectionLabel>Trade</SectionLabel>
            {pair ? (
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
              <p className="mt-2 text-sm text-pcs-textSub">Native Hyde swap is not available for this rail yet. This token trades on its Hyde auction curve.</p>
            )}
            {/* Disabled Buy/Sell preview removed (kami 23517) — it read as a working swap; the live-pair
                link above is the single trade action until the native swap actually executes. */}
          </Card>
        )}

        {/* Trust card — LIVE vs Hyde-stack strictly bucketed (§3.3, §3.9). */}
        <Card variant="panel">
          <SectionLabel>Trust</SectionLabel>
          <div className="mt-2 space-y-2 text-xs">
            <div className="flex items-center gap-2">
              <span className="rounded-md px-1.5 py-0.5 text-[10px] font-semibold" style={{ background: "rgba(52,199,123,0.12)", color: "#34C77B", border: "1px solid #34C77B40" }}>LIVE</span>
              <VerifiedBadge status={verify} />
            </div>
            <p className="text-pcs-textSub">Current rail: <b className="text-pcs-text font-mono">95% creator / 5% Doppler</b> · anti-snipe swap fee <b className="text-pcs-text">3%→1%</b> (first hour) · no max-wallet, no blacklist.</p>
            <div className="my-2 h-px" style={{ background: "#22252D" }} />
            <p className="text-[10px] font-semibold tracking-wide" style={{ color: "#E0A32E" }}>COMING · HYDE STACK</p>
            <p style={{ color: "#5B6472" }} className="font-mono text-[11px]">0.0004 ETH flat launch · 90% creator · 5% Hyde · 5% auto-locked liquidity · anti-snipe max-wallet</p>
            <p style={{ color: "#5B6472" }} className="text-[11px] leading-relaxed">Live rail, that 5% is a Doppler skim. With Hyde launches it becomes your token&rsquo;s permanently-locked liquidity that grows as it earns fees, working for your token instead of a platform.</p>
          </div>
        </Card>

        <Card variant="panel">
          <SectionLabel>Top Holders</SectionLabel>
          {holders.length === 0 ? (
            <p className="mt-3 text-sm text-pcs-textDim">Holder data unavailable right now.</p>
          ) : (
            <div className="mt-3 space-y-1.5">
              {holders.map((h, i) => (
                <a key={h.address + i} href={`${network.explorerUrl}/address/${h.address}`} target="_blank" rel="noreferrer" className="flex items-center justify-between text-xs hover:text-pcs-text">
                  <span className="font-mono text-pcs-textSub">#{i + 1} {short(h.address)}</span>
                </a>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

/** Thin wrapper preserving the /token/:address entry — resolves the param then renders TokenDetail.
 *  App redirects /token/:address → /swap?out= (kami 23477), but this keeps the component reusable. */
export function TokenPage(props: Props) {
  const { address = "" } = useParams();
  return <TokenDetail address={address} {...props} />;
}
