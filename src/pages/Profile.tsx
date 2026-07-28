// Profile (Wave A screen 3) — HYDEOUT_DESIGN_SPEC §2.C, honest scope (kami/shiro).
// Real Blockscout token holdings FILTERED to Hyde launches = the centerpiece +
// one real "Hyde Tokens Held" stat. NO fabricated "Tokens Created" / "Portfolio
// Value" — those need own-stack factory attribution + a price source, shown as an
// honest roadmap line. Balances fail neutral, never block the page. No block-0 scans.
import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import toast from "react-hot-toast";
import { ConnectorAlreadyConnectedError, useAccount, useConnect, usePublicClient } from "wagmi";
import {
  ArrowTopRightOnSquareIcon,
  BanknotesIcon,
  ChartBarSquareIcon,
  CheckIcon,
  CircleStackIcon,
  ClipboardDocumentIcon,
  RocketLaunchIcon,
  ShieldCheckIcon,
  WalletIcon,
} from "@heroicons/react/24/outline";
import { isMainnetOwnStackLaunch, useHydeLaunches } from "../hooks/useDopplerTokens";
import { useVerifiedStatus } from "../hooks/useVerifiedStatus";
import { ROBINHOOD_MAINNET, V4_CONTRACTS_BY_CHAIN } from "../utils/constants";
import type { NetworkConfig } from "../utils/constants";
import { chainV3Capability } from "../utils/chainRegistry";
import { Card, Button, Stat, VerifiedBadge, SectionLabel } from "../components/ui/kit";
import { TokenImage } from "../components/TokenImage";
import { fetchLaunchMeta } from "../utils/launchMeta";
import type { DopplerPool } from "../utils/dopplerConfig";

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

const BALANCE_OF_ABI = [{
  type: "function",
  name: "balanceOf",
  stateMutability: "view",
  inputs: [{ name: "account", type: "address" }],
  outputs: [{ type: "uint256" }],
}] as const;

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

/** Stable has no Blockscout-dependent portfolio adapter. Read balances directly from the verified
 * HydeV3Pad launch set, so creator and public wallet profiles are live as soon as a launch confirms. */
