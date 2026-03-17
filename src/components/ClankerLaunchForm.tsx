import { useRef, useState } from "react";
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
  const cancelledRef = useRef(false);

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

    cancelledRef.current = false;
    setLaunched(null);
    setSubmitting(true);
    const toastId = "hyde-launch";
    const MAX_ATTEMPTS = 3;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (cancelledRef.current) break;
      try {
        // 1. Predict the token address (factory CREATE nonce) — fetch fresh each attempt
        // NOTE: blockTag 'pending' accounts for in-flight factory txs; doesn't solve
        // concurrent user launches (requires contract-level CREATE2 to fix fully).
        const nonce = await publicClient.getTransactionCount({ address: factoryAddress, blockTag: 'pending' });
        const predictedToken = getContractAddress({ from: factoryAddress, nonce: BigInt(nonce) });

        // 2. Get pool tick params for that predicted address
        // WARNING: if nonce prediction is wrong (concurrent launch), sqrtPriceX96 is
        // computed for the wrong address — pool could be seeded with inverted price.
        // Full fix requires CREATE2 + factory view function; deferred to contract level.
        const [sqrtPriceX96, tickLower, tickUpper] = await publicClient.readContract({
          address: factoryAddress,
          abi: hydeTokenFactoryAbi,
          functionName: "computeDefaultParams",
          args: [predictedToken],
        }) as [bigint, number, number];

        if (cancelledRef.current) break;

        // 3. Launch the token
        toast.loading(attempt > 0 ? `Retrying… (attempt ${attempt + 1})` : "Confirm in wallet…", { id: toastId });
        const hash = await writeContractAsync({
          address: factoryAddress,
          abi: hydeTokenFactoryAbi,
          functionName: "launchToken",
          args: [name.trim(), symbol.trim(), sqrtPriceX96, tickLower, tickUpper, address],
          chainId: OPTIMISM_ID,
        });

        toast.loading("Transaction submitted…", { id: toastId });
        const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });

        if (receipt.status === 'reverted') {
          // Contract revert — don't retry, it'll fail the same way
          toast.error("Transaction reverted on-chain — check contract state and try again", { id: toastId });
          break;
        }

        // 4. Parse token address from TokenLaunched event
        let tokenAddress = predictedToken as string;
        let eventFound = false;
        for (const log of receipt.logs) {
          try {
            const decoded = decodeEventLog({
              abi: hydeTokenFactoryAbi,
              data: log.data,
              topics: log.topics,
            });
            if (decoded.eventName === "TokenLaunched") {
              tokenAddress = (decoded.args as { token: string }).token;
              eventFound = true;
              break;
            }
          } catch { /* skip non-matching logs */ }
        }
        if (!eventFound) {
          console.warn('[HydeSwap] TokenLaunched event not found in receipt — falling back to predicted address');
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
        // Timeout — don't retry, the original tx may still be pending
        const isTimeout = msg.includes("Timed out") || msg.includes("timeout") || msg.includes("TimeoutError");
        if (isTimeout) {
          toast.error("Transaction timed out — check Etherscan for status before retrying.", { id: toastId });
          break;
        }
        if (attempt < MAX_ATTEMPTS - 1) continue; // retry with fresh nonce
        toast.error(msg.length > 120 ? msg.slice(0, 120) + "…" : msg, { id: toastId });
      }
    }

    setSubmitting(false);
  };

  const handleCancel = () => {
    cancelledRef.current = true;
    setSubmitting(false);
    toast.dismiss("hyde-launch");
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
          onChange={(e) => setSymbol(e.target.value.toUpperCase().replace(/\s/g, ''))}
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
      ) : submitting ? (
        <div className="flex flex-col gap-2">
          <button
            className="w-full rounded-xl py-3 text-sm font-semibold transition disabled:opacity-50"
            style={{ background: "rgba(0,212,255,0.15)", color: "#00d4ff" }}
            disabled
          >
            Launching…
          </button>
          <button
            className="w-full text-xs text-pcs-textDim hover:text-pcs-text transition"
            onClick={handleCancel}
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          className="w-full rounded-xl py-3 text-sm font-semibold transition disabled:opacity-50"
          style={{ background: "#00d4ff", color: "#0d1220" }}
          onClick={handleLaunch}
          disabled={!name.trim() || !symbol.trim()}
        >
          Launch Token
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
