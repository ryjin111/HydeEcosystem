import { useState } from "react";
import { getContractAddress, decodeEventLog } from "viem";
import { useAccount, usePublicClient, useSwitchChain, useWriteContract } from "wagmi";
import toast from "react-hot-toast";
import { hydeTokenFactoryAbi, V4_CONTRACTS_BY_CHAIN } from "../utils/constants";

const OPTIMISM_ID = 10;

/* ─── helpers ──────────────────────────────────────────────────────────────── */

/* ─── component ────────────────────────────────────────────────────────────── */

export function ClankerLaunchForm() {
  const { address, chainId, isConnected } = useAccount();
  const publicClient  = usePublicClient({ chainId: OPTIMISM_ID });
  const { switchChain } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();

  const [name,         setName]         = useState("");
  const [symbol,       setSymbol]       = useState("");
  const [submitting,   setSubmitting]   = useState(false);
  const [launched,     setLaunched]     = useState<{ token: string; tx: string } | null>(null);

  const chainMismatch = isConnected && chainId !== OPTIMISM_ID;
  const factoryAddress = V4_CONTRACTS_BY_CHAIN[OPTIMISM_ID]?.hydeTokenFactory;

  const handleLaunch = async () => {
    if (!address || !publicClient) return;
    if (!factoryAddress) {
      toast.error("Factory not configured for this network");
      return;
    }
    if (!name.trim() || !symbol.trim()) {
      toast.error("Token name and symbol are required");
      return;
    }

    setSubmitting(true);
    const toastId = "hyde-launch";
    const MAX_ATTEMPTS = 3;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        // 1. Predict the token address (factory CREATE nonce) — fetch fresh each attempt
        const nonce = await publicClient.getTransactionCount({ address: factoryAddress });
        const predictedToken = getContractAddress({ from: factoryAddress, nonce: BigInt(nonce) });

        // 2. Get pool tick params for that predicted address
        const [sqrtPriceX96, tickLower, tickUpper] = await publicClient.readContract({
          address: factoryAddress,
          abi: hydeTokenFactoryAbi,
          functionName: "computeDefaultParams",
          args: [predictedToken],
        });

        // 3. Launch the token
        toast.loading(attempt > 0 ? `Retrying… (attempt ${attempt + 1})` : "Confirm in wallet…", { id: toastId });
        const hash = await writeContractAsync({
          address: factoryAddress,
          abi: hydeTokenFactoryAbi,
          functionName: "launchToken",
          args: [name.trim(), symbol.trim().toUpperCase(), sqrtPriceX96, tickLower, tickUpper, address],
          chainId: OPTIMISM_ID,
        });

        toast.loading("Transaction submitted…", { id: toastId });
        const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });

        if (receipt.status === 'reverted') {
          throw new Error('Transaction reverted on-chain — check contract state and try again');
        }

        // 4. Parse token address from TokenLaunched event
        let tokenAddress = predictedToken as string;
        for (const log of receipt.logs) {
          try {
            const decoded = decodeEventLog({
              abi: hydeTokenFactoryAbi,
              data: log.data,
              topics: log.topics,
            });
            if (decoded.eventName === "TokenLaunched") {
              tokenAddress = (decoded.args as { token: string }).token;
              break;
            }
          } catch { /* skip non-matching logs */ }
        }

        toast.success("Token launched!", { id: toastId, duration: 8000 });
        setLaunched({ token: tokenAddress, tx: hash });
        setName("");
        setSymbol("");
        break; // success — exit retry loop
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        const code = (err as { code?: number; cause?: { code?: number } })?.code
          ?? (err as { cause?: { code?: number } })?.cause?.code;
        const userCancelled = code === 4001
          || msg.includes("User rejected") || msg.includes("user rejected")
          || msg.includes("User denied")   || msg.includes("Request rejected");
        if (userCancelled) {
          toast.error("Transaction cancelled.", { id: toastId });
          break;
        }
        if (attempt < MAX_ATTEMPTS - 1) continue; // retry with fresh nonce
        toast.error(msg.length > 120 ? msg.slice(0, 120) + "…" : msg, { id: toastId });
      }
    }

    setSubmitting(false);
  };

  return (
    <div
      className="w-full max-w-md mx-auto rounded-2xl p-6 flex flex-col gap-5"
      style={{ background: "#0d1220", border: "1px solid rgba(0,212,255,0.10)" }}
    >
      {/* Header */}
      <div>
        <h2 className="text-lg font-bold text-pcs-text">Launch a Token</h2>
        <p className="text-xs text-pcs-textDim mt-1">
          Instant launch on Optimism — earn trading fees from day one.
        </p>
      </div>

      {/* Fee info banner */}
      <div
        className="rounded-xl px-4 py-3 text-xs flex flex-col gap-1"
        style={{ background: "rgba(0,212,255,0.06)", border: "1px solid rgba(0,212,255,0.12)" }}
      >
        <div className="flex justify-between text-pcs-textDim">
          <span>Pool fee</span>
          <span className="text-pcs-text font-medium">5% (+ anti-snipe on launch)</span>
        </div>
        <div className="flex justify-between text-pcs-textDim">
          <span>Creator share</span>
          <span className="text-pcs-text font-medium">60% of fees</span>
        </div>
        <div className="flex justify-between text-pcs-textDim">
          <span>Anti-snipe tax</span>
          <span className="text-pcs-text font-medium">85% → 5% over 10 blocks</span>
        </div>
        <div className="flex justify-between text-pcs-textDim">
          <span>Total supply</span>
          <span className="text-pcs-text font-medium">1,000,000,000</span>
        </div>
        <div className="flex justify-between text-pcs-textDim">
          <span>Initial cost</span>
          <span className="text-pcs-text font-medium">Gas only</span>
        </div>
      </div>

      {/* Name */}
      <div className="flex flex-col gap-1">
        <label className="text-xs text-pcs-textDim">Token Name</label>
        <input
          className="rounded-xl px-4 py-3 text-sm text-pcs-text bg-transparent outline-none"
          style={{ border: "1px solid rgba(0,212,255,0.15)" }}
          placeholder="e.g. HydeToken"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={64}
        />
      </div>

      {/* Symbol */}
      <div className="flex flex-col gap-1">
        <label className="text-xs text-pcs-textDim">Token Symbol</label>
        <input
          className="rounded-xl px-4 py-3 text-sm text-pcs-text bg-transparent outline-none"
          style={{ border: "1px solid rgba(0,212,255,0.15)" }}
          placeholder="e.g. HYDE"
          value={symbol}
          onChange={(e) => setSymbol(e.target.value.toUpperCase())}
          maxLength={10}
        />
      </div>

      {/* Launch button */}
      {!isConnected ? (
        <p className="text-center text-sm text-pcs-textDim">Connect wallet to launch</p>
      ) : chainMismatch ? (
        <button
          className="w-full rounded-xl py-3 text-sm font-semibold transition"
          style={{ background: "rgba(0,212,255,0.15)", color: "#00d4ff" }}
          onClick={() => switchChain({ chainId: OPTIMISM_ID })}
        >
          Switch to Optimism
        </button>
      ) : (
        <button
          className="w-full rounded-xl py-3 text-sm font-semibold transition disabled:opacity-50"
          style={{ background: submitting ? "rgba(0,212,255,0.15)" : "#00d4ff", color: submitting ? "#00d4ff" : "#0d1220" }}
          onClick={handleLaunch}
          disabled={submitting || !name.trim() || !symbol.trim()}
        >
          {submitting ? "Launching…" : "Launch Token"}
        </button>
      )}

      {/* Success */}
      {launched && (
        <div
          className="rounded-xl px-4 py-3 text-xs flex flex-col gap-2"
          style={{ background: "rgba(0,212,255,0.06)", border: "1px solid rgba(0,212,255,0.20)" }}
        >
          <p className="text-pcs-text font-semibold">Token launched!</p>
          {launched.token && (
            <p className="text-pcs-textDim break-all">
              Address:{" "}
              <a
                href={`https://optimistic.etherscan.io/token/${launched.token}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-pcs-primary hover:underline"
              >
                {launched.token}
              </a>
            </p>
          )}
          <a
            href={`https://optimistic.etherscan.io/tx/${launched.tx}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-pcs-primary hover:underline"
          >
            View transaction →
          </a>
        </div>
      )}
    </div>
  );
}
