import { useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { formatUnits, parseUnits } from "viem";
import { useAccount, useBalance, usePublicClient, useWalletClient } from "wagmi";
import type { NetworkConfig, TokenInfo } from "../utils/constants";
import { V4_CONTRACTS_BY_CHAIN, universalRouterAbi, v4QuoterAbi } from "../utils/constants";
import { buildSwapTemplatePayload } from "../utils/v4Encoding";
import { TokenSelector } from "./TokenSelector";

type V4SwapCardProps = {
  network: NetworkConfig;
  tokens: TokenInfo[];
  onAddCustomToken: (token: {
    address: `0x${string}`;
    symbol: string;
    name: string;
    decimals: number;
  }) => void;
};

export function V4SwapCard({ network, tokens, onAddCustomToken }: V4SwapCardProps) {
  const { address, chainId, isConnected } = useAccount();
  const publicClient = usePublicClient({ chainId: network.id });
  const { data: walletClient } = useWalletClient({ chainId: network.id });
  const contracts = V4_CONTRACTS_BY_CHAIN[network.id];

  const [tokenIn, setTokenIn] = useState<TokenInfo | undefined>(tokens[0]);
  const [tokenOut, setTokenOut] = useState<TokenInfo | undefined>(tokens[1]);
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

  const { data: tokenInBalance } = useBalance({
    address,
    token: tokenIn?.address as `0x${string}` | undefined,
    chainId: network.id,
    query: { enabled: Boolean(address && tokenIn) },
  });

  useEffect(() => {
    setTokenIn(tokens[0]);
    setTokenOut(tokens[1]);
  }, [tokens]);

  useEffect(() => {
    const quote = async () => {
      if (!publicClient || !tokenIn || !tokenOut || !amountIn || Number(amountIn) <= 0) {
        setQuotedOut("");
        return;
      }
      try {
        const amountParsed = parseUnits(amountIn, tokenIn.decimals);
        const out = await publicClient.readContract({
          address: contracts.quoter,
          abi: v4QuoterAbi,
          functionName: "quoteExactInputSingle",
          args: [tokenIn.address, tokenOut.address, amountParsed, Number(feeTier), 0n]
        });
        setQuotedOut(formatUnits(out as bigint, tokenOut.decimals));
      } catch {
        setQuotedOut("");
      }
    };
    void quote();
  }, [publicClient, contracts.quoter, tokenIn, tokenOut, amountIn, feeTier]);

  const canSwap = useMemo(() => {
    return Boolean(
      isConnected &&
        !chainMismatch &&
        tokenIn &&
        tokenOut &&
        tokenIn.address !== tokenOut.address &&
        amountIn &&
        commandsHex.startsWith("0x")
    );
  }, [isConnected, chainMismatch, tokenIn, tokenOut, amountIn, commandsHex]);

  const executeSwap = async () => {
    if (!walletClient || !publicClient || !address || !canSwap) {
      toast.error("Invalid swap input");
      return;
    }
    try {
      setSubmitting(true);
      const decodedInputs = JSON.parse(inputsJson) as `0x${string}`[];
      const deadline = BigInt(Math.floor(Date.now() / 1000) + Number(deadlineMins) * 60);

      toast.loading("Sending V4 swap...", { id: "v4-swap" });
      const hash = await walletClient.writeContract({
        address: contracts.universalRouter,
        abi: universalRouterAbi,
        functionName: "execute",
        args: [commandsHex as `0x${string}`, decodedInputs, deadline],
        account: address,
        chain: walletClient.chain
      });
      await publicClient.waitForTransactionReceipt({ hash });
      toast.success("V4 swap executed", { id: "v4-swap" });
    } catch {
      toast.error("V4 swap failed. Check commands/inputs encoding.", { id: "v4-swap" });
    } finally {
      setSubmitting(false);
    }
  };

  const autoBuildPayload = () => {
    if (!address || !tokenIn || !tokenOut || !amountIn) {
      toast.error("Fill token + amount fields first");
      return;
    }
    try {
      const built = buildSwapTemplatePayload({
        tokenIn: tokenIn.address,
        tokenOut: tokenOut.address,
        fee: Number(feeTier),
        recipient: address,
        amountIn,
        amountOutQuoted: quotedOut || "0",
        slippagePercent: slippage,
        decimalsIn: tokenIn.decimals,
        decimalsOut: tokenOut.decimals
      });
      setCommandsHex(built.commands);
      setInputsJson(JSON.stringify(built.inputs, null, 2));
      toast.success("Payload auto-built");
    } catch {
      toast.error("Failed to auto-build payload");
    }
  };

  const swapTokenDirection = () => {
    setTokenIn(tokenOut);
    setTokenOut(tokenIn);
    setAmountIn(quotedOut);
    setQuotedOut("");
  };

  return (
    <div className="card">
      {/* Card header - PCS v1 style with title + icons */}
      <div className="mb-5 flex items-start justify-between">
        <div>
          <h2 className="text-lg font-bold text-pcs-text">Exchange</h2>
          <p className="mt-0.5 text-xs text-pcs-textDim">Trade tokens in an instant</p>
        </div>
        <div className="flex items-center gap-1">
          {/* Settings icon */}
          <button
            type="button"
            onClick={() => setShowSettings((s) => !s)}
            className={`rounded-lg p-2 transition ${showSettings ? 'text-pcs-primary bg-pcs-primary/10' : 'text-pcs-textDim hover:text-pcs-primary'}`}
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 6h9.75M10.5 6a1.5 1.5 0 11-3 0m3 0a1.5 1.5 0 10-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-9.75 0h9.75" />
            </svg>
          </button>
          {/* History icon */}
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

      {/* Settings panel */}
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
                  style={{ border: '1px solid rgba(0, 212, 255, 0.1)' }}
                  value={slippage}
                  onChange={(e) => setSlippage(e.target.value)}
                />
                <span className="text-xs text-pcs-textDim">%</span>
              </div>
            </div>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-pcs-textSub">Tx Deadline</span>
            <div className="flex items-center gap-1">
              <input
                className="w-14 rounded-lg border-0 bg-pcs-input px-2 py-1 text-right text-xs text-pcs-text outline-none"
                style={{ border: '1px solid rgba(0, 212, 255, 0.1)' }}
                value={deadlineMins}
                onChange={(e) => setDeadlineMins(e.target.value)}
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
              onChange={(e) => setFeeTier(e.target.value)}
              placeholder="3000"
            />
          </div>
        </div>
      )}

      {/* From token - PCS v1 style input row */}
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

      {/* Swap direction arrow — sits in its own row, no box overlap */}
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

      {/* To token */}
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

      {/* Price info */}
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

      {/* Advanced Router Payload */}
      <details className="mt-4 rounded-2xl" style={{ background: 'rgba(0, 212, 255, 0.02)', border: '1px solid rgba(0, 212, 255, 0.06)' }}>
        <summary className="cursor-pointer px-4 py-3 text-xs font-medium text-pcs-textDim hover:text-pcs-primary transition">
          Advanced Router Payload
        </summary>
        <div className="px-4 pb-4 pt-1 space-y-3" style={{ borderTop: '1px solid rgba(0, 212, 255, 0.04)' }}>
          <button type="button" className="btn-secondary w-full py-2 text-xs" onClick={autoBuildPayload}>
            Auto Build Payload
          </button>
          <div>
            <label className="mb-1 block text-[11px] font-medium text-pcs-textDim">Commands (hex)</label>
            <input
              className="input text-xs"
              value={commandsHex}
              onChange={(e) => setCommandsHex(e.target.value.trim())}
              placeholder="0x..."
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-medium text-pcs-textDim">Inputs (JSON bytes[])</label>
            <textarea
              className="input min-h-16 resize-y text-xs"
              value={inputsJson}
              onChange={(e) => setInputsJson(e.target.value)}
              placeholder='["0x...", "0x..."]'
            />
          </div>
        </div>
      </details>

      {/* Swap button */}
      <button
        className="btn-neon mt-5 w-full py-3 text-base"
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
                  : !commandsHex.startsWith("0x")
                    ? "Build Payload First"
                    : "Swap"}
      </button>
    </div>
  );
}
