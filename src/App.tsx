import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { useMemo, useState } from "react";
import { Header } from "./components/Header";
import { AddLiquidityPage } from "./pages/AddLiquidity";
import { SwapPage } from "./pages/Swap";
import { NETWORKS } from "./utils/constants";
import { useTokenList } from "./hooks/useTokenList";

function App() {
  const [selectedNetworkId, setSelectedNetworkId] = useState(NETWORKS[0].id);
  const selectedNetwork = useMemo(
    () => NETWORKS.find((network) => network.id === selectedNetworkId) ?? NETWORKS[0],
    [selectedNetworkId]
  );
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const { tokens, addCustomToken } = useTokenList(selectedNetwork);

  type SidebarItem = { to: string; label: string; icon: () => React.JSX.Element; disabled?: boolean };
  type SidebarSection = { title: string; items: SidebarItem[] };

  const sidebarSections: SidebarSection[] = [
    {
      title: "HydeSwap",
      items: [
        { to: "/swap", label: "Exchange", icon: SwapIcon },
        { to: "/add-liquidity", label: "Liquidity", icon: LiquidityIcon },
      ],
    },
    {
      title: "Earn",
      items: [
        { to: "#", label: "Farms (Soon)", icon: FarmIcon, disabled: true },
        { to: "#", label: "Pools (Soon)", icon: PoolIcon, disabled: true },
      ],
    },
    {
      title: "More",
      items: [
        { to: "#", label: "Launchpad (Soon)", icon: LaunchIcon, disabled: true },
        { to: "#", label: "Info (Soon)", icon: InfoIcon, disabled: true },
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
        style={{ background: '#0d1220', borderRight: '1px solid rgba(0, 212, 255, 0.08)' }}
      >
        {/* Sidebar header */}
        <div className="flex h-14 items-center px-4" style={{ borderBottom: '1px solid rgba(0, 212, 255, 0.06)' }}>
          <h1 className="text-lg font-bold tracking-tight" style={{ color: '#00d4ff', textShadow: '0 0 10px rgba(0, 212, 255, 0.5)' }}>
            Hyde
          </h1>
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
        <div className="px-4 py-3" style={{ borderTop: '1px solid rgba(0, 212, 255, 0.06)' }}>
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
          networks={NETWORKS}
          onToggleSidebar={() => setSidebarOpen((s) => !s)}
          sidebarOpen={sidebarOpen}
        />

        <main className="flex-1 flex flex-col items-center px-4 pt-8 pb-16">
          {/* Card area */}
          <div className="w-full max-w-[420px]">
            <Routes>
              <Route
                path="/swap"
                element={<SwapPage network={selectedNetwork} tokens={tokens} onAddCustomToken={addCustomToken} />}
              />
              <Route
                path="/add-liquidity"
                element={<AddLiquidityPage network={selectedNetwork} tokens={tokens} onAddCustomToken={addCustomToken} />}
              />
              <Route path="/remove-liquidity" element={<Navigate to="/add-liquidity" replace />} />
              <Route path="*" element={<Navigate to="/swap" replace />} />
            </Routes>
          </div>
        </main>
      </div>
    </div>
  );
}

/* ---------- Sidebar Icons ---------- */

function SwapIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
    </svg>
  );
}

function LiquidityIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
    </svg>
  );
}


function FarmIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M20.893 13.393l-1.135-1.135a2.252 2.252 0 01-.421-.585l-1.08-2.16a.414.414 0 00-.663-.107.827.827 0 01-.812.21l-1.273-.363a.89.89 0 00-.738 1.595l.587.39c.59.395.674 1.23.172 1.732l-.2.2c-.212.212-.33.498-.33.796v.41c0 .409-.11.809-.32 1.158l-1.315 2.191a2.11 2.11 0 01-1.81 1.025 1.055 1.055 0 01-1.055-1.055v-1.172c0-.92-.56-1.747-1.414-2.089l-.655-.261a2.25 2.25 0 01-1.383-2.46l.007-.042a2.25 2.25 0 01.29-.787l.09-.15a2.25 2.25 0 012.37-1.048l1.178.236a1.125 1.125 0 001.302-.795l.208-.73a1.125 1.125 0 00-.578-1.315l-.665-.332-.091.091a2.25 2.25 0 01-1.591.659h-.18c-.249 0-.487.1-.662.274a.931.931 0 01-1.458-1.137l1.411-2.353a2.25 2.25 0 00.286-.76M11.25 2.25L12 2.25" />
    </svg>
  );
}

function PoolIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125" />
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

function InfoIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
    </svg>
  );
}

export default App;
