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
import { useHydeLaunches } from "../hooks/useDopplerTokens";
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
  const { pools, loading } = useHydeLaunches();
  const verify = useVerifiedStatus(address);
  const { pair, checked } = useDexPair(address);
  const { holders } = useTopHolders(address);
  const [copied, setCopied] = useState(false);

  const pool = useMemo(() => pools.find((p) => p.address.toLowerCase() === address.toLowerCase()), [pools, address]);

  if (loading) return <div className="py-20 text-center text-pcs-textSub">Loading token…</div>;
  if (!pool) {
    return (
      <Card variant="panel" className="mx-auto max-w-lg text-center">
        <p className="py-6 text-pcs-textSub">This token isn’t on the Hydeout board.</p>
        <Link to="/discover"><Button variant="secondary">Back to Discover</Button></Link>
      </Card>
    );
  }

  const sym = pool.baseToken.symbol || "?";
  const graduated = pool.type === "v2";

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

          {pool.progress != null && (
            <div className="mt-4">
              <Progress pct={pool.progress} showLabel />
              <p className="mt-1 font-mono text-[11px] text-pcs-textDim">{graduated ? "Graduated — liquidity migrated to a Uniswap pool." : `On the launch curve · ${pool.progress.toFixed(1)}% to graduation.`}</p>
            </div>
          )}
          <p className="mt-3 font-mono text-[11px] text-pcs-textDim">Launched {new Date(pool.createdAt).toLocaleString()}</p>
        </Card>

        {/* chart zone — real embed when indexed, designed fallback otherwise */}
        <Card className="p-0 overflow-hidden">
          {pair ? (
            <iframe title="chart" src={`https://dexscreener.com/robinhood/${pair}?embed=1&theme=dark&info=0`} className="h-[460px] w-full border-0" />
          ) : (
            <div className="flex h-[460px] flex-col items-center justify-center gap-2 bg-pcs-input/40 text-center">
              <SectionLabel>Live chart</SectionLabel>
              <p className="max-w-sm text-pcs-textSub">{checked ? "Live chart appears once the token graduates to a Uniswap pool and is indexed on DEXScreener. Until then it trades on its Hyde auction curve." : "Checking for a live chart…"}</p>
            </div>
          )}
        </Card>
      </div>

      {/* ---------- right rail ---------- */}
      <div className="space-y-5">
        <Card variant="panel">
          <SectionLabel>Trading restrictions</SectionLabel>
          <p className="mt-2 text-sm text-pcs-textSub">Anti-snipe: the swap fee <b className="text-pcs-text">starts at 3% and decays to 1%</b> over the first hour after launch. No max-wallet cap, no blacklist.</p>
        </Card>

        {/* Swap: correct routing needs live gateway + dopplerPool metadata. On
           this chain isGatewayLive() is false + launch tokens carry no routing
           metadata, so an executable widget would route wrong / mislead. Present
           an HONEST disabled state instead (kami correctness gate); the reused
           V4SwapCard renders only where the router is genuinely live. */}
        {isGatewayLive(network.id) ? (
          <V4SwapCard network={network} tokens={tokens} onAddCustomToken={onAddCustomToken} forceTokenOut={pool.address.toLowerCase()} />
        ) : (
          <Card variant="panel">
            <SectionLabel>Trade</SectionLabel>
            <p className="mt-2 text-sm text-pcs-textSub">In-app swap isn’t live on {network.name} yet. This token trades on its Hyde auction curve — a swap router UI is coming.</p>
            {graduated && (
              <a href={`https://dexscreener.com/robinhood/${pool.address}`} target="_blank" rel="noreferrer" className="mt-3 inline-block"><Button variant="secondary" size="sm">View market ↗</Button></a>
            )}
          </Card>
        )}
        <p className="text-center font-mono text-[11px] text-pcs-textDim">Swap fee: 3%→1% (first hour) · 95% creator · 5% Doppler · 0% platform</p>

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
