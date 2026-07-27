import { useEffect, useMemo, useRef } from "react";
import { NavLink, useLocation } from "react-router-dom";
import toast from "react-hot-toast";
import { useAccount, useBalance, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { ConnectorAlreadyConnectedError } from "wagmi";
import type { NetworkConfig } from "../utils/constants";
import { shortenAddress } from "../utils/format";
import { chainEngineCapabilities } from "../utils/chainRegistry";

type HeaderProps = {
  selectedNetwork: NetworkConfig;
  onNetworkChange: (id: number) => void;
  networks: NetworkConfig[];
};

type EthereumProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

// Discovery is the card board; trading lives on each token page.
const NAV: { label: string; to: string; match: (p: string, s: string) => boolean }[] = [
  { label: "Home", to: "/", match: (p) => p === "/" },
  { label: "Launch", to: "/launchpad?tab=launch", match: (p) => p.startsWith("/launchpad") },
  { label: "Discover", to: "/discover", match: (p) => p.startsWith("/discover") || p.startsWith("/token/") },
  { label: "Stats", to: "/stats", match: (p) => p.startsWith("/stats") },
];

function launchRouteComing(chainId: number): boolean {
  const capabilities = chainEngineCapabilities(chainId);
  return capabilities.length > 0
    && capabilities.every((capability) => capability.engine === "v3-single-sided" && capability.status !== "live");
}

export function Header({ selectedNetwork, onNetworkChange, networks }: HeaderProps) {
  const { address, isConnected, chainId } = useAccount();
  const { connectAsync, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChainAsync } = useSwitchChain();
  const loc = useLocation();
  const selectedNetworkComing = launchRouteComing(selectedNetwork.id);

  const { data: nativeBalance } = useBalance({ address, chainId: selectedNetwork.id });

  // A chain is "supported" when Hyde offers it (present in the switcher). We FOLLOW the wallet's chain
  // instead of nagging: "Wrong network" fires ONLY for a chain Hyde doesn't support at all.
  const walletChainSupported = useMemo(
    () => isConnected && networks.some((n) => n.id === chainId),
    [isConnected, networks, chainId]
  );
  const onUnsupportedChain = isConnected && !walletChainSupported;

  // Auto-follow the wallet's chain the moment it (newly) lands on a supported Hyde chain.
  const prevWalletChain = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (isConnected && chainId !== undefined && chainId !== prevWalletChain.current) {
      if (networks.some((n) => n.id === chainId) && chainId !== selectedNetwork.id) {
        onNetworkChange(chainId);
      }
    }
    prevWalletChain.current = isConnected ? chainId : undefined;
  }, [isConnected, chainId, networks, selectedNetwork.id, onNetworkChange]);

  const connectWallet = async () => {
    const injectedConnector = connectors[0];
    if (!injectedConnector) {
      toast.error("MetaMask connector not found");
      return;
    }
    try {
      await connectAsync({ connector: injectedConnector });
    } catch (err) {
      if (err instanceof ConnectorAlreadyConnectedError) return;
      toast.error("Wallet connection failed");
    }
  };

  const switchNetwork = async () => {
    try {
      await switchChainAsync({ chainId: selectedNetwork.id });
      toast.success(`Switched to ${selectedNetwork.name}`);
    } catch {
      toast.error("Switch network rejected");
    }
  };

  // DISCONNECTED → free browse selector (sets the view). CONNECTED → wallet is the source of truth, so a
  // pick REQUESTS a wallet chain-switch; selectedNetwork then follows via the auto-follow effect.
  const handleNetworkSelect = async (id: number) => {
    if (!isConnected || id === chainId) { onNetworkChange(id); return; }
    try {
      await switchChainAsync({ chainId: id });
    } catch {
      toast.error("Switch network rejected");
    }
  };

  const addNetworkToWallet = async () => {
    // Stable's metadata is verified (explorer + USDT0 native, gojo 24328), so wallet-add is allowed.
    const provider = (window as unknown as { ethereum?: EthereumProvider }).ethereum;
    if (!provider) { toast.error("MetaMask not detected"); return; }
    try {
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: `0x${selectedNetwork.id.toString(16)}`,
          chainName: selectedNetwork.name,
          rpcUrls: [selectedNetwork.rpcUrl],
          nativeCurrency: { name: selectedNetwork.currencySymbol, symbol: selectedNetwork.currencySymbol, decimals: 18 },
          blockExplorerUrls: [selectedNetwork.explorerUrl],
        }],
      });
      toast.success("Network added in wallet");
    } catch {
      toast.error("Failed to add network");
    }
  };

  const navCls = (active: boolean) =>
    `px-3 py-1.5 text-[13px] font-medium rounded-md transition whitespace-nowrap ${
      active ? "text-[var(--term-teal)] bg-[var(--term-teal-dim)]" : "text-[var(--term-sub)] hover:text-[var(--term-text)]"
    }`;

  return (
    <>
      <header
        className="sticky top-0 z-20 backdrop-blur-md"
        style={{ background: "rgba(8,9,11,0.9)", borderBottom: "1px solid var(--term-border)" }}
      >
        <div className="mx-auto flex h-14 max-w-[1920px] items-center gap-3 px-4 sm:px-8 md:px-10">
          {/* Brand */}
          <NavLink to="/" className="flex items-center gap-2 shrink-0">
            <span className="relative h-8 w-8 shrink-0 overflow-hidden" aria-hidden="true">
              <img
                src="/logo/trademark-shark-light.png"
                alt=""
                className="h-full w-full object-contain"
              />
            </span>
            <span className="font-display text-[15px] font-bold tracking-tight text-[var(--term-text)]">HYDEOUT</span>
          </NavLink>

          {/* Desktop nav */}
          <nav className="ml-2 hidden items-center gap-1 md:flex xl:hidden">
            {NAV.map((n) => (
              <NavLink key={n.label} to={n.to} className={navCls(n.match(loc.pathname, loc.search))}>
                {n.label}
              </NavLink>
            ))}
          </nav>

          <div className="flex-1" />

          {/* Chain pill */}
          <div
            className="hidden items-center gap-1.5 rounded-lg px-2.5 py-1.5 sm:flex"
            style={{ background: "var(--term-panel)", border: "1px solid var(--term-border)" }}
          >
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ background: selectedNetworkComing ? "var(--term-dim)" : "var(--term-teal)" }}
            />
            <select
              value={selectedNetwork.id}
              onChange={(e) => handleNetworkSelect(Number(e.target.value))}
              className="cursor-pointer bg-transparent text-[12px] font-medium text-[var(--term-sub)] outline-none"
            >
              {networks.map((net) => (
                <option key={net.id} value={net.id} style={{ background: "#0e1114" }}>
                  {net.name} · {net.id}
                  {launchRouteComing(net.id) ? " · Coming" : ""}
                </option>
              ))}
            </select>
          </div>

          {/* Wallet */}
          {!isConnected ? (
            <button className="btn-terminal px-4 py-1.5 text-[13px]" onClick={connectWallet} disabled={isPending}>
              {isPending ? "…" : "Connect"}
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <div
                className="hidden rounded-lg px-3 py-1.5 font-code text-[12px] text-[var(--term-sub)] sm:block"
                style={{ background: "var(--term-panel)", border: "1px solid var(--term-border)" }}
              >
                {nativeBalance?.formatted ? Number(nativeBalance.formatted).toFixed(4) : "0"} {selectedNetwork.currencySymbol}
              </div>
              <button
                className="rounded-lg px-3 py-1.5 font-code text-[12px] font-semibold text-[var(--term-text)] transition"
                style={{ background: "var(--term-panel)", border: "1px solid var(--term-border)" }}
                onClick={() => disconnect()}
              >
                {shortenAddress(address)}
              </button>
            </div>
          )}
        </div>

        {/* Mobile navigation keeps the reference hierarchy without forcing the chain control off-screen. */}
        <nav
          className="grid grid-cols-4 gap-1 px-3 pb-2 md:hidden"
          style={{ borderTop: "1px solid var(--term-border-soft)" }}
        >
          {NAV.map((n) => (
            <NavLink
              key={n.label}
              to={n.to}
              className={`${navCls(n.match(loc.pathname, loc.search))} text-center`}
            >
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="mx-3 mb-2 flex items-center gap-2 rounded-md border border-[var(--term-border)] px-3 py-1.5 md:hidden">
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ background: selectedNetworkComing ? "var(--term-dim)" : "var(--term-teal)" }}
          />
          <select
            aria-label="Network"
            value={selectedNetwork.id}
            onChange={(e) => handleNetworkSelect(Number(e.target.value))}
            className="min-w-0 flex-1 cursor-pointer bg-transparent text-[11px] text-[var(--term-sub)] outline-none"
          >
            {networks.map((net) => (
              <option key={net.id} value={net.id} style={{ background: "#0e1114" }}>
                {net.name} · {net.id}
                {launchRouteComing(net.id) ? " · Coming" : ""}
              </option>
            ))}
          </select>
        </div>
      </header>

      {/* Unsupported-network banner — only when the wallet is on a chain Hyde doesn't support at all. */}
      {onUnsupportedChain && (
        <div className="mx-auto mt-3 max-w-[1920px] px-4 sm:px-8 md:px-10">
          <div
            className="flex items-center justify-between gap-3 rounded-lg px-4 py-2.5"
            style={{ background: "rgba(246,70,93,0.08)", border: "1px solid rgba(246,70,93,0.3)" }}
          >
            <div className="flex min-w-0 items-center gap-2">
              <svg className="h-4 w-4 shrink-0" style={{ color: "var(--term-red)" }} fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
              </svg>
              <span className="text-sm font-medium" style={{ color: "var(--term-red)" }}>Unsupported network</span>
              <span className="hidden truncate text-xs text-[var(--term-dim)] sm:block">— switch to {selectedNetwork.name}</span>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button onClick={addNetworkToWallet} className="rounded-md px-3 py-1 text-xs font-semibold text-[var(--term-sub)] transition hover:text-[var(--term-text)]" style={{ border: "1px solid var(--term-border)" }}>
                Add
              </button>
              <button
                onClick={switchNetwork}
                className="rounded-md px-3 py-1 text-xs font-semibold transition active:scale-95"
                style={{ background: "rgba(246,70,93,0.14)", border: "1px solid rgba(246,70,93,0.45)", color: "var(--term-red)" }}
              >
                Switch
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
