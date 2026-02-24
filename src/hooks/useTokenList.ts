import { useMemo, useState } from "react";
import { getAddress } from "viem";
import type { Address } from "viem";
import toast from "react-hot-toast";
import type { NetworkConfig, TokenInfo } from "../utils/constants";

type CustomTokenRecord = Record<number, TokenInfo[]>;

const STORAGE_KEY = "tempo-ui-custom-tokens";

function isChecksumAddress(addr: string): boolean {
  try {
    getAddress(addr);
    return true;
  } catch {
    return false;
  }
}

function isValidToken(t: unknown): t is TokenInfo {
  if (!t || typeof t !== "object") return false;
  const obj = t as Record<string, unknown>;
  return (
    typeof obj.address === "string" &&
    obj.address.startsWith("0x") &&
    obj.address.length === 42 &&
    isChecksumAddress(obj.address) &&
    typeof obj.symbol === "string" &&
    obj.symbol.length > 0 &&
    obj.symbol.length <= 12 &&
    typeof obj.name === "string" &&
    typeof obj.decimals === "number" &&
    obj.decimals >= 0 &&
    obj.decimals <= 18
  );
}

function loadCustomTokens(): CustomTokenRecord {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as CustomTokenRecord;
    const validated: CustomTokenRecord = {};
    for (const [chainIdStr, tokens] of Object.entries(parsed)) {
      const chainId = Number(chainIdStr);
      if (!Number.isInteger(chainId) || chainId <= 0) continue;
      if (Array.isArray(tokens)) {
        validated[chainId] = tokens.filter(isValidToken).slice(0, 50);
      }
    }
    return validated;
  } catch {
    toast.error("Custom token list could not be loaded — it may be corrupted. Resetting.");
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    return {};
  }
}

export function useTokenList(network: NetworkConfig) {
  const [customTokens, setCustomTokens] = useState<CustomTokenRecord>(() => loadCustomTokens());

  const tokens = useMemo(() => {
    const extra = customTokens[network.id] ?? [];
    const merged = [...extra, ...network.tokens];
    const unique = new Map(merged.map((token) => [token.address.toLowerCase(), token]));
    return Array.from(unique.values());
  }, [customTokens, network]);

  const addCustomToken = (token: { address: Address; symbol: string; name: string; decimals: number }) => {
    // Normalise to checksum form; reject if invalid
    let checksummed: Address;
    try {
      checksummed = getAddress(token.address) as Address;
    } catch {
      toast.error("Invalid token address checksum");
      return;
    }
    if (token.decimals < 0 || token.decimals > 18) return;
    setCustomTokens((prev) => {
      const existing = prev[network.id] ?? [];
      if (existing.length >= 50) return prev;
      if (existing.some((t) => t.address.toLowerCase() === checksummed.toLowerCase())) return prev;
      const nextForChain = [...existing, { ...token, address: checksummed }];
      const next = { ...prev, [network.id]: nextForChain };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        toast.error("Failed to save custom token — storage may be full");
      }
      return next;
    });
  };

  return { tokens, addCustomToken };
}
