import { useState } from "react";
import toast from "react-hot-toast";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import type { NetworkConfig, TokenInfo } from "../utils/constants";
import { V4_CONTRACTS_BY_CHAIN, v4PositionManagerAbi } from "../utils/constants";
import { buildAddLiquidityTemplatePayload, buildRemoveLiquidityTemplatePayload } from "../utils/v4Encoding";
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
      toast.loading(mode === "add" ? "Submitting add-liquidity..." : "Submitting remove-liquidity...", { id: "v4-liq" });
      const hash = await walletClient.writeContract({
        address: contracts.positionManager,
        abi: v4PositionManagerAbi,
        functionName: "multicall",
        args: [payload, deadline],
        account: address,
        chain: walletClient.chain
      });
      await publicClient.waitForTransactionReceipt({ hash });
      toast.success(mode === "add" ? "Liquidity added (V4)" : "Liquidity removed (V4)", { id: "v4-liq" });
    } catch {
      toast.error("V4 liquidity tx failed. Check multicall bytes payload.", { id: "v4-liq" });
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
      if (mode === "add") {
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

  return (
    <div className="card">
      <h2 className="mb-2 text-lg font-bold text-brand-blue">{mode === "add" ? "Add Liquidity (V4)" : "Remove Liquidity (V4)"}</h2>
      <p className="mb-4 text-xs text-neutral-100">
        Keep the simple V1 look while executing through V4 Position Manager multicall.
      </p>

      <div className="grid gap-4 md:grid-cols-2">
        <TokenSelector
          label="Token A"
          selected={tokenA}
          tokens={tokens}
          onSelect={setTokenA}
          onAddCustom={onAddCustomToken}
        />
        <TokenSelector
          label="Token B"
          selected={tokenB}
          tokens={tokens}
          onSelect={setTokenB}
          onAddCustom={onAddCustomToken}
        />
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs font-semibold text-neutral-100">Fee Tier</label>
          <input className="input" value={feeTier} onChange={(e) => setFeeTier(e.target.value)} />
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold text-neutral-100">Deadline (minutes)</label>
          <input className="input" value={deadlineMins} onChange={(e) => setDeadlineMins(e.target.value)} />
        </div>
      </div>

      {mode === "add" ? (
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs font-semibold text-neutral-100">Tick Lower</label>
            <input className="input" value={tickLower} onChange={(e) => setTickLower(e.target.value)} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-neutral-100">Tick Upper</label>
            <input className="input" value={tickUpper} onChange={(e) => setTickUpper(e.target.value)} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-neutral-100">Amount0 Desired</label>
            <input className="input" value={amount0Desired} onChange={(e) => setAmount0Desired(e.target.value)} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-neutral-100">Amount1 Desired</label>
            <input className="input" value={amount1Desired} onChange={(e) => setAmount1Desired(e.target.value)} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-neutral-100">Amount0 Min</label>
            <input className="input" value={amount0Min} onChange={(e) => setAmount0Min(e.target.value)} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-neutral-100">Amount1 Min</label>
            <input className="input" value={amount1Min} onChange={(e) => setAmount1Min(e.target.value)} />
          </div>
        </div>
      ) : (
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs font-semibold text-neutral-100">Position Token ID</label>
            <input className="input" value={tokenId} onChange={(e) => setTokenId(e.target.value)} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-neutral-100">Liquidity (raw uint128)</label>
            <input className="input" value={liquidityRaw} onChange={(e) => setLiquidityRaw(e.target.value)} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-neutral-100">Amount0 Min</label>
            <input className="input" value={amount0Min} onChange={(e) => setAmount0Min(e.target.value)} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-neutral-100">Amount1 Min</label>
            <input className="input" value={amount1Min} onChange={(e) => setAmount1Min(e.target.value)} />
          </div>
        </div>
      )}

      <div className="mt-4 rounded-xl border border-cyber-tealDeep bg-cyber-navy p-3">
        <p className="mb-2 text-xs font-semibold text-brand-blue">Position Manager Multicall Data</p>
        <button type="button" className="btn-secondary mb-3 w-full" onClick={autoBuildMulticall}>
          Auto Build Multicall
        </button>
        <textarea
          className="input min-h-24 resize-y"
          value={multicallDataJson}
          onChange={(e) => setMulticallDataJson(e.target.value)}
          placeholder='["0x...", "0x..."]'
        />
        <p className="mt-2 text-xs text-neutral-100">
          Uses `V4_ENCODING_TEMPLATES` in `src/utils/constants.ts`. Update those templates to match your deployed V4 periphery.
        </p>
      </div>

      <button className="btn-primary mt-4 w-full py-3" disabled={loading} onClick={submit}>
        {loading ? "Processing..." : chainMismatch ? "Switch Network" : mode === "add" ? "Supply" : "Remove"}
      </button>
    </div>
  );
}
