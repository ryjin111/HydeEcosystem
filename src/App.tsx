import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { useMemo, useState } from "react";
import { Header } from "./components/Header";
import { AddLiquidityPage } from "./pages/AddLiquidity";
import { RemoveLiquidityPage } from "./pages/RemoveLiquidity";
import { SwapPage } from "./pages/Swap";
import { NETWORKS } from "./utils/constants";
import { useTokenList } from "./hooks/useTokenList";

function App() {
  const [selectedNetworkId, setSelectedNetworkId] = useState(NETWORKS[0].id);
  const selectedNetwork = useMemo(
    () => NETWORKS.find((network) => network.id === selectedNetworkId) ?? NETWORKS[0],
    [selectedNetworkId]
  );

  const { tokens, addCustomToken } = useTokenList(selectedNetwork);
  const stats = [
    { label: "TVL", value: "$40,416,759" },
    { label: "Volume 24h", value: "$943,224" },
    { label: "Fees 24h", value: "$5,413" }
  ];
  const trending = [
    "pathUSD/AlphaUSD",
    "pathUSD/BetaUSD",
    "AlphaUSD/ThetaUSD",
    "pathUSD/ThetaUSD",
    "BetaUSD/ThetaUSD"
  ];

  return (
    <div className="min-h-screen">
      <Header selectedNetwork={selectedNetwork} onNetworkChange={setSelectedNetworkId} networks={NETWORKS} />

      <div className="grid min-h-[calc(100vh-84px)] grid-cols-1 border-t border-cyber-tealDeep/40 lg:grid-cols-[240px_1fr_320px]">
        <aside className="border-r border-cyber-tealDeep/30 bg-cyber-black/40 p-4">
          <p className="mb-3 text-xs uppercase tracking-wide text-neutral-100">Hyde</p>
          <nav className="space-y-2">
            {[
              { to: "/swap", label: "Swap" },
              { to: "/add-liquidity", label: "Pools" },
              { to: "/remove-liquidity", label: "Launchpad (Soon)" },
              { to: "/swap", label: "Terminal (Soon)" },
              { to: "/swap", label: "Leaderboard (Soon)" }
            ].map((item) => (
              <NavLink
                key={`${item.to}-${item.label}`}
                to={item.to}
                className={({ isActive }) =>
                  `block rounded-xl px-3 py-2 text-sm font-semibold transition ${
                    isActive
                      ? "bg-brand-yellow/20 text-brand-blue"
                      : "text-neutral-50 hover:bg-cyber-navy hover:text-brand-blue"
                  }`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
        </aside>

        <main className="p-4 md:p-6">
          <div className="mb-5 grid gap-3 md:grid-cols-3">
            {stats.map((stat) => (
              <div key={stat.label} className="rounded-2xl border border-cyber-tealDeep/60 bg-cyber-navy/70 p-4">
                <p className="text-xs uppercase tracking-wide text-neutral-100">{stat.label}</p>
                <p className="mt-2 text-2xl font-semibold text-neutral-50">{stat.value}</p>
                <div className="mt-4 h-1 rounded-full bg-gradient-to-r from-brand-blue to-brand-yellow" />
              </div>
            ))}
          </div>

          <Routes>
            <Route
              path="/swap"
              element={<SwapPage network={selectedNetwork} tokens={tokens} onAddCustomToken={addCustomToken} />}
            />
            <Route
              path="/add-liquidity"
              element={<AddLiquidityPage network={selectedNetwork} tokens={tokens} onAddCustomToken={addCustomToken} />}
            />
            <Route
              path="/remove-liquidity"
              element={
                <RemoveLiquidityPage network={selectedNetwork} tokens={tokens} onAddCustomToken={addCustomToken} />
              }
            />
            <Route path="*" element={<Navigate to="/swap" replace />} />
          </Routes>
        </main>

        <aside className="hidden border-l border-cyber-tealDeep/30 bg-cyber-black/30 p-5 lg:block">
          <div className="rounded-2xl border border-cyber-tealDeep/60 bg-cyber-navy/70 p-4">
            <h3 className="mb-4 text-sm font-semibold text-brand-blue">Trending Pools</h3>
            <div className="space-y-3">
              {trending.map((pair, index) => (
                <div key={pair} className="flex items-center justify-between text-sm">
                  <span className="text-neutral-50">{pair}</span>
                  <span className="text-brand-blue">+{(index + 5) * 8.7}%</span>
                </div>
              ))}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

export default App;
