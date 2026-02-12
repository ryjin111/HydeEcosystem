import { useCallback, useEffect, useMemo, useState } from "react";
import type { Address } from "viem";
import type { TokenInfo } from "../utils/constants";

type TokenSelectorProps = {
  label: string;
  selected?: TokenInfo;
  tokens: TokenInfo[];
  onSelect: (token: TokenInfo) => void;
  onAddCustom: (token: { address: Address; symbol: string; name: string; decimals: number }) => void;
};

export function TokenSelector({ label, selected, tokens, onSelect, onAddCustom }: TokenSelectorProps) {
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
      (token) =>
        token.symbol.toLowerCase().includes(q) ||
        token.name.toLowerCase().includes(q) ||
        token.address.toLowerCase().includes(q)
    );
  }, [query, tokens]);

  const handleSelect = useCallback(
    (token: TokenInfo) => {
      onSelect(token);
      setOpen(false);
      setQuery("");
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
      decimals: Number.isFinite(decimals) ? decimals : 18
    });
    setShowCustom(false);
    setCustomAddress("");
    setCustomSymbol("");
    setCustomName("");
    setCustomDecimals("18");
    setOpen(false);
  };

  // Close modal on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open]);

  return (
    <>
      {/* Trigger button - PCS v1 "Select a currency" style */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 shrink-0 rounded-2xl px-3 py-2 text-sm font-semibold transition hover:opacity-80"
        style={
          selected
            ? { background: 'rgba(0, 212, 255, 0.08)', border: '1px solid rgba(0, 212, 255, 0.15)', color: '#e0f7ff' }
            : { background: '#00d4ff', color: '#0a0f1e' }
        }
      >
        {selected ? (
          <>
            <div className="flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-bold" style={{ background: 'rgba(0, 212, 255, 0.15)', color: '#00d4ff' }}>
              {selected.symbol.slice(0, 2)}
            </div>
            <span>{selected.symbol}</span>
          </>
        ) : (
          <span>Select a currency</span>
        )}
        <svg className="h-3 w-3 opacity-60" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
        </svg>
      </button>

      {/* Modal overlay */}
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          {/* Backdrop */}
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setOpen(false)} />

          {/* Modal */}
          <div className="relative w-full max-w-[420px] rounded-3xl bg-pcs-card shadow-card">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-pcs-border/50 px-5 py-4">
              <h3 className="text-base font-semibold text-pcs-text">Select a Token</h3>
              <button
                onClick={() => setOpen(false)}
                className="rounded-xl p-1.5 text-pcs-textDim hover:text-pcs-text hover:bg-pcs-cardLight transition"
              >
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Search */}
            <div className="px-5 pt-4">
              <input
                autoFocus
                className="input"
                placeholder="Search name or paste address"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>

            {/* Token list */}
            <div className="mt-3 max-h-[320px] overflow-auto px-2 pb-2">
              {filtered.map((token) => (
                <button
                  key={token.address}
                  type="button"
                  className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition ${
                    selected?.address === token.address
                      ? "bg-pcs-primary/10"
                      : "hover:bg-pcs-cardLight"
                  }`}
                  onClick={() => handleSelect(token)}
                >
                  {/* Token icon placeholder */}
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-pcs-cardLight text-xs font-bold text-pcs-primary">
                    {token.symbol.slice(0, 2)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-pcs-text">{token.symbol}</div>
                    <div className="truncate text-xs text-pcs-textDim">{token.name}</div>
                  </div>
                  {selected?.address === token.address && (
                    <svg className="h-4 w-4 shrink-0 text-pcs-primary" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                    </svg>
                  )}
                </button>
              ))}
              {filtered.length === 0 && (
                <p className="px-3 py-6 text-center text-sm text-pcs-textDim">No tokens found</p>
              )}
            </div>

            {/* Add custom token */}
            <div className="border-t border-pcs-border/50 px-5 py-3">
              {!showCustom ? (
                <button
                  type="button"
                  onClick={() => setShowCustom(true)}
                  className="w-full rounded-2xl border border-dashed border-pcs-border py-2 text-sm font-medium text-pcs-textSub hover:text-pcs-primary hover:border-pcs-primary/40 transition"
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
                    <button className="btn-secondary flex-1 py-2 text-xs" type="button" onClick={() => setShowCustom(false)}>
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
