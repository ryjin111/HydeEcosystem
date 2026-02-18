import { useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { formatUnits, parseUnits } from "viem";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import { erc20Abi, masterChefAbi } from "../utils/constants";
import { FARM_CONFIGS, type FarmConfig } from "../utils/farmConfig";
import type { NetworkConfig } from "../utils/constants";

type Props = { network: NetworkConfig };

/* ═══════════════════════════════════════════════════════════════════════════
   Single farm card
   ═══════════════════════════════════════════════════════════════════════════ */
function FarmCard({ farm, network }: { farm: FarmConfig; network: NetworkConfig }) {
  const { address, chainId, isConnected } = useAccount();
  const publicClient  = usePublicClient({ chainId: network.id });
  const { data: walletClient } = useWalletClient({ chainId: network.id });

  const chainMismatch = isConnected && chainId !== network.id;

  const [expanded,    setExpanded]    = useState(false);
  const [stakeInput,  setStakeInput]  = useState("");
  const [unstakeInput,setUnstakeInput]= useState("");
  const [tab,         setTab]         = useState<"stake" | "unstake">("stake");

  const [stakedAmt,   setStakedAmt]   = useState(0n);
  const [pendingAmt,  setPendingAmt]  = useState(0n);
  const [lpBalance,   setLpBalance]   = useState(0n);
  const [loading,     setLoading]     = useState(false);
  const [fetching,    setFetching]    = useState(false);

  /* ── fetch on-chain state ─────────────────────────────────────────────── */
  useEffect(() => {
    if (!address || !publicClient) return;
    const fetch = async () => {
      setFetching(true);
      try {
        const [userInfo, pending, bal] = await Promise.all([
          publicClient.readContract({ address: farm.masterChef, abi: masterChefAbi, functionName: "userInfo",      args: [BigInt(farm.pid), address] }),
          publicClient.readContract({ address: farm.masterChef, abi: masterChefAbi, functionName: "pendingReward", args: [BigInt(farm.pid), address] }),
          publicClient.readContract({ address: farm.lpToken,    abi: erc20Abi,      functionName: "balanceOf",     args: [address] }),
        ]);
        setStakedAmt(userInfo[0]);
        setPendingAmt(pending);
        setLpBalance(bal);
      } catch {
        // placeholder contracts — silently ignore
      } finally {
        setFetching(false);
      }
    };
    fetch();
  }, [address, publicClient, farm]);

  /* ── actions ─────────────────────────────────────────────────────────── */
  const action = async (type: "stake" | "unstake" | "harvest") => {
    if (!walletClient || !address) { toast.error("Connect wallet first"); return; }
    if (chainMismatch)              { toast.error("Switch network first"); return; }
    try {
      setLoading(true);
      if (type === "stake") {
        const amount = parseUnits(stakeInput || "0", 18);
        if (amount === 0n) { toast.error("Enter an amount"); return; }
        // approve LP token first
        toast.loading("Approving LP token…", { id: "farm-action" });
        await walletClient.writeContract({ address: farm.lpToken, abi: erc20Abi, functionName: "approve", args: [farm.masterChef, amount], account: address, chain: walletClient.chain });
        toast.loading("Staking…", { id: "farm-action" });
        const hash = await walletClient.writeContract({ address: farm.masterChef, abi: masterChefAbi, functionName: "deposit", args: [BigInt(farm.pid), amount], account: address, chain: walletClient.chain });
        await publicClient!.waitForTransactionReceipt({ hash });
        toast.success("Staked!", { id: "farm-action" });
        setStakeInput("");
      } else if (type === "unstake") {
        const amount = parseUnits(unstakeInput || "0", 18);
        if (amount === 0n) { toast.error("Enter an amount"); return; }
        toast.loading("Unstaking…", { id: "farm-action" });
        const hash = await walletClient.writeContract({ address: farm.masterChef, abi: masterChefAbi, functionName: "withdraw", args: [BigInt(farm.pid), amount], account: address, chain: walletClient.chain });
        await publicClient!.waitForTransactionReceipt({ hash });
        toast.success("Unstaked!", { id: "farm-action" });
        setUnstakeInput("");
      } else {
        // harvest = deposit 0
        toast.loading("Harvesting…", { id: "farm-action" });
        const hash = await walletClient.writeContract({ address: farm.masterChef, abi: masterChefAbi, functionName: "deposit", args: [BigInt(farm.pid), 0n], account: address, chain: walletClient.chain });
        await publicClient!.waitForTransactionReceipt({ hash });
        toast.success("Harvested!", { id: "farm-action" });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      toast.error(msg.includes("User rejected") || msg.includes("denied") ? "Transaction rejected" : `Error: ${msg.slice(0, 60)}`, { id: "farm-action" });
    } finally { setLoading(false); }
  };

  const fmtAmt  = (n: bigint) => Number(formatUnits(n, 18)).toLocaleString(undefined, { maximumFractionDigits: 4 });
  const box     = { background: "rgba(0, 212, 255, 0.03)", border: "1px solid rgba(0, 212, 255, 0.06)" };
  const hasPending = pendingAmt > 0n;

  return (
    <div className="rounded-2xl overflow-hidden" style={box}>
      {/* ── card header ─────────────────────────────────────────────── */}
      <div className="p-4">
        {/* pair + multiplier */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            {/* stacked token logos */}
            <div className="relative flex">
              <img src={farm.tokenALogo} alt={farm.tokenASymbol} className="h-8 w-8 rounded-full ring-2 ring-pcs-bg" onError={e => { (e.target as HTMLImageElement).style.display = "none"; }} />
              <img src={farm.tokenBLogo} alt={farm.tokenBSymbol} className="h-8 w-8 rounded-full ring-2 ring-pcs-bg -ml-2" onError={e => { (e.target as HTMLImageElement).style.display = "none"; }} />
            </div>
            <div>
              <p className="text-sm font-bold text-pcs-text">{farm.tokenASymbol}/{farm.tokenBSymbol}</p>
              <p className="text-[10px] text-pcs-textDim">{farm.feeTier} fee</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="rounded-lg px-2 py-0.5 text-[10px] font-semibold text-pcs-primary" style={{ background: "rgba(0, 212, 255, 0.1)" }}>
              {farm.multiplier}
            </span>
            {fetching && <span className="text-[10px] text-pcs-textDim">Loading…</span>}
          </div>
        </div>

        {/* stats row */}
        <div className="grid grid-cols-2 gap-3 mb-3">
          <div className="rounded-xl p-2.5" style={{ background: "rgba(0, 212, 255, 0.04)" }}>
            <p className="text-[10px] text-pcs-textDim mb-0.5">APR</p>
            <p className="text-sm font-bold text-green-400">{farm.apr.toFixed(1)}%</p>
          </div>
          <div className="rounded-xl p-2.5" style={{ background: "rgba(0, 212, 255, 0.04)" }}>
            <p className="text-[10px] text-pcs-textDim mb-0.5">TVL</p>
            <p className="text-sm font-bold text-pcs-text">{farm.tvl}</p>
          </div>
        </div>

        {/* user stats */}
        <div className="flex items-center justify-between text-xs">
          <div>
            <span className="text-pcs-textDim">Staked: </span>
            <span className="text-pcs-text font-medium">{fmtAmt(stakedAmt)} LP</span>
          </div>
          <div>
            <span className="text-pcs-textDim">Earned: </span>
            <span className={`font-medium ${hasPending ? "text-yellow-400" : "text-pcs-text"}`}>{fmtAmt(pendingAmt)} {farm.rewardSymbol}</span>
          </div>
        </div>
      </div>

      {/* ── action bar ──────────────────────────────────────────────── */}
      <div className="flex gap-2 px-4 pb-4">
        <button
          type="button"
          className="btn-neon flex-1 py-2 text-sm"
          onClick={() => setExpanded(e => !e)}
        >
          {expanded ? "Hide" : "Stake"}
        </button>
        {hasPending && (
          <button
            type="button"
            className="btn-secondary px-4 py-2 text-sm"
            disabled={loading || !isConnected || chainMismatch}
            onClick={() => action("harvest")}
          >
            {loading ? "…" : "Harvest"}
          </button>
        )}
      </div>

      {/* ── expanded stake/unstake form ──────────────────────────────── */}
      {expanded && (
        <div className="border-t px-4 pb-4 pt-3" style={{ borderColor: "rgba(0, 212, 255, 0.06)" }}>
          {/* tabs */}
          <div className="mb-3 flex rounded-xl overflow-hidden" style={{ background: "rgba(0,0,0,0.2)" }}>
            {(["stake", "unstake"] as const).map(t => (
              <button key={t} type="button" className={`flex-1 py-1.5 text-xs font-semibold capitalize transition ${tab === t ? "bg-pcs-secondary text-white" : "text-pcs-textSub"}`} onClick={() => setTab(t)}>{t}</button>
            ))}
          </div>

          {tab === "stake" ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-pcs-textDim">
                <span>{farm.tokenASymbol}/{farm.tokenBSymbol} LP Balance</span>
                <button type="button" className="text-pcs-primary" onClick={() => setStakeInput(formatUnits(lpBalance, 18))}>MAX: {fmtAmt(lpBalance)}</button>
              </div>
              <input className="input text-sm" placeholder="0.0" value={stakeInput} onChange={e => setStakeInput(e.target.value)} />
              <button type="button" className="btn-neon w-full py-2.5 text-sm" disabled={loading || !isConnected || chainMismatch || !stakeInput} onClick={() => action("stake")}>
                {!isConnected ? "Connect Wallet" : chainMismatch ? "Wrong Network" : loading ? "Processing…" : "Stake LP"}
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-pcs-textDim">
                <span>Staked LP</span>
                <button type="button" className="text-pcs-primary" onClick={() => setUnstakeInput(formatUnits(stakedAmt, 18))}>MAX: {fmtAmt(stakedAmt)}</button>
              </div>
              <input className="input text-sm" placeholder="0.0" value={unstakeInput} onChange={e => setUnstakeInput(e.target.value)} />
              <button type="button" className="btn-secondary w-full py-2.5 text-sm" disabled={loading || !isConnected || chainMismatch || !unstakeInput || stakedAmt === 0n} onClick={() => action("unstake")}>
                {!isConnected ? "Connect Wallet" : chainMismatch ? "Wrong Network" : loading ? "Processing…" : "Unstake LP"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   Farms page
   ═══════════════════════════════════════════════════════════════════════════ */
export function FarmsPage({ network }: Props) {
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<"apr" | "tvl" | "multiplier">("apr");

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return [...FARM_CONFIGS]
      .filter(f => !q || f.tokenASymbol.toLowerCase().includes(q) || f.tokenBSymbol.toLowerCase().includes(q))
      .sort((a, b) => {
        if (sortBy === "apr")        return b.apr - a.apr;
        if (sortBy === "multiplier") return parseInt(b.multiplier) - parseInt(a.multiplier);
        // tvl — crude string comparison fallback
        return b.tvl.localeCompare(a.tvl);
      });
  }, [search, sortBy]);

  const box = { background: "rgba(0, 212, 255, 0.03)", border: "1px solid rgba(0, 212, 255, 0.06)" };

  return (
    <div className="w-full max-w-[480px] mx-auto">
      {/* header */}
      <div className="mb-5">
        <h1 className="text-xl font-bold text-pcs-text">Farms</h1>
        <p className="mt-0.5 text-xs text-pcs-textDim">Stake LP tokens to earn HYDE rewards</p>
      </div>

      {/* search + sort */}
      <div className="mb-4 flex gap-2">
        <input
          className="input flex-1 text-sm"
          placeholder="Search farms…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <div className="flex rounded-xl overflow-hidden" style={box}>
          {(["apr", "tvl", "multiplier"] as const).map(s => (
            <button key={s} type="button" className={`px-3 py-2 text-xs font-semibold capitalize transition ${sortBy === s ? "bg-pcs-secondary text-white" : "text-pcs-textSub hover:text-pcs-text"}`} onClick={() => setSortBy(s)}>{s}</button>
          ))}
        </div>
      </div>

      {/* farm list */}
      <div className="space-y-3">
        {filtered.map(farm => (
          <FarmCard key={farm.pid} farm={farm} network={network} />
        ))}
        {filtered.length === 0 && (
          <p className="py-8 text-center text-sm text-pcs-textDim">No farms found</p>
        )}
      </div>
    </div>
  );
}
