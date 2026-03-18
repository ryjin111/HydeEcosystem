import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import type { NetworkConfig, TokenInfo } from "../utils/constants";
import { V4SwapCard } from "../components/V4SwapCard";
import { TrendingCarousel } from "../components/TrendingCarousel";
import type { DopplerPool } from "../components/TrendingCarousel";

/* ─── GeckoTerminal chart embed ───────────────────────────────────────────── */
function TokenChart({ tokenAddress }: { tokenAddress: string | null }) {
  if (!tokenAddress) {
    return (
      <div
        className="w-full h-[500px] rounded-2xl flex items-center justify-center"
        style={{ background: "#0d1220", border: "1px solid rgba(0,212,255,0.08)" }}
      >
        <p className="text-xs text-pcs-textDim">Select a token to view chart</p>
      </div>
    );
  }

  const src = `https://www.geckoterminal.com/optimism/tokens/${tokenAddress}?embed=1&theme=dark&trades_table=0&info=0`;

  return (
    <div
      className="w-full rounded-2xl overflow-hidden"
      style={{ height: 500, border: "1px solid rgba(0,212,255,0.08)" }}
    >
      <iframe
        src={src}
        width="100%"
        height="100%"
        frameBorder="0"
        allow="clipboard-write"
        title="Token chart"
      />
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

function fmtUsd(raw: string | null): string {
  const n = parseFloat(raw ?? "0");
  if (!n) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

// ─── Clanker token feed (replaces Doppler indexer) ───────────────────────────

interface ClankerToken {
  contract_address: string;
  pool_address?: string;
  name: string;
  symbol: string;
  deployed_at: string;
  social_context?: { interface?: string };
}

function useClankerTokens() {
  const [tokens, setTokens] = useState<ClankerToken[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/clanker-tokens?chainId=10`)
      .then((r) => r.json())
      .then((d) => { setTokens(d.data ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  return { tokens, loading };
}

function clankerToPool(token: ClankerToken): DopplerPool {
  return {
    address: token.pool_address ?? token.contract_address,
    chainId: 10,
    baseToken: { address: token.contract_address, name: token.name, symbol: token.symbol, decimals: 18 },
    quoteToken: { address: "0x4200000000000000000000000000000000000006", name: "Wrapped Ether", symbol: "WETH", decimals: 18 },
    type: "v4",
    dollarLiquidity: null,
    volumeUsd: null,
    createdAt: token.deployed_at,
  };
}

function RecentlyLaunched({
  chainId,
  onSelect,
}: {
  chainId: number;
  onSelect: (pool: DopplerPool) => void;
}) {
  const { tokens, loading } = useClankerTokens();
  const navigate = useNavigate();

  // Prefer Hyde-tagged tokens; fall back to all Optimism tokens
  const hydeTokens = tokens.filter((t) => t.social_context?.interface === "Hyde");
  const recent = (hydeTokens.length > 0 ? hydeTokens : tokens).slice(0, 8);

  return (
    <div
      className="rounded-2xl overflow-hidden"
      style={{ background: "#0d1220", border: "1px solid rgba(0,212,255,0.08)" }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-2.5"
        style={{ borderBottom: "1px solid rgba(0,212,255,0.06)" }}
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
        <div className="divide-y" style={{ borderColor: "rgba(0,212,255,0.04)" }}>
          {recent.map((token) => {
            const pool = clankerToPool(token);
            return (
            <div
              key={token.contract_address}
              className="flex items-center gap-2.5 px-4 py-2 hover:bg-white/[0.02] cursor-pointer transition"
              onClick={() => onSelect(pool)}
            >
              {/* Avatar */}
              <div
                className="h-7 w-7 rounded-full flex items-center justify-center text-[9px] font-bold flex-shrink-0"
                style={{ background: "rgba(0,212,255,0.12)", color: "#00d4ff" }}
              >
                {token.symbol.slice(0, 2).toUpperCase()}
              </div>

              {/* Name + time */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-bold text-pcs-text truncate">{token.symbol}</span>
                </div>
                <span className="text-[10px] text-pcs-textDim">{token.name}</span>
              </div>

              {/* Time */}
              <div className="text-right flex-shrink-0">
                <p className="text-[9px] text-pcs-textDim">{timeAgo(token.deployed_at)} ago</p>
              </div>
            </div>
            );
          })}
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

  return (
    <div className="w-full max-w-6xl mx-auto">
      {/* Trending carousel — full width */}
      <TrendingCarousel
        selected={selectedPool?.address}
        onSelect={handleSelect}
      />

      {/* Two-column layout */}
      <div className="flex flex-col lg:flex-row gap-5 items-start">
        {/* Left: Swap card */}
        <div className="w-full lg:w-[440px] flex-shrink-0">
          <V4SwapCard
            network={network}
            tokens={tokens}
            onAddCustomToken={onAddCustomToken}
            forceTokenOut={selectedPool?.baseToken.address}
            onTokenOutChange={handleTokenOutChange}
          />
        </div>

        {/* Right: Chart + Recently Launched */}
        <div className="flex-1 min-w-0 flex flex-col gap-4 w-full">
          <TokenChart tokenAddress={chartTokenAddress} />
          <RecentlyLaunched chainId={network.id} onSelect={handleSelect} />
        </div>
      </div>
    </div>
  );
}
