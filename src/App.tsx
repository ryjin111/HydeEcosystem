import { Navigate, Route, Routes } from "react-router-dom";
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
    <div className="min-h-screen">
      <Header selectedNetwork={selectedNetwork} onNetworkChange={setSelectedNetworkId} networks={NETWORKS} />

      <main className="mx-auto max-w-swap px-4 pt-8 pb-16">
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
    </div>
  );
}

export default App;
