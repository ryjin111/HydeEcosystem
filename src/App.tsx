import { NavLink, Navigate, Route, Routes, useParams, useSearchParams } from "react-router-dom";
import { useMemo, useState } from "react";
import { Header } from "./components/Header";
import { TrendingTicker } from "./components/TrendingTicker";
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
  // Open by default on desktop; CLOSED on phones so the fixed drawer doesn't cover the board on
  // first load (shiro mobile blocker 21214). The Header hamburger toggles it as an overlay drawer.
  const [sidebarOpen, setSidebarOpen] = useState(() =>
    typeof window === "undefined" ? true : window.innerWidth >= 768
  );
  // On mobile, tapping a nav item should dismiss the drawer so the chosen page is visible.
  const closeOnMobile = () => {
    if (typeof window !== "undefined" && window.innerWidth < 768) setSidebarOpen(false);
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

  type SidebarItem = { to: string; label: string; icon: () => React.JSX.Element; disabled?: boolean };
  type SidebarSection = { title: string; items: SidebarItem[] };

  // Launchpad-first IA (UI_CONSOLIDATION.md) + the honest Stats/transparency page (shiro mock 21675).
  // The PancakeSwap-fork DEX/farm cruft (Exchange, Liquidity, Farms, Pools) stays gone.
  const sidebarSections: SidebarSection[] = [
    {
      title: "Menu",
      items: [
        // Single Launchpad entry — the in-page [Launch | Explore] tabs handle the sub-nav.
        { to: "/launchpad", label: "Launchpad", icon: LaunchIcon },
        { to: "/stats", label: "Stats", icon: StatsIcon },
        { to: "/profile", label: "Portfolio", icon: WalletIcon },
      ],
    },
  ];

  return (
    <div className="min-h-screen flex">
      {/* Mobile backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-20 bg-black/60 backdrop-blur-sm md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed top-0 left-0 z-30 h-full w-56 flex flex-col transition-transform duration-200 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
        style={{ background: '#0F1114', borderRight: '1px solid #1C1F26' }}
      >
        {/* Sidebar header — clickable, returns to the homepage (clint) */}
        <NavLink
          to="/"
          onClick={closeOnMobile}
          className="flex h-14 items-center gap-2.5 px-4 transition hover:bg-white/[0.03]"
          style={{ borderBottom: '1px solid #1C1F26' }}
        >
          <img src="/logo/lo.png" alt="Hyde" className="h-7 w-7 rounded-md object-contain" />
          <span className="font-display text-lg font-semibold tracking-tight text-pcs-text">
            Hyde
          </span>
        </NavLink>

        {/* Nav sections */}
        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-5">
          {sidebarSections.map((section) => (
            <div key={section.title}>
              <p className="mb-2 px-3 text-[10px] font-semibold uppercase tracking-widest text-pcs-textDim">
                {section.title}
              </p>
              <div className="space-y-0.5">
                {section.items.map((item) =>
                  item.disabled ? (
                    <div
                      key={item.label}
                      className="flex items-center gap-3 rounded-xl px-3 py-2 text-sm text-pcs-textDim cursor-not-allowed opacity-50"
                    >
                      <item.icon />
                      <span>{item.label}</span>
                    </div>
                  ) : (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      onClick={closeOnMobile}
                      className={({ isActive }) =>
                        `flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition ${
                          isActive
                            ? "text-pcs-primary bg-pcs-primary/10"
                            : "text-pcs-textSub hover:text-pcs-text hover:bg-white/[0.03]"
                        }`
                      }
                    >
                      <item.icon />
                      <span>{item.label}</span>
                    </NavLink>
                  )
                )}
              </div>
            </div>
          ))}
        </nav>

        {/* Sidebar footer */}
        <div className="px-4 py-3" style={{ borderTop: '1px solid #1C1F26' }}>
          <div className="text-xs text-pcs-textDim">
            {selectedNetwork.name}
          </div>
        </div>
      </aside>

      {/* Main area */}
      <div className={`flex-1 min-w-0 flex flex-col transition-all duration-200 ${sidebarOpen ? "md:ml-56" : "ml-0"}`}>
        <Header
          selectedNetwork={selectedNetwork}
          onNetworkChange={setSelectedNetworkId}
          networks={NETWORKS.filter((n) => n.id !== 57073)}
          onToggleSidebar={() => setSidebarOpen((s) => !s)}
          sidebarOpen={sidebarOpen}
        />

        {/* Global DexScreener-style trending ticker — pinned under the header on every page (clint
            23798/23812). Renders nothing until there's real launch data. */}
        <TrendingTicker chainId={selectedNetwork.id} />

        <main className="flex-1 flex flex-col items-center px-4 pt-8 pb-16">
          {/* Card area */}
          <div className="w-full">
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
              {/* Stats/transparency page — restored as a real aggregate (shiro mock 21675), not a board-relist.
                  Chain-scoped (kami A-blocker #4): the aggregate is a mainnet Doppler source; on testnet it
                  shows an explicit "not aggregated here" state rather than mainnet numbers. */}
              <Route path="/stats" element={<StatsPage chainId={selectedNetwork.id} />} />
              {/* /trust (Security) page removed (clint 22844) — the catch-all redirects any typed /trust → /launchpad. */}
              {/* Landing (UI_CONSOLIDATION step 4) — hero + trending strip, not a 4th board copy. */}
              <Route path="/" element={<LandingPage chainId={selectedNetwork.id} />} />
              {/* The board lives ONLY at /launchpad — collapse the duplicate board routes. */}
              <Route path="/discover" element={<Navigate to="/launchpad" replace />} />
              <Route path="/launches" element={<Navigate to="/launchpad" replace />} />
              {/* /token/<addr> is only an alias now — one canonical token page at /swap?out= (kami 23477). */}
              <Route path="/token/:address" element={<TokenRedirect />} />
              <Route path="/profile" element={<ProfilePage network={selectedNetwork} />} />
              <Route path="/profile/:address" element={<ProfilePage network={selectedNetwork} />} />
              <Route path="/launchpad" element={<LaunchpadPage chainId={selectedNetwork.id} />} />
              {/* /_ui (internal dev kit) is REMOVED from prod entirely — the catch-all handles a typed URL. */}
              <Route path="/remove-liquidity" element={<Navigate to="/add-liquidity" replace />} />
              <Route path="*" element={<Navigate to="/launchpad" replace />} />
            </Routes>
          </div>
        </main>
      </div>
    </div>
  );
}

/* ---------- Sidebar Icons ---------- */

function WalletIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a2.25 2.25 0 00-2.25-2.25H15a3 3 0 11-6 0H5.25A2.25 2.25 0 003 12m18 0v6a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 18v-6m18 0V9a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 9m18 0V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v3" />
    </svg>
  );
}


function LaunchIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.59 14.37a6 6 0 01-5.84 7.38v-4.8m5.84-2.58a14.98 14.98 0 006.16-12.12A14.98 14.98 0 009.631 8.41m5.96 5.96a14.926 14.926 0 01-5.841 2.58m-.119-8.54a6 6 0 00-7.381 5.84h4.8m2.581-5.84a14.927 14.927 0 00-2.58 5.84m2.699 2.7c-.103.021-.207.041-.311.06a15.09 15.09 0 01-2.448-2.448 14.9 14.9 0 01.06-.312m-2.24 2.39a4.493 4.493 0 00-1.757 4.306 4.493 4.493 0 004.306-1.758M16.5 9a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0z" />
    </svg>
  );
}

function StatsIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
    </svg>
  );
}

export default App;
