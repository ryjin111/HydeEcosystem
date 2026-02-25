import { useState } from "react";
import { useAccount, usePublicClient, useWalletClient, useSwitchChain, useWriteContract } from "wagmi";
import { unichain } from "viem/chains";
import type { WalletClient } from "viem";
import type { Transport, Chain, Account, PublicClient } from "viem";
import toast from "react-hot-toast";
import { Clanker } from "clanker-sdk/v4";

const UNICHAIN_ID        = 130;
const CLANKER_FACTORY    = "0xE85A59c628F7d27878ACeB4bf3b35733630083a9" as const;
const HYDE_TEAM          = "0x9C076a736D727F33c005145E0DB189Fd58D20110" as const;
const HYDE_ECOSYSTEM     = "0xeb17B8c29717036161936A2179A88fe981B9CB80" as const;

/* ─── helpers ──────────────────────────────────────────────────────────────── */

function toBase64DataUrl(file: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

/* ─── component ────────────────────────────────────────────────────────────── */

export function ClankerLaunchForm() {
  const { address, chainId, isConnected } = useAccount();
  const publicClient  = usePublicClient({ chainId: UNICHAIN_ID });
  const { data: walletClient } = useWalletClient({ chainId: UNICHAIN_ID });
  const { switchChain } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();

  const [name,         setName]         = useState("");
  const [symbol,       setSymbol]       = useState("");
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [submitting,   setSubmitting]   = useState(false);
  const [launched,     setLaunched]     = useState<{ token: string; tx: string } | null>(null);

  const chainMismatch = isConnected && chainId !== UNICHAIN_ID;

  const handleImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const dataUrl = await toBase64DataUrl(file);
    setImagePreview(dataUrl);
  };

  const handleLaunch = async () => {
    if (!address || !publicClient || !walletClient) return;
    if (!name.trim() || !symbol.trim()) {
      toast.error("Token name and symbol are required");
      return;
    }

    setSubmitting(true);
    const toastId = "clanker-launch";
    try {
      const clanker = new Clanker({
        publicClient: publicClient as PublicClient,
        wallet: walletClient as WalletClient<Transport, Chain, Account>,
      });

      const txConfig = await clanker.getDeployTransaction({
        chainId:    UNICHAIN_ID,
        tokenAdmin: address,
        name:       name.trim(),
        symbol:     symbol.trim().toUpperCase(),
        image:      imagePreview ?? "",
        context: { interface: "Hyde" },

        // Static 1% buy / 1% sell fee
        fees: { type: "static", clankerFee: 100, pairedFee: 100 },

        // Standard single position: ~$27K → $1.5B mcap
        pool: {
          pairedToken:           "WETH",
          tickIfToken0IsClanker: -230400,
          tickSpacing:           200,
          positions: [{ tickLower: -230400, tickUpper: -120000, positionBps: 10000 }],
        },

        // Fee split: 60% creator, 30% Hyde team, 10% Hyde ecosystem
        rewards: {
          recipients: [
            { admin: address,        recipient: address,        bps: 6000, token: "Both" },
            { admin: HYDE_TEAM,      recipient: HYDE_TEAM,      bps: 3000, token: "Both" },
            { admin: HYDE_ECOSYSTEM, recipient: HYDE_ECOSYSTEM, bps: 1000, token: "Both" },
          ],
        },
      });

      toast.loading("Confirm in wallet…", { id: toastId });
      const hash = await writeContractAsync({
        ...txConfig,
        chain: unichain,
        account: address,
      } as Parameters<typeof writeContractAsync>[0]);

      toast.loading("Waiting for confirmation…", { id: toastId });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });

      // Extract token address from the factory's TokenCreated event.
      // TokenCreated(address msgSender, address indexed tokenAddress, address indexed tokenAdmin, ...)
      // topic[0] = event sig hash, topic[1] = tokenAddress, topic[2] = tokenAdmin
      const factoryLog = receipt.logs.find(
        (log) => log.address.toLowerCase() === CLANKER_FACTORY.toLowerCase() && log.topics.length >= 2,
      );
      const tokenAddr = (factoryLog?.topics[1]
        ? ("0x" + factoryLog.topics[1].slice(26))
        : null) as `0x${string}` | null;

      toast.success("Token launched!", { id: toastId, duration: 8000 });
      setLaunched({ token: tokenAddr ?? "", tx: hash });
      setName("");
      setSymbol("");
      setImagePreview(null);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("User rejected") || msg.includes("user rejected")) {
        toast.error("Transaction cancelled.", { id: toastId });
      } else {
        toast.error(msg.length > 120 ? msg.slice(0, 120) + "…" : msg, { id: toastId });
      }
    } finally {
      setSubmitting(false);
    }
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
          Powered by{" "}
          <a href="https://clanker.world" target="_blank" rel="noopener noreferrer" className="text-pcs-primary hover:underline">
            Clanker
          </a>{" "}
          — instant launch on Unichain with creator fees.
        </p>
      </div>

      {/* Fee info banner */}
      <div
        className="rounded-xl px-4 py-3 text-xs flex flex-col gap-1"
        style={{ background: "rgba(0,212,255,0.06)", border: "1px solid rgba(0,212,255,0.12)" }}
      >
        <div className="flex justify-between text-pcs-textDim">
          <span>Buy / Sell fee</span>
          <span className="text-pcs-text font-medium">1% / 1%</span>
        </div>
        <div className="flex justify-between text-pcs-textDim">
          <span>Creator share</span>
          <span className="text-pcs-text font-medium">60% of fees</span>
        </div>
        <div className="flex justify-between text-pcs-textDim">
          <span>Anti-sniper</span>
          <span className="text-pcs-text font-medium">2-block delay</span>
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

      {/* Image */}
      <div className="flex flex-col gap-1">
        <label className="text-xs text-pcs-textDim">Token Image <span className="opacity-50">(optional)</span></label>
        <label
          className="rounded-xl px-4 py-3 text-sm text-pcs-textDim cursor-pointer flex items-center gap-3 hover:border-pcs-primary/40 transition"
          style={{ border: "1px solid rgba(0,212,255,0.15)" }}
        >
          {imagePreview ? (
            <>
              <img src={imagePreview} alt="preview" className="h-8 w-8 rounded-full object-cover" />
              <span className="text-pcs-text text-xs">Image selected — click to change</span>
            </>
          ) : (
            <span>Click to upload image</span>
          )}
          <input type="file" accept="image/*" className="hidden" onChange={handleImage} />
        </label>
      </div>

      {/* Launch button */}
      {!isConnected ? (
        <p className="text-center text-sm text-pcs-textDim">Connect wallet to launch</p>
      ) : chainMismatch ? (
        <button
          className="w-full rounded-xl py-3 text-sm font-semibold transition"
          style={{ background: "rgba(0,212,255,0.15)", color: "#00d4ff" }}
          onClick={() => switchChain({ chainId: UNICHAIN_ID })}
        >
          Switch to Unichain
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
                href={`https://uniscan.xyz/token/${launched.token}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-pcs-primary hover:underline"
              >
                {launched.token}
              </a>
            </p>
          )}
          <a
            href={`https://uniscan.xyz/tx/${launched.tx}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-pcs-primary hover:underline"
          >
            View transaction
          </a>
        </div>
      )}
    </div>
  );
}
