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
import { Card, Button, Stat, Progress, Badge, VerifiedBadge, SectionLabel } from "../components/ui/kit";

type Props = { network: NetworkConfig; tokens: TokenInfo[]; onAddCustomToken: (t: { address: `0x${string}`; symbol: string; name: string; decimals: number }) => void };

// resolve the DEXScreener robinhood pair (fail neutral → null; never a wrong pair)
function useDexPair(address?: string): { pair: string | null; checked: boolean } {
  const [pair, setPair] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    setChecked(false); setPair(null);
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
  }, [address]);
  return { pair, checked };
}

type Holder = { address: string; value: string };
function useTopHolders(address?: string): { holders: Holder[]; loading: boolean } {
  const [holders, setHolders] = useState<Holder[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!address) return;
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
  }, [address]);
  return { holders, loading };
}

const short = (a: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");

export function TokenPage({ network, tokens, onAddCustomToken }: Props) {
  const { address = "" } = useParams();
  const { pools } = useHydeLaunches();
  const verify = useVerifiedStatus(address);
  const { pair, checked } = useDexPair(address);
  const { holders } = useTopHolders(address);
  const [copied, setCopied] = useState(false);
  const [chartLoad, setChartLoad] = useState(false); // don't auto-embed DEXScreener's raw UI

  // Prefer the board pool (richer: precise graduation %); else read the token
  // directly by address so launches OUTSIDE the newest-60 page still render.
  const boardPool = useMemo(() => pools.find((p) => p.address.toLowerCase() === address.toLowerCase()), [pools, address]);
  const { pool: fetchedPool, loading: tokenLoading } = useHydeToken(address);
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
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-pcs-primary/40 to-pcs-cardLight font-display text-xl font-bold text-pcs-text">{sym.slice(0, 1).toUpperCase()}</div>
            <div className="min-w-0 flex-1">
              <h1 className="truncate font-display text-2xl font-bold text-pcs-text">{pool.baseToken.name} <span className="font-mono text-sm text-pcs-textSub">${sym}</span></h1>
              <div className="mt-1 flex items-center gap-2">
                <VerifiedBadge status={verify} />
                <Badge tone={graduated ? "success" : "accent"}>{graduated ? "Graduated" : "Auction"}</Badge>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="ghost" size="sm" onClick={() => { navigator.clipboard?.writeText(pool.address); setCopied(true); setTimeout(() => setCopied(false), 1200); }}>{copied ? "Copied" : short(pool.address)}</Button>
              <a href={`${network.explorerUrl}/address/${pool.address}`} target="_blank" rel="noreferrer"><Button variant="ghost" size="sm">Explorer ↗</Button></a>
              <Link to={`/token/${pool.address}/claim`}><Button variant="secondary" size="sm">Collect Fees</Button></Link>
            </div>
          </div>

          <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="Market Cap" value="—" />
            <Stat label="ATH" value="—" />
            <Stat label="24h Volume" value="—" />
            <Stat label="Price" value="—" />
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
          {chartLoad && pair ? (
            <iframe title="chart" src={`https://dexscreener.com/robinhood/${pair}?embed=1&theme=dark&info=0`} className="h-[460px] w-full border-0" />
          ) : (
            <div className="flex h-[460px] flex-col items-center justify-center gap-3 bg-pcs-input/40 px-6 text-center">
              <SectionLabel>Live chart</SectionLabel>
              {pair ? (
                <>
                  <p className="max-w-sm text-pcs-textSub">Live market chart for this pool on DEXScreener.</p>
                  <div className="flex flex-wrap items-center justify-center gap-2">
                    <Button variant="secondary" size="sm" onClick={() => setChartLoad(true)}>▶ Load live chart</Button>
                    <a href={`https://dexscreener.com/robinhood/${pair}`} target="_blank" rel="noreferrer"><Button variant="ghost" size="sm">Open on DEXScreener ↗</Button></a>
                  </div>
                </>
              ) : (
                <p className="max-w-sm text-pcs-textSub">{checked ? "Live chart appears once the token graduates to a Uniswap pool and is indexed on DEXScreener. Until then it trades on its Hyde auction curve." : "Checking for a live chart…"}</p>
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
            {/* reference-only in-app swap preview — dimmed + non-interactive until native swap carries the order */}
            <div className="mt-3 select-none rounded-xl p-3 opacity-50" style={{ background: "#171A21", border: "1px solid #22252D", pointerEvents: "none" }} aria-disabled>
              <div className="flex gap-2">
                <span className="flex-1 rounded-lg py-1.5 text-center text-xs font-semibold" style={{ background: "rgba(52,199,123,0.12)", color: "#34C77B" }}>Buy</span>
                <span className="flex-1 rounded-lg py-1.5 text-center text-xs font-semibold" style={{ background: "rgba(229,72,77,0.12)", color: "#E5484D" }}>Sell</span>
              </div>
              <div className="mt-2 flex gap-1.5">
                {["0.1", "0.5", "1"].map((v) => (
                  <span key={v} className="flex-1 rounded-md py-1 text-center font-mono text-[11px] tabular-nums" style={{ background: "#121419", color: "#8A93A2", border: "1px solid #22252D" }}>{v}</span>
                ))}
              </div>
              <p className="mt-2 font-mono text-[10px]" style={{ color: "#5B6472" }}>Native Hyde swap · preview — not live on this rail</p>
            </div>
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
            <p style={{ color: "#5B6472" }} className="font-mono text-[11px]">$1 flat launch · 90/5/5 (creator / buyback&amp;burn / Hydeout) · LP locked forever · anti-snipe max-wallet</p>
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
