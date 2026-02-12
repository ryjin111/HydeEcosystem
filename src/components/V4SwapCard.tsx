import { useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { formatUnits, parseUnits } from "viem";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
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

  const chainMismatch = isConnected && chainId !== network.id;

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

  return (
    <div className="card">
      <h2 className="mb-2 text-lg font-bold text-brand-blue">Swap (V4)</h2>
      <p className="mb-4 text-xs text-neutral-100">Classic swap UI with V4 execution under the hood.</p>

      <div className="grid gap-3 md:grid-cols-2">
        <TokenSelector
          label="From Token"
          selected={tokenIn}
          tokens={tokens}
          onSelect={setTokenIn}
          onAddCustom={onAddCustomToken}
        />
        <TokenSelector
          label="To Token"
          selected={tokenOut}
          tokens={tokens}
          onSelect={setTokenOut}
          onAddCustom={onAddCustomToken}
        />
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs font-semibold text-neutral-100">Amount In</label>
          <input className="input" value={amountIn} onChange={(e) => setAmountIn(e.target.value)} placeholder="0.0" />
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold text-neutral-100">Fee Tier</label>
          <input className="input" value={feeTier} onChange={(e) => setFeeTier(e.target.value)} placeholder="3000" />
        </div>
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs font-semibold text-neutral-100">Slippage (%)</label>
          <input className="input" value={slippage} onChange={(e) => setSlippage(e.target.value)} placeholder="0.50" />
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold text-neutral-100">Quoted Amount Out</label>
          <input className="input" value={quotedOut} readOnly placeholder="0.0" />
        </div>
      </div>

      <details className="mt-4 rounded-xl border border-cyber-tealDeep bg-cyber-navy p-3">
        <summary className="cursor-pointer text-sm font-semibold text-brand-blue">Advanced Router Payload</summary>
        <div className="mt-3">
          <button type="button" className="btn-secondary mb-3 w-full" onClick={autoBuildPayload}>
            Auto Build Payload
          </button>
          <label className="mb-1 block text-xs font-semibold text-neutral-100">Commands (hex bytes)</label>
          <input
            className="input mb-2"
            value={commandsHex}
            onChange={(e) => setCommandsHex(e.target.value.trim())}
            placeholder="0x..."
          />
          <label className="mb-1 block text-xs font-semibold text-neutral-100">Inputs (JSON bytes[])</label>
          <textarea
            className="input min-h-24 resize-y"
            value={inputsJson}
            onChange={(e) => setInputsJson(e.target.value)}
            placeholder='["0x...", "0x..."]'
          />
        </div>
      </details>

      <div className="mt-4">
        <label className="mb-1 block text-xs font-semibold text-neutral-100">Deadline (minutes)</label>
        <input className="input" value={deadlineMins} onChange={(e) => setDeadlineMins(e.target.value)} />
      </div>

      <button className="btn-primary mt-4 w-full py-3" disabled={!canSwap || submitting} onClick={executeSwap}>
        {submitting ? "Processing..." : chainMismatch ? "Switch Network" : "Swap"}
      </button>
    </div>
  );
}
