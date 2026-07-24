import { NavLink, useNavigate } from "react-router-dom";
import { useHydeLaunches } from "../hooks/useDopplerTokens";
import { chainEngineCapabilities, chainLaunchLive } from "../utils/chainRegistry";
import { PoolCard } from "./Launchpad";

const ROBINHOOD_CHAIN_ID = 4663;
const RH_TESTNET_ID = 46630;
const TRENDING_COUNT = 4;

/** Landing (`/`) — hero + trending strip (a subset), NOT a 4th copy of the board (UI_CONSOLIDATION §4).
 *  Honest two-register copy (shiro): live on Robinhood Chain today; the own-stack 90/5-locked model is
 *  presented as COMING, not live, until deploy. */
export function LandingPage({ chainId = ROBINHOOD_CHAIN_ID }: { chainId?: number }) {
  const { pools } = useHydeLaunches(chainId);
  const navigate = useNavigate();
  const trending = pools.slice(0, TRENDING_COUNT);
  // Hero economics + CTA are REGISTRY-derived — never hardcode Robinhood/V4 copy or an active CTA on a
  // chain whose launch isn't live (kami 24317 / 24323 #2).
  const engine = chainEngineCapabilities(chainId)[0]?.engine;
  const chainName = chainEngineCapabilities(chainId)[0]?.name ?? "Robinhood Chain";
  const launchLive = chainLaunchLive(chainId);

  const handleTrade = (tokenAddress: string, chainId: number) => {
    // Landing is the browse-all home for BOTH supported rails now — allow Robinhood mainnet (4663) and
    // the testnet own-stack (46630), matching Launchpad, so testnet cards' Trade button actually works.
    if (!/^0x[0-9a-fA-F]{40}$/.test(tokenAddress)) return;
    if (chainId !== ROBINHOOD_CHAIN_ID && chainId !== RH_TESTNET_ID) return;
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
              {engine === "v3-single-sided" ? (
                <>
                  <span className="text-pcs-text font-medium">Coming soon on {chainName}.</span> Single-sided V3
                  launches &mdash; creators will keep 95% of fees, 5% to Hyde, and liquidity is <span className="text-pcs-text font-medium">permanently locked</span> (principal can’t be removed).
                </>
              ) : (
                <>
                  <span className="text-pcs-text font-medium">Live today on Robinhood Chain.</span> Hyde launches
                  soon &mdash; creators keep 90% of fees and 5% locks into liquidity <span className="text-pcs-text font-medium">nobody can pull</span> &mdash; designed to auto-compound.
                </>
              )}
              {" "}Proven in code, not promised.
            </p>
            <div className="flex flex-wrap gap-3 mt-8">
              {launchLive ? (
                <NavLink to="/launchpad?tab=launch" className="btn-primary px-6 py-3 text-sm font-semibold rounded-xl">
                  Launch a Token
                </NavLink>
              ) : (
                <button
                  type="button"
                  disabled
                  className="rounded-xl border border-pcs-border bg-pcs-cardLight px-6 py-3 text-sm font-semibold text-pcs-textDim cursor-not-allowed"
                >
                  Launch — Coming soon
                </button>
              )}
            </div>
        </div>
      </div>

      {/* Trending strip — a highlighted subset, shown only when there are enough launches that it's
          distinct from the full list below (otherwise it would just duplicate it). */}
      {pools.length > TRENDING_COUNT && (
        <div className="mb-12">
          <h2 className="font-display text-lg font-semibold text-pcs-text mb-4">Trending launches</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {trending.map((pool) => (
              <PoolCard key={`trending-${pool.chainId}-${pool.address}`} pool={pool} onTrade={handleTrade} />
            ))}
          </div>
        </div>
      )}

      {/* The rest of the launches (or all of them, when there's no separate trending strip). The
          Landing is the browse-all home now (clint ①), so the launchpad's second tab is personal
          "My Launches". Excludes the trending cards above so nothing is shown twice. */}
      {pools.length > 0 && (
        <div>
          <h2 className="font-display text-lg font-semibold text-pcs-text mb-4">
            {pools.length > TRENDING_COUNT ? "More launches" : "Launches"}
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {(pools.length > TRENDING_COUNT ? pools.slice(TRENDING_COUNT) : pools).map((pool) => (
              <PoolCard key={`${pool.chainId}-${pool.address}`} pool={pool} onTrade={handleTrade} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
