import { useEffect, useMemo, useState } from "react";
import { NavLink } from "react-router-dom";
import toast from "react-hot-toast";
import { ConnectorAlreadyConnectedError, useAccount, useConnect } from "wagmi";
import { useAllHydeLaunches } from "../hooks/useAllHydeLaunches";
import type { DopplerPool } from "../utils/dopplerConfig";
import { chainEngineCapabilities, isHydeLaunchLive } from "../utils/chainRegistry";
import { NETWORKS } from "../utils/constants";
import { CoinCard } from "./Discover";
import { useTrenchV5Ready } from "../hooks/useTrenchV5Ready";
import { isTrenchV5PubliclyAvailable } from "../utils/trenchV5";

const ROBINHOOD_CHAIN_ID = 4663;
const MARKET_ROW_COUNT = 6;

type MarketSort = "volume" | "new" | "liquidity" | "mcap";
type MarketEngine = DopplerPool["launchEngine"] | "all";
type ChainScope = "all" | number;

const MARKET_TABS: { id: MarketSort; label: string }[] = [
  { id: "volume", label: "24h Volume" },
  { id: "new", label: "New" },
  { id: "liquidity", label: "Top Liquidity" },
  { id: "mcap", label: "Top MCap" },
];

const MARKET_ENGINE_TABS: { id: DopplerPool["launchEngine"]; label: string }[] = [
  { id: "v4-hook", label: "V4" },
  { id: "v3-single-sided", label: "V3" },
];

