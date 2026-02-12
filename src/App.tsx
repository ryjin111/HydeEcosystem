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

  return (
    <div className="app-shell">
      <Header selectedNetwork={selectedNetwork} onNetworkChange={setSelectedNetworkId} networks={NETWORKS} />

      <nav className="mb-4 flex gap-2">
        {[
          { to: "/swap", label: "Swap" },
          { to: "/add-liquidity", label: "Add Liquidity" },
          { to: "/remove-liquidity", label: "Remove Liquidity" }
        ].map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              `rounded-xl px-4 py-2 text-sm font-semibold transition ${
                isActive
                  ? "bg-brand-yellow text-neutral-50 shadow-[0_0_20px_rgba(225,58,106,0.35)]"
                  : "border border-cyber-tealDeep bg-cyber-navy text-brand-blue hover:bg-cyber-navyDeep"
              }`
            }
          >
            {item.label}
          </NavLink>
        ))}
      </nav>

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
    </div>
  );
}

export default App;
