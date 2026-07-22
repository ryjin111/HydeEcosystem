import { useNavigate, useSearchParams } from "react-router-dom";
import type { NetworkConfig, TokenInfo } from "../utils/constants";
import { isGatewayLive } from "../utils/constants";
import { V4SwapCard } from "../components/V4SwapCard";
import type { DopplerPool } from "../utils/dopplerConfig";
import { useHydeLaunches } from "../hooks/useDopplerTokens";
import { TokenDetail } from "./Token";

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
          onClick={() => navigate("/launchpad")}
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

/* ─── Page ────────────────────────────────────────────────────────────────────
   /swap?out=<token> is the ONE canonical token page (clint 23476 / kami 23477): when `out` is a
   real token it renders the full TokenDetail (header · stats · chart · trade · Your Position · Trust ·
   holders). With no token it's the discovery/exchange view. Selecting anywhere sets ?out= so the page
   is shareable and /token/<addr> can redirect straight into it. */

type Props = {
  network: NetworkConfig;
  tokens: TokenInfo[];
  onAddCustomToken: (token: { address: `0x${string}`; symbol: string; name: string; decimals: number }) => void;
};

const ZERO = "0x0000000000000000000000000000000000000000";

export function SwapPage({ network, tokens, onAddCustomToken }: Props) {
  const [searchParams, setSearchParams] = useSearchParams();
  const out = searchParams.get("out") ?? "";
  const weth = network.weth.toLowerCase();
  const showDetail = !!out && out.toLowerCase() !== weth && out.toLowerCase() !== ZERO;

  // Selecting a token anywhere drives the canonical ?out= (shareable, back-button friendly).
  const selectToken = (address: string) => setSearchParams({ out: address });

  return (
    <div className="w-full max-w-6xl mx-auto">
      {/* Trending moved to the global top ticker (App shell) — no per-page strip here (clint 23798). */}
      {showDetail ? (
        /* Canonical token page — the full detail layout for the selected token */
        <TokenDetail address={out} network={network} tokens={tokens} onAddCustomToken={onAddCustomToken} />
      ) : (
        /* Discovery / exchange view — pick a token to open its page */
        <div className="flex flex-col lg:flex-row gap-5 items-start">
          <div className="w-full lg:w-[440px] flex-shrink-0">
            {isGatewayLive(network.id) ? (
              <V4SwapCard network={network} tokens={tokens} onAddCustomToken={onAddCustomToken} />
            ) : (
              <div
                className="w-full rounded-2xl p-6 flex flex-col gap-3 shadow-card"
                style={{ background: "#121419", border: "1px solid #22252D" }}
              >
                <h2 className="font-display text-lg font-semibold text-pcs-text">Exchange</h2>
                <p className="text-sm text-pcs-textDim">
                  In-app swap is coming to Robinhood Chain shortly. Every HOODIE launch
                  trades live now in its locked-liquidity pool — pick one below to open its page.
                </p>
                <p className="text-xs text-pcs-textDim">
                  Pick a token from Trending or Recently Launched to open its full page —
                  chart, trade, and your position.
                </p>
              </div>
            )}
          </div>

          {/* Right: prompt + Recently Launched */}
          <div className="flex-1 min-w-0 flex flex-col gap-4 w-full">
            <div
              className="w-full h-[260px] rounded-2xl flex items-center justify-center"
              style={{ background: "#121419", border: "1px solid #22252D" }}
            >
              <p className="text-xs text-pcs-textDim">Select a token to view its page</p>
            </div>
            <RecentlyLaunched onSelect={(pool) => selectToken(pool.baseToken.address)} />
          </div>
        </div>
      )}
    </div>
  );
}
