import { useMemo, useState } from "react";
import type { Address } from "viem";
import type { NetworkConfig, TokenInfo } from "../utils/constants";

type CustomTokenRecord = Record<number, TokenInfo[]>;

const STORAGE_KEY = "tempo-ui-custom-tokens";

function loadCustomTokens(): CustomTokenRecord {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {};
    }
    return JSON.parse(raw) as CustomTokenRecord;
  } catch {
    return {};
  }
}

export function useTokenList(network: NetworkConfig) {
  const [customTokens, setCustomTokens] = useState<CustomTokenRecord>(() => loadCustomTokens());

  const tokens = useMemo(() => {
    const extra = customTokens[network.id] ?? [];
    const merged = [...network.faucetTokens, ...extra];
    const unique = new Map(merged.map((token) => [token.address.toLowerCase(), token]));
    return Array.from(unique.values());
  }, [customTokens, network]);

  const addCustomToken = (token: { address: Address; symbol: string; name: string; decimals: number }) => {
    setCustomTokens((prev) => {
      const nextForChain = [...(prev[network.id] ?? []), token];
      const next = { ...prev, [network.id]: nextForChain };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  };

  return { tokens, addCustomToken };
}
