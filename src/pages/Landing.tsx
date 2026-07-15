import { NavLink, useNavigate } from "react-router-dom";
import { useHydeLaunches } from "../hooks/useDopplerTokens";
import { PoolCard } from "./Launchpad";

const ROBINHOOD_CHAIN_ID = 4663;
const TRENDING_COUNT = 4;

/** Landing (`/`) — hero + trending strip (a subset), NOT a 4th copy of the board (UI_CONSOLIDATION §4).
 *  Honest two-register copy (shiro): live on Robinhood Chain today; the own-stack 90/5-locked model is
 *  presented as COMING, not live, until deploy. */
export function LandingPage({ chainId = ROBINHOOD_CHAIN_ID }: { chainId?: number }) {
  const { pools } = useHydeLaunches(chainId);
  const navigate = useNavigate();
  const trending = pools.slice(0, TRENDING_COUNT);

  const handleTrade = (tokenAddress: string, chainId: number) => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(tokenAddress) || chainId !== ROBINHOOD_CHAIN_ID) return;
    navigate(`/swap?out=${tokenAddress}`);
  };

  return (
    <div className="max-w-6xl mx-auto w-full">
      {/* Hero */}
      <div
        className="rounded-2xl p-10 mb-12"
        style={{ background: "#101216", border: "1px solid #1C1F26" }}
      >
        <div className="max-w-3xl">
            <h1 className="font-display font-bold leading-[1.05] text-pcs-text" style={{ fontSize: "44px" }}>
              Launch a token.
              <br />
              <span style={{ color: "#54B4F0" }}>Liquidity locked forever.</span>
            </h1>
            <p className="text-sm text-pcs-textSub mt-5 leading-relaxed max-w-xl">
              <span className="text-pcs-text font-medium">Live today on Robinhood Chain.</span> Hyde&rsquo;s own stack launches
              soon &mdash; creators keep 90% of fees and 5% auto-compounds into liquidity <span className="text-pcs-text font-medium">nobody can pull</span>.
              Proven in code, not promised.
            </p>
            <div className="flex flex-wrap gap-3 mt-8">
              <NavLink to="/launchpad?tab=launch" className="btn-primary px-6 py-3 text-sm font-semibold rounded-xl">
                Launch a Token
              </NavLink>
              <NavLink
                to="/launchpad?tab=explore"
                className="px-6 py-3 text-sm font-semibold rounded-xl transition"
                style={{ background: "rgba(255,255,255,0.05)", color: "#EDEFF3", border: "1px solid #22252D" }}
              >
                Explore Launches &rarr;
              </NavLink>
            </div>
        </div>
      </div>

      {/* Trending strip — only rendered when REAL data exists; never ship empty outlines (shiro). */}
      {trending.length > 0 && (
        <>
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-display text-lg font-semibold text-pcs-text">Trending launches</h2>
            <NavLink to="/launchpad?tab=explore" className="text-xs text-pcs-primary hover:underline">
              View all &rarr;
            </NavLink>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {trending.map((pool) => (
              <PoolCard key={`${pool.chainId}-${pool.address}`} pool={pool} onTrade={handleTrade} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
