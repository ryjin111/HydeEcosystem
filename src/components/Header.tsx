import { useMemo, useState } from "react";
import { NavLink } from "react-router-dom";
import toast from "react-hot-toast";
import { useAccount, useBalance, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import type { NetworkConfig } from "../utils/constants";
import { shortenAddress } from "../utils/format";

type HeaderProps = {
  selectedNetwork: NetworkConfig;
  onNetworkChange: (id: number) => void;
  networks: NetworkConfig[];
};

type EthereumProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

export function Header({ selectedNetwork, onNetworkChange, networks }: HeaderProps) {
  const { address, isConnected, chainId } = useAccount();
  const { connectAsync, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChainAsync } = useSwitchChain();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const { data: nativeBalance } = useBalance({
    address,
    chainId: selectedNetwork.id
  });

  const chainMismatch = useMemo(
    () => isConnected && chainId !== selectedNetwork.id,
    [isConnected, chainId, selectedNetwork.id]
  );

  const connectWallet = async () => {
    const injectedConnector = connectors[0];
    if (!injectedConnector) {
      toast.error("MetaMask connector not found");
      return;
    }
    try {
      await connectAsync({ connector: injectedConnector });
    } catch {
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

  const addNetworkToWallet = async () => {
    const provider = (window as unknown as { ethereum?: EthereumProvider }).ethereum;
    if (!provider) {
      toast.error("MetaMask not detected");
      return;
    }
    try {
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: `0x${selectedNetwork.id.toString(16)}`,
            chainName: selectedNetwork.name,
            rpcUrls: [selectedNetwork.rpcUrl],
            nativeCurrency: {
              name: selectedNetwork.currencySymbol,
              symbol: selectedNetwork.currencySymbol,
              decimals: 18
            },
            blockExplorerUrls: [selectedNetwork.explorerUrl]
          }
        ]
      });
      toast.success("Network added in wallet");
    } catch {
      toast.error("Failed to add network");
    }
  };

  const navLinks = [
    { to: "/swap", label: "Swap" },
    { to: "/add-liquidity", label: "Liquidity" },
  ];

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `px-4 py-2 text-sm font-semibold rounded-2xl transition ${
      isActive
        ? "bg-pcs-cardLight text-pcs-primary"
        : "text-pcs-textSub hover:text-pcs-text"
    }`;

  return (
    <>
      <header className="sticky top-0 z-40 bg-pcs-card/95 backdrop-blur-md" style={{ borderBottom: '1px solid rgba(0, 212, 255, 0.1)' }}>
        <div className="mx-auto flex h-14 max-w-[1200px] items-center justify-between px-4">
          {/* Left: Logo + Nav */}
          <div className="flex items-center gap-6">
            <h1 className="text-xl font-bold tracking-tight" style={{ color: '#00d4ff', textShadow: '0 0 10px rgba(0, 212, 255, 0.5), 0 0 20px rgba(0, 212, 255, 0.2)' }}>
              Hyde
            </h1>
            <nav className="hidden items-center gap-1 md:flex">
              {navLinks.map((item) => (
                <NavLink key={item.to} to={item.to} className={linkClass}>
                  {item.label}
                </NavLink>
              ))}
            </nav>
          </div>

          {/* Right: Network + Wallet */}
          <div className="flex items-center gap-2">
            <select
              value={selectedNetwork.id}
              onChange={(e) => onNetworkChange(Number(e.target.value))}
              className="hidden sm:block rounded-2xl border-0 bg-pcs-input px-3 py-2 text-xs font-medium text-pcs-text outline-none cursor-pointer"
            >
              {networks.map((net) => (
                <option key={net.id} value={net.id}>
                  {net.name}
                </option>
              ))}
            </select>

            <button
              onClick={addNetworkToWallet}
              className="hidden sm:inline-flex rounded-2xl bg-pcs-input px-3 py-2 text-xs font-medium text-pcs-textSub hover:text-pcs-text transition"
            >
              Add Net
            </button>

            {!isConnected ? (
              <button className="btn-primary px-4 py-2 text-sm" onClick={connectWallet} disabled={isPending}>
                {isPending ? "Connecting..." : "Connect Wallet"}
              </button>
            ) : (
              <div className="flex items-center gap-2">
                <div className="hidden sm:block rounded-2xl bg-pcs-input px-3 py-2 text-xs font-medium text-pcs-textSub">
                  {nativeBalance?.formatted ? Number(nativeBalance.formatted).toFixed(4) : "0"} {selectedNetwork.currencySymbol}
                </div>
                <button
                  className="rounded-2xl bg-pcs-primary px-4 py-2 text-xs font-semibold text-pcs-bg hover:opacity-90 transition"
                  onClick={() => disconnect()}
                >
                  {shortenAddress(address)}
                </button>
              </div>
            )}

            {/* Mobile menu button */}
            <button
              className="ml-1 md:hidden rounded-xl p-2 text-pcs-textSub hover:text-pcs-text"
              onClick={() => setMobileMenuOpen((s) => !s)}
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                {mobileMenuOpen ? (
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                ) : (
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 9h16.5m-16.5 6.75h16.5" />
                )}
              </svg>
            </button>
          </div>
        </div>

        {/* Mobile nav dropdown */}
        {mobileMenuOpen && (
          <div className="border-t border-pcs-border/50 px-4 py-3 md:hidden">
            <nav className="flex flex-col gap-1">
              {navLinks.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={linkClass}
                  onClick={() => setMobileMenuOpen(false)}
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>
            <div className="mt-3 flex flex-col gap-2">
              <select
                value={selectedNetwork.id}
                onChange={(e) => onNetworkChange(Number(e.target.value))}
                className="rounded-2xl border-0 bg-pcs-input px-3 py-2 text-xs font-medium text-pcs-text outline-none"
              >
                {networks.map((net) => (
                  <option key={net.id} value={net.id}>
                    {net.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}
      </header>

      {/* Chain mismatch banner */}
      {chainMismatch && (
        <div className="mx-auto max-w-swap px-4 mt-3">
          <div className="flex items-center justify-between rounded-2xl bg-pcs-failure/10 border border-pcs-failure/30 px-4 py-2 text-sm text-pcs-text">
            <span>Wrong network</span>
            <button className="btn-primary py-1.5 px-3 text-xs" onClick={switchNetwork}>
              Switch to {selectedNetwork.name}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
