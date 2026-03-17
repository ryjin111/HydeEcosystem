import { useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { formatUnits, maxUint256, parseUnits, zeroAddress } from "viem";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import type { NetworkConfig, TokenInfo } from "../utils/constants";
import { erc20Abi, factoryAbi, routerAbi } from "../utils/constants";
import { calcMinAmount, formatAmount } from "../utils/format";
import { TokenSelector } from "./TokenSelector";

type Props = {
  network: NetworkConfig;
  tokens: TokenInfo[];
  onAddCustomToken: (token: {
    address: `0x${string}`;
    symbol: string;
    name: string;
    decimals: number;
  }) => void;
};

const PCT_PRESETS = [25, 50, 75, 100];

export function LiquidityRemoveCard({ network, tokens, onAddCustomToken }: Props) {
  const { address, isConnected, chainId } = useAccount();
  const publicClient = usePublicClient({ chainId: network.id });
  const { data: walletClient } = useWalletClient({ chainId: network.id });

  const [tokenA, setTokenA] = useState<TokenInfo | undefined>(tokens[0]);
  const [tokenB, setTokenB] = useState<TokenInfo | undefined>(tokens[1]);
  const [pairAddress, setPairAddress] = useState<`0x${string}` | null>(null);
  const [lpBalance, setLpBalance] = useState<bigint>(0n);
  const [percent, setPercent] = useState(100);
  const [slippage, setSlippage] = useState("0.5");
  const [showSettings, setShowSettings] = useState(false);
  const [loading, setLoading] = useState(false);
  const [reserveA, setReserveA] = useState<bigint>(0n);
  const [reserveB, setReserveB] = useState<bigint>(0n);
  const [totalSupply, setTotalSupply] = useState<bigint>(0n);

  const chainMismatch = isConnected && chainId !== network.id;
  const slippageBps = Math.floor(Number(slippage || "0") * 100);
  const resolveAddr = (t: TokenInfo) => t.isNative ? network.weth : t.address;

  useEffect(() => { setTokenA(tokens[0]); setTokenB(tokens[1]); }, [tokens]);

  useEffect(() => {
    const load = async () => {
      if (!publicClient || !tokenA || !tokenB || !address) return;
      try {
        const pair = await publicClient.readContract({
          address: network.factory, abi: factoryAbi, functionName: "getPair",
          args: [resolveAddr(tokenA), resolveAddr(tokenB)],
        }) as `0x${string}`;

        if (pair === zeroAddress) {
          setPairAddress(null); setLpBalance(0n);
          setReserveA(0n); setReserveB(0n); setTotalSupply(0n);
          return;
        }
        setPairAddress(pair);

        const [bal, resA, resB, supply] = await Promise.all([
          publicClient.readContract({ address: pair, abi: erc20Abi, functionName: "balanceOf", args: [address] }) as Promise<bigint>,
          publicClient.readContract({ address: resolveAddr(tokenA), abi: erc20Abi, functionName: "balanceOf", args: [pair] }) as Promise<bigint>,
          publicClient.readContract({ address: resolveAddr(tokenB), abi: erc20Abi, functionName: "balanceOf", args: [pair] }) as Promise<bigint>,
          publicClient.readContract({ address: pair, abi: erc20Abi, functionName: "totalSupply" }) as Promise<bigint>,
        ]);
        setLpBalance(bal); setReserveA(resA); setReserveB(resB); setTotalSupply(supply);
      } catch {
        setPairAddress(null); setLpBalance(0n);
      }
    };
    void load();
  }, [publicClient, address, tokenA, tokenB]);

  const lpToRemove = useMemo(() => (lpBalance * BigInt(percent)) / 100n, [lpBalance, percent]);

  const estimatedA = useMemo(() =>
    totalSupply > 0n ? (reserveA * lpToRemove) / totalSupply : 0n,
    [reserveA, lpToRemove, totalSupply]);

  const estimatedB = useMemo(() =>
    totalSupply > 0n ? (reserveB * lpToRemove) / totalSupply : 0n,
    [reserveB, lpToRemove, totalSupply]);

  const remove = async () => {
    if (!walletClient || !publicClient || !address || !tokenA || !tokenB || !pairAddress) return;
    if (lpToRemove === 0n) { toast.error("No LP balance to remove"); return; }
    try {
      setLoading(true);
      // Approve LP token
      const currentAllowance = await publicClient.readContract({
        address: pairAddress, abi: erc20Abi, functionName: "allowance", args: [address, network.router],
      }) as bigint;
      if (currentAllowance < lpToRemove) {
        toast.loading("Approving LP token...", { id: "approve-lp" });
        const h = await walletClient.writeContract({
          address: pairAddress, abi: erc20Abi, functionName: "approve",
          args: [network.router, maxUint256], account: address, chain: walletClient.chain,
        });
        await publicClient.waitForTransactionReceipt({ hash: h, timeout: 60_000 });
        toast.success("LP approved", { id: "approve-lp" });
      }

      const minA = calcMinAmount(estimatedA, slippageBps);
      const minB = calcMinAmount(estimatedB, slippageBps);
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60);

      toast.loading("Removing liquidity...", { id: "remove-liq" });
      let hash: `0x${string}`;
      if (tokenA.isNative || tokenB.isNative) {
        const isANative = tokenA.isNative;
        const erc20 = isANative ? tokenB : tokenA;
        const minToken = isANative ? minB : minA;
        const minETH = isANative ? minA : minB;
        hash = await walletClient.writeContract({
          address: network.router, abi: routerAbi, functionName: "removeLiquidityETH",
          args: [erc20.address, lpToRemove, minToken, minETH, address, deadline],
          account: address, chain: walletClient.chain,
        });
      } else {
        hash = await walletClient.writeContract({
          address: network.router, abi: routerAbi, functionName: "removeLiquidity",
          args: [tokenA.address, tokenB.address, lpToRemove, minA, minB, address, deadline],
          account: address, chain: walletClient.chain,
        });
      }
      await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
      toast.success("Liquidity removed!", { id: "remove-liq" });
      // Refresh
      setLpBalance(prev => prev - lpToRemove);
      setPercent(100);
    } catch {
      toast.error("Transaction failed or rejected", { id: "remove-liq" });
    } finally {
      setLoading(false);
    }
  };

  const hasPool = pairAddress !== null && lpBalance > 0n;

  return (
    <div className="card">
      {/* Header */}
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-bold text-pcs-text">Remove Liquidity</h2>
        <button onClick={() => setShowSettings(s => !s)} className={`rounded-lg p-1.5 transition ${showSettings ? "text-pcs-primary" : "text-pcs-textDim hover:text-pcs-primary"}`}>
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 6h9.75M10.5 6a1.5 1.5 0 11-3 0m3 0a1.5 1.5 0 10-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-9.75 0h9.75" />
          </svg>
        </button>
      </div>

      {/* Settings */}
      {showSettings && (
        <div className="mb-4 rounded-2xl p-3" style={{ background: "rgba(0,212,255,0.03)", border: "1px solid rgba(0,212,255,0.08)" }}>
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-pcs-textSub">Slippage</span>
            <div className="flex items-center gap-1">
              {["0.1", "0.5", "1.0"].map(v => (
                <button key={v} onClick={() => setSlippage(v)}
                  className={`rounded-lg px-2.5 py-1 text-xs font-medium transition ${slippage === v ? "bg-pcs-primary text-pcs-bg" : "text-pcs-textDim hover:text-pcs-text"}`}
                  style={slippage !== v ? { border: "1px solid rgba(0,212,255,0.1)" } : undefined}>{v}%</button>
              ))}
              <div className="flex items-center gap-1">
                <input className="w-12 rounded-lg bg-pcs-input px-2 py-1 text-right text-xs text-pcs-text outline-none"
                  style={{ border: "1px solid rgba(0,212,255,0.1)" }}
                  value={slippage} onChange={e => setSlippage(e.target.value)} />
                <span className="text-xs text-pcs-textDim">%</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Token pair selectors */}
      <div className="grid grid-cols-2 gap-3">
        <TokenSelector label="Token A" selected={tokenA} tokens={tokens}
          onSelect={t => { setTokenA(t); setPercent(100); }} onAddCustom={onAddCustomToken} />
        <TokenSelector label="Token B" selected={tokenB} tokens={tokens}
          onSelect={t => { setTokenB(t); setPercent(100); }} onAddCustom={onAddCustomToken} />
      </div>

      {/* LP Balance */}
      <div className="mt-4 rounded-2xl p-4" style={{ background: "rgba(0,212,255,0.03)", border: "1px solid rgba(0,212,255,0.06)" }}>
        <div className="flex items-center justify-between">
          <span className="text-sm text-pcs-textDim">Your LP Balance</span>
          <span className="text-sm font-semibold text-pcs-text">{formatAmount(lpBalance, 18, 6)}</span>
        </div>
        {!hasPool && pairAddress === null && tokenA && tokenB && tokenA.address !== tokenB.address && (
          <p className="mt-1 text-xs text-pcs-textDim">No liquidity position found for this pair.</p>
        )}
      </div>

      {/* Percentage slider */}
      {hasPool && (
        <div className="mt-4 rounded-2xl p-4" style={{ background: "rgba(0,212,255,0.03)", border: "1px solid rgba(0,212,255,0.06)" }}>
          <div className="mb-3 flex items-center justify-between">
            <span className="text-xs text-pcs-textDim">Amount to remove</span>
            <span className="text-2xl font-bold text-pcs-text">{percent}%</span>
          </div>

          {/* Slider */}
          <input
            type="range" min={1} max={100} value={percent}
            onChange={e => setPercent(Number(e.target.value))}
            className="w-full accent-pcs-primary"
          />

          {/* Preset buttons */}
          <div className="mt-3 grid grid-cols-4 gap-2">
            {PCT_PRESETS.map(p => (
              <button key={p} onClick={() => setPercent(p)}
                className={`rounded-xl py-1.5 text-xs font-semibold transition ${percent === p ? "bg-pcs-primary text-pcs-bg" : "text-pcs-textSub hover:text-pcs-text"}`}
                style={percent !== p ? { background: "rgba(0,212,255,0.06)", border: "1px solid rgba(0,212,255,0.1)" } : undefined}>
                {p === 100 ? "MAX" : `${p}%`}
              </button>
            ))}
          </div>

          {/* You will receive */}
          <div className="mt-4 space-y-2">
            <p className="text-xs font-semibold text-pcs-textDim">You will receive</p>
            <div className="flex items-center justify-between rounded-xl px-3 py-2" style={{ background: "rgba(0,212,255,0.04)" }}>
              <div className="flex items-center gap-2">
                {tokenA?.logoURI && <img src={tokenA.logoURI} alt={tokenA.symbol} className="h-5 w-5 rounded-full" />}
                <span className="text-sm font-medium text-pcs-text">{tokenA?.symbol}</span>
              </div>
              <span className="text-sm font-semibold text-pcs-text">
                {formatAmount(estimatedA, tokenA?.decimals ?? 18)}
              </span>
            </div>
            <div className="flex items-center justify-between rounded-xl px-3 py-2" style={{ background: "rgba(0,212,255,0.04)" }}>
              <div className="flex items-center gap-2">
                {tokenB?.logoURI && <img src={tokenB.logoURI} alt={tokenB.symbol} className="h-5 w-5 rounded-full" />}
                <span className="text-sm font-medium text-pcs-text">{tokenB?.symbol}</span>
              </div>
              <span className="text-sm font-semibold text-pcs-text">
                {formatAmount(estimatedB, tokenB?.decimals ?? 18)}
              </span>
            </div>
          </div>
        </div>
      )}

      <button
        className="btn-primary mt-4 w-full py-3 text-base"
        onClick={remove}
        disabled={loading || chainMismatch || !isConnected || !hasPool || lpToRemove === 0n || !tokenA || !tokenB || tokenA.address === tokenB.address}
      >
        {loading ? "Processing..."
          : !isConnected ? "Connect Wallet"
          : chainMismatch ? "Switch Network"
          : !hasPool ? "No Position Found"
          : "Remove Liquidity"}
      </button>
    </div>
  );
}
