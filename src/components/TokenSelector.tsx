import { useMemo, useState } from "react";
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
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [showCustom, setShowCustom] = useState(false);
  const [customAddress, setCustomAddress] = useState("");
  const [customSymbol, setCustomSymbol] = useState("");
  const [customName, setCustomName] = useState("");
  const [customDecimals, setCustomDecimals] = useState("18");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      return tokens;
    }
    return tokens.filter(
      (token) =>
        token.symbol.toLowerCase().includes(q) ||
        token.name.toLowerCase().includes(q) ||
        token.address.toLowerCase().includes(q)
    );
  }, [query, tokens]);

  const addCustom = () => {
    if (!customAddress.startsWith("0x") || customAddress.length !== 42) {
      return;
    }
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
  };

  return (
    <div className="rounded-xl border border-cyber-tealDeep/70 bg-cyber-navyDeep/70 p-3">
      <p className="mb-2 text-xs font-semibold uppercase text-neutral-100">{label}</p>
      <button
        type="button"
        onClick={() => setOpen((s) => !s)}
        className="flex w-full items-center justify-between rounded-xl border border-cyber-tealDeep bg-cyber-navy px-3 py-3 text-left"
      >
        <span>
          <span className="block text-sm font-bold text-neutral-50">{selected?.symbol ?? "Select token"}</span>
          <span className="block text-xs text-neutral-100">{selected?.name ?? "Choose a token"}</span>
        </span>
        <span className="text-xs text-brand-blue">{open ? "Close" : "Select"}</span>
      </button>

      {open && (
        <div className="mt-2 rounded-xl border border-cyber-tealDeep bg-cyber-navy p-2">
          <div className="mb-2 flex gap-2">
            <input
              className="input"
              placeholder="Search token or address"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <button type="button" className="btn-secondary whitespace-nowrap" onClick={() => setShowCustom((s) => !s)}>
              Add
            </button>
          </div>
          <div className="max-h-52 space-y-1 overflow-auto">
            {filtered.map((token) => (
              <button
                key={token.address}
                type="button"
                className={`w-full rounded-lg border px-2 py-2 text-left text-sm transition ${
                  selected?.address === token.address
                    ? "border-brand-blue bg-cyber-tealDeep/30 text-brand-blue"
                    : "border-transparent bg-cyber-navyDeep hover:border-cyber-tealDeep text-neutral-50"
                }`}
                onClick={() => {
                  onSelect(token);
                  setOpen(false);
                }}
              >
                <div className="font-semibold">{token.symbol}</div>
                <div className="truncate text-xs text-neutral-100">{token.address}</div>
              </button>
            ))}
          </div>
        </div>
      )}
      {showCustom && (
        <div className="mt-3 space-y-2 rounded-lg border border-cyber-tealDeep bg-cyber-navy p-2">
          <input
            className="input"
            placeholder="Token address (0x...)"
            value={customAddress}
            onChange={(e) => setCustomAddress(e.target.value.trim())}
          />
          <div className="grid grid-cols-2 gap-2">
            <input
              className="input"
              placeholder="Symbol"
              value={customSymbol}
              onChange={(e) => setCustomSymbol(e.target.value)}
            />
            <input
              className="input"
              placeholder="Decimals"
              value={customDecimals}
              onChange={(e) => setCustomDecimals(e.target.value)}
            />
          </div>
          <input
            className="input"
            placeholder="Name"
            value={customName}
            onChange={(e) => setCustomName(e.target.value)}
          />
          <button className="btn-primary w-full" type="button" onClick={addCustom}>
            Save Token
          </button>
        </div>
      )}
    </div>
  );
}
