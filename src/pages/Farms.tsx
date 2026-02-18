import { useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { formatUnits, parseUnits } from "viem";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import { erc20Abi, masterChefAbi } from "../utils/constants";
import { FARM_CONFIGS, type FarmConfig } from "../utils/farmConfig";
import type { NetworkConfig } from "../utils/constants";

type Props = { network: NetworkConfig };

/* ═══════════════════════════════════════════════════════════════════════════
   Single farm row (PancakeSwap v1 table style)
   ═══════════════════════════════════════════════════════════════════════════ */
function FarmRow({ farm, network }: { farm: FarmConfig; network: NetworkConfig }) {
  const { address, chainId, isConnected } = useAccount();
  const publicClient  = usePublicClient({ chainId: network.id });
  const { data: walletClient } = useWalletClient({ chainId: network.id });

  const chainMismatch = isConnected && chainId !== network.id;

  const [expanded,     setExpanded]     = useState(false);
  const [stakeInput,   setStakeInput]   = useState("");
  const [unstakeInput, setUnstakeInput] = useState("");
  const [tab,          setTab]          = useState<"stake" | "unstake">("stake");

  const [stakedAmt,  setStakedAmt]  = useState(0n);
  const [pendingAmt, setPendingAmt] = useState(0n);
  const [lpBalance,  setLpBalance]  = useState(0n);
  const [loading,    setLoading]    = useState(false);
  const [fetching,   setFetching]   = useState(false);

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

  const fmtAmt   = (n: bigint) => Number(formatUnits(n, 18)).toLocaleString(undefined, { maximumFractionDigits: 4 });
  const hasPending = pendingAmt > 0n;
  const rowBg    = { borderBottom: "1px solid rgba(0, 212, 255, 0.07)" };
  const panelBg  = { background: "rgba(0, 212, 255, 0.025)", borderBottom: "1px solid rgba(0, 212, 255, 0.07)" };

  return (
    <>
      {/* ── main row ──────────────────────────────────────────────────── */}
      <tr
        className="hover:bg-white/[0.02] transition cursor-pointer select-none"
        style={rowBg}
        onClick={() => setExpanded(e => !e)}
      >
        {/* Pair */}
        <td className="py-3.5 pl-5 pr-3">
          <div className="flex items-center gap-2.5">
            <div className="relative flex shrink-0">
              <img src={farm.tokenALogo} alt={farm.tokenASymbol} className="h-8 w-8 rounded-full ring-2 ring-pcs-bg" onError={e => { (e.target as HTMLImageElement).style.display = "none"; }} />
              <img src={farm.tokenBLogo} alt={farm.tokenBSymbol} className="h-8 w-8 rounded-full ring-2 ring-pcs-bg -ml-2.5" onError={e => { (e.target as HTMLImageElement).style.display = "none"; }} />
            </div>
            <div>
              <p className="text-sm font-bold text-pcs-text leading-tight">{farm.tokenASymbol}/{farm.tokenBSymbol}</p>
              <p className="text-[10px] text-pcs-textDim">{farm.feeTier} fee</p>
            </div>
            <span className="ml-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold text-pcs-primary" style={{ background: "rgba(0, 212, 255, 0.1)" }}>
              {farm.multiplier}
            </span>
          </div>
        </td>

        {/* APR */}
        <td className="py-3.5 px-3">
          <p className="text-sm font-bold text-green-400">{farm.apr.toFixed(1)}%</p>
          <p className="text-[10px] text-pcs-textDim">APR</p>
        </td>

        {/* TVL */}
        <td className="py-3.5 px-3">
          <p className="text-sm font-semibold text-pcs-text">{farm.tvl}</p>
          <p className="text-[10px] text-pcs-textDim">TVL</p>
        </td>

        {/* Earned */}
        <td className="py-3.5 px-3">
          <p className={`text-sm font-semibold ${hasPending ? "text-yellow-400" : "text-pcs-textDim"}`}>
            {fetching ? "…" : fmtAmt(pendingAmt)}
          </p>
          <p className="text-[10px] text-pcs-textDim">{farm.rewardSymbol} Earned</p>
        </td>

        {/* Staked */}
        <td className="py-3.5 px-3">
          <p className="text-sm font-semibold text-pcs-text">{fetching ? "…" : fmtAmt(stakedAmt)}</p>
          <p className="text-[10px] text-pcs-textDim">LP Staked</p>
        </td>

        {/* Actions */}
        <td className="py-3.5 pl-3 pr-5">
          <div className="flex items-center justify-end gap-2" onClick={e => e.stopPropagation()}>
            {hasPending && (
              <button
                type="button"
                className="btn-secondary px-3 py-1.5 text-xs whitespace-nowrap"
                disabled={loading || !isConnected || chainMismatch}
                onClick={() => action("harvest")}
              >
                {loading ? "…" : "Harvest"}
              </button>
            )}
            <button
              type="button"
              className="btn-neon px-4 py-1.5 text-xs whitespace-nowrap"
              onClick={() => setExpanded(e => !e)}
            >
              {expanded ? "Hide" : "Details"}
              <span className={`ml-1.5 inline-block transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}>▾</span>
            </button>
          </div>
        </td>
      </tr>

      {/* ── expanded panel ────────────────────────────────────────────── */}
      {expanded && (
        <tr>
          <td colSpan={6} style={panelBg}>
            <div className="px-5 py-4 flex gap-6">
              {/* left: stats */}
              <div className="flex flex-col gap-3 min-w-[160px]">
                <div>
                  <p className="text-[10px] text-pcs-textDim mb-0.5">LP Token Balance</p>
                  <p className="text-sm font-semibold text-pcs-text">{fmtAmt(lpBalance)} LP</p>
                </div>
                <div>
                  <p className="text-[10px] text-pcs-textDim mb-0.5">Currently Staked</p>
                  <p className="text-sm font-semibold text-pcs-text">{fmtAmt(stakedAmt)} LP</p>
                </div>
                <div>
                  <p className="text-[10px] text-pcs-textDim mb-0.5">Pending Rewards</p>
                  <p className={`text-sm font-semibold ${hasPending ? "text-yellow-400" : "text-pcs-textDim"}`}>{fmtAmt(pendingAmt)} {farm.rewardSymbol}</p>
                </div>
              </div>

              {/* divider */}
              <div className="w-px" style={{ background: "rgba(0,212,255,0.08)" }} />

              {/* right: stake/unstake form */}
              <div className="flex-1 max-w-xs">
                {/* tabs */}
                <div className="mb-3 flex rounded-xl overflow-hidden" style={{ background: "rgba(0,0,0,0.2)" }}>
                  {(["stake", "unstake"] as const).map(t => (
                    <button key={t} type="button" className={`flex-1 py-1.5 text-xs font-semibold capitalize transition ${tab === t ? "bg-pcs-secondary text-white" : "text-pcs-textSub"}`} onClick={() => setTab(t)}>{t}</button>
                  ))}
                </div>

                {tab === "stake" ? (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-xs text-pcs-textDim">
                      <span>{farm.tokenASymbol}/{farm.tokenBSymbol} LP</span>
                      <button type="button" className="text-pcs-primary" onClick={() => setStakeInput(formatUnits(lpBalance, 18))}>MAX: {fmtAmt(lpBalance)}</button>
                    </div>
                    <input className="input text-sm" placeholder="0.0" value={stakeInput} onChange={e => setStakeInput(e.target.value)} />
                    <button type="button" className="btn-neon w-full py-2 text-sm" disabled={loading || !isConnected || chainMismatch || !stakeInput} onClick={() => action("stake")}>
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
                    <button type="button" className="btn-secondary w-full py-2 text-sm" disabled={loading || !isConnected || chainMismatch || !unstakeInput || stakedAmt === 0n} onClick={() => action("unstake")}>
                      {!isConnected ? "Connect Wallet" : chainMismatch ? "Wrong Network" : loading ? "Processing…" : "Unstake LP"}
                    </button>
                  </div>
                )}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
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
        return b.tvl.localeCompare(a.tvl);
      });
  }, [search, sortBy]);

  const tableBg  = { background: "rgba(0, 212, 255, 0.02)", border: "1px solid rgba(0, 212, 255, 0.07)" };
  const thStyle  = "py-2.5 px-3 text-[11px] font-semibold text-pcs-textDim uppercase tracking-wide text-left";

  return (
    <div className="w-full max-w-5xl mx-auto px-4">
      {/* header */}
      <div className="mb-5 flex items-end justify-between">
        <div>
          <h1 className="text-xl font-bold text-pcs-text">Farms</h1>
          <p className="mt-0.5 text-xs text-pcs-textDim">Stake LP tokens to earn HYDE rewards</p>
        </div>
      </div>

      {/* search + sort */}
      <div className="mb-4 flex gap-2">
        <input
          className="input flex-1 text-sm"
          placeholder="Search farms…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <div className="flex rounded-xl overflow-hidden" style={{ background: "rgba(0, 212, 255, 0.03)", border: "1px solid rgba(0, 212, 255, 0.06)" }}>
          {(["apr", "tvl", "multiplier"] as const).map(s => (
            <button key={s} type="button" className={`px-3 py-2 text-xs font-semibold capitalize transition ${sortBy === s ? "bg-pcs-secondary text-white" : "text-pcs-textSub hover:text-pcs-text"}`} onClick={() => setSortBy(s)}>{s}</button>
          ))}
        </div>
      </div>

      {/* table */}
      <div className="rounded-2xl overflow-hidden" style={tableBg}>
        <table className="w-full border-collapse">
          <thead>
            <tr style={{ borderBottom: "1px solid rgba(0, 212, 255, 0.07)" }}>
              <th className={`${thStyle} pl-5`}>Farm</th>
              <th className={thStyle}>APR</th>
              <th className={thStyle}>TVL</th>
              <th className={thStyle}>Earned</th>
              <th className={thStyle}>Staked</th>
              <th className={`${thStyle} pr-5 text-right`}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(farm => (
              <FarmRow key={farm.pid} farm={farm} network={network} />
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={6} className="py-10 text-center text-sm text-pcs-textDim">No farms found</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