function useStableV3Holdings(
  address: string,
  chainId: number,
  pools: DopplerPool[],
  enabled: boolean,
): { holdings: Holding[]; loading: boolean } {
  const publicClient = usePublicClient({ chainId });
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled || !publicClient || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
      setHoldings([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    Promise.all(pools.map(async (pool) => {
      const balance = await publicClient.readContract({
        address: pool.address as `0x${string}`,
        abi: BALANCE_OF_ABI,
        functionName: "balanceOf",
        args: [address as `0x${string}`],
      }).catch(() => 0n);
      return {
        address: pool.address.toLowerCase(),
        name: pool.baseToken.name,
        symbol: pool.baseToken.symbol,
        value: balance.toString(),
        decimals: pool.baseToken.decimals,
      } satisfies Holding;
    }))
      .then((rows) => {
        if (!cancelled) setHoldings(rows.filter((row) => BigInt(row.value) > 0n));
      })
      .catch(() => {
        if (!cancelled) setHoldings([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [address, enabled, pools, publicClient]);

  return { holdings, loading };
}

function RobinhoodHoldingRow({ h }: { h: Holding }) {
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
  const { connectAsync, connectors, isPending } = useConnect();
  const address = (routeAddr || connected || "").toLowerCase();
  const [copied, setCopied] = useState(false);
  const isV3Chain = !!chainV3Capability(network.id);
  const { pools, loading: launchesLoading } = useHydeLaunches(network.id);
  const robinhoodPortfolio = useHydeHoldings(address, !isV3Chain);
  const stablePortfolio = useStableV3Holdings(address, network.id, pools, isV3Chain);
  const holdings = isV3Chain ? stablePortfolio.holdings : robinhoodPortfolio.holdings;
  const loading = isV3Chain
    ? launchesLoading || stablePortfolio.loading
    : robinhoodPortfolio.loading;
  const myLaunches = address
    ? pools.filter((pool) => pool.creator?.toLowerCase() === address)
    : [];
  const connectWallet = async () => {
    const connector = connectors[0];
    if (!connector) {
      toast.error("Wallet connector not found");
      return;
    }
    try {
      await connectAsync({ connector });
    } catch (error) {
      if (error instanceof ConnectorAlreadyConnectedError) return;
      toast.error("Wallet connection failed");
    }
  };

  if (!address) {
    return (
      <div className="hyde-page hyde-profile mx-auto w-full max-w-[1040px] space-y-4" data-depth-label="Hideout · wallet depth">
        <section className="profile-vault-empty">
          <div className="profile-vault-copy">
            <div className="inline-flex items-center gap-2 rounded-full border border-pcs-primary/20 bg-pcs-primary/[0.06] px-3 py-1.5">
              <span className="hyde-pulse h-1.5 w-1.5 rounded-full bg-pcs-primary" />
              <span className="font-code text-[10px] uppercase tracking-[0.16em] text-pcs-primary">Private wallet depth</span>
            </div>
            <h1 className="mt-5 max-w-xl font-display text-3xl font-bold leading-tight text-pcs-text sm:text-[40px]">
              {isV3Chain
                ? "Your Stable launches and token positions—one layer down."
                : "Your launches, positions, and fees—one layer down."}
            </h1>
            <p className="mt-3 max-w-xl text-sm leading-6 text-pcs-textSub">
              Connect your wallet to reveal the Hydeout assets tied to it. Portfolio data is read from
              the selected chain and stays hidden until you connect.
            </p>
            <button
              type="button"
              className="btn-terminal mt-6 inline-flex items-center gap-2 px-5 py-2.5"
              onClick={connectWallet}
              disabled={isPending}
            >
              <WalletIcon className="h-4 w-4" />
              {isPending ? "Opening wallet…" : "Connect wallet"}
            </button>
            <p className="mt-3 flex items-center gap-1.5 text-[11px] text-pcs-textDim">
              <ShieldCheckIcon className="h-3.5 w-3.5 text-pcs-primary" />
              Read-only until you choose to sign a transaction.
            </p>
          </div>

          <div className="profile-vault-sonar" aria-hidden="true">
            <span className="profile-sonar-ring profile-sonar-ring-1" />
            <span className="profile-sonar-ring profile-sonar-ring-2" />
            <span className="profile-sonar-ring profile-sonar-ring-3" />
            <div className="profile-sonar-core">
              <WalletIcon className="h-8 w-8" />
            </div>
          </div>
        </section>

        <div className="grid gap-3 sm:grid-cols-3">
          {[
            { label: "My launches", detail: "Creator deployments", icon: RocketLaunchIcon },
            { label: "Token positions", detail: "Verified Hyde holdings", icon: CircleStackIcon },
            isV3Chain
              ? { label: "Creator fee route", detail: "95% paid in pool assets", icon: BanknotesIcon }
              : { label: "Claimable fees", detail: "Chain-scoped rewards", icon: BanknotesIcon },
          ].map(({ label, detail, icon: Icon }) => (
            <div key={label} className="profile-preview-card">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-pcs-primary/20 bg-pcs-primary/[0.07] text-pcs-primary">
                <Icon className="h-4.5 w-4.5" />
              </div>
              <div>
                <p className="text-sm font-semibold text-pcs-text">{label}</p>
                <p className="mt-0.5 text-[11px] text-pcs-textDim">{detail}</p>
              </div>
              <span className="ml-auto font-code text-[10px] uppercase tracking-wider text-pcs-textDim">Locked</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="hyde-page hyde-profile mx-auto w-full max-w-[1040px] space-y-4" data-depth-label="Hideout · wallet depth">
      <Card variant="hero" className="trench-profile-hero">
        <div className="relative z-[1] flex flex-col gap-4 sm:flex-row sm:items-center">
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-pcs-primary/25 bg-pcs-primary/[0.08] text-pcs-primary">
            <WalletIcon className="h-6 w-6" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-mono text-lg text-pcs-text">{short(address)}</p>
              <span className="rounded-full border border-pcs-primary/20 bg-pcs-primary/[0.07] px-2 py-0.5 font-code text-[9px] uppercase tracking-wider text-pcs-primary">
                {routeAddr ? "Public view" : "Connected"}
              </span>
            </div>
            <p className="mt-1 text-xs text-pcs-textDim">{network.name} · on-chain portfolio</p>
            <div className="mt-2 flex flex-wrap gap-1">
              <Button variant="ghost" size="sm" onClick={() => { navigator.clipboard?.writeText(address); setCopied(true); setTimeout(() => setCopied(false), 1200); }}>
                {copied ? <CheckIcon className="h-4 w-4" /> : <ClipboardDocumentIcon className="h-4 w-4" />}
                {copied ? "Copied" : "Copy address"}
              </Button>
              <a
                href={`${network.explorerUrl.replace(/\/$/, "")}/address/${address}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium text-pcs-textSub transition hover:bg-white/[0.04] hover:text-pcs-text"
              >
                Explorer <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" />
              </a>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:min-w-[280px]">
            <div className="sonar-metric rounded-xl border border-pcs-border bg-black/10 p-3">
              <Stat label="My launches" value={launchesLoading ? "—" : myLaunches.length} />
            </div>
            <div className="sonar-metric rounded-xl border border-pcs-border bg-black/10 p-3">
              <Stat label="Token positions" value={loading ? "—" : holdings.length} />
            </div>
          </div>
        </div>
      </Card>

      <div className="rounded-2xl border border-pcs-border bg-pcs-cardLight p-4 sm:p-5">
        <div className="flex items-center justify-between">
          <div>
            <SectionLabel>My launches</SectionLabel>
            <p className="mt-1 text-xs text-pcs-textDim">
              Creator deployments attributed by the selected chain’s launch events.
            </p>
          </div>
          <RocketLaunchIcon className="h-5 w-5 text-pcs-primary" />
        </div>
        {launchesLoading ? (
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {[0, 1].map((item) => <div key={item} className="h-[74px] animate-pulse rounded-xl border border-pcs-border bg-white/[0.02]" />)}
          </div>
        ) : myLaunches.length === 0 ? (
          <div className="mt-4 rounded-xl border border-dashed border-pcs-border bg-black/10 px-5 py-6 text-center">
            <p className="text-sm font-semibold text-pcs-text">No creator launches found</p>
            <p className="mt-1 text-xs text-pcs-textDim">Launch a token and it will appear here from its on-chain event.</p>
            <Link to="/launchpad?tab=launch" className="btn-ghost-term mt-4 inline-flex px-4 py-2 text-xs">
              Launch a token
            </Link>
          </div>
        ) : (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {myLaunches.map((pool) => <ProfileLaunchRow key={`${pool.chainId}-${pool.address}`} pool={pool} />)}
          </div>
        )}
      </div>

      <div className="rounded-2xl border border-pcs-border bg-pcs-cardLight p-4 sm:p-5">
        <div className="flex items-center justify-between">
          <div>
            <SectionLabel>Token holdings</SectionLabel>
            <p className="mt-1 text-xs text-pcs-textDim">
              {isV3Chain
                ? "Balances read directly across verified Stable V3 launches."
                : "Hydeout launches detected in this wallet."}
            </p>
          </div>
          <ChartBarSquareIcon className="h-5 w-5 text-pcs-primary" />
        </div>
        {loading ? (
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {[0, 1].map((item) => <div key={item} className="h-[74px] animate-pulse rounded-xl border border-pcs-border bg-white/[0.02]" />)}
          </div>
        ) : holdings.length === 0 ? (
          <div className="mt-4 flex flex-col items-center rounded-xl border border-dashed border-pcs-border bg-black/10 px-5 py-7 text-center">
            <CircleStackIcon className="h-6 w-6 text-pcs-textDim" />
            <p className="mt-3 text-sm font-semibold text-pcs-text">No Hydeout tokens detected</p>
            <p className="mt-1 max-w-md text-xs leading-5 text-pcs-textDim">
              Tokens from verified Hyde launches will surface here automatically.
            </p>
            <Link to="/discover" className="btn-ghost-term mt-4 inline-flex items-center gap-1.5 px-4 py-2 text-xs">
              Explore launches <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" />
            </Link>
          </div>
        ) : (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {holdings.map((h) => isV3Chain
              ? <StableHoldingRow key={h.address} h={h} />
              : <RobinhoodHoldingRow key={h.address} h={h} />)}
          </div>
        )}
      </div>

      <div className="flex items-start gap-3 rounded-xl border border-pcs-border bg-pcs-card px-4 py-3.5">
        <ShieldCheckIcon className="mt-0.5 h-5 w-5 shrink-0 text-pcs-primary" />
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-pcs-textSub">Portfolio coverage</p>
          <p className="mt-1 text-xs leading-5 text-pcs-textDim">
            {isV3Chain
              ? "Stable launches come from HydeV3Pad events and balances come from direct token reads. USD portfolio value stays hidden until a verified Stable market indexer is connected."
              : "Holdings are attributed on-chain. Creator history and priced portfolio value appear only when their verified data sources are available."}
          </p>
        </div>
      </div>
    </div>
  );
}

function StableHoldingRow({ h }: { h: Holding }) {
  const [image, setImage] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchLaunchMeta(988, h.address).then((meta) => {
      if (!cancelled) setImage(meta?.image || null);
    });
    return () => { cancelled = true; };
  }, [h.address]);

  return (
    <Link to={`/token/${h.address}?network=988`} className="block">
      <Card variant="token" interactive>
        <div className="flex items-center gap-3">
          <TokenImage
            src={image}
            symbol={h.symbol}
            className="h-10 w-10 shrink-0 rounded-xl text-sm"
          />
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold text-pcs-text">
              {h.name} <span className="font-mono text-xs text-pcs-textSub">${h.symbol}</span>
            </p>
            <p className="mt-1 font-code text-[9px] uppercase tracking-wider text-pcs-primary">
              Stable · V3 launch
            </p>
          </div>
          <span className="font-mono text-sm text-pcs-text">{fmtBalance(h.value, h.decimals)}</span>
        </div>
      </Card>
    </Link>
  );
}

function ProfileLaunchRow({ pool }: { pool: DopplerPool }) {
  const [image, setImage] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchLaunchMeta(pool.chainId, pool.address).then((meta) => {
      if (!cancelled) setImage(meta?.image || null);
    });
    return () => { cancelled = true; };
  }, [pool.address, pool.chainId]);

  return (
    <Link to={`/token/${pool.address}?network=${pool.chainId}`} className="block">
      <Card variant="token" interactive>
        <div className="flex items-center gap-3">
          <TokenImage
            src={image}
            symbol={pool.baseToken.symbol}
            className="h-10 w-10 shrink-0 rounded-xl text-sm"
          />
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold text-pcs-text">
              {pool.baseToken.name}{" "}
              <span className="font-mono text-xs text-pcs-textSub">${pool.baseToken.symbol}</span>
            </p>
            <p className="mt-1 text-[10px] text-pcs-textDim">
              {pool.launchEngine === "v3-single-sided" ? "V3 · 95% creator" : "V4 · 90% creator"}
            </p>
          </div>
          <span className="rounded-md border border-pcs-primary/20 bg-pcs-primary/[0.07] px-2 py-1 font-code text-[9px] uppercase tracking-wider text-pcs-primary">
            Live
          </span>
        </div>
      </Card>
    </Link>
  );
}
