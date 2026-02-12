import { useMemo } from "react";
import toast from "react-hot-toast";
import { useAccount, useBalance, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import type { NetworkConfig } from "../utils/constants";
import { shortenAddress } from "../utils/format";

type HeaderProps = {
  selectedNetwork: NetworkConfig;
  onNetworkChange: (id: number) => void;
  networks: NetworkConfig[];
  onToggleSidebar: () => void;
  sidebarOpen: boolean;
};

type EthereumProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

export function Header({ selectedNetwork, onNetworkChange, networks, onToggleSidebar, sidebarOpen }: HeaderProps) {
  const { address, isConnected, chainId } = useAccount();
  const { connectAsync, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChainAsync } = useSwitchChain();

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

  return (
    <>
      <header
        className="sticky top-0 z-20 flex h-14 items-center justify-between px-4 backdrop-blur-md"
        style={{ background: 'rgba(13, 18, 32, 0.9)', borderBottom: '1px solid rgba(0, 212, 255, 0.06)' }}
      >
        {/* Left: sidebar toggle */}
        <button
          onClick={onToggleSidebar}
          className="rounded-lg p-2 text-pcs-textSub hover:text-pcs-primary hover:bg-white/[0.03] transition"
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            {sidebarOpen ? (
              <path strokeLinecap="round" strokeLinejoin="round" d="M18.75 19.5l-7.5-7.5 7.5-7.5m-6 15L5.25 12l7.5-7.5" />
            ) : (
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 9h16.5m-16.5 6.75h16.5" />
            )}
          </svg>
        </button>

        {/* Right: network + wallet */}
        <div className="flex items-center gap-2">
          <select
            value={selectedNetwork.id}
            onChange={(e) => onNetworkChange(Number(e.target.value))}
            className="rounded-xl bg-pcs-card px-3 py-1.5 text-xs font-medium text-pcs-textSub outline-none cursor-pointer"
            style={{ border: '1px solid rgba(0, 212, 255, 0.1)' }}
          >
            {networks.map((net) => (
              <option key={net.id} value={net.id}>
                {net.name}
              </option>
            ))}
          </select>

          {!isConnected ? (
            <button className="btn-primary px-4 py-1.5 text-xs" onClick={connectWallet} disabled={isPending}>
              {isPending ? "..." : "Connect"}
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <div
                className="hidden sm:block rounded-xl px-3 py-1.5 text-xs font-medium text-pcs-textSub"
                style={{ background: 'rgba(0, 212, 255, 0.05)', border: '1px solid rgba(0, 212, 255, 0.1)' }}
              >
                {nativeBalance?.formatted ? Number(nativeBalance.formatted).toFixed(4) : "0"} {selectedNetwork.currencySymbol}
              </div>
              <button
                className="rounded-xl bg-pcs-primary px-4 py-1.5 font-mono text-xs font-semibold text-pcs-bg hover:shadow-neon transition"
                onClick={() => disconnect()}
              >
                {shortenAddress(address)}
              </button>
            </div>
          )}
        </div>
      </header>

      {/* Chain mismatch banner */}
      {chainMismatch && (
        <div className="mx-auto max-w-[420px] px-4 mt-3">
          <div
            className="flex items-center justify-between gap-3 rounded-xl px-4 py-2.5"
            style={{ background: 'rgba(255, 64, 129, 0.07)', border: '1px solid rgba(255, 64, 129, 0.25)' }}
          >
            {/* Left: icon + text */}
            <div className="flex items-center gap-2 min-w-0">
              <svg className="h-4 w-4 shrink-0 text-pcs-failure" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
              </svg>
              <span className="text-sm font-medium text-pcs-failure">Wrong network</span>
              <span className="hidden sm:block text-xs text-pcs-textDim truncate">— connect to {selectedNetwork.name}</span>
            </div>

            {/* Right: action button */}
            <button
              onClick={switchNetwork}
              className="shrink-0 rounded-lg px-3 py-1 text-xs font-semibold transition hover:opacity-90 active:scale-95"
              style={{
                background: 'rgba(255, 64, 129, 0.15)',
                border: '1px solid rgba(255, 64, 129, 0.4)',
                color: '#ff4081',
              }}
            >
              Switch
            </button>
          </div>
        </div>
      )}
    </>
  );
}
