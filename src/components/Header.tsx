import { useMemo } from "react";
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
    <header className="mb-6 rounded-2xl border border-cyber-tealDeep bg-cyber-navyDeep px-4 py-3 shadow-card">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-xl font-black text-brand-blue">Hyde</h1>
          <p className="text-xs text-neutral-100">HydeSwap + HydeNFTs (more coming soon)</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={selectedNetwork.id}
            onChange={(e) => onNetworkChange(Number(e.target.value))}
            className="input w-auto min-w-[180px]"
          >
            {networks.map((net) => (
              <option key={net.id} value={net.id}>
                {net.name}
              </option>
            ))}
          </select>
          <button onClick={addNetworkToWallet} className="btn-secondary">
            Add Network
          </button>
          {!isConnected ? (
            <button className="btn-primary" onClick={connectWallet} disabled={isPending}>
              {isPending ? "Connecting..." : "Connect Wallet"}
            </button>
          ) : (
            <>
              <div className="rounded-xl border border-cyber-tealDeep bg-cyber-navy px-3 py-2 text-xs font-semibold text-neutral-50">
                {nativeBalance?.formatted ?? "0"} {selectedNetwork.currencySymbol}
              </div>
              <button className="btn-secondary" onClick={disconnect}>
                {shortenAddress(address)}
              </button>
            </>
          )}
        </div>
      </div>
      {chainMismatch && (
        <div className="mt-3 flex items-center justify-between rounded-xl border border-error/40 bg-error/10 px-3 py-2 text-sm text-neutral-50">
          <span>Wallet is on another network</span>
          <button className="btn-primary py-1 text-sm" onClick={switchNetwork}>
            Switch to {selectedNetwork.name}
          </button>
        </div>
      )}
    </header>
  );
}
