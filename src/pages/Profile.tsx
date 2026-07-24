// Profile (Wave A screen 3) — HYDEOUT_DESIGN_SPEC §2.C, honest scope (kami/shiro).
// Real Blockscout token holdings FILTERED to Hyde launches = the centerpiece +
// one real "Hyde Tokens Held" stat. NO fabricated "Tokens Created" / "Portfolio
// Value" — those need own-stack factory attribution + a price source, shown as an
// honest roadmap line. Balances fail neutral, never block the page. No block-0 scans.
import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useAccount } from "wagmi";
import { isMainnetOwnStackLaunch } from "../hooks/useDopplerTokens";
import { useVerifiedStatus } from "../hooks/useVerifiedStatus";
import { ROBINHOOD_MAINNET, V4_CONTRACTS_BY_CHAIN } from "../utils/constants";
import type { NetworkConfig } from "../utils/constants";
import { ComingChainNotice } from "../components/ComingChainNotice";
import { chainSupportsTrade } from "../utils/chainRegistry";
import { Card, Button, Stat, VerifiedBadge, SectionLabel } from "../components/ui/kit";

// Base numeraire assets are pool pairs, never "a launch you hold" — excluded from Hyde holdings so
// launching LILHOODIE never surfaces $HOODIE as a holding (kami 23886).
const BASE_ASSETS = new Set(
  [ROBINHOOD_MAINNET.weth, V4_CONTRACTS_BY_CHAIN[ROBINHOOD_MAINNET.id]?.hoodieNumeraire]
    .filter(Boolean)
    .map((a) => (a as string).toLowerCase()),
);

const EXPLORER = "https://robinhoodchain.blockscout.com";
const short = (a: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
type Holding = { address: string; name: string; symbol: string; value: string; decimals: number };

function fmtBalance(value: string, decimals: number): string {
  try {
    const n = Number(BigInt(value)) / 10 ** decimals;
    return n >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  } catch { return "0"; }
}

// Real ERC-20 holdings from Blockscout, filtered to Hyde launch tokens (cheap
// getCode proxy check each; capped). Fails neutral → empty, never throws.
function useHydeHoldings(address?: string, enabled = true): { holdings: Holding[]; loading: boolean } {
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    // No portfolio request on a non-trade chain (kami 24323 #4): this query is Robinhood-scoped, so it must
    // NOT fire for Stable etc. — gate it, don't just hide the render.
    if (!enabled || !address || !/^0x[0-9a-fA-F]{40}$/.test(address)) { setHoldings([]); setLoading(false); return; }
    let cancelled = false;
    setHoldings([]); // clear the prior wallet's holdings before refetch (no stale carry-over)
    setLoading(true);
    fetch(`${EXPLORER}/api/v2/addresses/${address}/tokens?type=ERC-20`)
      .then((r) => (r.ok ? r.json() : null))
      .then(async (d) => {
        const items: Holding[] = (d?.items ?? []).slice(0, 40)
          .map((i: { token?: { address_hash?: string; address?: string; name?: string; symbol?: string; decimals?: string }; value?: string }) => ({
            address: (i.token?.address_hash ?? i.token?.address ?? "").toLowerCase(),
            name: i.token?.name ?? "Token", symbol: i.token?.symbol ?? "?",
            value: i.value ?? "0", decimals: Number(i.token?.decimals ?? 18),
          }))
          .filter((h: Holding) => /^0x[0-9a-fA-F]{40}$/.test(h.address) && !BASE_ASSETS.has(h.address));
        // Authoritative own-stack attribution (LaunchCreated / HoodieLaunchCreated) — admits HOODIE-engine
        // launches (LILHOODIE) the old clone-bytecode check missed, never the base assets (kami 23886).
        const isHyde = await Promise.all(items.map((h) => isMainnetOwnStackLaunch(h.address as `0x${string}`).catch(() => false)));
        const hyde = items.filter((_, i) => isHyde[i]);
        if (!cancelled) setHoldings(hyde);
      })
      .catch(() => { /* fail neutral → empty */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [address, enabled]);
  return { holdings, loading };
}

function HoldingRow({ h }: { h: Holding }) {
  const verify = useVerifiedStatus(h.address);
  return (
    <Link to={`/token/${h.address}`} className="block">
      <Card variant="token" interactive>
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-pcs-primary/40 to-pcs-cardLight font-display font-bold text-pcs-text">{h.symbol.slice(0, 1).toUpperCase()}</div>
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold text-pcs-text">{h.name} <span className="font-mono text-xs text-pcs-textSub">${h.symbol}</span></p>
            <VerifiedBadge status={verify} />
          </div>
          <span className="font-mono text-sm text-pcs-text">{fmtBalance(h.value, h.decimals)}</span>
        </div>
      </Card>
    </Link>
  );
}

export function ProfilePage({ network }: { network: NetworkConfig }) {
  const { address: routeAddr } = useParams();
  const { address: connected } = useAccount();
  const address = (routeAddr || connected || "").toLowerCase();
  const [copied, setCopied] = useState(false);
  const supportsTrade = chainSupportsTrade(network.id);
  const { holdings, loading } = useHydeHoldings(address, supportsTrade);

  // Fail closed where the registry says the chain has no in-app V4 trade (Stable V3): portfolio isn't
  // tracked, and the Robinhood-scoped holdings request above is disabled (kami 24323 #1/#4).
  if (!supportsTrade) {
    return (
      <div className="pt-8">
        <ComingChainNotice chainName={network.name} feature="Portfolio" />
      </div>
    );
  }

  if (!address) {
    return (
      <Card variant="panel" className="mx-auto max-w-lg text-center">
        <p className="py-6 text-pcs-textSub">Connect a wallet, or open a profile at /profile/&lt;address&gt;.</p>
      </Card>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[900px] space-y-5">
      <Card variant="hero">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <div className="h-14 w-14 shrink-0 rounded-2xl bg-gradient-to-br from-pcs-primary/50 to-pcs-cardLight" />
          <div className="min-w-0 flex-1">
            <p className="font-mono text-lg text-pcs-text">{short(address)}</p>
            <div className="mt-1 flex flex-wrap gap-2">
              <Button variant="ghost" size="sm" onClick={() => { navigator.clipboard?.writeText(address); setCopied(true); setTimeout(() => setCopied(false), 1200); }}>{copied ? "Copied" : "Copy address"}</Button>
              <a href={`${EXPLORER}/address/${address}`} target="_blank" rel="noreferrer"><Button variant="ghost" size="sm">Explorer ↗</Button></a>
            </div>
          </div>
          <Stat label="Hyde Tokens Held" value={loading ? "—" : holdings.length} />
        </div>
      </Card>

      <div>
        <SectionLabel>Token Holdings</SectionLabel>
        {loading ? (
          <p className="py-10 text-center text-pcs-textSub">Loading holdings…</p>
        ) : holdings.length === 0 ? (
          <Card variant="panel"><p className="py-6 text-center text-pcs-textSub">No Hydeout launch tokens held by this wallet.</p></Card>
        ) : (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">{holdings.map((h) => <HoldingRow key={h.address} h={h} />)}</div>
        )}
      </div>

      <Card variant="panel">
        <SectionLabel>Launch history & portfolio value</SectionLabel>
        <p className="mt-2 text-sm text-pcs-textSub">Full launch history and portfolio value arrive with Hyde factory launches — including on-chain creator attribution and token pricing.</p>
      </Card>
    </div>
  );
}
