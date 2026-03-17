import { useEffect, useState } from "react";
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

export function LiquidityAddCard({ network, tokens, onAddCustomToken }: Props) {
  const { address, isConnected, chainId } = useAccount();
  const publicClient = usePublicClient({ chainId: network.id });
  const { data: walletClient } = useWalletClient({ chainId: network.id });

  const [tokenA, setTokenA] = useState<TokenInfo | undefined>(tokens[0]);
  const [tokenB, setTokenB] = useState<TokenInfo | undefined>(tokens[1]);
  const [amountA, setAmountA] = useState("");
  const [amountB, setAmountB] = useState("");
  const [lastEdited, setLastEdited] = useState<"A" | "B">("A");
  const [slippage, setSlippage] = useState("0.5");
  const [showSettings, setShowSettings] = useState(false);
  const [loading, setLoading] = useState(false);
  const [balances, setBalances] = useState<Record<string, bigint>>({});
  // Pool ratio: reserveB per reserveA
  const [ratio, setRatio] = useState<{ reserveA: bigint; reserveB: bigint } | null>(null);
  const [newPool, setNewPool] = useState(false);

  const chainMismatch = isConnected && chainId !== network.id;
  const slippageBps = Math.floor(Number(slippage || "0") * 100);
  const resolveAddr = (t: TokenInfo) => t.isNative ? network.weth : t.address;

  useEffect(() => { setTokenA(tokens[0]); setTokenB(tokens[1]); }, [tokens]);

  // Fetch balances + pool ratio whenever pair changes
  useEffect(() => {
    const load = async () => {
      if (!publicClient || !address || !tokenA || !tokenB) return;
      try {
        const fetchBal = (t: TokenInfo) =>
          t.isNative
            ? publicClient.getBalance({ address })
            : publicClient.readContract({ address: t.address, abi: erc20Abi, functionName: "balanceOf", args: [address] }) as Promise<bigint>;

        const [balA, balB] = await Promise.all([fetchBal(tokenA), fetchBal(tokenB)]);
        setBalances({ [tokenA.address]: balA as bigint, [tokenB.address]: balB as bigint });

        // Load pool ratio
        const pair = await publicClient.readContract({
          address: network.factory, abi: factoryAbi, functionName: "getPair",
          args: [resolveAddr(tokenA), resolveAddr(tokenB)],
        }) as `0x${string}`;

        if (pair === zeroAddress) {
          setRatio(null);
          setNewPool(true);
          return;
        }
        setNewPool(false);
        const [resA, resB] = await Promise.all([
          publicClient.readContract({ address: resolveAddr(tokenA), abi: erc20Abi, functionName: "balanceOf", args: [pair] }) as Promise<bigint>,
          publicClient.readContract({ address: resolveAddr(tokenB), abi: erc20Abi, functionName: "balanceOf", args: [pair] }) as Promise<bigint>,
        ]);
        setRatio({ reserveA: resA, reserveB: resB });
      } catch { /* ignore */ }
    };
    void load();
  }, [publicClient, address, tokenA, tokenB]);

  // Auto-calculate the other amount from pool ratio
  useEffect(() => {
    if (!ratio || ratio.reserveA === 0n || ratio.reserveB === 0n || !tokenA || !tokenB) return;
    if (lastEdited === "A" && amountA) {
      try {
        const parsed = parseUnits(amountA, tokenA.decimals);
        const derived = (parsed * ratio.reserveB) / ratio.reserveA;
        setAmountB(formatUnits(derived, tokenB.decimals));
      } catch { setAmountB(""); }
    } else if (lastEdited === "B" && amountB) {
      try {
        const parsed = parseUnits(amountB, tokenB.decimals);
        const derived = (parsed * ratio.reserveA) / ratio.reserveB;
        setAmountA(formatUnits(derived, tokenA.decimals));
      } catch { setAmountA(""); }
    }
  }, [amountA, amountB, lastEdited, ratio, tokenA, tokenB]);

  const approveToken = async (token: TokenInfo, amount: bigint) => {
    if (!walletClient || !publicClient || !address || token.isNative) return true;
    const current = await publicClient.readContract({
      address: token.address, abi: erc20Abi, functionName: "allowance", args: [address, network.router],
    }) as bigint;
    if (current >= amount) return true;
    toast.loading(`Approving ${token.symbol}...`, { id: `approve-${token.address}` });
    const hash = await walletClient.writeContract({
      address: token.address, abi: erc20Abi, functionName: "approve",
      args: [network.router, maxUint256], account: address, chain: walletClient.chain,
    });
    await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
    toast.success(`${token.symbol} approved`, { id: `approve-${token.address}` });
    return true;
  };

  const supply = async () => {
    if (!walletClient || !publicClient || !address || !tokenA || !tokenB) return;
    if (!amountA || !amountB || Number(amountA) <= 0 || Number(amountB) <= 0) {
      toast.error("Enter an amount"); return;
    }
    try {
      setLoading(true);
      const parsedA = parseUnits(amountA, tokenA.decimals);
      const parsedB = parseUnits(amountB, tokenB.decimals);
      await approveToken(tokenA, parsedA);
      await approveToken(tokenB, parsedB);
      const minA = calcMinAmount(parsedA, slippageBps);
      const minB = calcMinAmount(parsedB, slippageBps);
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60);
      toast.loading("Adding liquidity...", { id: "add-liq" });
      let hash: `0x${string}`;
      if (tokenA.isNative || tokenB.isNative) {
        const isANative = tokenA.isNative;
        const erc20 = isANative ? tokenB : tokenA;
        hash = await walletClient.writeContract({
          address: network.router, abi: routerAbi, functionName: "addLiquidityETH",
          args: [erc20.address, isANative ? parsedB : parsedA, isANative ? minB : minA, isANative ? minA : minB, address, deadline],
          value: isANative ? parsedA : parsedB, account: address, chain: walletClient.chain,
        });
      } else {
        hash = await walletClient.writeContract({
          address: network.router, abi: routerAbi, functionName: "addLiquidity",
          args: [tokenA.address, tokenB.address, parsedA, parsedB, minA, minB, address, deadline],
          account: address, chain: walletClient.chain,
        });
      }
      await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
      toast.success("Liquidity added!", { id: "add-liq" });
      setAmountA(""); setAmountB("");
    } catch {
      toast.error("Transaction failed or rejected", { id: "add-liq" });
    } finally {
      setLoading(false);
    }
  };

  const setMax = (which: "A" | "B") => {
    const token = which === "A" ? tokenA : tokenB;
    if (!token) return;
    const bal = balances[token.address];
    if (!bal) return;
    const val = formatUnits(bal, token.decimals);
    if (which === "A") { setAmountA(val); setLastEdited("A"); }
    else { setAmountB(val); setLastEdited("B"); }
  };

  const buttonLabel = () => {
    if (!isConnected) return "Connect Wallet";
    if (chainMismatch) return "Switch Network";
    if (!tokenA || !tokenB || tokenA.address === tokenB.address) return "Select Tokens";
    if (!amountA || !amountB || Number(amountA) <= 0) return "Enter Amount";
    return loading ? "Processing..." : "Add Liquidity";
  };

  return (
    <div className="card">
      {/* Header */}
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-bold text-pcs-text">Add Liquidity</h2>
        <button onClick={() => setShowSettings(s => !s)} className={`rounded-lg p-1.5 transition ${showSettings ? "text-pcs-primary" : "text-pcs-textDim hover:text-pcs-primary"}`}>
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 6h9.75M10.5 6a1.5 1.5 0 11-3 0m3 0a1.5 1.5 0 10-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-9.75 0h9.75" />
          </svg>
        </button>
      </div>

      {/* Settings panel */}
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

      {newPool && (
        <div className="mb-3 rounded-xl px-3 py-2 text-xs font-medium" style={{ background: "rgba(255,152,0,0.08)", border: "1px solid rgba(255,152,0,0.3)", color: "#ffab40" }}>
          No pool found — you are creating a new pool. You can set any initial ratio.
        </div>
      )}

      {/* Token A */}
      <div className="rounded-2xl p-4" style={{ background: "rgba(0,212,255,0.03)", border: "1px solid rgba(0,212,255,0.06)" }}>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs text-pcs-textDim">Token A</span>
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-pcs-textDim">
              Balance: {formatAmount(balances[tokenA?.address ?? zeroAddress], tokenA?.decimals ?? 18)}
            </span>
            <button onClick={() => setMax("A")} className="rounded px-1.5 py-0.5 text-[10px] font-bold text-pcs-primary hover:bg-pcs-primary/10 transition">MAX</button>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <input
            className="min-w-0 flex-1 bg-transparent text-2xl font-semibold text-pcs-text outline-none placeholder:text-pcs-textDim"
            value={amountA}
            onChange={e => { setAmountA(e.target.value); setLastEdited("A"); }}
            placeholder="0.0" inputMode="decimal"
          />
          <TokenSelector label="Token A" selected={tokenA} tokens={tokens} onSelect={t => { setTokenA(t); setAmountA(""); setAmountB(""); }} onAddCustom={onAddCustomToken} />
        </div>
      </div>

      <div className="flex justify-center py-2">
        <div className="rounded-full p-1.5" style={{ background: "rgba(0,212,255,0.08)", border: "1px solid rgba(0,212,255,0.15)" }}>
          <svg className="h-4 w-4 text-pcs-primary" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
        </div>
      </div>

      {/* Token B */}
      <div className="rounded-2xl p-4" style={{ background: "rgba(0,212,255,0.03)", border: "1px solid rgba(0,212,255,0.06)" }}>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs text-pcs-textDim">Token B</span>
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-pcs-textDim">
              Balance: {formatAmount(balances[tokenB?.address ?? zeroAddress], tokenB?.decimals ?? 18)}
            </span>
            <button onClick={() => setMax("B")} className="rounded px-1.5 py-0.5 text-[10px] font-bold text-pcs-primary hover:bg-pcs-primary/10 transition">MAX</button>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <input
            className="min-w-0 flex-1 bg-transparent text-2xl font-semibold text-pcs-text outline-none placeholder:text-pcs-textDim"
            value={amountB}
            onChange={e => { setAmountB(e.target.value); setLastEdited("B"); }}
            placeholder="0.0" inputMode="decimal"
            readOnly={!newPool && ratio !== null}
          />
          <TokenSelector label="Token B" selected={tokenB} tokens={tokens} onSelect={t => { setTokenB(t); setAmountA(""); setAmountB(""); }} onAddCustom={onAddCustomToken} />
        </div>
      </div>

      {/* Pool rate info */}
      {ratio && ratio.reserveA > 0n && tokenA && tokenB && (
        <div className="mt-3 flex justify-between rounded-xl px-3 py-2 text-xs text-pcs-textSub" style={{ background: "rgba(0,212,255,0.03)", border: "1px solid rgba(0,212,255,0.06)" }}>
          <span>Pool rate</span>
          <span>
            1 {tokenA.symbol} = {Number(formatUnits(ratio.reserveB, tokenB.decimals)) / Number(formatUnits(ratio.reserveA, tokenA.decimals)) > 0
              ? (Number(formatUnits(ratio.reserveB, tokenB.decimals)) / Number(formatUnits(ratio.reserveA, tokenA.decimals))).toFixed(6)
              : "—"} {tokenB.symbol}
          </span>
        </div>
      )}

      <button
        className="btn-primary mt-4 w-full py-3 text-base"
        onClick={supply}
        disabled={loading || chainMismatch || !isConnected || !tokenA || !tokenB || tokenA.address === tokenB.address || !amountA || Number(amountA) <= 0}
      >
        {buttonLabel()}
      </button>
    </div>
  );
}
