import { useState } from "react";
import { V4LiquidityCard } from "../components/V4LiquidityCard";
import type { NetworkConfig, TokenInfo } from "../utils/constants";

type Props = {
  network: NetworkConfig;
  tokens: TokenInfo[];
  onAddCustomToken: (token: { address: `0x${string}`; symbol: string; name: string; decimals: number }) => void;
};

export function AddLiquidityPage({ network, tokens, onAddCustomToken }: Props) {
  const [mode, setMode] = useState<"add" | "remove">("add");

  return (
    <div className="max-w-[440px] mx-auto">
      {/* Add / Remove toggle */}
      <div
        className="mb-4 flex items-center rounded-2xl p-1 mx-auto"
        style={{ background: '#111827', border: '1px solid rgba(0, 212, 255, 0.08)' }}
      >
        <button
          type="button"
          onClick={() => setMode("add")}
          className={`flex-1 flex items-center justify-center gap-1.5 rounded-xl px-4 py-2 text-sm font-semibold transition ${
            mode === "add"
              ? "bg-pcs-secondary text-white shadow-sm"
              : "text-pcs-textSub hover:text-pcs-text"
          }`}
        >
          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          Add
        </button>
        <button
          type="button"
          onClick={() => setMode("remove")}
          className={`flex-1 flex items-center justify-center gap-1.5 rounded-xl px-4 py-2 text-sm font-semibold transition ${
            mode === "remove"
              ? "bg-pcs-failure/80 text-white shadow-sm"
              : "text-pcs-textSub hover:text-pcs-text"
          }`}
        >
          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 12h-15" />
          </svg>
          Remove
        </button>
      </div>

      <V4LiquidityCard
        network={network}
        tokens={tokens}
        mode={mode}
        onAddCustomToken={onAddCustomToken}
      />
    </div>
  );
}
