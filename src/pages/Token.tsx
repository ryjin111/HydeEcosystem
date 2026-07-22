// Token / trade page (Wave A screen 2) — HYDEOUT_DESIGN_SPEC §2.B. Real feed via
// useHydeLaunches (honest 404 if not on the board). Chart = real DEXScreener
// embed when the token has a robinhood/uniswap pair, else a designed full-size
// fallback (never a collapsed hole). Swap = the EXISTING verified V4SwapCard
// (reskin/reuse only — no trade-logic change). Top holders via Blockscout, fail
// neutral. Restrictions copy = 3%→1% anti-snipe decay ONLY. No protocol touched.
import { useEffect, useMemo, useState } from "react";
import { useParams, Link } from "react-router-dom";
import type { NetworkConfig, TokenInfo } from "../utils/constants";
import { isGatewayLive, V4_CONTRACTS_BY_CHAIN } from "../utils/constants";
import { useHydeLaunches, useHydeToken } from "../hooks/useDopplerTokens";
import { V4SwapCard } from "../components/V4SwapCard";
import { HoodieSwapCard } from "../components/HoodieSwapCard";
import { TokenImage } from "../components/TokenImage";
import { fetchLaunchMeta, type LaunchMeta } from "../utils/launchMeta";
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

/**
 * TokenDetail — the full token-detail layout, address-as-prop so it can render BOTH as its own
 * route AND embedded inside the /swap?out=<token> page (kami 23471: /swap is the canonical token
 * page). The thin `TokenPage` wrapper below preserves the old /token/:address entry.
 */
