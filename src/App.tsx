import { Navigate, Route, Routes, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { Header } from "./components/Header";
import { SideRail } from "./components/SideRail";
import { NETWORKS } from "./utils/constants";
import { useTokenList } from "./hooks/useTokenList";
import { useHydeTokens } from "./hooks/useDopplerTokens";

const AddLiquidityPage = lazy(() => import("./pages/AddLiquidity").then((module) => ({ default: module.AddLiquidityPage })));
const LaunchpadPage = lazy(() => import("./pages/Launchpad").then((module) => ({ default: module.LaunchpadPage })));
const LandingPage = lazy(() => import("./pages/Landing").then((module) => ({ default: module.LandingPage })));
const DiscoverPage = lazy(() => import("./pages/Discover").then((module) => ({ default: module.DiscoverPage })));
const StatsPage = lazy(() => import("./pages/Stats").then((module) => ({ default: module.StatsPage })));
const TokenPage = lazy(() => import("./pages/Token").then((module) => ({ default: module.TokenPage })));
const ProfilePage = lazy(() => import("./pages/Profile").then((module) => ({ default: module.ProfilePage })));

/** Preserve old /swap links while keeping discovery → token page → embedded trade canonical. */
function LegacySwapRedirect() {
  const [searchParams] = useSearchParams();
  const address = searchParams.get("out") ?? "";
  const requestedNetwork = Number(searchParams.get("network"));
  const networkQuery = NETWORKS.some((network) => network.id === requestedNetwork)
    ? `?network=${requestedNetwork}`
    : "";
  return (
    <Navigate
      to={/^0x[0-9a-fA-F]{40}$/.test(address) ? `/token/${address}${networkQuery}` : `/discover${networkQuery}`}
      replace
    />
  );
}

function App() {
  // Global chain context can be URL-initialized (?network=988) so a chain view is shareable/linkable; the
  // header selector remains the live authority thereafter. Validated against NETWORKS.
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const urlNetwork = Number(searchParams.get("network"));
  const [selectedNetworkId, setSelectedNetworkId] = useState(
    NETWORKS.some((n) => n.id === urlNetwork) ? urlNetwork : NETWORKS[0].id,
  );
  useEffect(() => {
    // Cross-chain discovery cards carry their network in the URL. Adopt that
    // context before mounting transaction controls for the destination token.
    if (NETWORKS.some((network) => network.id === urlNetwork)) {
      setSelectedNetworkId(urlNetwork);
    }
  }, [urlNetwork]);
  const selectedNetwork = useMemo(
    () => NETWORKS.find((network) => network.id === selectedNetworkId) ?? NETWORKS[0],
    [selectedNetworkId]
  );
  const changeNetwork = (networkId: number) => {
    setSelectedNetworkId(networkId);
    const nextSearch = new URLSearchParams(location.search);
    nextSearch.set("network", String(networkId));
    navigate({ pathname: location.pathname, search: nextSearch.toString() }, { replace: true });
  };

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
        onNetworkChange={changeNetwork}
        networks={NETWORKS.filter((n) => n.id !== 57073)}
      />

      <div className="mx-auto flex w-full max-w-[1920px]">
        <SideRail />
        <main className="hyde-content min-w-0 flex-1 px-4 pb-10 pt-4 sm:px-8 md:px-10">
        <Suspense
          fallback={(
            <div className="term-panel rounded-xl px-5 py-12 text-center font-code text-xs uppercase tracking-widest text-pcs-textDim">
              Loading Hydeout surface…
            </div>
          )}
        >
        <Routes>
          <Route path="/swap" element={<LegacySwapRedirect />} />
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
          {/* Card discovery is canonical; legacy launch-list links converge here. */}
          <Route path="/discover" element={<DiscoverPage chainId={selectedNetwork.id} />} />
          <Route path="/launches" element={<Navigate to="/discover" replace />} />
          <Route
            path="/token/:address"
            element={<TokenPage network={selectedNetwork} tokens={tokens} onAddCustomToken={addCustomToken} />}
          />
          <Route path="/profile" element={<ProfilePage network={selectedNetwork} />} />
          <Route path="/profile/:address" element={<ProfilePage network={selectedNetwork} />} />
          <Route path="/launchpad" element={<LaunchpadPage chainId={selectedNetwork.id} />} />
          <Route path="/remove-liquidity" element={<Navigate to="/add-liquidity" replace />} />
          <Route path="*" element={<Navigate to="/launchpad" replace />} />
        </Routes>
        </Suspense>
        </main>
      </div>
    </div>
  );
}

export default App;
