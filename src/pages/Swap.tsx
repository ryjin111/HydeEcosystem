import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { NetworkConfig, TokenInfo } from "../utils/constants";
import { isGatewayLive } from "../utils/constants";
import { V4SwapCard } from "../components/V4SwapCard";
import { TrendingCarousel } from "../components/TrendingCarousel";
import type { DopplerPool } from "../components/TrendingCarousel";
import { useHydeLaunches } from "../hooks/useDopplerTokens";

/* ─── Token chart panel ──────────────────────────────────────────────────────
   Chart indexers (DexScreener/GeckoTerminal) don't cover Robinhood Chain yet —
   an honest explorer link beats an embed that 404s. */
function TokenChart({ tokenAddress, explorerUrl }: { tokenAddress: string | null; explorerUrl: string }) {
  return (
    <div
      className="w-full h-[500px] rounded-2xl flex flex-col items-center justify-center gap-2"
      style={{ background: "#121419", border: "1px solid #22252D" }}
    >
      {tokenAddress ? (
        <>
          <p className="text-xs text-pcs-textDim">Charts come online as indexers add Robinhood Chain.</p>
          <a
            href={`${explorerUrl}/token/${tokenAddress}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-pcs-primary hover:underline"
          >
            View token on the Robinhood Chain explorer →
          </a>
        </>
      ) : (
        <p className="text-xs text-pcs-textDim">Select a token to view details</p>
      )}
    </div>
  );
}

/* ─── Recently launched feed ─────────────────────────────────────────────── */
function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function RecentlyLaunched({ onSelect }: { onSelect: (pool: DopplerPool) => void }) {
  const { pools, loading } = useHydeLaunches();
  const navigate = useNavigate();

  const recent = pools.slice(0, 8);

  return (
    <div
      className="rounded-2xl overflow-hidden"
      style={{ background: "#121419", border: "1px solid #22252D" }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-2.5"
        style={{ borderBottom: "1px solid #1C1F26" }}
      >
        <span className="text-[11px] font-semibold uppercase tracking-widest text-pcs-textDim">
          Recently Launched
        </span>
        <button
          className="text-[10px] text-pcs-primary hover:underline"
          onClick={() => navigate("/launches")}
        >
          View all →
        </button>
      </div>

      {/* List */}
      {loading && recent.length === 0 ? (
        <div className="p-4 space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-9 rounded-xl animate-pulse"
              style={{ background: "rgba(255,255,255,0.04)" }}
            />
          ))}
        </div>
      ) : recent.length === 0 ? (
        <p className="p-4 text-xs text-pcs-textDim text-center">No launches yet</p>
      ) : (
        <div className="divide-y" style={{ borderColor: "rgba(255,255,255,0.03)" }}>
          {recent.map((pool) => (
            <div
              key={pool.baseToken.address}
              className="flex items-center gap-2.5 px-4 py-2 hover:bg-white/[0.02] cursor-pointer transition"
              onClick={() => onSelect(pool)}
            >
              {/* Avatar */}
              <div
                className="h-7 w-7 rounded-full flex items-center justify-center text-[9px] font-bold flex-shrink-0"
                style={{ background: "rgba(46,159,230,0.14)", color: "#54B4F0" }}
              >
                {pool.baseToken.symbol.slice(0, 2).toUpperCase()}
              </div>

              {/* Name + time */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-bold text-pcs-text truncate">{pool.baseToken.symbol}</span>
                </div>
                <span className="text-[10px] text-pcs-textDim">{pool.baseToken.name}</span>
              </div>

              {/* Time */}
              <div className="text-right flex-shrink-0">
                <p className="text-[9px] text-pcs-textDim">{timeAgo(pool.createdAt)} ago</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── Page ────────────────────────────────────────────────────────────────── */

type Props = {
  network: NetworkConfig;
  tokens: TokenInfo[];
  onAddCustomToken: (token: { address: `0x${string}`; symbol: string; name: string; decimals: number }) => void;
};

export function SwapPage({ network, tokens, onAddCustomToken }: Props) {
  const [selectedPool, setSelectedPool] = useState<DopplerPool | null>(null);
  const [chartTokenAddress, setChartTokenAddress] = useState<string | null>(null);

  const handleSelect = (pool: DopplerPool) => {
    setSelectedPool(pool);
    setChartTokenAddress(pool.baseToken.address);
  };

  const handleTokenOutChange = (address: string) => {
    // Don't show chart for ETH/WETH — no meaningful price chart
    const weth = network.weth.toLowerCase();
    const addr = address.toLowerCase();
    if (addr === weth || addr === "0x0000000000000000000000000000000000000000") return;
    setChartTokenAddress(address);
  };

  const gatewayLive = isGatewayLive(network.id);

  return (
    <div className="w-full max-w-6xl mx-auto">
      {/* Trending carousel — full width */}
      <TrendingCarousel
        selected={selectedPool?.address}
        onSelect={handleSelect}
      />

      {/* Two-column layout */}
      <div className="flex flex-col lg:flex-row gap-5 items-start">
        {/* Left: Swap card (or the honest not-yet state) */}
        <div className="w-full lg:w-[440px] flex-shrink-0">
          {gatewayLive ? (
            <V4SwapCard
              network={network}
              tokens={tokens}
              onAddCustomToken={onAddCustomToken}
              forceTokenOut={selectedPool?.baseToken.address}
              onTokenOutChange={handleTokenOutChange}
            />
          ) : (
            <div
              className="w-full rounded-2xl p-6 flex flex-col gap-3 shadow-card"
              style={{ background: "#121419", border: "1px solid #22252D" }}
            >
              <h2 className="font-display text-lg font-semibold text-pcs-text">Exchange</h2>
              <p className="text-sm text-pcs-textDim">
                Trading opens as tokens graduate from the launch curve. The Hyde swap
                router isn't deployed on Robinhood Chain yet — launched tokens trade
                on their launch curve, and graduated pools will be tradeable here.
              </p>
              <p className="text-xs text-pcs-textDim">
                Want in early? Launch or back a token on the{" "}
                <a href="/launchpad" className="text-pcs-primary hover:underline">Launchpad</a>.
              </p>
            </div>
          )}
        </div>

        {/* Right: Chart + Recently Launched */}
        <div className="flex-1 min-w-0 flex flex-col gap-4 w-full">
          <TokenChart tokenAddress={chartTokenAddress} explorerUrl={network.explorerUrl} />
          <RecentlyLaunched onSelect={handleSelect} />
        </div>
      </div>
    </div>
  );
}