export function TokenDetail({ address, network, tokens, onAddCustomToken }: Props & { address: string }) {
  // Chain-scoped to the active network (clint #4): testnet and mainnet each read only their configured
  // own-stack launch sources — never cross-chain data.
  const { pools } = useHydeLaunches(network.id);
  const { pair } = useDexPair(address, network.id);
  const { holders } = useTopHolders(address, network.id);
  const [copied, setCopied] = useState(false);
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

  // HOODIE-numeraire own-stack pool → live in-app Buy/Sell via the canonical UniversalRouter (the Hyde
  // gateway isn't deployed on 4663). Detected by the pool's quote token matching the configured $HOODIE
  // numeraire — inherently mainnet-only (only 4663 has `hoodieNumeraire` set). WETH pairs keep the
  // gateway-gated / reference-only rail below, untouched.
  const hoodieNumeraire = V4_CONTRACTS_BY_CHAIN[network.id]?.hoodieNumeraire;
  const isHoodiePair = !!hoodieNumeraire && pool.quoteToken?.address?.toLowerCase() === hoodieNumeraire.toLowerCase();

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
                {/* Own-stack Hyde/HOODIE launch — trades live in a locked-liquidity pool; no auction
                    curve, no graduation, no "Verified" badge (removed: clint/kami/shiro 23798-23804). */}
                <span className="rounded-md px-1.5 py-0.5 text-[10px] font-semibold" style={{ background: "rgba(52,199,123,0.12)", color: "#34C77B", border: "1px solid #34C77B40" }}>LIVE</span>
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

          {/* Truthful live state (no graduation bar/percentage — these tokens launch straight into a
              locked-liquidity pool, they don't graduate off an auction curve; clint/kami 23798-23802). */}
          <div className="mt-4 flex items-center gap-2">
            <span className="inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full" style={{ background: "#34C77B" }} />
            <p className="font-mono text-[11px] text-pcs-textDim">Liquidity locked · single-sided seed, auto-compounding as it earns fees.</p>
          </div>
          {new Date(pool.createdAt).getUTCFullYear() > 2020 && (
            <p className="mt-3 font-mono text-[11px] text-pcs-textDim">Launched {new Date(pool.createdAt).toLocaleString()}</p>
          )}
        </Card>

        {/* Chart — self-hosted price history (candles from on-chain PoolManager Swap events) is a
            separate post-swap task (gojo/kami 23826-23829); no GeckoTerminal dependency/ETA on 4663.
            Until that feed ships, an honest "warming up" state: LIVE on-chain, a NEUTRAL decorative
            shimmer skeleton (never fabricated candles/axes/numbers), no external-indexer claim, and no
            CTA to a not-yet-enabled swap. */}
        <Card className="p-0 overflow-hidden">
          <div
            className="relative flex h-[340px] flex-col items-center justify-center gap-4 px-6 text-center"
            style={{ background: "radial-gradient(120% 90% at 50% 0%, rgba(46,159,230,0.05), transparent 60%), #0E1013" }}
          >
            {/* subtle chart grid — decorative only */}
            <div
              className="pointer-events-none absolute inset-0 opacity-[0.05]"
              style={{ backgroundImage: "linear-gradient(#fff 1px, transparent 1px), linear-gradient(90deg, #fff 1px, transparent 1px)", backgroundSize: "34px 34px" }}
            />
            <span
              className="relative z-10 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-semibold tracking-wide"
              style={{ background: "rgba(52,199,123,0.12)", color: "#34C77B", border: "1px solid #34C77B40" }}
            >
              <span className="hyde-pulse inline-block h-1.5 w-1.5 rounded-full" style={{ background: "#34C77B" }} />
              LIVE · LOCKED LIQUIDITY
            </span>
            {/* neutral shimmer skeleton — loading bars only, NEVER fabricated candles/prices (honesty rule) */}
            <div className="relative z-10 flex h-16 items-end gap-1.5" aria-hidden="true">
              {[9, 5, 12, 7, 14, 6, 11, 8, 13, 5, 10, 7].map((h, i) => (
                <span key={i} className="hyde-shimmer w-2 rounded-sm" style={{ height: `${h * 4}px`, background: "rgba(255,255,255,0.06)", animationDelay: `${i * 90}ms` }} />
              ))}
            </div>
            <div className="relative z-10">
              <p className="font-display text-sm font-semibold text-pcs-text">Chart warming up</p>
              <p className="mt-1 max-w-sm text-xs text-pcs-textSub">Trading is live on-chain. Price history begins with on-chain swaps.</p>
            </div>
          </div>
        </Card>
      </div>

      {/* ---------- right rail ---------- */}
      <div className="space-y-5">
        {/* Rail-aware trade widget (§3.2). When the router genuinely goes live, the reused
           V4SwapCard executes; otherwise the primary action routes to the live pair and the
           in-app Buy/Sell is shown REFERENCE-ONLY (dimmed, non-interactive) — never implying
           Hyde submits/pre-fills an order it can't carry. Graduation is NEVER cited as a reason. */}
        {isHoodiePair ? (
          <HoodieSwapCard
            network={network}
            token={{ address: pool.address as `0x${string}`, symbol: sym, name: pool.baseToken.name, decimals: pool.baseToken.decimals }}
          />
        ) : isGatewayLive(network.id) ? (
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
              <p className="mt-2 text-sm text-pcs-textSub">In-app swap for this token is coming shortly. It trades live now on its locked-liquidity pool, on-chain.</p>
            )}
            {/* Disabled Buy/Sell preview removed (kami 23517) — it read as a working swap; the live-pair
                link above is the single trade action until the native swap actually executes. */}
          </Card>
        )}

        {/* Trust card — the Hyde stack is LIVE now (no Doppler rail, no COMING/future-tense; kami 23836). */}
        <Card variant="panel">
          <SectionLabel>Trust</SectionLabel>
          <div className="mt-2 space-y-2 text-xs">
            <div className="flex items-center gap-2">
              <span className="rounded-md px-1.5 py-0.5 text-[10px] font-semibold" style={{ background: "rgba(52,199,123,0.12)", color: "#34C77B", border: "1px solid #34C77B40" }}>HYDE STACK · LIVE</span>
            </div>
            <p className="font-mono text-[11px] text-pcs-text">90% creator · 5% Hyde · 5% locked liquidity</p>
            <p className="text-[11px] leading-relaxed text-pcs-textSub">Liquidity is custody-locked and auto-compounds as fees accrue.</p>
            <p className="text-[11px] leading-relaxed text-pcs-textDim">
              <span className="font-semibold text-pcs-textSub">Launch protection:</span> swap fee decays 3%→1% over 5 minutes; 1% max-wallet for 5 minutes. Selling remains unrestricted.
            </p>
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
