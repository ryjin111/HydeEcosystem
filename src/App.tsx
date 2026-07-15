import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { useMemo, useState } from "react";
import { Header } from "./components/Header";
import { AddLiquidityPage } from "./pages/AddLiquidity";
import { SwapPage } from "./pages/Swap";
import { LaunchpadPage } from "./pages/Launchpad";
import { DiscoverPage } from "./pages/Discover";
import { TokenPage } from "./pages/Token";
import { ProfilePage } from "./pages/Profile";
import { NETWORKS } from "./utils/constants";
import { useTokenList } from "./hooks/useTokenList";
import { useHydeTokens } from "./hooks/useDopplerTokens";

function App() {
  const [selectedNetworkId, setSelectedNetworkId] = useState(NETWORKS[0].id);
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

  // Launchpad-first IA (UI_CONSOLIDATION.md): just Launchpad + Portfolio. All the PancakeSwap-fork
  // DEX/farm cruft (Exchange, Liquidity, Farms, Pools, Stats) is gone from the nav.
  const sidebarSections: SidebarSection[] = [
    {
      title: "Launchpad",
      items: [
        // Single entry — the in-page [Launch | Explore] tabs handle the sub-nav (shiro: no double-nav).
        // Lands on the Launch form by default (?tab absent → launch).
        { to: "/launchpad", label: "Launchpad", icon: LaunchIcon },
      ],
    },
    {
      title: "Account",
      items: [{ to: "/profile", label: "Portfolio", icon: WalletIcon }],
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
        {/* Sidebar header */}
        <div className="flex h-14 items-center gap-2.5 px-4" style={{ borderBottom: '1px solid #1C1F26' }}>
          <img src="/logo/lo.png" alt="Hyde" className="h-7 w-7 rounded-md object-contain" />
          <span className="font-display text-lg font-semibold tracking-tight text-pcs-text">
            Hyde
          </span>
        </div>

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
      <div className={`flex-1 flex flex-col transition-all duration-200 ${sidebarOpen ? "md:ml-56" : "ml-0"}`}>
        <Header
          selectedNetwork={selectedNetwork}
          onNetworkChange={setSelectedNetworkId}
          networks={NETWORKS.filter((n) => n.id !== 57073)}
          onToggleSidebar={() => setSidebarOpen((s) => !s)}
          sidebarOpen={sidebarOpen}
        />

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
              <Route path="/stats" element={<Navigate to="/launchpad" replace />} />
              {/* `/` stays Discover until the Landing rebuild (UI_CONSOLIDATION step 4, shiro mock). */}
              <Route path="/" element={<DiscoverPage />} />
              {/* The board lives ONLY at /launchpad — collapse the duplicate board routes. */}
              <Route path="/discover" element={<Navigate to="/launchpad" replace />} />
              <Route path="/launches" element={<Navigate to="/launchpad" replace />} />
              <Route path="/token/:address" element={<TokenPage network={selectedNetwork} tokens={tokens} onAddCustomToken={addCustomToken} />} />
              <Route path="/profile" element={<ProfilePage />} />
              <Route path="/profile/:address" element={<ProfilePage />} />
              <Route path="/launchpad" element={<LaunchpadPage />} />
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

export default App;
