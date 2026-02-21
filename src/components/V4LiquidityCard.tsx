import { useCallback, useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { encodeAbiParameters, keccak256, parseAbiParameters, parseUnits } from "viem";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import type { NetworkConfig, TokenInfo } from "../utils/constants";
import { SWEEP_ETH_ADDRESS, V4_CONTRACTS_BY_CHAIN, hydeGatewayAbi } from "../utils/constants";
import { buildAddLiquidityTemplatePayload, buildRemoveLiquidityTemplatePayload, feeToTickSpacing } from "../utils/v4Encoding";
import { useApproval } from "../hooks/useApproval";
import { TokenSelector } from "./TokenSelector";

/* ─── fee tiers ─────────────────────────────────────────────────────────── */
const FEE_TIERS = [
  { label: "0.01%", value: 100 },
  { label: "0.05%", value: 500 },
  { label: "0.3%",  value: 3000 },
  { label: "1%",    value: 10000 },
] as const;

/* ─── price strategies ───────────────────────────────────────────────────── */
type StrategyId = "stable" | "wide" | "one-lower" | "one-upper";
const STRATEGIES: { id: StrategyId; label: string; range: string; desc: string }[] = [
  { id: "stable",    label: "Stable",          range: "±3 ticks",     desc: "Good for stablecoins or low volatility pairs" },
  { id: "wide",      label: "Wide",             range: "-50% — +100%", desc: "Good for volatile pairs" },
  { id: "one-lower", label: "One-sided lower",  range: "-50%",         desc: "Supply liquidity if price goes down" },
  { id: "one-upper", label: "One-sided upper",  range: "+100%",        desc: "Supply liquidity if price goes up" },
];

/* ─── tick helpers ───────────────────────────────────────────────────────── */
const LOG_1_0001 = Math.log(1.0001);
const WIDE_TICKS  = 6932; // ≈ ±50% in tick space

function snap(tick: number, spacing: number): number {
  return Math.round(tick / spacing) * spacing;
}

function tickToHumanPrice(tick: number, dec0: number, dec1: number): number {
  return Math.pow(1.0001, tick) * Math.pow(10, dec0 - dec1);
}

function humanPriceToTick(price: number, dec0: number, dec1: number): number {
  const raw = price / Math.pow(10, dec0 - dec1);
  if (raw <= 0) return 0;
  return Math.round(Math.log(raw) / LOG_1_0001);
}

function strategyToTicks(
  id: StrategyId | "full",
  currentTick: number,
  spacing: number
): { tickLower: number; tickUpper: number } {
  switch (id) {
    case "full":      return { tickLower: snap(-887272, spacing), tickUpper: snap(887272, spacing) };
    case "stable":    return { tickLower: snap(currentTick - 3 * spacing, spacing), tickUpper: snap(currentTick + 3 * spacing, spacing) };
    case "wide":      return { tickLower: snap(currentTick - WIDE_TICKS, spacing),  tickUpper: snap(currentTick + WIDE_TICKS, spacing) };
    case "one-lower": return { tickLower: snap(currentTick - WIDE_TICKS, spacing),  tickUpper: snap(currentTick, spacing) };
    case "one-upper": return { tickLower: snap(currentTick, spacing),               tickUpper: snap(currentTick + WIDE_TICKS, spacing) };
  }
}

function fmtPrice(p: number): string {
  if (!isFinite(p) || p <= 0) return "∞";
  if (p < 1e-6 || p > 1e9) return p.toExponential(3);
  if (p < 0.001) return p.toFixed(8);
  if (p < 1)     return p.toFixed(6);
  if (p < 1000)  return p.toFixed(4);
  return p.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function fmtPct(pct: number): string {
  const s = pct >= 0 ? "+" : "";
  return `${s}${pct.toFixed(2)}%`;
}

/* ─── pool manager ABI ───────────────────────────────────────────────────── */
const poolManagerAbi = [
  {
    type: "function", name: "getSlot0", stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick",         type: "int24"   },
      { name: "protocolFee",  type: "uint24"  },
      { name: "lpFee",        type: "uint24"  },
    ],
  },
] as const;

/* ─── position NFT ABI ───────────────────────────────────────────────────── */
const positionsQueryAbi = [
  {
    type: "function", name: "positions", stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [
      { name: "nonce",                    type: "uint96"  },
      { name: "operator",                 type: "address" },
      { name: "token0",                   type: "address" },
      { name: "token1",                   type: "address" },
      { name: "fee",                      type: "uint24"  },
      { name: "tickLower",                type: "int24"   },
      { name: "tickUpper",                type: "int24"   },
      { name: "liquidity",                type: "uint128" },
      { name: "feeGrowthInside0LastX128", type: "uint256" },
      { name: "feeGrowthInside1LastX128", type: "uint256" },
      { name: "tokensOwed0",              type: "uint128" },
      { name: "tokensOwed1",              type: "uint128" },
    ],
  },
] as const;

/* ─── pool-id helper ─────────────────────────────────────────────────────── */
function computePoolId(
  c0: `0x${string}`, c1: `0x${string}`,
  fee: number, spacing: number, hooks: `0x${string}`
): `0x${string}` {
  return keccak256(encodeAbiParameters(
    parseAbiParameters("address,address,uint24,int24,address"),
    [c0, c1, fee, spacing, hooks]
  ));
}

/** sqrtPriceX96 → human price of token0 in token1 */
function sqrtPriceX96ToPrice(sqrtPriceX96: bigint, dec0: number, dec1: number): number {
  if (sqrtPriceX96 === 0n) return 0;
  const PREC = 10n ** 18n;
  const priceFixed = (sqrtPriceX96 * sqrtPriceX96 * PREC) / (2n ** 192n);
  return Number(priceFixed) / 1e18 * Math.pow(10, dec0 - dec1);
}

/* ─── types ──────────────────────────────────────────────────────────────── */
type Props = {
  network: NetworkConfig;
  tokens: TokenInfo[];
  mode: "add" | "remove";
  onAddCustomToken: (token: { address: `0x${string}`; symbol: string; name: string; decimals: number }) => void;
};

/* ═══════════════════════════════════════════════════════════════════════════
   V4LiquidityCard
   ═══════════════════════════════════════════════════════════════════════════ */
export function V4LiquidityCard({ network, tokens, mode, onAddCustomToken }: Props) {
  const { address, chainId, isConnected } = useAccount();
  const publicClient  = usePublicClient({ chainId: network.id });
  const { data: walletClient } = useWalletClient({ chainId: network.id });
  const contracts = V4_CONTRACTS_BY_CHAIN[network.id];

  const isAdd        = mode === "add";
  const chainMismatch = isConnected && chainId !== network.id;

  /* ── token pair ──────────────────────────────────────────────────────── */
  const [tokenA, setTokenA] = useState<TokenInfo | undefined>(tokens[0]);
  const [tokenB, setTokenB] = useState<TokenInfo | undefined>(tokens[1]);

  const resetAmounts = () => { setAmountA(""); setAmountB(""); };

  /* ── fee tier ────────────────────────────────────────────────────────── */
  const [feeTier, setFeeTier] = useState<number>(3000);

  /* ── pool state ──────────────────────────────────────────────────────── */
  const [poolPrice,    setPoolPrice]    = useState<number | null>(null); // tokenB per tokenA
  const [currentTick,  setCurrentTick]  = useState(0);
  const [newPool,      setNewPool]      = useState(false);
  const [priceLoading, setPriceLoading] = useState(false);

  /* ── strategy / ticks ────────────────────────────────────────────────── */
  const [strategyId, setStrategyId] = useState<StrategyId | "full">("wide");

  const spacing = useMemo(() => feeToTickSpacing(feeTier), [feeTier]);

  const { tickLower, tickUpper } = useMemo(
    () => strategyToTicks(strategyId, currentTick, spacing),
    [strategyId, currentTick, spacing]
  );

  /* ── min / max price display ─────────────────────────────────────────── */
  // sorted0 = lower address token
  const aIsLower = (tokenA && tokenB)
    ? tokenA.address.toLowerCase() < tokenB.address.toLowerCase()
    : true;

  const sorted0 = aIsLower ? tokenA : tokenB;
  const sorted1 = aIsLower ? tokenB : tokenA;

  const minPrice = useMemo(() => {
    if (!sorted0 || !sorted1) return null;
    // tickLower corresponds to min price of sorted0 in sorted1
    const raw = tickToHumanPrice(tickLower, sorted0.decimals, sorted1.decimals);
    // if tokenA is sorted1, invert
    return aIsLower ? raw : (raw > 0 ? 1 / raw : null);
  }, [tickLower, sorted0, sorted1, aIsLower]);

  const maxPrice = useMemo(() => {
    if (!sorted0 || !sorted1) return null;
    const raw = tickToHumanPrice(tickUpper, sorted0.decimals, sorted1.decimals);
    return aIsLower ? raw : (raw > 0 ? 1 / raw : null);
  }, [tickUpper, sorted0, sorted1, aIsLower]);

  const minPct = poolPrice && minPrice ? ((minPrice - poolPrice) / poolPrice) * 100 : null;
  const maxPct = poolPrice && maxPrice ? ((maxPrice - poolPrice) / poolPrice) * 100 : null;

  /* ── adjust ticks via +/- buttons ────────────────────────────────────── */
  const [tickLowerManual, setTickLowerManual] = useState<number | null>(null);
  const [tickUpperManual, setTickUpperManual] = useState<number | null>(null);

  const effectiveTickLower = tickLowerManual !== null ? tickLowerManual : tickLower;
  const effectiveTickUpper = tickUpperManual !== null ? tickUpperManual : tickUpper;

  const adjustLower = (delta: number) => {
    const base = tickLowerManual !== null ? tickLowerManual : tickLower;
    setTickLowerManual(snap(base + delta * spacing, spacing));
    setStrategyId("wide"); // leave strategy mode on manual adjust
  };
  const adjustUpper = (delta: number) => {
    const base = tickUpperManual !== null ? tickUpperManual : tickUpper;
    setTickUpperManual(snap(base + delta * spacing, spacing));
    setStrategyId("wide");
  };
  const selectStrategy = (id: StrategyId | "full") => {
    setStrategyId(id);
    setTickLowerManual(null);
    setTickUpperManual(null);
  };

  /* ── pool price effect ───────────────────────────────────────────────── */
  useEffect(() => {
    if (!isAdd || !tokenA || !tokenB || tokenA.address === tokenB.address || !publicClient) {
      setPoolPrice(null); setNewPool(false); return;
    }
    const aLow = tokenA.address.toLowerCase() < tokenB.address.toLowerCase();
    const [s0, s1] = aLow ? [tokenA, tokenB] : [tokenB, tokenA];
    const sp = feeToTickSpacing(feeTier);

    const fetchPrice = async () => {
      setPriceLoading(true);
      try {
        const poolId = computePoolId(s0.address, s1.address, feeTier, sp, SWEEP_ETH_ADDRESS);
        const slot0  = await publicClient.readContract({
          address: contracts.poolManager, abi: poolManagerAbi, functionName: "getSlot0", args: [poolId],
        });
        const sqrtPx96 = slot0[0];
        const tick     = slot0[1] as number;
        if (sqrtPx96 === 0n) { setPoolPrice(null); setNewPool(true); return; }
        const priceS0S1 = sqrtPriceX96ToPrice(sqrtPx96, s0.decimals, s1.decimals);
        setPoolPrice(aLow ? priceS0S1 : 1 / priceS0S1);
        setCurrentTick(tick);
        setNewPool(false);
      } catch {
        setPoolPrice(null); setNewPool(false);
      } finally {
        setPriceLoading(false);
      }
    };
    fetchPrice();
  }, [tokenA, tokenB, feeTier, isAdd, publicClient, contracts.poolManager]);

  /* ── amounts ─────────────────────────────────────────────────────────── */
  const [amountA, setAmountA] = useState("");
  const [amountB, setAmountB] = useState("");

  const handleAmountAChange = (val: string) => {
    setAmountA(val);
    if (poolPrice !== null && val && Number(val) > 0) {
      setAmountB((Number(val) * poolPrice).toFixed(6).replace(/\.?0+$/, ""));
    }
  };
  const handleAmountBChange = (val: string) => {
    setAmountB(val);
    if (poolPrice !== null && val && Number(val) > 0 && poolPrice > 0) {
      setAmountA((Number(val) / poolPrice).toFixed(6).replace(/\.?0+$/, ""));
    }
  };

  /* ── slippage ────────────────────────────────────────────────────────── */
  const [slippage, setSlippage]         = useState("0.5");
  const [showSlippage, setShowSlippage] = useState(false);

  /* ── remove mode ─────────────────────────────────────────────────────── */
  const [tokenId, setTokenId]                     = useState("");
  const [positionLiquidity, setPositionLiquidity] = useState<bigint | null>(null);
  const [positionFetching, setPositionFetching]   = useState(false);
  const [removePercent, setRemovePercent]         = useState(100);

  const liquidityToRemove = useMemo(() => {
    if (!positionLiquidity) return 0n;
    return (positionLiquidity * BigInt(removePercent)) / 100n;
  }, [positionLiquidity, removePercent]);

  const [loading, setLoading] = useState(false);

  /* ── parsed amounts ──────────────────────────────────────────────────── */
  const amount0Parsed = useMemo(() => {
    try { return tokenA && amountA ? parseUnits(amountA, tokenA.decimals) : 0n; } catch { return 0n; }
  }, [amountA, tokenA]);
  const amount1Parsed = useMemo(() => {
    try { return tokenB && amountB ? parseUnits(amountB, tokenB.decimals) : 0n; } catch { return 0n; }
  }, [amountB, tokenB]);

  /* ── approvals ───────────────────────────────────────────────────────── */
  const { needsApproval: needsApprovalA, approve: approveA } = useApproval({
    token: tokenA?.address, spender: contracts.permit2, amount: amount0Parsed,
    chainId: network.id, isNative: tokenA?.isNative,
  });
  const { needsApproval: needsApprovalB, approve: approveB } = useApproval({
    token: tokenB?.address, spender: contracts.permit2, amount: amount1Parsed,
    chainId: network.id, isNative: tokenB?.isNative,
  });

  const [approvingA, setApprovingA] = useState(false);
  const [approvingB, setApprovingB] = useState(false);

  const handleApproveA = async () => {
    try { setApprovingA(true); toast.loading(`Approving ${tokenA?.symbol}...`, { id: "approve-a" }); await approveA(); toast.success(`${tokenA?.symbol} approved`, { id: "approve-a" }); }
    catch { toast.error("Approval failed", { id: "approve-a" }); } finally { setApprovingA(false); }
  };
  const handleApproveB = async () => {
    try { setApprovingB(true); toast.loading(`Approving ${tokenB?.symbol}...`, { id: "approve-b" }); await approveB(); toast.success(`${tokenB?.symbol} approved`, { id: "approve-b" }); }
    catch { toast.error("Approval failed", { id: "approve-b" }); } finally { setApprovingB(false); }
  };

  /* ── fetch position ──────────────────────────────────────────────────── */
  const fetchPosition = useCallback(async () => {
    if (!tokenId || !publicClient) return;
    try {
      setPositionFetching(true);
      const result = await publicClient.readContract({
        address: contracts.positionManager, abi: positionsQueryAbi,
        functionName: "positions", args: [BigInt(tokenId)],
      });
      setPositionLiquidity(result[7]);
      toast.success("Position loaded");
    } catch {
      toast.error("Could not fetch position — check the token ID");
      setPositionLiquidity(null);
    } finally { setPositionFetching(false); }
  }, [tokenId, publicClient, contracts.positionManager]);

  useEffect(() => {
    if (!tokenId || isAdd) return;
    const t = setTimeout(() => fetchPosition(), 700);
    return () => clearTimeout(t);
  }, [tokenId, isAdd, fetchPosition]);

  useEffect(() => { if (!tokenId) setPositionLiquidity(null); }, [tokenId]);

  /* ── slippage bps ────────────────────────────────────────────────────── */
  const slippageBps = useMemo(() => BigInt(Math.min(Math.floor(Number(slippage || "0") * 100), 5000)), [slippage]);
  const minA = useMemo(() => amount0Parsed ? ((amount0Parsed * (10000n - slippageBps)) / 10000n).toString() : "0", [amount0Parsed, slippageBps]);
  const minB = useMemo(() => amount1Parsed ? ((amount1Parsed * (10000n - slippageBps)) / 10000n).toString() : "0", [amount1Parsed, slippageBps]);

  /* ── can submit ──────────────────────────────────────────────────────── */
  const canSubmit = useMemo(() => {
    if (!isConnected || chainMismatch || !tokenA || !tokenB || tokenA.address === tokenB.address) return false;
    if (isAdd) {
      if (!amountA && !amountB) return false;
      if (amountA && needsApprovalA) return false;
      if (amountB && needsApprovalB) return false;
      return true;
    }
    return Boolean(tokenId && liquidityToRemove > 0n);
  }, [isConnected, chainMismatch, tokenA, tokenB, isAdd, amountA, amountB, tokenId, liquidityToRemove, needsApprovalA, needsApprovalB]);

  /* ── submit ──────────────────────────────────────────────────────────── */
  const submit = async () => {
    if (!walletClient || !publicClient || !address) { toast.error("Connect wallet first"); return; }
    if (chainMismatch) { toast.error("Switch network first"); return; }
    if (!tokenA || !tokenB || tokenA.address === tokenB.address) { toast.error("Choose valid pair"); return; }
    try {
      setLoading(true);
      let payload: `0x${string}`[];
      if (isAdd) {
        payload = buildAddLiquidityTemplatePayload({
          token0: tokenA.address, token1: tokenB.address, fee: feeTier,
          tickLower: effectiveTickLower, tickUpper: effectiveTickUpper,
          amount0Desired: amountA, amount1Desired: amountB,
          amount0Min: minA, amount1Min: minB,
          decimals0: tokenA.decimals, decimals1: tokenB.decimals, recipient: address,
        });
      } else {
        if (!tokenId || liquidityToRemove === 0n) { toast.error("Enter position ID"); return; }
        payload = buildRemoveLiquidityTemplatePayload({
          tokenId, liquidity: liquidityToRemove.toString(),
          amount0Min: "0", amount1Min: "0", recipient: address,
          decimals0: tokenA.decimals, decimals1: tokenB.decimals,
        });
      }
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60);
      toast.loading(isAdd ? "Adding liquidity..." : "Removing liquidity...", { id: "v4-liq" });
      const hash = await walletClient.writeContract({
        address: contracts.gateway, abi: hydeGatewayAbi,
        functionName: "executePositionMulticall", args: [payload, deadline],
        account: address, chain: walletClient.chain,
      });
      await publicClient.waitForTransactionReceipt({ hash });
      toast.success(isAdd ? "Liquidity added!" : "Liquidity removed!", { id: "v4-liq" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      toast.error(msg.includes("User rejected") || msg.includes("denied") ? "Transaction rejected" : `Failed: ${msg.slice(0, 80)}`, { id: "v4-liq" });
    } finally { setLoading(false); }
  };

  /* ── styles ──────────────────────────────────────────────────────────── */
  const box = { background: "rgba(0, 212, 255, 0.03)", border: "1px solid rgba(0, 212, 255, 0.06)" };

  /* ═══════════════════════════════════════════════════════════════════════
     Render
     ═══════════════════════════════════════════════════════════════════════ */
  return (
    <div className="card">

      {/* ── header ─────────────────────────────────────────────────────── */}
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-pcs-text">{isAdd ? "Add Liquidity" : "Remove Liquidity"}</h2>
          <p className="mt-0.5 text-xs text-pcs-textDim">{isAdd ? "Provide liquidity to earn fees" : "Withdraw your liquidity position"}</p>
        </div>
        {isAdd && (
          <button type="button" className="flex h-8 w-8 items-center justify-center rounded-xl text-pcs-textDim hover:text-pcs-primary transition" style={box} onClick={() => setShowSlippage(s => !s)}>
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 6h9.75M10.5 6a1.5 1.5 0 1 1-3 0m3 0a1.5 1.5 0 1 0-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 0 1-3 0m3 0a1.5 1.5 0 0 0-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 0 1-3 0m3 0a1.5 1.5 0 0 0-3 0m-9.75 0h9.75" />
            </svg>
          </button>
        )}
      </div>

      {/* ── slippage ───────────────────────────────────────────────────── */}
      {isAdd && showSlippage && (
        <div className="mb-4 rounded-2xl p-3 space-y-2" style={box}>
          <p className="text-xs font-medium text-pcs-textDim">Slippage Tolerance</p>
          <div className="flex gap-2 flex-wrap">
            {["0.1", "0.5", "1.0"].map(v => (
              <button key={v} type="button" className={`rounded-lg px-3 py-1 text-xs font-medium transition ${slippage === v ? "btn-neon" : "btn-secondary"}`} onClick={() => setSlippage(v)}>{v}%</button>
            ))}
            <input className="input text-xs w-20" value={slippage} onChange={e => setSlippage(e.target.value)} placeholder="Custom" />
          </div>
        </div>
      )}

      {/* ── token pair ─────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 mb-4">
        <div className="flex-1 rounded-2xl p-3" style={box}>
          <span className="mb-1.5 block text-xs font-medium text-pcs-textDim">Token A</span>
          <TokenSelector label="Token A" selected={tokenA} tokens={tokens} onSelect={t => { setTokenA(t); resetAmounts(); }} onAddCustom={onAddCustomToken} chainId={network.id} />
        </div>
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-pcs-primary" style={{ background: "rgba(0, 212, 255, 0.08)" }}>
          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>
        </div>
        <div className="flex-1 rounded-2xl p-3" style={box}>
          <span className="mb-1.5 block text-xs font-medium text-pcs-textDim">Token B</span>
          <TokenSelector label="Token B" selected={tokenB} tokens={tokens} onSelect={t => { setTokenB(t); resetAmounts(); }} onAddCustom={onAddCustomToken} chainId={network.id} />
        </div>
      </div>

      {/* ── fee tier ───────────────────────────────────────────────────── */}
      <div className="mb-4">
        <p className="mb-2 text-xs font-medium text-pcs-textDim">Fee Tier</p>
        <div className="grid grid-cols-4 gap-2">
          {FEE_TIERS.map(ft => (
            <button key={ft.value} type="button" className={`rounded-xl py-2 text-xs font-semibold transition ${feeTier === ft.value ? "btn-neon" : "btn-secondary"}`} onClick={() => { setFeeTier(ft.value); resetAmounts(); }}>{ft.label}</button>
          ))}
        </div>
      </div>

      {/* ══ ADD MODE ════════════════════════════════════════════════════ */}
      {isAdd && (
        <>
          {/* pool info bar */}
          {(priceLoading || newPool || poolPrice !== null) && (
            <div className="mb-4 rounded-xl px-3 py-2 text-xs" style={box}>
              {priceLoading
                ? <span className="text-pcs-textDim">Fetching pool price…</span>
                : newPool
                  ? <span className="text-yellow-400">New pool — you set the initial price</span>
                  : poolPrice !== null
                    ? <span className="text-pcs-textDim">Current rate: <span className="text-pcs-text font-medium">1 {tokenA?.symbol} = {fmtPrice(poolPrice)} {tokenB?.symbol}</span></span>
                    : null}
            </div>
          )}

          {/* price strategies */}
          <div className="mb-4">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-medium text-pcs-textDim">Price strategies</p>
              <button
                type="button"
                className={`rounded-lg px-2 py-0.5 text-xs font-semibold transition ${strategyId === "full" ? "btn-neon" : "btn-secondary"}`}
                onClick={() => selectStrategy("full")}
              >
                Full Range
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {STRATEGIES.map(s => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => selectStrategy(s.id)}
                  className={`rounded-2xl p-3 text-left transition ${strategyId === s.id ? "ring-1 ring-pcs-primary" : "hover:ring-1 hover:ring-pcs-primary/30"}`}
                  style={strategyId === s.id
                    ? { ...box, background: "rgba(0, 212, 255, 0.08)" }
                    : box}
                >
                  <p className="text-xs font-semibold text-pcs-text">{s.label}</p>
                  <p className="mt-0.5 text-[10px] font-medium text-pcs-primary">{s.range}</p>
                  <p className="mt-1.5 text-[10px] leading-tight text-pcs-textDim">{s.desc}</p>
                </button>
              ))}
            </div>
          </div>

          {/* min / max price */}
          {strategyId !== "full" && (
            <div className="mb-4 grid grid-cols-2 gap-3">
              {/* Min price */}
              <div className="rounded-2xl p-3" style={box}>
                <p className="text-xs text-pcs-textDim mb-1">Min price</p>
                <p className="text-base font-bold text-pcs-text truncate">
                  {minPrice !== null ? fmtPrice(minPrice) : "—"}
                </p>
                {minPct !== null && (
                  <p className={`text-[10px] mt-0.5 ${minPct < 0 ? "text-red-400" : "text-green-400"}`}>
                    {fmtPct(minPct)}
                  </p>
                )}
                <div className="flex gap-1.5 mt-2">
                  <button type="button" className="btn-secondary flex-1 py-1 text-sm font-bold" onClick={() => adjustLower(-1)}>−</button>
                  <button type="button" className="btn-secondary flex-1 py-1 text-sm font-bold" onClick={() => adjustLower(+1)}>+</button>
                </div>
              </div>

              {/* Max price */}
              <div className="rounded-2xl p-3" style={box}>
                <p className="text-xs text-pcs-textDim mb-1">Max price</p>
                <p className="text-base font-bold text-pcs-text truncate">
                  {maxPrice !== null ? fmtPrice(maxPrice) : "—"}
                </p>
                {maxPct !== null && (
                  <p className={`text-[10px] mt-0.5 ${maxPct < 0 ? "text-red-400" : "text-green-400"}`}>
                    {fmtPct(maxPct)}
                  </p>
                )}
                <div className="flex gap-1.5 mt-2">
                  <button type="button" className="btn-secondary flex-1 py-1 text-sm font-bold" onClick={() => adjustUpper(-1)}>−</button>
                  <button type="button" className="btn-secondary flex-1 py-1 text-sm font-bold" onClick={() => adjustUpper(+1)}>+</button>
                </div>
              </div>
            </div>
          )}

          {/* deposit amounts */}
          <p className="mb-2 text-xs font-medium text-pcs-textDim">Deposit tokens</p>
          <div className="space-y-3 mb-4">
            <div className="rounded-2xl p-4" style={box}>
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-medium text-pcs-textDim">{tokenA?.symbol ?? "Token A"}</p>
              </div>
              <input type="number" className="w-full bg-transparent text-xl font-semibold text-pcs-text outline-none placeholder:text-pcs-textDim" placeholder="0.0" value={amountA} onChange={e => handleAmountAChange(e.target.value)} />
            </div>
            <div className="rounded-2xl p-4" style={box}>
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-medium text-pcs-textDim">
                  {tokenB?.symbol ?? "Token B"}
                  {poolPrice !== null && <span className="ml-1 text-pcs-primary/60">(auto)</span>}
                </p>
              </div>
              <input type="number" className="w-full bg-transparent text-xl font-semibold text-pcs-text outline-none placeholder:text-pcs-textDim" placeholder="0.0" value={amountB} onChange={e => handleAmountBChange(e.target.value)} />
            </div>
          </div>

          {/* approvals */}
          <div className="space-y-2">
            {needsApprovalA && tokenA && amountA && (
              <button className="btn-secondary w-full py-3 text-base" disabled={approvingA} onClick={handleApproveA}>{approvingA ? "Approving..." : `Approve ${tokenA.symbol}`}</button>
            )}
            {needsApprovalB && tokenB && amountB && (
              <button className="btn-secondary w-full py-3 text-base" disabled={approvingB} onClick={handleApproveB}>{approvingB ? "Approving..." : `Approve ${tokenB.symbol}`}</button>
            )}
          </div>
        </>
      )}

      {/* ══ REMOVE MODE ═════════════════════════════════════════════════ */}
      {!isAdd && (
        <div className="space-y-3">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-pcs-textDim">Position Token ID</label>
            <div className="flex gap-2">
              <input className="input flex-1 text-sm" placeholder="Your position NFT token ID" value={tokenId} onChange={e => { setTokenId(e.target.value); setPositionLiquidity(null); }} />
              <button type="button" className="btn-secondary px-4 text-sm" disabled={!tokenId || positionFetching} onClick={fetchPosition}>{positionFetching ? "..." : "Fetch"}</button>
            </div>
          </div>

          {positionLiquidity !== null && (
            <div className="rounded-2xl p-3" style={box}>
              <p className="text-xs text-pcs-textDim mb-1">Position Liquidity</p>
              <p className="font-mono text-sm text-pcs-text break-all">{positionLiquidity.toString()}</p>
            </div>
          )}

          {positionLiquidity !== null && (
            <div className="rounded-2xl p-4 space-y-3" style={box}>
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-pcs-textDim">Amount to Remove</span>
                <span className="text-lg font-bold text-pcs-text">{removePercent}%</span>
              </div>
              <input type="range" min={1} max={100} value={removePercent} onChange={e => setRemovePercent(Number(e.target.value))} className="w-full accent-pcs-primary" />
              <div className="flex gap-2">
                {[25, 50, 75, 100].map(p => (
                  <button key={p} type="button" className={`flex-1 rounded-xl py-1.5 text-xs font-semibold transition ${removePercent === p ? "btn-neon" : "btn-secondary"}`} onClick={() => setRemovePercent(p)}>{p === 100 ? "MAX" : `${p}%`}</button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── submit ─────────────────────────────────────────────────────── */}
      <button className="btn-neon mt-5 w-full py-3 text-base" disabled={!canSubmit || loading} onClick={submit}>
        {loading ? "Processing..."
          : !isConnected ? "Connect Wallet"
          : chainMismatch ? "Wrong Network"
          : !tokenA || !tokenB ? "Select Tokens"
          : tokenA.address === tokenB.address ? "Select Different Tokens"
          : isAdd && !amountA && !amountB ? "Enter Amounts"
          : !isAdd && !tokenId ? "Enter Position ID"
          : !isAdd && positionLiquidity === null ? "Fetch Position First"
          : isAdd ? "Supply"
          : "Remove Liquidity"}
      </button>
    </div>
  );
}
