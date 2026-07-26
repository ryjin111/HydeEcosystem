import { useMemo, useState } from "react";
import { NavLink } from "react-router-dom";
import toast from "react-hot-toast";
import { ConnectorAlreadyConnectedError, useAccount, useConnect } from "wagmi";
import { useHydeLaunches } from "../hooks/useDopplerTokens";
import type { DopplerPool } from "../utils/dopplerConfig";
import { chainEngineCapabilities, chainV3Capability } from "../utils/chainRegistry";
import { CoinCard } from "./Discover";

const ROBINHOOD_CHAIN_ID = 4663;
const MARKET_ROW_COUNT = 6;

type MarketSort = "trending" | "new" | "graduating" | "mcap";

const MARKET_TABS: { id: MarketSort; label: string }[] = [
  { id: "trending", label: "Trending" },
  { id: "new", label: "New" },
  { id: "graduating", label: "Graduating" },
  { id: "mcap", label: "Top MCap" },
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

function graduation(pool: DopplerPool): number | null {
  if (pool.type === "v2") return 100;
  const progress = numeric(pool.progress);
  return progress == null ? null : Math.max(0, Math.min(100, progress));
}

function sortMarket(pools: DopplerPool[], sort: MarketSort): DopplerPool[] {
  return [...pools].sort((a, b) => {
    if (sort === "new") {
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    }
    if (sort === "graduating") {
      return (graduation(b) ?? -1) - (graduation(a) ?? -1);
    }
    if (sort === "mcap") {
      return (numeric(b.marketCapUsd) ?? -1) - (numeric(a.marketCapUsd) ?? -1);
    }
    return (
      (numeric(b.volumeUsd) ?? -1) - (numeric(a.volumeUsd) ?? -1)
      || (numeric(b.marketCapUsd) ?? -1) - (numeric(a.marketCapUsd) ?? -1)
    );
  });
}

/** Pro-Terminal landing surface (approved mock 24229).
 *  The layout follows the reference; every number and readiness state remains chain/data-derived.
 */
export function LandingPage({ chainId = ROBINHOOD_CHAIN_ID }: { chainId?: number }) {
  const { pools, loading, error, refetch } = useHydeLaunches(chainId);
  const { address, isConnected } = useAccount();
  const { connectAsync, connectors, isPending } = useConnect();
  const [marketSort, setMarketSort] = useState<MarketSort>("trending");

  const capability = chainEngineCapabilities(chainId)[0];
  const chainName = capability?.name ?? "Robinhood Chain";
  const v3Capability = chainV3Capability(chainId);
  // Preserve the already-audited Robinhood behavior; Stable V3 is fail-closed from its evidence status.
  const launchLive = !v3Capability || v3Capability.status === "live";
  const isStableV3 = capability?.engine === "v3-single-sided";

  const marketRows = useMemo(
    () => sortMarket(pools, marketSort).slice(0, MARKET_ROW_COUNT),
    [pools, marketSort],
  );
  const volume24h = useMemo(() => sumKnown(pools.map((pool) => pool.volumeUsd)), [pools]);
  const lockedLiquidity = useMemo(() => sumKnown(pools.map((pool) => pool.dollarLiquidity)), [pools]);

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
    <div className="w-full">
      {/* Four-stat protocol bar. Unknown aggregates render as em dashes, never fabricated zeroes. */}
      <section className="term-panel mb-4 grid overflow-hidden rounded-lg grid-cols-2 lg:grid-cols-4">
        <ProtocolStat
          label="Total launches"
          value={loading || error ? "—" : pools.length.toLocaleString("en-US")}
        />
        <ProtocolStat label="24h volume" value={formatUsd(volume24h, true)} accent />
        <ProtocolStat label="LP locked" value={formatUsd(lockedLiquidity, true)} />
        <ProtocolStat label="Fees → creators" value="—" note="not indexed" />
      </section>

      {/* Reference hero band: copy on the left, protocol-volume stage on the right. */}
      <section className="term-panel mb-8 grid overflow-hidden rounded-lg lg:grid-cols-[1.08fr,0.92fr]">
        <div className="px-6 py-8 sm:px-8 sm:py-10">
          <p className="term-label mb-3">{launchLive ? "Live launch protocol" : "Launch rail coming soon"}</p>
          <h1 className="font-display text-[34px] font-bold leading-[1.03] text-[var(--term-text)] sm:text-[44px]">
            Launch a token.
            <br />
            <span className="term-teal">
              {isStableV3 ? "Liquidity will lock forever." : "Liquidity locked forever."}
            </span>
          </h1>
          <p className="mt-5 max-w-[610px] text-sm leading-6 text-[var(--term-sub)]">
            {isStableV3 ? (
              <>
                <strong className="font-semibold text-[var(--term-text)]">Coming soon on {chainName}.</strong>{" "}
                Single-sided V3 launches will route 95% of fees to creators and 5% to Hyde; LP principal
                cannot be removed. The launch action stays disabled until deployment evidence lands.
              </>
            ) : (
              <>
                <strong className="font-semibold text-[var(--term-text)]">Live on Robinhood Chain.</strong>{" "}
                Creators keep 90% of fees; 5% locks into LP nobody can pull, auto-compounding. Proven in
                code, not promised.
              </>
            )}
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            {launchLive ? (
              <NavLink to="/launchpad?tab=launch" className="btn-terminal px-6 py-3">
                Launch a Token
              </NavLink>
            ) : (
              <button type="button" className="btn-terminal px-6 py-3" disabled>
                Launch — Coming soon
              </button>
            )}
            <a href="#live-market" className="btn-ghost-term px-6 py-3">
              Browse market
            </a>
          </div>
        </div>

        <div
          className="flex min-h-[220px] flex-col justify-center px-6 py-8 sm:px-8 lg:border-l"
          style={{ borderColor: "var(--term-border)" }}
        >
          <p className="term-label">Protocol volume · 30d</p>
          <div className="relative mt-5 h-28 overflow-hidden rounded-md border border-dashed border-[var(--term-border)] bg-[var(--term-panel-2)]">
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
      <section id="live-market" className="mb-9 scroll-mt-28">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 className="mr-3 font-display text-sm font-bold uppercase tracking-[0.14em] text-[var(--term-sub)]">
            Live market
          </h2>
          {MARKET_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setMarketSort(tab.id)}
              className={`rounded-md border px-3 py-1.5 text-[12px] font-semibold transition ${
                marketSort === tab.id
                  ? "border-[var(--term-teal)] bg-[var(--term-teal-dim)] text-[var(--term-teal)]"
                  : "border-[var(--term-border)] text-[var(--term-dim)] hover:text-[var(--term-sub)]"
              }`}
            >
              {tab.label}
            </button>
          ))}
          <NavLink to="/discover" className="ml-auto text-[12px] font-semibold text-[var(--term-teal)] hover:underline">
            View all →
          </NavLink>
        </div>

        {error ? (
          <div className="term-panel rounded-lg px-5 py-10 text-center">
            <p className="text-sm text-[var(--term-sub)]">Launch data is temporarily unavailable.</p>
            <button type="button" onClick={refetch} className="btn-ghost-term mt-4 px-4 py-2">Retry</button>
          </div>
        ) : loading && marketRows.length === 0 ? (
          <div className="term-panel rounded-lg px-5 py-10 text-center font-code text-[12px] text-[var(--term-dim)]">
            Indexing live launches…
          </div>
        ) : marketRows.length === 0 ? (
          <div className="term-panel rounded-lg px-5 py-10 text-center font-code text-[12px] text-[var(--term-dim)]">
            No launches indexed on {chainName} yet.
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
        <div className="rounded-lg border border-dashed border-[var(--term-border)] bg-[var(--term-panel-2)] px-5 py-12 text-center sm:py-14">
          <TerminalArch />
          {isConnected && address ? (
            <>
              <h3 className="mt-5 font-display text-lg font-bold uppercase text-[var(--term-text)]">
                Wallet connected
              </h3>
              <p className="mx-auto mt-2 max-w-md text-sm text-[var(--term-sub)]">
                Open the chain-scoped portfolio for launches, LP positions, and claimable fees.
              </p>
              <p className="mx-auto mt-4 w-fit rounded-md border border-[var(--term-border)] px-3 py-2 font-code text-[11px] text-[var(--term-dim)]">
                {address.slice(0, 8)}…{address.slice(-6)}
              </p>
              <NavLink to="/profile" className="btn-terminal mt-5 inline-flex px-6 py-3">
                Open portfolio
              </NavLink>
            </>
          ) : (
            <>
              <h3 className="mt-5 font-display text-lg font-bold uppercase text-[var(--term-text)]">
                No wallet connected
              </h3>
              <p className="mx-auto mt-2 max-w-md text-sm text-[var(--term-sub)]">
                Connect to view your launches, LP positions, and claimable fees.
              </p>
              <p className="mx-auto mt-4 w-fit rounded-md border border-[var(--term-border)] px-3 py-2 font-code text-[11px] text-[var(--term-dim)]">
                /profile/&lt;address&gt;
              </p>
              <button
                type="button"
                className="btn-terminal mt-5 px-6 py-3"
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
    <div className="protocol-stat min-h-[88px] px-5 py-4">
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
