import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { formatUnits, parseUnits } from "viem";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import { erc20Abi, stakingPoolAbi } from "../utils/constants";
import { POOL_CONFIGS, type PoolConfig } from "../utils/farmConfig";
import type { NetworkConfig } from "../utils/constants";

type Props = { network: NetworkConfig };

function PoolCard({ pool, network }: { pool: PoolConfig; network: NetworkConfig }) {
  const { address, chainId, isConnected } = useAccount();
  const publicClient = usePublicClient({ chainId: network.id });
  const { data: walletClient } = useWalletClient({ chainId: network.id });
  const chainMismatch = isConnected && chainId !== network.id;

  const [expanded, setExpanded] = useState(false);
  const [stakeInput, setStakeInput] = useState("");
  const [unstakeInput, setUnstakeInput] = useState("");
  const [tab, setTab] = useState<"stake" | "unstake">("stake");
  const [stakedAmt, setStakedAmt] = useState(0n);
  const [pendingAmt, setPendingAmt] = useState(0n);
  const [balance, setBalance] = useState(0n);
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(false);

  useEffect(() => {
    if (!address || !publicClient) return;
    const run = async () => {
      setFetching(true);
      try {
        const isNativeStake = pool.stakedToken === "0x0000000000000000000000000000000000000000";
        const [userInfo, pending, bal] = await Promise.all([
          publicClient.readContract({ address: pool.contract, abi: stakingPoolAbi, functionName: "userInfo", args: [address] }),
          publicClient.readContract({ address: pool.contract, abi: stakingPoolAbi, functionName: "pendingReward", args: [address] }),
          isNativeStake
            ? publicClient.getBalance({ address })
            : publicClient.readContract({ address: pool.stakedToken, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
        ]);
        setStakedAmt(userInfo[0]);
        setPendingAmt(pending);
        setBalance(bal as bigint);
      } catch { /* placeholder */ } finally { setFetching(false); }
    };
    run();
  }, [address, publicClient, pool]);

  const action = async (type: "stake" | "unstake" | "harvest") => {
    if (!walletClient || !address) { toast.error("Connect wallet first"); return; }
    if (chainMismatch) { toast.error("Switch network first"); return; }
    try {
      setLoading(true);
      if (type === "stake") {
        const amount = parseUnits(stakeInput || "0", pool.stakedDecimals);
        if (amount === 0n) { toast.error("Enter an amount"); return; }
        const isNative = pool.stakedToken === "0x0000000000000000000000000000000000000000";
        if (!isNative) {
          toast.loading(`Approving ${pool.stakedSymbol}…`, { id: "pool-action" });
          await walletClient.writeContract({ address: pool.stakedToken, abi: erc20Abi, functionName: "approve", args: [pool.contract, amount], account: address, chain: walletClient.chain });
        }
        toast.loading("Staking…", { id: "pool-action" });
        const hash = await walletClient.writeContract({ address: pool.contract, abi: stakingPoolAbi, functionName: "deposit", args: [amount], account: address, chain: walletClient.chain });
        await publicClient!.waitForTransactionReceipt({ hash });
        toast.success("Staked!", { id: "pool-action" });
        setStakeInput("");
      } else if (type === "unstake") {
        const amount = parseUnits(unstakeInput || "0", pool.stakedDecimals);
        if (amount === 0n) { toast.error("Enter an amount"); return; }
        toast.loading("Unstaking…", { id: "pool-action" });
        const hash = await walletClient.writeContract({ address: pool.contract, abi: stakingPoolAbi, functionName: "withdraw", args: [amount], account: address, chain: walletClient.chain });
        await publicClient!.waitForTransactionReceipt({ hash });
        toast.success("Unstaked!", { id: "pool-action" });
        setUnstakeInput("");
      } else {
        toast.loading("Harvesting…", { id: "pool-action" });
        const hash = await walletClient.writeContract({ address: pool.contract, abi: stakingPoolAbi, functionName: "harvest", args: [], account: address, chain: walletClient.chain });
        await publicClient!.waitForTransactionReceipt({ hash });
        toast.success("Harvested!", { id: "pool-action" });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      toast.error(msg.includes("User rejected") || msg.includes("denied") ? "Transaction rejected" : `Error: ${msg.slice(0, 60)}`, { id: "pool-action" });
    } finally { setLoading(false); }
  };

  const fmt = (n: bigint, dec = 18) => Number(formatUnits(n, dec)).toLocaleString(undefined, { maximumFractionDigits: 4 });
  const hasPending = pendingAmt > 0n;

  return (
    <div className="rounded-2xl flex flex-col" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(0,212,255,0.08)" }}>
      {/* card body */}
      <div className="p-4 flex-1">
        {/* header */}
        <div className="flex items-start justify-between mb-4 gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <div className="relative shrink-0">
              <img src={pool.stakedLogo} alt={pool.stakedSymbol} className="h-9 w-9 rounded-full ring-2 ring-pcs-bg object-contain" onError={e => { (e.target as HTMLImageElement).style.display = "none"; }} />
              <img src={pool.rewardLogo} alt={pool.rewardSymbol} className="h-4 w-4 rounded-full ring-2 ring-pcs-bg absolute -bottom-0.5 -right-0.5 object-contain" onError={e => { (e.target as HTMLImageElement).style.display = "none"; }} />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-bold text-pcs-text leading-tight truncate">Stake {pool.stakedSymbol}</p>
              <p className="text-[10px] text-pcs-textDim">Earn {pool.rewardSymbol}</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {fetching && <span className="text-[10px] text-pcs-textDim">…</span>}
            {pool.isAutoCompound && (
              <span className="rounded-lg px-2 py-0.5 text-[10px] font-bold text-pcs-primary whitespace-nowrap" style={{ background: "rgba(0,212,255,0.12)" }}>Auto</span>
            )}
          </div>
        </div>

        {/* APR + Total Staked */}
        <div className="grid grid-cols-2 gap-2 mb-4">
          <div className="rounded-xl p-2.5" style={{ background: "rgba(0,212,255,0.04)" }}>
            <p className="text-[10px] text-pcs-textDim mb-0.5 uppercase tracking-wide">APR</p>
            <p className="text-sm font-bold text-green-400">{pool.apr.toFixed(1)}%</p>
          </div>
          <div className="rounded-xl p-2.5" style={{ background: "rgba(0,212,255,0.04)" }}>
            <p className="text-[10px] text-pcs-textDim mb-0.5 uppercase tracking-wide">Total Staked</p>
            <p className="text-sm font-bold text-pcs-text truncate">{pool.totalStaked}</p>
          </div>
        </div>

        {/* staked / earned */}
        <div className="flex items-center justify-between text-xs mb-4">
          <div>
            <p className="text-pcs-textDim mb-0.5">Staked</p>
            <p className="font-semibold text-pcs-text">{fmt(stakedAmt, pool.stakedDecimals)} {pool.stakedSymbol}</p>
          </div>
          <div className="text-right">
            <p className="text-pcs-textDim mb-0.5">Earned</p>
            <p className={`font-semibold ${hasPending ? "text-yellow-400" : "text-pcs-text"}`}>{fmt(pendingAmt)} {pool.rewardSymbol}</p>
          </div>
        </div>
      </div>

      {/* action buttons */}
      <div className="px-4 pb-4 flex gap-2">
        <button type="button" className="btn-neon flex-1 py-2.5 text-sm font-semibold" onClick={() => setExpanded(e => !e)}>
          {expanded ? "Hide" : "Stake"}
        </button>
        {hasPending && (
          <button type="button" className="btn-secondary px-4 py-2.5 text-sm" disabled={loading || !isConnected || chainMismatch} onClick={() => action("harvest")}>
            {loading ? "…" : "Harvest"}
          </button>
        )}
      </div>

      {/* expanded stake/unstake */}
      {expanded && (
        <div className="border-t px-4 pb-4 pt-3" style={{ borderColor: "rgba(0,212,255,0.08)" }}>
          <div className="mb-3 flex rounded-xl overflow-hidden" style={{ background: "rgba(0,0,0,0.25)" }}>
            {(["stake", "unstake"] as const).map(t => (
              <button key={t} type="button" className={`flex-1 py-1.5 text-xs font-semibold capitalize transition ${tab === t ? "bg-pcs-secondary text-white" : "text-pcs-textSub"}`} onClick={() => setTab(t)}>{t}</button>
            ))}
          </div>
          {tab === "stake" ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-pcs-textDim">
                <span>{pool.stakedSymbol} Balance</span>
                <button type="button" className="text-pcs-primary" onClick={() => setStakeInput(formatUnits(balance, pool.stakedDecimals))}>MAX: {fmt(balance, pool.stakedDecimals)}</button>
              </div>
              <input className="input text-sm" placeholder="0.0" value={stakeInput} onChange={e => setStakeInput(e.target.value)} />
              <button type="button" className="btn-neon w-full py-2.5 text-sm" disabled={loading || !isConnected || chainMismatch || !stakeInput} onClick={() => action("stake")}>
                {!isConnected ? "Connect Wallet" : chainMismatch ? "Wrong Network" : loading ? "Processing…" : `Stake ${pool.stakedSymbol}`}
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-pcs-textDim">
                <span>Staked {pool.stakedSymbol}</span>
                <button type="button" className="text-pcs-primary" onClick={() => setUnstakeInput(formatUnits(stakedAmt, pool.stakedDecimals))}>MAX: {fmt(stakedAmt, pool.stakedDecimals)}</button>
              </div>
              <input className="input text-sm" placeholder="0.0" value={unstakeInput} onChange={e => setUnstakeInput(e.target.value)} />
              <button type="button" className="btn-secondary w-full py-2.5 text-sm" disabled={loading || !isConnected || chainMismatch || !unstakeInput || stakedAmt === 0n} onClick={() => action("unstake")}>
                {!isConnected ? "Connect Wallet" : chainMismatch ? "Wrong Network" : loading ? "Processing…" : `Unstake ${pool.stakedSymbol}`}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function PoolsPage({ network }: Props) {
  return (
    <div className="w-full max-w-6xl mx-auto px-4">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-pcs-text">Pools</h1>
        <p className="mt-1 text-xs text-pcs-textDim">Stake tokens to earn rewards</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {POOL_CONFIGS.map(pool => <PoolCard key={pool.id} pool={pool} network={network} />)}
      </div>
    </div>
  );
}
