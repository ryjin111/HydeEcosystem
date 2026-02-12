import { useMemo, useState } from "react";
import toast from "react-hot-toast";
import { parseUnits } from "viem";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import type { NetworkConfig, TokenInfo } from "../utils/constants";
import { V4_CONTRACTS_BY_CHAIN, hydeGatewayAbi } from "../utils/constants";
import { buildAddLiquidityTemplatePayload, buildRemoveLiquidityTemplatePayload } from "../utils/v4Encoding";
import { useApproval } from "../hooks/useApproval";
import { TokenSelector } from "./TokenSelector";

type V4LiquidityCardProps = {
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

export function V4LiquidityCard({ network, tokens, mode, onAddCustomToken }: V4LiquidityCardProps) {
  const { address, chainId, isConnected } = useAccount();
  const publicClient = usePublicClient({ chainId: network.id });
  const { data: walletClient } = useWalletClient({ chainId: network.id });
  const contracts = V4_CONTRACTS_BY_CHAIN[network.id];

  const [tokenA, setTokenA] = useState<TokenInfo | undefined>(tokens[0]);
  const [tokenB, setTokenB] = useState<TokenInfo | undefined>(tokens[1]);
  const [feeTier, setFeeTier] = useState("3000");
  const [tickLower, setTickLower] = useState("-60000");
  const [tickUpper, setTickUpper] = useState("60000");
  const [amount0Desired, setAmount0Desired] = useState("");
  const [amount1Desired, setAmount1Desired] = useState("");
  const [amount0Min, setAmount0Min] = useState("0");
  const [amount1Min, setAmount1Min] = useState("0");
  const [tokenId, setTokenId] = useState("");
  const [liquidityRaw, setLiquidityRaw] = useState("");
  const [deadlineMins, setDeadlineMins] = useState("20");
  const [multicallDataJson, setMulticallDataJson] = useState("[]");
  const [loading, setLoading] = useState(false);

  const chainMismatch = isConnected && chainId !== network.id;
  const isAdd = mode === "add";

  const amount0Parsed = useMemo(() => {
    try {
      if (!amount0Desired || !tokenA) return 0n;
      return parseUnits(amount0Desired, tokenA.decimals);
    } catch { return 0n; }
  }, [amount0Desired, tokenA]);

  const amount1Parsed = useMemo(() => {
    try {
      if (!amount1Desired || !tokenB) return 0n;
      return parseUnits(amount1Desired, tokenB.decimals);
    } catch { return 0n; }
  }, [amount1Desired, tokenB]);

  const { needsApproval: needsApprovalA, approve: approveA } = useApproval({
    token: tokenA?.address,
    spender: contracts.permit2,
    amount: amount0Parsed,
    chainId: network.id,
  });

  const { needsApproval: needsApprovalB, approve: approveB } = useApproval({
    token: tokenB?.address,
    spender: contracts.permit2,
    amount: amount1Parsed,
    chainId: network.id,
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
    } finally {
      setApprovingA(false);
    }
  };

  const handleApproveB = async () => {
    try {
      setApprovingB(true);
      toast.loading(`Approving ${tokenB?.symbol}...`, { id: "approve-b" });
      await approveB();
      toast.success(`${tokenB?.symbol} approved`, { id: "approve-b" });
    } catch {
      toast.error("Approval failed", { id: "approve-b" });
    } finally {
      setApprovingB(false);
    }
  };

  const canSubmit = useMemo(() => {
    if (!isConnected || chainMismatch || !tokenA || !tokenB || tokenA.address === tokenB.address) return false;
    if (isAdd) {
      if (!amount0Desired && !amount1Desired) return false;
      if ((amount0Desired && needsApprovalA) || (amount1Desired && needsApprovalB)) return false;
      return true;
    }
    return Boolean(tokenId && liquidityRaw);
  }, [isConnected, chainMismatch, tokenA, tokenB, isAdd, amount0Desired, amount1Desired, tokenId, liquidityRaw, needsApprovalA, needsApprovalB]);

  const submit = async () => {
    if (!walletClient || !publicClient || !address) {
      toast.error("Connect wallet first");
      return;
    }
    if (chainMismatch) {
      toast.error("Switch network first");
      return;
    }
    if (!tokenA || !tokenB || tokenA.address === tokenB.address) {
      toast.error("Choose valid pair");
      return;
    }
    try {
      setLoading(true);
      const payload = JSON.parse(multicallDataJson) as `0x${string}`[];
      const deadline = BigInt(Math.floor(Date.now() / 1000) + Number(deadlineMins) * 60);
      toast.loading(isAdd ? "Submitting add-liquidity..." : "Submitting remove-liquidity...", { id: "v4-liq" });
      const hash = await walletClient.writeContract({
        address: contracts.gateway,
        abi: hydeGatewayAbi,
        functionName: "executePositionMulticall",
        args: [payload, deadline],
        account: address,
        chain: walletClient.chain
      });
      await publicClient.waitForTransactionReceipt({ hash });
      toast.success(isAdd ? "Liquidity added (V4)" : "Liquidity removed (V4)", { id: "v4-liq" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      if (msg.includes("User rejected") || msg.includes("denied")) {
        toast.error("Transaction rejected", { id: "v4-liq" });
      } else {
        toast.error(`Liquidity tx failed: ${msg.slice(0, 80)}`, { id: "v4-liq" });
      }
    } finally {
      setLoading(false);
    }
  };

  const autoBuildMulticall = () => {
    if (!address || !tokenA || !tokenB) {
      toast.error("Choose pair and connect wallet");
      return;
    }
    try {
      if (isAdd) {
        const payload = buildAddLiquidityTemplatePayload({
          token0: tokenA.address,
          token1: tokenB.address,
          fee: Number(feeTier),
          tickLower: Number(tickLower),
          tickUpper: Number(tickUpper),
          amount0Desired,
          amount1Desired,
          amount0Min,
          amount1Min,
          decimals0: tokenA.decimals,
          decimals1: tokenB.decimals,
          recipient: address
        });
        setMulticallDataJson(JSON.stringify(payload, null, 2));
      } else {
        const payload = buildRemoveLiquidityTemplatePayload({
          tokenId,
          liquidity: liquidityRaw,
          amount0Min,
          amount1Min,
          recipient: address,
          decimals0: tokenA.decimals,
          decimals1: tokenB.decimals
        });
        setMulticallDataJson(JSON.stringify(payload, null, 2));
      }
      toast.success("Multicall template built");
    } catch {
      toast.error("Failed to build template payload");
    }
  };

  const inputBoxStyle = { background: 'rgba(0, 212, 255, 0.03)', border: '1px solid rgba(0, 212, 255, 0.06)' };

  return (
    <div className="card">
      {/* Card header */}
      <div className="mb-5">
        <h2 className="text-lg font-bold text-pcs-text">
          {isAdd ? "Add Liquidity" : "Remove Liquidity"}
        </h2>
        <p className="mt-0.5 text-xs text-pcs-textDim">
          {isAdd ? "Add tokens to a liquidity pool" : "Remove your liquidity position"}
        </p>
      </div>

      {/* Token pair selection */}
      <div className="flex items-center gap-3 mb-4">
        <div className="flex-1 rounded-2xl p-3" style={inputBoxStyle}>
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
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-pcs-primary" style={{ background: 'rgba(0, 212, 255, 0.08)' }}>
          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
        </div>
        <div className="flex-1 rounded-2xl p-3" style={inputBoxStyle}>
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

      {/* Parameters */}
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-pcs-textDim">Fee Tier</label>
            <input className="input text-sm" value={feeTier} onChange={(e) => setFeeTier(e.target.value)} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-pcs-textDim">Deadline (min)</label>
            <input className="input text-sm" value={deadlineMins} onChange={(e) => setDeadlineMins(e.target.value)} />
          </div>
        </div>

        {isAdd ? (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-pcs-textDim">Tick Lower</label>
                <input className="input text-sm" value={tickLower} onChange={(e) => setTickLower(e.target.value)} />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-pcs-textDim">Tick Upper</label>
                <input className="input text-sm" value={tickUpper} onChange={(e) => setTickUpper(e.target.value)} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-pcs-textDim">Amount A</label>
                <input className="input text-sm" value={amount0Desired} onChange={(e) => setAmount0Desired(e.target.value)} placeholder="0.0" />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-pcs-textDim">Amount B</label>
                <input className="input text-sm" value={amount1Desired} onChange={(e) => setAmount1Desired(e.target.value)} placeholder="0.0" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-pcs-textDim">Min A</label>
                <input className="input text-sm" value={amount0Min} onChange={(e) => setAmount0Min(e.target.value)} />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-pcs-textDim">Min B</label>
                <input className="input text-sm" value={amount1Min} onChange={(e) => setAmount1Min(e.target.value)} />
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-pcs-textDim">Position Token ID</label>
                <input className="input text-sm" value={tokenId} onChange={(e) => setTokenId(e.target.value)} placeholder="Token ID" />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-pcs-textDim">Liquidity (uint128)</label>
                <input className="input text-sm" value={liquidityRaw} onChange={(e) => setLiquidityRaw(e.target.value)} placeholder="0" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-pcs-textDim">Min A</label>
                <input className="input text-sm" value={amount0Min} onChange={(e) => setAmount0Min(e.target.value)} />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-pcs-textDim">Min B</label>
                <input className="input text-sm" value={amount1Min} onChange={(e) => setAmount1Min(e.target.value)} />
              </div>
            </div>
          </>
        )}
      </div>

      {/* Advanced Multicall */}
      <details className="mt-4 rounded-2xl" style={{ background: 'rgba(0, 212, 255, 0.02)', border: '1px solid rgba(0, 212, 255, 0.06)' }}>
        <summary className="cursor-pointer px-4 py-3 text-xs font-medium text-pcs-textDim hover:text-pcs-primary transition">
          Position Manager Multicall Data
        </summary>
        <div className="px-4 pb-4 pt-1 space-y-3" style={{ borderTop: '1px solid rgba(0, 212, 255, 0.04)' }}>
          <button type="button" className="btn-secondary w-full py-2 text-xs" onClick={autoBuildMulticall}>
            Auto Build Multicall
          </button>
          <textarea
            className="input min-h-16 resize-y text-xs"
            value={multicallDataJson}
            onChange={(e) => setMulticallDataJson(e.target.value)}
            placeholder='["0x...", "0x..."]'
          />
        </div>
      </details>

      {/* Approval + Submit buttons */}
      <div className="mt-5 space-y-2">
        {isAdd && needsApprovalA && tokenA && amount0Desired && (
          <button
            className="btn-secondary w-full py-3 text-base"
            disabled={approvingA}
            onClick={handleApproveA}
          >
            {approvingA ? "Approving..." : `Approve ${tokenA.symbol}`}
          </button>
        )}
        {isAdd && needsApprovalB && tokenB && amount1Desired && (
          <button
            className="btn-secondary w-full py-3 text-base"
            disabled={approvingB}
            onClick={handleApproveB}
          >
            {approvingB ? "Approving..." : `Approve ${tokenB.symbol}`}
          </button>
        )}
        <button
          className="btn-neon w-full py-3 text-base"
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
                    : isAdd && !amount0Desired && !amount1Desired
                      ? "Enter Amounts"
                      : !isAdd && (!tokenId || !liquidityRaw)
                        ? "Enter Position Details"
                        : isAdd
                          ? "Supply"
                          : "Remove"}
        </button>
      </div>
    </div>
  );
}
