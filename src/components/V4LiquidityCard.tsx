import { useCallback, useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { parseUnits } from "viem";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import type { NetworkConfig, TokenInfo } from "../utils/constants";
import { V4_CONTRACTS_BY_CHAIN, hydeGatewayAbi } from "../utils/constants";
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

/* ─── price-range presets ────────────────────────────────────────────────── */
const RANGE_PRESETS = [
  { label: "Full Range", tickLower: -887272, tickUpper: 887272 },
  { label: "±50%",       tickLower: -6000,   tickUpper: 6000   },
  { label: "±10%",       tickLower: -1200,   tickUpper: 1200   },
] as const;

/* ─── minimal ABI to query position NFT ─────────────────────────────────── */
const positionsQueryAbi = [
  {
    type: "function",
    name: "positions",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [
      { name: "nonce",                      type: "uint96"  },
      { name: "operator",                   type: "address" },
      { name: "token0",                     type: "address" },
      { name: "token1",                     type: "address" },
      { name: "fee",                        type: "uint24"  },
      { name: "tickLower",                  type: "int24"   },
      { name: "tickUpper",                  type: "int24"   },
      { name: "liquidity",                  type: "uint128" },
      { name: "feeGrowthInside0LastX128",   type: "uint256" },
      { name: "feeGrowthInside1LastX128",   type: "uint256" },
      { name: "tokensOwed0",                type: "uint128" },
      { name: "tokensOwed1",                type: "uint128" },
    ],
  },
] as const;

/* ─── helpers ────────────────────────────────────────────────────────────── */
function snapToSpacing(tick: number, spacing: number): number {
  return Math.round(tick / spacing) * spacing;
}

/* ─── types ─────────────────────────────────────────────────────────────── */
type Props = {
  network: NetworkConfig;
  tokens: TokenInfo[];
  mode: "add" | "remove";
  onAddCustomToken: (token: {
    address: `0x${string}`;
    symbol: string;
    name: string;
    decimals: number;
  }) => void;
};

/* ═══════════════════════════════════════════════════════════════════════════
   V4LiquidityCard
   ═══════════════════════════════════════════════════════════════════════════ */
export function V4LiquidityCard({ network, tokens, mode, onAddCustomToken }: Props) {
  const { address, chainId, isConnected } = useAccount();
  const publicClient = usePublicClient({ chainId: network.id });
  const { data: walletClient } = useWalletClient({ chainId: network.id });
  const contracts = V4_CONTRACTS_BY_CHAIN[network.id];

  const isAdd = mode === "add";
  const chainMismatch = isConnected && chainId !== network.id;

  /* ── token pair ──────────────────────────────────────────────────────── */
  const [tokenA, setTokenA] = useState<TokenInfo | undefined>(tokens[0]);
  const [tokenB, setTokenB] = useState<TokenInfo | undefined>(tokens[1]);

  /* ── fee tier ────────────────────────────────────────────────────────── */
  const [feeTier, setFeeTier] = useState<number>(3000);

  /* ── price range (add mode) ──────────────────────────────────────────── */
  const [rangeIdx, setRangeIdx]               = useState(0);
  const [showCustomTicks, setShowCustomTicks] = useState(false);
  const [customTickLower, setCustomTickLower] = useState(-887272);
  const [customTickUpper, setCustomTickUpper] = useState(887272);

  const { tickLower, tickUpper } = useMemo(() => {
    const spacing = feeToTickSpacing(feeTier);
    if (showCustomTicks) {
      return {
        tickLower: snapToSpacing(customTickLower, spacing),
        tickUpper: snapToSpacing(customTickUpper, spacing),
      };
    }
    const preset = RANGE_PRESETS[rangeIdx];
    return {
      tickLower: snapToSpacing(preset.tickLower, spacing),
      tickUpper: snapToSpacing(preset.tickUpper, spacing),
    };
  }, [feeTier, showCustomTicks, customTickLower, customTickUpper, rangeIdx]);

  /* ── amounts (add mode) ──────────────────────────────────────────────── */
  const [amountA, setAmountA] = useState("");
  const [amountB, setAmountB] = useState("");

  /* ── slippage ────────────────────────────────────────────────────────── */
  const [slippage, setSlippage]         = useState("0.5");
  const [showSlippage, setShowSlippage] = useState(false);

  /* ── remove mode state ───────────────────────────────────────────────── */
  const [tokenId, setTokenId]                     = useState("");
  const [positionLiquidity, setPositionLiquidity] = useState<bigint | null>(null);
  const [positionFetching, setPositionFetching]   = useState(false);
  const [removePercent, setRemovePercent]         = useState(100);

  const liquidityToRemove = useMemo(() => {
    if (!positionLiquidity) return 0n;
    return (positionLiquidity * BigInt(removePercent)) / 100n;
  }, [positionLiquidity, removePercent]);

  /* ── loading ─────────────────────────────────────────────────────────── */
  const [loading, setLoading] = useState(false);

  /* ── parsed amounts ──────────────────────────────────────────────────── */
  const amount0Parsed = useMemo(() => {
    try { return tokenA && amountA ? parseUnits(amountA, tokenA.decimals) : 0n; }
    catch { return 0n; }
  }, [amountA, tokenA]);

  const amount1Parsed = useMemo(() => {
    try { return tokenB && amountB ? parseUnits(amountB, tokenB.decimals) : 0n; }
    catch { return 0n; }
  }, [amountB, tokenB]);

  /* ── approvals ───────────────────────────────────────────────────────── */
  const { needsApproval: needsApprovalA, approve: approveA } = useApproval({
    token:    tokenA?.address,
    spender:  contracts.permit2,
    amount:   amount0Parsed,
    chainId:  network.id,
    isNative: tokenA?.isNative,
  });

  const { needsApproval: needsApprovalB, approve: approveB } = useApproval({
    token:    tokenB?.address,
    spender:  contracts.permit2,
    amount:   amount1Parsed,
    chainId:  network.id,
    isNative: tokenB?.isNative,
  });

  const [approvingA, setApprovingA] = useState(false);
  const [approvingB, setApprovingB] = useState(false);

  const handleApproveA = async () => {
    try {
      setApprovingA(true);
      toast.loading(`Approving ${tokenA?.symbol}...`, { id: "approve-a" });
      await approveA();
      toast.success(`${tokenA?.symbol} approved`, { id: "approve-a" });
    } catch {
      toast.error("Approval failed", { id: "approve-a" });
    } finally { setApprovingA(false); }
  };

  const handleApproveB = async () => {
    try {
      setApprovingB(true);
      toast.loading(`Approving ${tokenB?.symbol}...`, { id: "approve-b" });
      await approveB();
      toast.success(`${tokenB?.symbol} approved`, { id: "approve-b" });
    } catch {
      toast.error("Approval failed", { id: "approve-b" });
    } finally { setApprovingB(false); }
  };

  /* ── fetch position liquidity (remove mode) ──────────────────────────── */
  const fetchPosition = useCallback(async () => {
    if (!tokenId || !publicClient) return;
    try {
      setPositionFetching(true);
      const result = await publicClient.readContract({
        address:      contracts.positionManager,
        abi:          positionsQueryAbi,
        functionName: "positions",
        args:         [BigInt(tokenId)],
      });
      setPositionLiquidity(result[7]); // index 7 = liquidity field
      toast.success("Position loaded");
    } catch {
      toast.error("Could not fetch position — check the token ID");
      setPositionLiquidity(null);
    } finally {
      setPositionFetching(false);
    }
  }, [tokenId, publicClient, contracts.positionManager]);

  /* auto-fetch when tokenId changes (debounced) */
  useEffect(() => {
    if (!tokenId || isAdd) return;
    const t = setTimeout(() => fetchPosition(), 700);
    return () => clearTimeout(t);
  }, [tokenId, isAdd, fetchPosition]);

  /* reset position when tokenId cleared */
  useEffect(() => {
    if (!tokenId) setPositionLiquidity(null);
  }, [tokenId]);

  /* ── slippage bps ────────────────────────────────────────────────────── */
  const slippageBps = useMemo(() => {
    const pct = Number(slippage || "0");
    return BigInt(Math.min(Math.floor(pct * 100), 5000));
  }, [slippage]);

  const minA = useMemo(() => {
    if (!amount0Parsed || !tokenA) return "0";
    const min = (amount0Parsed * (10000n - slippageBps)) / 10000n;
    return min.toString();
  }, [amount0Parsed, slippageBps, tokenA]);

  const minB = useMemo(() => {
    if (!amount1Parsed || !tokenB) return "0";
    const min = (amount1Parsed * (10000n - slippageBps)) / 10000n;
    return min.toString();
  }, [amount1Parsed, slippageBps, tokenB]);

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
          token0:         tokenA.address,
          token1:         tokenB.address,
          fee:            feeTier,
          tickLower,
          tickUpper,
          amount0Desired: amountA,
          amount1Desired: amountB,
          amount0Min:     minA,
          amount1Min:     minB,
          decimals0:      tokenA.decimals,
          decimals1:      tokenB.decimals,
          recipient:      address,
        });
      } else {
        if (!tokenId || liquidityToRemove === 0n) { toast.error("Enter position ID"); return; }
        payload = buildRemoveLiquidityTemplatePayload({
          tokenId,
          liquidity:   liquidityToRemove.toString(),
          amount0Min:  "0",
          amount1Min:  "0",
          recipient:   address,
          decimals0:   tokenA.decimals,
          decimals1:   tokenB.decimals,
        });
      }

      const deadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60);
      toast.loading(isAdd ? "Adding liquidity..." : "Removing liquidity...", { id: "v4-liq" });

      const hash = await walletClient.writeContract({
        address:      contracts.gateway,
        abi:          hydeGatewayAbi,
        functionName: "executePositionMulticall",
        args:         [payload, deadline],
        account:      address,
        chain:        walletClient.chain,
      });
      await publicClient.waitForTransactionReceipt({ hash });
      toast.success(isAdd ? "Liquidity added!" : "Liquidity removed!", { id: "v4-liq" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      if (msg.includes("User rejected") || msg.includes("denied")) {
        toast.error("Transaction rejected", { id: "v4-liq" });
      } else {
        toast.error(`Failed: ${msg.slice(0, 80)}`, { id: "v4-liq" });
      }
    } finally {
      setLoading(false);
    }
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
          <h2 className="text-lg font-bold text-pcs-text">
            {isAdd ? "Add Liquidity" : "Remove Liquidity"}
          </h2>
          <p className="mt-0.5 text-xs text-pcs-textDim">
            {isAdd ? "Provide liquidity to earn fees" : "Withdraw your liquidity position"}
          </p>
        </div>
        {isAdd && (
          <button
            type="button"
            className="flex h-8 w-8 items-center justify-center rounded-xl text-pcs-textDim hover:text-pcs-primary transition"
            style={box}
            onClick={() => setShowSlippage(s => !s)}
            title="Slippage settings"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 6h9.75M10.5 6a1.5 1.5 0 1 1-3 0m3 0a1.5 1.5 0 1 0-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 0 1-3 0m3 0a1.5 1.5 0 0 0-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 0 1-3 0m3 0a1.5 1.5 0 0 0-3 0m-9.75 0h9.75" />
            </svg>
          </button>
        )}
      </div>

      {/* ── slippage panel ─────────────────────────────────────────────── */}
      {isAdd && showSlippage && (
        <div className="mb-4 rounded-2xl p-3 space-y-2" style={box}>
          <p className="text-xs font-medium text-pcs-textDim">Slippage Tolerance</p>
          <div className="flex gap-2 flex-wrap">
            {["0.1", "0.5", "1.0"].map(v => (
              <button
                key={v}
                type="button"
                className={`rounded-lg px-3 py-1 text-xs font-medium transition ${slippage === v ? "btn-neon" : "btn-secondary"}`}
                onClick={() => setSlippage(v)}
              >
                {v}%
              </button>
            ))}
            <input
              className="input text-xs w-20"
              value={slippage}
              onChange={e => setSlippage(e.target.value)}
              placeholder="Custom"
            />
          </div>
        </div>
      )}

      {/* ── token pair ─────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 mb-4">
        <div className="flex-1 rounded-2xl p-3" style={box}>
          <span className="mb-1.5 block text-xs font-medium text-pcs-textDim">Token A</span>
          <TokenSelector
            label="Token A"
            selected={tokenA}
            tokens={tokens}
            onSelect={setTokenA}
            onAddCustom={onAddCustomToken}
            chainId={network.id}
          />
        </div>
        <div
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-pcs-primary"
          style={{ background: "rgba(0, 212, 255, 0.08)" }}
        >
          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
        </div>
        <div className="flex-1 rounded-2xl p-3" style={box}>
          <span className="mb-1.5 block text-xs font-medium text-pcs-textDim">Token B</span>
          <TokenSelector
            label="Token B"
            selected={tokenB}
            tokens={tokens}
            onSelect={setTokenB}
            onAddCustom={onAddCustomToken}
            chainId={network.id}
          />
        </div>
      </div>

      {/* ── fee tier ───────────────────────────────────────────────────── */}
      <div className="mb-4">
        <p className="mb-2 text-xs font-medium text-pcs-textDim">Fee Tier</p>
        <div className="grid grid-cols-4 gap-2">
          {FEE_TIERS.map(ft => (
            <button
              key={ft.value}
              type="button"
              className={`rounded-xl py-2 text-xs font-semibold transition ${feeTier === ft.value ? "btn-neon" : "btn-secondary"}`}
              onClick={() => setFeeTier(ft.value)}
            >
              {ft.label}
            </button>
          ))}
        </div>
      </div>

      {/* ══ ADD MODE ════════════════════════════════════════════════════ */}
      {isAdd && (
        <>
          {/* price range */}
          <div className="mb-4">
            <p className="mb-2 text-xs font-medium text-pcs-textDim">Price Range</p>
            <div className="flex gap-2">
              {RANGE_PRESETS.map((preset, i) => (
                <button
                  key={preset.label}
                  type="button"
                  className={`flex-1 rounded-xl py-2 text-xs font-semibold transition ${
                    !showCustomTicks && rangeIdx === i ? "btn-neon" : "btn-secondary"
                  }`}
                  onClick={() => { setRangeIdx(i); setShowCustomTicks(false); }}
                >
                  {preset.label}
                </button>
              ))}
            </div>

            <button
              type="button"
              className="mt-2 text-xs text-pcs-textDim hover:text-pcs-primary transition"
              onClick={() => setShowCustomTicks(s => !s)}
            >
              {showCustomTicks ? "▼" : "▶"} Custom tick range
            </button>

            {showCustomTicks && (
              <div className="mt-2 grid grid-cols-2 gap-2">
                <div>
                  <label className="mb-1 block text-xs text-pcs-textDim">Tick Lower</label>
                  <input
                    className="input text-xs"
                    type="number"
                    value={customTickLower}
                    onChange={e => setCustomTickLower(Number(e.target.value))}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-pcs-textDim">Tick Upper</label>
                  <input
                    className="input text-xs"
                    type="number"
                    value={customTickUpper}
                    onChange={e => setCustomTickUpper(Number(e.target.value))}
                  />
                </div>
              </div>
            )}
          </div>

          {/* deposit amounts */}
          <div className="space-y-3 mb-4">
            <div className="rounded-2xl p-4" style={box}>
              <p className="text-xs font-medium text-pcs-textDim mb-2">
                {tokenA?.symbol ?? "Token A"} Amount
              </p>
              <input
                type="number"
                className="w-full bg-transparent text-xl font-semibold text-pcs-text outline-none placeholder:text-pcs-textDim"
                placeholder="0.0"
                value={amountA}
                onChange={e => setAmountA(e.target.value)}
              />
            </div>
            <div className="rounded-2xl p-4" style={box}>
              <p className="text-xs font-medium text-pcs-textDim mb-2">
                {tokenB?.symbol ?? "Token B"} Amount
              </p>
              <input
                type="number"
                className="w-full bg-transparent text-xl font-semibold text-pcs-text outline-none placeholder:text-pcs-textDim"
                placeholder="0.0"
                value={amountB}
                onChange={e => setAmountB(e.target.value)}
              />
            </div>
          </div>

          {/* approval buttons */}
          <div className="space-y-2">
            {needsApprovalA && tokenA && amountA && (
              <button
                className="btn-secondary w-full py-3 text-base"
                disabled={approvingA}
                onClick={handleApproveA}
              >
                {approvingA ? "Approving..." : `Approve ${tokenA.symbol}`}
              </button>
            )}
            {needsApprovalB && tokenB && amountB && (
              <button
                className="btn-secondary w-full py-3 text-base"
                disabled={approvingB}
                onClick={handleApproveB}
              >
                {approvingB ? "Approving..." : `Approve ${tokenB.symbol}`}
              </button>
            )}
          </div>
        </>
      )}

      {/* ══ REMOVE MODE ═════════════════════════════════════════════════ */}
      {!isAdd && (
        <div className="space-y-3">
          {/* position ID input */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-pcs-textDim">
              Position Token ID
            </label>
            <div className="flex gap-2">
              <input
                className="input flex-1 text-sm"
                placeholder="Your position NFT token ID"
                value={tokenId}
                onChange={e => { setTokenId(e.target.value); setPositionLiquidity(null); }}
              />
              <button
                type="button"
                className="btn-secondary px-4 text-sm"
                disabled={!tokenId || positionFetching}
                onClick={fetchPosition}
              >
                {positionFetching ? "..." : "Fetch"}
              </button>
            </div>
          </div>

          {/* position info */}
          {positionLiquidity !== null && (
            <div className="rounded-2xl p-3" style={box}>
              <p className="text-xs text-pcs-textDim mb-1">Position Liquidity</p>
              <p className="font-mono text-sm text-pcs-text break-all">{positionLiquidity.toString()}</p>
            </div>
          )}

          {/* percentage slider */}
          {positionLiquidity !== null && (
            <div className="rounded-2xl p-4 space-y-3" style={box}>
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-pcs-textDim">Amount to Remove</span>
                <span className="text-lg font-bold text-pcs-text">{removePercent}%</span>
              </div>
              <input
                type="range"
                min={1}
                max={100}
                value={removePercent}
                onChange={e => setRemovePercent(Number(e.target.value))}
                className="w-full accent-pcs-primary"
              />
              <div className="flex gap-2">
                {[25, 50, 75, 100].map(p => (
                  <button
                    key={p}
                    type="button"
                    className={`flex-1 rounded-xl py-1.5 text-xs font-semibold transition ${
                      removePercent === p ? "btn-neon" : "btn-secondary"
                    }`}
                    onClick={() => setRemovePercent(p)}
                  >
                    {p === 100 ? "MAX" : `${p}%`}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── submit button ───────────────────────────────────────────────── */}
      <button
        className="btn-neon mt-5 w-full py-3 text-base"
        disabled={!canSubmit || loading}
        onClick={submit}
      >
        {loading
          ? "Processing..."
          : !isConnected
            ? "Connect Wallet"
            : chainMismatch
              ? "Wrong Network"
              : !tokenA || !tokenB
                ? "Select Tokens"
                : tokenA.address === tokenB.address
                  ? "Select Different Tokens"
                  : isAdd && !amountA && !amountB
                    ? "Enter Amounts"
                    : !isAdd && !tokenId
                      ? "Enter Position ID"
                      : !isAdd && positionLiquidity === null
                        ? "Fetch Position First"
                        : isAdd
                          ? "Supply"
                          : "Remove Liquidity"}
      </button>
    </div>
  );
}
