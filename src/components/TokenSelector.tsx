import { useCallback, useEffect, useMemo, useState } from "react";
import type { Address } from "viem";
import { useAccount, useBalance } from "wagmi";
import type { TokenInfo } from "../utils/constants";

type TokenSelectorProps = {
  label: string;
  selected?: TokenInfo;
  tokens: TokenInfo[];
  onSelect: (token: TokenInfo) => void;
  onAddCustom: (token: { address: Address; symbol: string; name: string; decimals: number }) => void;
  chainId?: number;
};

// Deterministic color per token symbol
function getTokenColor(symbol: string): string {
  const palette = [
    "#00d4ff", "#7c3aed", "#ff4081", "#00ff9f",
    "#ffb237", "#f97316", "#a78bfa", "#34d399",
    "#60a5fa", "#fb7185",
  ];
  let h = 0;
  for (let i = 0; i < symbol.length; i++) h = (h * 31 + symbol.charCodeAt(i)) & 0xffff;
  return palette[h % palette.length];
}

// Individual token row — fetches its own balance so hooks are called unconditionally
function TokenRow({
  token,
  selected,
  onSelect,
  chainId,
}: {
  token: TokenInfo;
  selected: boolean;
  onSelect: (t: TokenInfo) => void;
  chainId?: number;
}) {
  const { address } = useAccount();
  const { data: bal } = useBalance({
    address,
    token: token.address as Address,
    chainId,
    query: { enabled: Boolean(address) },
  });

  const color = getTokenColor(token.symbol);

  return (
    <button
      type="button"
      className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition ${
        selected ? "bg-pcs-primary/10" : "hover:bg-pcs-cardLight"
      }`}
      onClick={() => onSelect(token)}
    >
      {/* Token icon */}
      <div
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold"
        style={{
          background: `${color}18`,
          border: `1.5px solid ${color}40`,
          color,
        }}
      >
        {token.symbol.slice(0, 2).toUpperCase()}
      </div>

      {/* Name */}
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-pcs-text">{token.symbol}</div>
        <div className="truncate text-xs text-pcs-textDim">{token.name}</div>
      </div>

      {/* Balance + checkmark */}
      <div className="shrink-0 flex items-center gap-1.5">
        {bal && Number(bal.formatted) > 0 && (
          <span className="text-sm font-medium text-pcs-textSub">
            {Number(bal.formatted).toLocaleString(undefined, { maximumFractionDigits: 4 })}
          </span>
        )}
        {selected && (
          <svg className="h-4 w-4 text-pcs-primary" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
          </svg>
        )}
      </div>
    </button>
  );
}

export function TokenSelector({ label, selected, tokens, onSelect, onAddCustom, chainId }: TokenSelectorProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [showCustom, setShowCustom] = useState(false);
  const [customAddress, setCustomAddress] = useState("");
  const [customSymbol, setCustomSymbol] = useState("");
  const [customName, setCustomName] = useState("");
  const [customDecimals, setCustomDecimals] = useState("18");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tokens;
    return tokens.filter(
      (t) =>
        t.symbol.toLowerCase().includes(q) ||
        t.name.toLowerCase().includes(q) ||
        t.address.toLowerCase().includes(q)
    );
  }, [query, tokens]);

  // Quick-select chips: first 4 tokens
  const commonTokens = useMemo(() => tokens.slice(0, 4), [tokens]);

  const handleSelect = useCallback(
    (token: TokenInfo) => {
      onSelect(token);
      setOpen(false);
      setQuery("");
      setShowCustom(false);
    },
    [onSelect]
  );

  const addCustom = () => {
    if (!customAddress.startsWith("0x") || customAddress.length !== 42) return;
    const decimals = Number(customDecimals);
    onAddCustom({
      address: customAddress as Address,
      symbol: customSymbol || "CUSTOM",
      name: customName || customSymbol || "Custom Token",
      decimals: Number.isFinite(decimals) ? decimals : 18,
    });
    setShowCustom(false);
    setCustomAddress("");
    setCustomSymbol("");
    setCustomName("");
    setCustomDecimals("18");
    setOpen(false);
  };

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open]);

  const selectedColor = selected ? getTokenColor(selected.symbol) : "#00d4ff";

  return (
    <>
      {/* Trigger button */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 shrink-0 rounded-2xl px-3 py-2.5 font-semibold transition hover:opacity-90 active:scale-95"
        style={
          selected
            ? {
                background: `${selectedColor}14`,
                border: `1px solid ${selectedColor}30`,
                color: "#e0f7ff",
              }
            : { background: "#00d4ff", color: "#0a0f1e" }
        }
      >
        {selected ? (
          <>
            <div
              className="flex h-7 w-7 items-center justify-center rounded-full text-[10px] font-bold shrink-0"
              style={{
                background: `${selectedColor}25`,
                border: `1px solid ${selectedColor}40`,
                color: selectedColor,
              }}
            >
              {selected.symbol.slice(0, 2).toUpperCase()}
            </div>
            <span className="max-w-[80px] truncate text-[15px]">{selected.symbol}</span>
          </>
        ) : (
          <span className="whitespace-nowrap text-sm">Select token</span>
        )}
        <svg className="h-3.5 w-3.5 opacity-50 shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
        </svg>
      </button>

      {/* Modal */}
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => setOpen(false)} />

          <div
            className="relative w-full max-w-[400px] rounded-3xl shadow-card flex flex-col"
            style={{
              background: "#111827",
              border: "1px solid rgba(0, 212, 255, 0.12)",
              maxHeight: "min(85vh, 600px)",
            }}
          >
            {/* Header */}
            <div
              className="flex items-center justify-between px-5 py-4"
              style={{ borderBottom: "1px solid rgba(0, 212, 255, 0.07)" }}
            >
              <h3 className="text-base font-semibold text-pcs-text">Select a Token</h3>
              <button
                onClick={() => setOpen(false)}
                className="rounded-xl p-1.5 text-pcs-textDim hover:text-pcs-text hover:bg-white/[0.04] transition"
              >
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Search */}
            <div className="px-4 pt-4 pb-3">
              <input
                autoFocus
                className="input"
                placeholder="Search name or paste address"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>

            {/* Common tokens quick-select */}
            {!query && commonTokens.length > 0 && (
              <div className="px-4 pb-3 flex flex-wrap gap-2">
                {commonTokens.map((t) => {
                  const c = getTokenColor(t.symbol);
                  const isSelected = selected?.address === t.address;
                  return (
                    <button
                      key={t.address}
                      type="button"
                      onClick={() => handleSelect(t)}
                      className="flex items-center gap-1.5 rounded-xl px-2.5 py-1 text-xs font-semibold transition hover:opacity-80"
                      style={{
                        background: isSelected ? `${c}20` : `${c}0c`,
                        border: `1px solid ${isSelected ? `${c}60` : `${c}25`}`,
                        color: isSelected ? c : "#94a3b8",
                      }}
                    >
                      <span
                        className="flex h-4 w-4 items-center justify-center rounded-full text-[8px] font-bold"
                        style={{ background: `${c}25`, color: c }}
                      >
                        {t.symbol.slice(0, 1)}
                      </span>
                      {t.symbol}
                    </button>
                  );
                })}
              </div>
            )}

            {/* Section label */}
            <div className="px-5 pb-1">
              <span className="text-[10px] font-semibold uppercase tracking-widest text-pcs-textDim">
                {query ? "Results" : "Token List"}
              </span>
            </div>

            {/* Token list */}
            <div className="flex-1 overflow-auto px-2 pb-2" style={{ minHeight: 0 }}>
              {filtered.map((token) => (
                <TokenRow
                  key={token.address}
                  token={token}
                  selected={selected?.address === token.address}
                  onSelect={handleSelect}
                  chainId={chainId}
                />
              ))}
              {filtered.length === 0 && (
                <p className="px-3 py-8 text-center text-sm text-pcs-textDim">No tokens found</p>
              )}
            </div>

            {/* Add custom token */}
            <div className="px-4 py-3" style={{ borderTop: "1px solid rgba(0, 212, 255, 0.07)" }}>
              {!showCustom ? (
                <button
                  type="button"
                  onClick={() => setShowCustom(true)}
                  className="w-full rounded-xl py-2 text-sm font-medium text-pcs-textSub hover:text-pcs-primary transition"
                  style={{ border: "1px dashed rgba(0, 212, 255, 0.2)" }}
                >
                  + Add Custom Token
                </button>
              ) : (
                <div className="space-y-2">
                  <input
                    className="input text-xs"
                    placeholder="Token address (0x...)"
                    value={customAddress}
                    onChange={(e) => setCustomAddress(e.target.value.trim())}
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      className="input text-xs"
                      placeholder="Symbol"
                      value={customSymbol}
                      onChange={(e) => setCustomSymbol(e.target.value)}
                    />
                    <input
                      className="input text-xs"
                      placeholder="Decimals"
                      value={customDecimals}
                      onChange={(e) => setCustomDecimals(e.target.value)}
                    />
                  </div>
                  <input
                    className="input text-xs"
                    placeholder="Name"
                    value={customName}
                    onChange={(e) => setCustomName(e.target.value)}
                  />
                  <div className="flex gap-2">
                    <button
                      className="btn-secondary flex-1 py-2 text-xs"
                      type="button"
                      onClick={() => setShowCustom(false)}
                    >
                      Cancel
                    </button>
                    <button className="btn-primary flex-1 py-2 text-xs" type="button" onClick={addCustom}>
                      Add Token
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