function numeric(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sumKnown(values: (string | number | null | undefined)[]): number | null {
  const known = values.map(numeric).filter((value): value is number => value !== null);
  return known.length > 0 ? known.reduce((sum, value) => sum + value, 0) : null;
}

function formatUsd(value: number | null, compact = false): string {
  if (value == null) return "—";
  if (compact && value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (compact && value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (compact && value >= 10_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: value < 1 ? 6 : 2 })}`;
}

function sortMarket(pools: DopplerPool[], sort: MarketSort): DopplerPool[] {
  return [...pools].sort((a, b) => {
    const newestFirst = () => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    if (sort === "new") {
      return newestFirst();
    }
    if (sort === "liquidity") {
      return (numeric(b.dollarLiquidity) ?? -1) - (numeric(a.dollarLiquidity) ?? -1)
        || newestFirst();
    }
    if (sort === "mcap") {
      return (numeric(b.marketCapUsd) ?? -1) - (numeric(a.marketCapUsd) ?? -1)
        || newestFirst();
    }
    return (
      (numeric(b.volumeUsd) ?? -1) - (numeric(a.volumeUsd) ?? -1)
      || (numeric(b.marketCapUsd) ?? -1) - (numeric(a.marketCapUsd) ?? -1)
      || newestFirst()
    );
  });
}

/** Pro-Terminal landing surface (approved mock 24229).
 *  The layout follows the reference; every number and readiness state remains chain/data-derived.
 */
export function LandingPage({ chainId = ROBINHOOD_CHAIN_ID }: { chainId?: number }) {
  const { pools: allPools, sources, loading, error, warning, refetch } = useAllHydeLaunches();
  const { address, isConnected } = useAccount();
  const { connectAsync, connectors, isPending } = useConnect();
  const [chainScope, setChainScope] = useState<ChainScope>("all");
  const [marketSort, setMarketSort] = useState<MarketSort>("volume");
  const [marketEngine, setMarketEngine] = useState<MarketEngine>("all");

  const capabilities = chainEngineCapabilities(chainId);
  const capability = capabilities[0];
  const chainName = capability?.name
    ?? NETWORKS.find((network) => network.id === chainId)?.name
    ?? `Chain ${chainId}`;
  const hasEngine = capabilities.length > 0;
  const launchLive = isHydeLaunchLive(chainId);
  const { ready: v5Ready } = useTrenchV5Ready(chainId);
  const publicMainnetPending = !isTrenchV5PubliclyAvailable(chainId);
  const isStableV3 = capabilities.length > 0 && capabilities.every((item) => item.engine === "v3-single-sided");
  const pools = useMemo(
    () => chainScope === "all"
      ? allPools
      : allPools.filter((pool) => pool.chainId === chainScope),
    [allPools, chainScope],
  );
  const marketCapabilities = chainScope === "all"
    ? NETWORKS.flatMap((network) => chainEngineCapabilities(network.id))
    : chainEngineCapabilities(chainScope);
  const scopeIsStableV3 = marketCapabilities.length > 0
    && marketCapabilities.every((item) => item.engine === "v3-single-sided");
  const supportedMarketEngines = marketCapabilities
    .filter((item) => item.status !== "unsupported")
    .map((item) => item.engine);
  const scopedSource = chainScope === "all"
    ? null
    : sources.find((source) => source.chainId === chainScope);
  const scopeLoading = chainScope === "all" ? loading : (scopedSource?.loading ?? false);
  const scopeError = chainScope === "all" ? error : (scopedSource?.error ?? null);
  const scopeName = chainScope === "all"
    ? "All chains"
    : (scopedSource?.name ?? `Chain ${chainScope}`);

  useEffect(() => {
    setMarketSort("volume");
    setMarketEngine("all");
  }, [chainId]);

  useEffect(() => {
    setMarketEngine("all");
  }, [chainScope]);

  const marketRows = useMemo(
    () => sortMarket(
      marketEngine === "all"
        ? pools
        : pools.filter((pool) => pool.launchEngine === marketEngine),
      marketSort,
    ).slice(0, MARKET_ROW_COUNT),
    [pools, marketSort, marketEngine],
  );
  const volume24h = useMemo(() => sumKnown(pools.map((pool) => pool.volumeUsd)), [pools]);
  const lockedLiquidity = useMemo(() => sumKnown(pools.map((pool) => pool.dollarLiquidity)), [pools]);
  const liveNetworkCount = sources.filter((source) => !source.error).length;

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

  return (
    <div className="hyde-page hyde-home w-full" data-depth-label="Hydeout surface · live protocol">
      {/* Four-stat protocol bar. Unknown aggregates render as em dashes, never fabricated zeroes. */}
      <section className="term-panel mb-4 grid overflow-hidden rounded-lg grid-cols-2 lg:grid-cols-4">
        <ProtocolStat
          label="Total launches"
          value={(scopeLoading && pools.length === 0) || scopeError ? "—" : pools.length.toLocaleString("en-US")}
        />
        <ProtocolStat label="24h volume" value={formatUsd(volume24h, true)} accent />
        <ProtocolStat
          label={chainScope === "all" ? "Live networks" : (scopeIsStableV3 ? "Locked positions" : "LP locked")}
          value={chainScope === "all"
            ? liveNetworkCount.toLocaleString("en-US")
            : scopeIsStableV3
              ? (scopeLoading || scopeError ? "—" : pools.length.toLocaleString("en-US"))
              : formatUsd(lockedLiquidity, true)}
          note={chainScope === "all" ? "aggregated" : undefined}
        />
        <ProtocolStat
          label="Fees → creators"
          value={chainScope === "all" ? "90–95%" : (scopeIsStableV3 ? "95%" : "90%")}
          note={chainScope === "all" ? "by engine" : (scopeIsStableV3 ? "in kind" : "plus 5% auto LP")}
        />
      </section>

      {/* Reference hero band: copy on the left, protocol-volume stage on the right. */}
      <section className="surface-hero term-panel mb-6 grid overflow-hidden rounded-lg lg:grid-cols-[1.08fr,0.92fr]">
        <div className="relative z-[1] px-5 py-6 sm:px-7 sm:py-8">
          <p className="term-label mb-3">
            {publicMainnetPending
              ? `${chainName} · coming soon`
              : v5Ready
                ? "V5 Trench Curve · live"
                : launchLive
                  ? "Legacy markets live · V5 pending"
                  : "Launch rail coming soon"}
          </p>
          <h1 className="font-display text-[34px] font-bold leading-[1.03] text-[var(--term-text)] sm:text-[44px]">
            Launch a token.
            <br />
            <span className="term-teal">
              Liquidity locked forever.
            </span>
          </h1>
          <p className="mt-4 max-w-[610px] text-sm leading-6 text-[var(--term-sub)]">
            {publicMainnetPending ? (
              <>
                <strong className="font-semibold text-[var(--term-text)]">{chainName} public mainnet is not live yet.</strong>{" "}
                The network remains visible for preview, but launches, swaps, claims, and liquidity actions are disabled.
              </>
            ) : v5Ready ? (
              <>
                <strong className="font-semibold text-[var(--term-text)]">V5 Trench Curve is verified on {chainName}.</strong>{" "}
                80% enters a live pool-native curve and 20% is reserved for graduation into permanently
                custodied {isStableV3 ? "V3" : "V4"} liquidity.
              </>
            ) : !launchLive && !hasEngine ? (
              <>
                <strong className="font-semibold text-[var(--term-text)]">{chainName} network access is connected.</strong>{" "}
                Wallet, RPC, and explorer context are available. Launches, swaps, claims, and liquidity
                remain disabled until Hydeout deploys and verifies a chain-specific engine.
              </>
            ) : !launchLive ? (
              <>
                <strong className="font-semibold text-[var(--term-text)]">Uniswap V4 is live on {chainName}.</strong>{" "}
                Hydeout launches remain disabled until the chain-specific factory, hook, vault, and fee
                path are deployed and verified.
              </>
            ) : isStableV3 ? (
              <>
                <strong className="font-semibold text-[var(--term-text)]">Legacy Stable markets remain live.</strong>{" "}
                Existing instant V3 launches keep trading and fee claims while V5 deployment is pending.
              </>
            ) : (
              <>
                <strong className="font-semibold text-[var(--term-text)]">Legacy {chainName} markets remain live.</strong>{" "}
                Existing instant V4 launches keep trading and fee claims while V5 deployment is pending.
              </>
            )}
          </p>
          <div className="mt-5 flex flex-wrap gap-2.5">
            {v5Ready ? (
              <NavLink to="/launchpad?tab=launch" className="btn-terminal px-5 py-2.5">
                Launch a Token
              </NavLink>
            ) : (
              <button type="button" className="btn-terminal px-5 py-2.5" disabled>
                {publicMainnetPending ? "Coming soon" : "V5 deployment pending"}
              </button>
            )}
          </div>
        </div>

        <div
          className="relative z-[1] flex min-h-[180px] flex-col justify-center px-5 py-6 sm:px-7 lg:border-l"
          style={{ borderColor: "var(--term-border)" }}
        >
          <p className="term-label">Protocol volume · 30d</p>
          <div className="relative mt-4 h-24 overflow-hidden rounded-md border border-dashed border-[var(--term-border)] bg-[var(--term-panel-2)]">
            <div className="absolute inset-x-0 top-1/3 border-t border-[var(--term-border-soft)]" />
            <div className="absolute inset-x-0 top-2/3 border-t border-[var(--term-border-soft)]" />
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="font-code text-[11px] uppercase tracking-[0.14em] text-[var(--term-dim)]">
                Historical series not indexed
              </span>
            </div>
          </div>
          <p className="mt-3 text-[11px] text-[var(--term-dim)]">
            Live pool rows below show only currently indexed on-chain and market data.
          </p>
        </div>
      </section>

      {/* Card-first discovery mirrors the token-first launchpad flow: pick a token, then trade on its page. */}
      <section id="live-market" className="mb-7 scroll-mt-28">
        <div className="mb-3 flex items-center gap-3">
          <div>
            <h2 className="font-display text-sm font-bold uppercase tracking-[0.14em] text-[var(--term-sub)]">
              Live market
            </h2>
            <p className="mt-0.5 font-code text-[10px] uppercase tracking-[0.1em] text-[var(--term-dim)]">
              {scopeName} · chain-safe discovery
            </p>
          </div>
          <NavLink to="/discover" className="ml-auto text-[12px] font-semibold text-[var(--term-teal)] hover:underline">
            View all →
          </NavLink>
        </div>

        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-[var(--term-border)] bg-[var(--term-panel)] p-2.5">
          <span className="term-label mr-1">Network</span>
          <button
            type="button"
            onClick={() => setChainScope("all")}
            aria-pressed={chainScope === "all"}
            className={`rounded-md border px-3 py-1.5 text-[12px] font-semibold transition ${
              chainScope === "all"
                ? "border-[var(--term-teal)] bg-[var(--term-teal-dim)] text-[var(--term-teal)]"
                : "border-[var(--term-border)] text-[var(--term-dim)] hover:text-[var(--term-sub)]"
            }`}
          >
            All chains
          </button>
          {sources.map((source) => (
            <button
              key={source.chainId}
              type="button"
              onClick={() => setChainScope(source.chainId)}
              aria-pressed={chainScope === source.chainId}
              className={`rounded-md border px-3 py-1.5 text-[12px] font-semibold transition ${
                chainScope === source.chainId
                  ? "border-[var(--term-teal)] bg-[var(--term-teal-dim)] text-[var(--term-teal)]"
                  : "border-[var(--term-border)] text-[var(--term-dim)] hover:text-[var(--term-sub)]"
              }`}
            >
              {source.name}
            </button>
          ))}
          <span className="mx-1 hidden h-5 w-px bg-[var(--term-border)] sm:block" aria-hidden="true" />
          {MARKET_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setMarketSort(tab.id)}
              aria-pressed={marketSort === tab.id}
              className={`rounded-md border px-3 py-1.5 text-[12px] font-semibold transition ${
                marketSort === tab.id
                  ? "border-[var(--term-teal)] bg-[var(--term-teal-dim)] text-[var(--term-teal)]"
                  : "border-[var(--term-border)] text-[var(--term-dim)] hover:text-[var(--term-sub)]"
              }`}
            >
              {tab.label}
            </button>
          ))}
          <span className="mx-1 h-5 w-px bg-[var(--term-border)]" aria-hidden="true" />
          {MARKET_ENGINE_TABS.map((tab) => {
            const supported = supportedMarketEngines.includes(tab.id);
            const active = marketEngine === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setMarketEngine((current) => current === tab.id ? "all" : tab.id)}
                aria-pressed={active}
                disabled={!supported}
                title={supported ? `Filter by ${tab.label} launches` : `${tab.label} is not supported on ${chainName}`}
                className={`rounded-md border px-3 py-1.5 text-[12px] font-semibold transition ${
                  !supported
                    ? "cursor-not-allowed border-[var(--term-border)] text-[var(--term-dim)] opacity-35"
                    : active
                      ? "border-[var(--term-teal)] bg-[var(--term-teal-dim)] text-[var(--term-teal)]"
                      : "border-[var(--term-border)] text-[var(--term-dim)] hover:text-[var(--term-sub)]"
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        {warning && chainScope === "all" && (
          <div className="mb-3 rounded-lg border border-amber-400/20 bg-amber-400/[0.06] px-4 py-2.5 text-xs text-amber-200/80">
            Partial market view: {warning}
          </div>
        )}

        {scopeError ? (
          <div className="term-panel rounded-lg px-5 py-10 text-center">
            <p className="text-sm text-[var(--term-sub)]">Launch data is temporarily unavailable.</p>
            <button type="button" onClick={refetch} className="btn-ghost-term mt-4 px-4 py-2">Retry</button>
          </div>
        ) : scopeLoading && marketRows.length === 0 ? (
          <div className="term-panel rounded-lg px-5 py-10 text-center font-code text-[12px] text-[var(--term-dim)]">
            Indexing live launches…
          </div>
        ) : marketRows.length === 0 ? (
          <div className="term-panel rounded-lg px-5 py-10 text-center font-code text-[12px] text-[var(--term-dim)]">
            {marketEngine === "all"
              ? `No launches indexed on ${chainName} yet.`
              : `No ${marketEngine === "v4-hook" ? "V4" : "V3"} launches indexed on ${chainName} yet.`}
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,220px))] gap-x-4 gap-y-6">
            {marketRows.map((pool) => (
              <CoinCard key={`${pool.chainId}-${pool.address}`} p={pool} />
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-3 font-display text-sm font-bold uppercase tracking-[0.14em] text-[var(--term-sub)]">
          Your positions
        </h2>
        <div className="rounded-lg border border-dashed border-[var(--term-border)] bg-[var(--term-panel-2)] px-5 py-8 text-center sm:py-10">
          <TerminalArch />
          {isConnected && address ? (
            <>
              <h3 className="mt-4 font-display text-lg font-bold uppercase text-[var(--term-text)]">
                Wallet connected
              </h3>
              <p className="mx-auto mt-2 max-w-md text-sm text-[var(--term-sub)]">
                {isStableV3
                  ? "Open your Stable portfolio for creator launches and V3 token positions."
                  : "Open the chain-scoped portfolio for launches, LP positions, and claimable fees."}
              </p>
              <p className="mx-auto mt-4 w-fit rounded-md border border-[var(--term-border)] px-3 py-2 font-code text-[11px] text-[var(--term-dim)]">
                {address.slice(0, 8)}…{address.slice(-6)}
              </p>
              <NavLink to="/profile" className="btn-terminal mt-4 inline-flex px-5 py-2.5">
                Open portfolio
              </NavLink>
            </>
          ) : (
            <>
              <h3 className="mt-4 font-display text-lg font-bold uppercase text-[var(--term-text)]">
                No wallet connected
              </h3>
              <p className="mx-auto mt-2 max-w-md text-sm text-[var(--term-sub)]">
                {isStableV3
                  ? "Connect to view your Stable launches and V3 token positions."
                  : "Connect to view your launches, LP positions, and claimable fees."}
              </p>
              <button
                type="button"
                className="btn-terminal mt-4 px-5 py-2.5"
                onClick={connectWallet}
                disabled={isPending}
              >
                {isPending ? "Connecting…" : "Connect Wallet"}
              </button>
            </>
          )}
        </div>
      </section>
    </div>
  );
}

function ProtocolStat({
  label,
  value,
  accent = false,
  note,
}: {
  label: string;
  value: string;
  accent?: boolean;
  note?: string;
}) {
  return (
    <div className="protocol-stat min-h-[88px] cursor-default select-none px-5 py-4" aria-label={`${label}: ${value}${note ? `, ${note}` : ""}`}>
      <p className="term-label">{label}</p>
      <div className="mt-2 flex items-baseline gap-2">
        <span className={`font-code text-xl font-semibold ${accent ? "text-[var(--term-teal)]" : "text-[var(--term-text)]"}`}>
          {value}
        </span>
        {note && <span className="text-[10px] uppercase tracking-wider text-[var(--term-dim)]">{note}</span>}
      </div>
    </div>
  );
}

function TerminalArch() {
  return (
    <svg
      className="mx-auto h-14 w-14"
      viewBox="0 0 56 56"
      fill="none"
      stroke="var(--term-teal)"
      strokeWidth="3"
      aria-hidden
    >
      <path d="M12 46V27a16 16 0 0 1 32 0v19h-9V28a7 7 0 0 0-14 0v18h-9Z" />
      <circle cx="24" cy="25" r="1.5" fill="var(--term-teal)" stroke="none" />
      <circle cx="32" cy="25" r="1.5" fill="var(--term-teal)" stroke="none" />
    </svg>
  );
}
