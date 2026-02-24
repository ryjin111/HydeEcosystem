import { useEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import { formatUnits, parseUnits, zeroAddress } from "viem";
import { useAccount, useBalance, usePublicClient, useWalletClient } from "wagmi";
import { useSearchParams } from "react-router-dom";
import type { NetworkConfig, TokenInfo } from "../utils/constants";
import { V4_CONTRACTS_BY_CHAIN, hydeGatewayAbi, v4QuoterAbi, routerAbi } from "../utils/constants";
import { buildSwapTemplatePayload, feeToTickSpacing } from "../utils/v4Encoding";
import { useApproval } from "../hooks/useApproval";
import { TokenSelector } from "./TokenSelector";

type RoutingMode = "v4" | "v4-hook" | "v2";

type V4SwapCardProps = {
  network: NetworkConfig;
  tokens: TokenInfo[];
  onAddCustomToken: (token: {
    address: `0x${string}`;
    symbol: string;
    name: string;
    decimals: number;
  }) => void;
  forceTokenOut?: string; // lowercase address — set by carousel / external selection
};

export function V4SwapCard({ network, tokens, onAddCustomToken, forceTokenOut }: V4SwapCardProps) {
  const { address, chainId, isConnected } = useAccount();
  const publicClient = usePublicClient({ chainId: network.id });
  const { data: walletClient } = useWalletClient({ chainId: network.id });
  const contracts = V4_CONTRACTS_BY_CHAIN[network.id];

  const [searchParams] = useSearchParams();
  const outParam = searchParams.get("out")?.toLowerCase();

  const [tokenIn, setTokenIn] = useState<TokenInfo | undefined>(tokens[0]);
  const [tokenOut, setTokenOut] = useState<TokenInfo | undefined>(
    outParam ? tokens.find((t) => t.address.toLowerCase() === outParam) ?? tokens[1] : tokens[1]
  );
  const [amountIn, setAmountIn] = useState("");
  const [quotedOut, setQuotedOut] = useState("");
  const [feeTier, setFeeTier] = useState("3000");
  const [slippage, setSlippage] = useState("0.50");
  const [deadlineMins, setDeadlineMins] = useState("20");
  const [commandsHex, setCommandsHex] = useState("");
  const [inputsJson, setInputsJson] = useState("[]");
  const [submitting, setSubmitting] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const chainMismatch = isConnected && chainId !== network.id;

  // Carousel / external token selection
  useEffect(() => {
    if (!forceTokenOut) return;
    const match = tokens.find((t) => t.address.toLowerCase() === forceTokenOut.toLowerCase());
    if (match) setTokenOut(match);
  }, [forceTokenOut, tokens]);

  // Derive routing mode from selected tokens
  const dopplerToken = tokenOut?.dopplerPool ? tokenOut : tokenIn?.dopplerPool ? tokenIn : undefined;
  const routingMode = useMemo((): RoutingMode => {
    if (!dopplerToken) return "v4";
    return dopplerToken.dopplerPool!.type === "v2" ? "v2" : "v4-hook";
  }, [dopplerToken]);
  const hookAddress = routingMode === "v4-hook"
    ? (dopplerToken?.dopplerPool?.hookAddress ?? zeroAddress)
    : zeroAddress;

  const amountInParsed = useMemo(() => {
    try {
      if (!amountIn || !tokenIn) return 0n;
      return parseUnits(amountIn, tokenIn.decimals);
    } catch { return 0n; }
  }, [amountIn, tokenIn]);

  // For Doppler graduated (V2) tokens, use the Doppler-specific router (standard hash, Doppler factory).
  // For other V2 pairs (our own liquidity), use the Hyde router.
  const v2Router = (routingMode === "v2" && dopplerToken && network.dopplerRouter)
    ? network.dopplerRouter
    : network.router;

  // V2 routes approve to the correct router; V4 routes approve to Permit2
  const approvalSpender = routingMode === "v2" ? v2Router : contracts.permit2;
  const { needsApproval, approve: approveToken } = useApproval({
    token: tokenIn?.address,
    spender: approvalSpender,
    amount: amountInParsed,
    chainId: network.id,
    isNative: tokenIn?.isNative,
  });

  const [approving, setApproving] = useState(false);

  const handleApprove = async () => {
    try {
      setApproving(true);
      toast.loading("Approving token...", { id: "approve" });
      await approveToken();
      toast.success("Token approved", { id: "approve" });
    } catch {
      toast.error("Approval failed", { id: "approve" });
    } finally {
      setApproving(false);
    }
  };

  const { data: tokenInBalance } = useBalance({
    address,
    // Omit `token` for native ETH so wagmi reads the native balance
    token: tokenIn?.isNative ? undefined : (tokenIn?.address as `0x${string}` | undefined),
    chainId: network.id,
    query: { enabled: Boolean(address && tokenIn) },
  });

  useEffect(() => {
    setTokenIn((prev) => prev ?? tokens[0]);
    setTokenOut((prev) => {
      if (prev) {
        // Keep existing selection if the token is still in the list; refresh its metadata
        const refreshed = tokens.find((t) => t.address.toLowerCase() === prev.address.toLowerCase());
        return refreshed ?? prev;
      }
      if (outParam) return tokens.find((t) => t.address.toLowerCase() === outParam) ?? tokens[1];
      return tokens[1];
    });
  }, [tokens, outParam]);

  const quoteIdRef = useRef(0);

  useEffect(() => {
    const id = ++quoteIdRef.current;
    const quote = async () => {
      if (!publicClient || !tokenIn || !tokenOut || !amountIn || Number(amountIn) <= 0) {
        setQuotedOut("");
        return;
      }
      try {
        const amountParsed = parseUnits(amountIn, tokenIn.decimals);

        if (routingMode === "v2") {
          // V2 quote via router.getAmountsOut (use dopplerRouter for Doppler graduated tokens)
          const path: `0x${string}`[] = [
            tokenIn.isNative ? network.weth : tokenIn.address,
            tokenOut.isNative ? network.weth : tokenOut.address,
          ];
          const amounts = await publicClient.readContract({
            address: v2Router,
            abi: routerAbi,
            functionName: "getAmountsOut",
            args: [amountParsed, path],
          }) as bigint[];
          if (id !== quoteIdRef.current) return;
          setQuotedOut(formatUnits(amounts[amounts.length - 1], tokenOut.decimals));
          return;
        }

        // V4 quote (normal or hook)
        const zeroForOne = tokenIn.address.toLowerCase() < tokenOut.address.toLowerCase();
        const currency0 = zeroForOne ? tokenIn.address : tokenOut.address;
        const currency1 = zeroForOne ? tokenOut.address : tokenIn.address;
        const result = await publicClient.simulateContract({
          address: contracts.quoter,
          abi: v4QuoterAbi,
          functionName: "quoteExactInputSingle",
          args: [{
            poolKey: {
              currency0,
              currency1,
              fee: Number(feeTier),
              tickSpacing: feeToTickSpacing(Number(feeTier)),
              hooks: hookAddress,
            },
            zeroForOne,
            exactAmount: BigInt(amountParsed),
            hookData: "0x"
          }]
        });
        const [amountOut] = result.result as [bigint, bigint];
        if (id !== quoteIdRef.current) return;
        setQuotedOut(formatUnits(amountOut, tokenOut.decimals));
      } catch {
        if (id !== quoteIdRef.current) return;
        setQuotedOut("");
      }
    };
    void quote();
  }, [publicClient, contracts.quoter, v2Router, network.weth, tokenIn, tokenOut, amountIn, feeTier, routingMode, hookAddress]);

  const canSwap = useMemo(() => {
    const base = Boolean(
      isConnected &&
        !chainMismatch &&
        !needsApproval &&
        tokenIn &&
        tokenOut &&
        tokenIn.address !== tokenOut.address &&
        amountIn &&
        quotedOut &&
        Number(quotedOut) > 0
    );
    if (routingMode === "v2") return base;
    return base && commandsHex.startsWith("0x");
  }, [isConnected, chainMismatch, needsApproval, tokenIn, tokenOut, amountIn, quotedOut, commandsHex, routingMode]);

  const executeSwap = async () => {
    if (!walletClient || !publicClient || !address || !canSwap) {
      toast.error("Invalid swap input");
      return;
    }
    // Validate deadline (1–4320 mins)
    const deadlineMinsNum = Number(deadlineMins);
    if (!Number.isFinite(deadlineMinsNum) || deadlineMinsNum < 1 || deadlineMinsNum > 4320) {
      toast.error("Deadline must be between 1 and 4320 minutes");
      return;
    }
    // Validate slippage (0–50%)
    const slippageNum = Number(slippage);
    if (!Number.isFinite(slippageNum) || slippageNum < 0 || slippageNum > 50) {
      toast.error("Slippage must be between 0% and 50%");
      return;
    }
    const toastId = routingMode === "v2" ? "v2-swap" : "v4-swap";
    try {
      setSubmitting(true);
      const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineMinsNum * 60);

      if (routingMode === "v2") {
        const slippageBps = BigInt(Math.min(Math.floor(slippageNum * 100), 5000));
        const amountInParsed = parseUnits(amountIn, tokenIn!.decimals);
        const quotedOutParsed = parseUnits(quotedOut, tokenOut!.decimals);
        const amountOutMin = (quotedOutParsed * (10000n - slippageBps)) / 10000n;
        const path: `0x${string}`[] = [
          tokenIn!.isNative ? network.weth : tokenIn!.address,
          tokenOut!.isNative ? network.weth : tokenOut!.address,
        ];

        toast.loading("Sending swap...", { id: toastId });
        let hash: `0x${string}`;
        if (tokenIn!.isNative) {
          hash = await walletClient.writeContract({
            address: v2Router,
            abi: routerAbi,
            functionName: "swapExactETHForTokens",
            args: [amountOutMin, path, address, deadline],
            value: amountInParsed,
            account: address,
            chain: walletClient.chain,
          });
        } else if (tokenOut!.isNative) {
          hash = await walletClient.writeContract({
            address: v2Router,
            abi: routerAbi,
            functionName: "swapExactTokensForETH",
            args: [amountInParsed, amountOutMin, path, address, deadline],
            account: address,
            chain: walletClient.chain,
          });
        } else {
          hash = await walletClient.writeContract({
            address: v2Router,
            abi: routerAbi,
            functionName: "swapExactTokensForTokens",
            args: [amountInParsed, amountOutMin, path, address, deadline],
            account: address,
            chain: walletClient.chain,
          });
        }
        await publicClient.waitForTransactionReceipt({ hash });
        toast.success("Swap executed", { id: toastId });
        return;
      }

      // V4 swap via Hyde Gateway
      let decodedInputs: `0x${string}`[];
      try {
        decodedInputs = JSON.parse(inputsJson) as `0x${string}`[];
      } catch {
        toast.error("Invalid swap payload — please try again", { id: toastId });
        setSubmitting(false);
        return;
      }
      toast.loading("Sending swap...", { id: toastId });
      const hash = await walletClient.writeContract({
        address: contracts.gateway,
        abi: hydeGatewayAbi,
        functionName: "executeSwap",
        args: [commandsHex as `0x${string}`, decodedInputs, deadline],
        // Forward ETH when swapping native currency (gateway passes msg.value to UniversalRouter)
        value: tokenIn!.isNative ? amountInParsed : 0n,
        account: address,
        chain: walletClient.chain
      });
      await publicClient.waitForTransactionReceipt({ hash });
      toast.success("Swap executed", { id: toastId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      if (msg.includes("User rejected") || msg.includes("denied")) {
        toast.error("Transaction rejected", { id: toastId });
      } else if (msg.includes("insufficient")) {
        toast.error("Insufficient balance or allowance", { id: toastId });
      } else {
        toast.error(`Swap failed: ${msg.slice(0, 80)}`, { id: toastId });
      }
    } finally {
      setSubmitting(false);
    }
  };

  // Auto-build payload whenever inputs change (V4 only — V2 uses router directly)
  useEffect(() => {
    if (routingMode === "v2") {
      setCommandsHex("");
      setInputsJson("[]");
      return;
    }
    if (!address || !tokenIn || !tokenOut || !amountIn || !quotedOut || Number(quotedOut) <= 0) {
      setCommandsHex("");
      setInputsJson("[]");
      return;
    }
    try {
      const built = buildSwapTemplatePayload({
        tokenIn: tokenIn.isNative ? network.weth : tokenIn.address,
        tokenOut: tokenOut.isNative ? network.weth : tokenOut.address,
        fee: Number(feeTier),
        recipient: address,
        amountIn,
        amountOutQuoted: quotedOut,
        slippagePercent: slippage,
        decimalsIn: tokenIn.decimals,
        decimalsOut: tokenOut.decimals,
        hooks: hookAddress,
      });
      setCommandsHex(built.commands);
      setInputsJson(JSON.stringify(built.inputs, null, 2));
    } catch {
      setCommandsHex("");
      setInputsJson("[]");
    }
  }, [address, tokenIn, tokenOut, amountIn, quotedOut, feeTier, slippage, network.weth, routingMode, hookAddress]);

  const swapTokenDirection = () => {
    setTokenIn(tokenOut);
    setTokenOut(tokenIn);
    setAmountIn(quotedOut);
    setQuotedOut("");
  };

  return (
    <div className="card">
      <div className="mb-5 flex items-start justify-between">
        <div>
          <h2 className="text-lg font-bold text-pcs-text">Exchange</h2>
          <p className="mt-0.5 text-xs text-pcs-textDim">Trade tokens in an instant</p>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setShowSettings((s) => !s)}
            className={`rounded-lg p-2 transition ${showSettings ? 'text-pcs-primary bg-pcs-primary/10' : 'text-pcs-textDim hover:text-pcs-primary'}`}
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 6h9.75M10.5 6a1.5 1.5 0 11-3 0m3 0a1.5 1.5 0 10-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-9.75 0h9.75" />
            </svg>
          </button>
          <button
            type="button"
            className="rounded-lg p-2 text-pcs-textDim hover:text-pcs-primary transition"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </button>
        </div>
      </div>

      {showSettings && (
        <div className="mb-4 rounded-2xl p-4 space-y-3" style={{ background: 'rgba(0, 212, 255, 0.03)', border: '1px solid rgba(0, 212, 255, 0.08)' }}>
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-pcs-textSub">Slippage Tolerance</span>
            <div className="flex items-center gap-1.5">
              {["0.1", "0.5", "1.0"].map((val) => (
                <button
                  key={val}
                  type="button"
                  onClick={() => setSlippage(val)}
                  className={`rounded-lg px-2.5 py-1 text-xs font-medium transition ${
                    slippage === val
                      ? "bg-pcs-primary text-pcs-bg"
                      : "text-pcs-textDim hover:text-pcs-text"
                  }`}
                  style={slippage !== val ? { border: '1px solid rgba(0, 212, 255, 0.1)' } : undefined}
                >
                  {val}%
                </button>
              ))}
              <div className="flex items-center gap-1">
                <input
                  className="w-14 rounded-lg border-0 bg-pcs-input px-2 py-1 text-right text-xs text-pcs-text outline-none"
                  style={{ border: `1px solid ${Number(slippage) > 5 ? 'rgba(255,100,0,0.5)' : 'rgba(0, 212, 255, 0.1)'}` }}
                  value={slippage}
                  onChange={(e) => {
                    const v = e.target.value;
                    // Allow free typing but reject values outside 0-50
                    const n = Number(v);
                    if (v === "" || v === "." || (Number.isFinite(n) && n >= 0 && n <= 50)) setSlippage(v);
                  }}
                />
                <span className="text-xs text-pcs-textDim">%</span>
              </div>
              {Number(slippage) > 5 && (
                <span className="w-full text-right text-[10px] text-orange-400">High slippage — you may lose funds</span>
              )}
            </div>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-pcs-textSub">Tx Deadline</span>
            <div className="flex items-center gap-1">
              <input
                className="w-14 rounded-lg border-0 bg-pcs-input px-2 py-1 text-right text-xs text-pcs-text outline-none"
                style={{ border: '1px solid rgba(0, 212, 255, 0.1)' }}
                value={deadlineMins}
                onChange={(e) => {
                  const v = e.target.value;
                  const n = Number(v);
                  if (v === "" || (Number.isFinite(n) && n >= 1 && n <= 4320)) setDeadlineMins(v);
                }}
              />
              <span className="text-xs text-pcs-textDim">min</span>
            </div>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-pcs-textSub">Fee Tier</span>
            <input
              className="w-20 rounded-lg border-0 bg-pcs-input px-2 py-1 text-right text-xs text-pcs-text outline-none"
              style={{ border: '1px solid rgba(0, 212, 255, 0.1)' }}
              value={feeTier}
              onChange={(e) => { if (/^\d*$/.test(e.target.value)) setFeeTier(e.target.value); }}
              placeholder="3000"
            />
          </div>
        </div>
      )}

      <div className="rounded-2xl p-4 overflow-hidden" style={{ background: 'rgba(0, 212, 255, 0.03)', border: '1px solid rgba(0, 212, 255, 0.06)' }}>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-medium text-pcs-textDim">From</span>
          {tokenInBalance && address && (
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-pcs-textDim">
                Balance: {Number(tokenInBalance.formatted).toLocaleString(undefined, { maximumFractionDigits: 4 })} {tokenIn?.symbol}
              </span>
              <button
                type="button"
                className="rounded-md px-1.5 py-0.5 text-[10px] font-bold text-pcs-primary transition hover:bg-pcs-primary/10"
                onClick={() => setAmountIn(tokenInBalance.formatted)}
              >
                MAX
              </button>
            </div>
          )}
        </div>
        <div className="flex items-center gap-3">
          <input
            className="min-w-0 flex-1 bg-transparent text-2xl font-semibold text-pcs-text outline-none placeholder:text-pcs-textDim"
            value={amountIn}
            onChange={(e) => setAmountIn(e.target.value)}
            placeholder="0.0"
            inputMode="decimal"
          />
          <TokenSelector
            label="From Token"
            selected={tokenIn}
            tokens={tokens}
            onSelect={setTokenIn}
            onAddCustom={onAddCustomToken}
            chainId={network.id}
          />
        </div>
      </div>

      <div className="flex justify-center py-1">
        <button
          type="button"
          onClick={swapTokenDirection}
          className="rounded-xl border-4 p-1.5 text-pcs-primary hover:text-pcs-bg hover:bg-pcs-primary hover:shadow-neon transition"
          style={{ borderColor: '#111827', background: '#1a2236' }}
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 13.5L12 21m0 0l-7.5-7.5M12 21V3" />
          </svg>
        </button>
      </div>

      <div className="rounded-2xl p-4 overflow-hidden" style={{ background: 'rgba(0, 212, 255, 0.03)', border: '1px solid rgba(0, 212, 255, 0.06)' }}>
        <div className="mb-2 text-xs font-medium text-pcs-textDim">To (estimated)</div>
        <div className="flex items-center gap-3">
          <input
            className="min-w-0 flex-1 bg-transparent text-2xl font-semibold text-pcs-text outline-none placeholder:text-pcs-textDim"
            value={quotedOut}
            readOnly
            placeholder="0.0"
          />
          <TokenSelector
            label="To Token"
            selected={tokenOut}
            tokens={tokens}
            onSelect={setTokenOut}
            onAddCustom={onAddCustomToken}
            chainId={network.id}
          />
        </div>
      </div>

      {tokenIn && tokenOut && quotedOut && Number(quotedOut) > 0 && (
        <div className="mt-3 px-1 space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span className="text-pcs-textDim">Price</span>
            <span className="text-pcs-textSub">
              1 {tokenIn.symbol} = {(Number(quotedOut) / Number(amountIn)).toFixed(6)} {tokenOut.symbol}
            </span>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-pcs-textDim">Slippage Tolerance</span>
            <span className="text-pcs-textSub">{slippage}%</span>
          </div>
        </div>
      )}

      <div className="mt-5 space-y-2">
        {needsApproval && tokenIn && amountIn && (
          <button
            className="btn-secondary w-full py-3 text-base"
            disabled={approving}
            onClick={handleApprove}
          >
            {approving ? "Approving..." : `Approve ${tokenIn.symbol}`}
          </button>
        )}
        <button
          className="btn-neon w-full py-3 text-base"
          disabled={!canSwap || submitting}
          onClick={executeSwap}
        >
          {submitting
            ? "Swapping..."
            : !isConnected
              ? "Connect Wallet"
              : chainMismatch
                ? "Wrong Network"
                : !tokenIn || !tokenOut
                  ? "Select Tokens"
                  : !amountIn
                    ? "Enter Amount"
                    : needsApproval
                      ? "Approve First"
                      : !quotedOut || Number(quotedOut) <= 0
                        ? "No Quote"
                        : "Swap"}
        </button>
      </div>
    </div>
  );
}
