import { Navigate, Route, Routes, useParams, useSearchParams } from "react-router-dom";
import { useMemo, useState } from "react";
import { Header } from "./components/Header";
import { AddLiquidityPage } from "./pages/AddLiquidity";
import { SwapPage } from "./pages/Swap";
import { LaunchpadPage } from "./pages/Launchpad";
import { LandingPage } from "./pages/Landing";
import { StatsPage } from "./pages/Stats";
import { ProfilePage } from "./pages/Profile";
import { NETWORKS } from "./utils/constants";
import { useTokenList } from "./hooks/useTokenList";
import { useHydeTokens } from "./hooks/useDopplerTokens";

/** /token/<addr> → the canonical /swap?out=<addr> token page (kami 23477). Preserves shared links. */
function TokenRedirect() {
  const { address = "" } = useParams();
  return <Navigate to={address ? `/swap?out=${address}` : "/swap"} replace />;
}

function App() {
  // Global chain context can be URL-initialized (?network=988) so a chain view is shareable/linkable; the
  // header selector remains the live authority thereafter. Validated against NETWORKS.
  const [searchParams] = useSearchParams();
  const urlNetwork = Number(searchParams.get("network"));
  const [selectedNetworkId, setSelectedNetworkId] = useState(
    NETWORKS.some((n) => n.id === urlNetwork) ? urlNetwork : NETWORKS[0].id,
  );
  const selectedNetwork = useMemo(
    () => NETWORKS.find((network) => network.id === selectedNetworkId) ?? NETWORKS[0],
    [selectedNetworkId]
  );

  const { tokens: baseTokens, addCustomToken } = useTokenList(selectedNetwork);
  const { tokens: hydeTokens } = useHydeTokens(selectedNetwork.id);

  // Merge Hyde-launched tokens into the token list (auto-discovery)
  const tokens = useMemo(() => {
    const map = new Map(baseTokens.map((t) => [t.address.toLowerCase(), t]));
    for (const t of hydeTokens) {
      if (!map.has(t.address.toLowerCase())) map.set(t.address.toLowerCase(), t);
    }
    return Array.from(map.values());
  }, [baseTokens, hydeTokens]);

  // Pro-Terminal shell (mock 24229): a single top nav, no sidebar. Content is centered in a terminal-width
  // column so the dense tables/stat-bar read like an instrument, not a full-bleed marketing page.
  return (
    <div className="min-h-screen">
      <Header
        selectedNetwork={selectedNetwork}
        onNetworkChange={setSelectedNetworkId}
        networks={NETWORKS.filter((n) => n.id !== 57073)}
      />

      <main className="mx-auto w-full max-w-[1920px] px-4 pt-6 pb-16 sm:px-8 md:px-10">
        <Routes>
          <Route
            path="/swap"
            element={<SwapPage network={selectedNetwork} tokens={tokens} onAddCustomToken={addCustomToken} />}
          />
          <Route
            path="/add-liquidity"
            element={<AddLiquidityPage network={selectedNetwork} tokens={tokens} onAddCustomToken={addCustomToken} />}
          />
          {/* DEX/farm cruft — made UNREACHABLE (redirect), not just unlinked (casper FINDING). */}
          <Route path="/farms" element={<Navigate to="/launchpad" replace />} />
          <Route path="/pools" element={<Navigate to="/launchpad" replace />} />
          {/* Stats/transparency page — chain-scoped aggregate (shiro mock 21675). */}
          <Route path="/stats" element={<StatsPage chainId={selectedNetwork.id} />} />
          {/* Landing (Pro-Terminal): stat-bar + hero + LIVE MARKET table + positions. */}
          <Route path="/" element={<LandingPage chainId={selectedNetwork.id} />} />
          {/* The board lives ONLY at /launchpad — collapse duplicate board routes. */}
          <Route path="/discover" element={<Navigate to="/launchpad" replace />} />
          <Route path="/launches" element={<Navigate to="/launchpad" replace />} />
          <Route path="/token/:address" element={<TokenRedirect />} />
          <Route path="/profile" element={<ProfilePage network={selectedNetwork} />} />
          <Route path="/profile/:address" element={<ProfilePage network={selectedNetwork} />} />
          <Route path="/launchpad" element={<LaunchpadPage chainId={selectedNetwork.id} />} />
          <Route path="/remove-liquidity" element={<Navigate to="/add-liquidity" replace />} />
          <Route path="*" element={<Navigate to="/launchpad" replace />} />
        </Routes>
      </main>
    </div>
  );
}

export default App;
