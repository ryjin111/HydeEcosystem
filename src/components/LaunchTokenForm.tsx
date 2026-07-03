import { useEffect, useState } from "react";
import type { PublicClient, WalletClient } from "viem";
import { useAccount, usePublicClient, useSwitchChain, useWalletClient } from "wagmi";
import toast from "react-hot-toast";
import {
  ROBINHOOD_CHAIN_ID,
  simulateRobinhoodLaunch,
  executeRobinhoodLaunch,
  type RobinhoodLaunchPreview,
} from "../utils/dopplerLaunch";
import { ROBINHOOD_MAINNET } from "../utils/constants";

/* ─── component ────────────────────────────────────────────────────────────── */

export function LaunchTokenForm() {
  const { address, chainId, isConnected } = useAccount();
  const publicClient = usePublicClient({ chainId: ROBINHOOD_CHAIN_ID });
  const { data: walletClient } = useWalletClient({ chainId: ROBINHOOD_CHAIN_ID });
  const { switchChain } = useSwitchChain();

  const [name,       setName]       = useState("");
  const [symbol,     setSymbol]     = useState("");
  const [preview,    setPreview]    = useState<RobinhoodLaunchPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [launched,   setLaunched]   = useState<{ token: string; tx: string } | null>(null);
  const [recipientConfirmed, setRecipientConfirmed] = useState(false);

  // Creator address is immutable on-chain — a stale confirmation or preview
  // must not survive a wallet switch
  useEffect(() => { setRecipientConfirmed(false); setPreview(null); setPreviewError(null); }, [address]);
  // A preview belongs to exactly one (name, symbol) pair
  useEffect(() => { setPreview(null); setRecipientConfirmed(false); setPreviewError(null); }, [name, symbol]);

  const chainMismatch = isConnected && chainId !== ROBINHOOD_CHAIN_ID;
  const formValid = !!name.trim() && !!symbol.trim();

  const handlePreview = async () => {
    if (!address || !publicClient || !formValid) return;
    setPreviewing(true);
    setPreviewError(null);
    const toastId = "hyde-preview";
    try {
      toast.loading("Simulating launch on Robinhood Chain…", { id: toastId });
      const sim = await simulateRobinhoodLaunch(publicClient as PublicClient, {
        name, symbol, creator: address,
      });
      setPreview(sim);
      toast.success("Pre-flight passed — review and confirm below.", { id: toastId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setPreviewError(msg);
      toast.error("Pre-flight failed — see details below.", { id: toastId, duration: 6000 });
      setPreview(null);
    } finally {
      setPreviewing(false);
    }
  };

  const handleLaunch = async () => {
    if (!address || !publicClient || !walletClient || !preview) return;
    setSubmitting(true);
    const toastId = "hyde-launch";
    try {
      toast.loading("Confirm in wallet…", { id: toastId });
      const result = await executeRobinhoodLaunch(
        publicClient as PublicClient,
        walletClient as WalletClient,
        { name, symbol, creator: address }
      );
      toast.success("Token launched!", { id: toastId, duration: 8000 });
      setLaunched({ token: result.tokenAddress, tx: result.transactionHash });
      setName(""); setSymbol(""); setPreview(null); setRecipientConfirmed(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = (err as { code?: number; cause?: { code?: number } })?.code
        ?? (err as { cause?: { code?: number } })?.cause?.code;
      const userCancelled = code === 4001
        || msg.includes("User rejected") || msg.includes("user rejected")
        || msg.includes("User denied")   || msg.includes("Request rejected");
      toast.error(userCancelled ? "Transaction cancelled." : (msg.length > 120 ? msg.slice(0, 120) + "…" : msg), { id: toastId });
    } finally {
      setSubmitting(false);
    }
  };

  const explorer = ROBINHOOD_MAINNET.explorerUrl;

  return (
    <div
      className="w-full max-w-md mx-auto rounded-2xl p-6 flex flex-col gap-5 shadow-card"
      style={{ background: "#121419", border: "1px solid #22252D" }}
    >
      {/* Header */}
      <div>
        <h2 className="font-display text-lg font-semibold text-pcs-text">Launch a Token</h2>
        <p className="text-xs text-pcs-textSub mt-1">
          Price-discovery launch on Robinhood L2 — fees stream to you from the first trade.
        </p>
      </div>

      {/* Terms banner */}
      <div
        className="rounded-xl px-4 py-3 text-xs flex flex-col gap-1.5"
        style={{ background: "rgba(255,255,255,0.03)", border: "1px solid #22252D" }}
      >
        <div className="flex justify-between text-pcs-textDim">
          <span>Total supply</span>
          <span className="text-pcs-text font-medium">1,000,000,000 (100% on the launch curve)</span>
        </div>
        <div className="flex justify-between text-pcs-textDim">
          <span>Launch fee (anti-snipe)</span>
          <span className="text-pcs-text font-medium">3% → 1% over the first hour</span>
        </div>
        <div className="flex justify-between text-pcs-textDim">
          <span>Trading fees</span>
          <span className="text-pcs-text font-medium">100% to the creator</span>
        </div>
        <div className="flex justify-between text-pcs-textDim">
          <span>Graduation</span>
          <span className="text-pcs-text font-medium">Liquidity moves to a real pool</span>
        </div>
        <div className="flex justify-between text-pcs-textDim">
          <span>Initial cost</span>
          <span className="text-pcs-text font-medium">Gas only</span>
        </div>
      </div>

      {/* Name */}
      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium text-pcs-textSub">Token Name</label>
        <input
          className="input"
          placeholder="e.g. HydeToken"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={64}
        />
      </div>

      {/* Symbol */}
      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium text-pcs-textSub">Token Symbol</label>
        <input
          className="input font-code"
          placeholder="e.g. HYDE"
          value={symbol}
          onChange={(e) => setSymbol(e.target.value.toUpperCase().replace(/\s/g, ''))}
          maxLength={10}
        />
      </div>

      {/* Simulate failure — amber panel with the raw reason, launch stays dead */}
      {previewError && (
        <div
          className="rounded-xl px-4 py-3 text-xs flex flex-col gap-1"
          style={{ background: "rgba(232,163,61,0.08)", border: "1px solid rgba(232,163,61,0.35)" }}
        >
          <p className="font-medium" style={{ color: "#E8A33D" }}>Pre-flight simulation failed</p>
          <p className="text-pcs-textDim break-all">{previewError.slice(0, 300)}</p>
        </div>
      )}

      {/* Pre-flight receipt + creator confirm — the launch button only arms after
          a passing simulation (predicted token address) AND an explicit confirm
          of the immutable fee-recipient address (Reviewer-required steps) */}
      {isConnected && address && preview && (
        <div
          className="rounded-xl px-4 py-3 flex flex-col gap-3"
          style={{ background: "rgba(46,159,230,0.06)", border: "1px solid rgba(46,159,230,0.25)" }}
        >
          <p className="text-xs font-medium text-pcs-textSub">Pre-flight receipt</p>

          {/* 1. Token identity */}
          <div className="flex justify-between text-xs">
            <span className="text-pcs-textDim">Token</span>
            <span className="text-pcs-text font-medium">
              {name.trim()} <span className="font-code">{symbol.trim()}</span>
            </span>
          </div>

          {/* 2. Supply split — 100% of supply goes to the launch curve */}
          <div className="flex flex-col gap-1">
            <div className="flex justify-between text-xs">
              <span className="text-pcs-textDim">Supply</span>
              <span className="text-pcs-text font-medium tabular-nums">1,000,000,000 total</span>
            </div>
            <div className="flex justify-between text-[11px] text-pcs-textDim">
              <span>100% to the launch curve — nothing pre-minted or held back</span>
            </div>
            <div className="h-1 rounded-full overflow-hidden" style={{ background: "#22252D" }}>
              <div className="h-full" style={{ width: "100%", background: "#2E9FE6" }} />
            </div>
          </div>

          {/* 3. Fee decay */}
          <div className="flex flex-col gap-0.5">
            <div className="flex justify-between text-xs">
              <span className="text-pcs-textDim">Launch fee</span>
              <span className="text-pcs-text font-medium">3% → 1% over the first hour</span>
            </div>
            <p className="text-[11px] text-pcs-textDim">High early fee = sniping is unprofitable by design.</p>
          </div>

          {/* 4. Predicted token address */}
          <div className="flex flex-col gap-0.5">
            <p className="text-xs text-pcs-textDim">Token address — predicted (from simulation)</p>
            <p className="font-code text-xs text-pcs-text break-all">{preview.tokenAddress}</p>
          </div>

          {/* 5. Creator & fee recipient — immutable, explicit confirm */}
          <div className="flex flex-col gap-2 pt-1" style={{ borderTop: "1px solid #22252D" }}>
            <p className="text-xs font-medium text-pcs-textSub">Creator &amp; fee recipient</p>
            <p className="font-code text-xs text-pcs-text break-all">{address}</p>
            <p className="text-[11px] text-pcs-textDim">
              This address is permanent for this token. Creator fees can only ever be claimed to it —
              it cannot be changed after launch.
            </p>
            <label className="flex items-start gap-2 text-xs text-pcs-textSub cursor-pointer select-none">
              <input
                type="checkbox"
                className="mt-0.5 accent-pcs-primary"
                checked={recipientConfirmed}
                onChange={(e) => setRecipientConfirmed(e.target.checked)}
              />
              <span>I confirm this is the correct fee recipient address.</span>
            </label>
          </div>
        </div>
      )}

      {/* Action buttons */}
      {!isConnected ? (
        <p className="text-center text-sm text-pcs-textDim">Connect wallet to launch</p>
      ) : chainMismatch ? (
        <button
          className="w-full rounded-xl py-3 text-sm font-semibold transition"
          style={{ background: "rgba(46,159,230,0.14)", color: "#54B4F0" }}
          onClick={() => switchChain({ chainId: ROBINHOOD_CHAIN_ID })}
        >
          Switch to Robinhood L2
        </button>
      ) : !preview ? (
        <button
          className="btn-neon w-full py-3 text-sm"
          onClick={handlePreview}
          disabled={!formValid || previewing}
        >
          {previewing ? "Simulating…" : "Preview Launch"}
        </button>
      ) : submitting ? (
        <button
          className="w-full rounded-xl py-3 text-sm font-semibold transition disabled:opacity-50"
          style={{ background: "rgba(46,159,230,0.14)", color: "#54B4F0" }}
          disabled
        >
          Launching…
        </button>
      ) : (
        <button
          className="btn-neon w-full py-3 text-sm"
          onClick={handleLaunch}
          disabled={!recipientConfirmed}
        >
          {recipientConfirmed ? "Launch Token" : "Confirm recipient to launch"}
        </button>
      )}

      {/* Success */}
      {launched && (
        <div
          className="rounded-xl px-4 py-3 text-xs flex flex-col gap-2"
          style={{ background: "rgba(52,199,123,0.08)", border: "1px solid rgba(52,199,123,0.30)" }}
        >
          <p className="text-pcs-text font-semibold">Token launched!</p>
          <p className="text-pcs-textDim">
            It's live on the launch curve now — liquidity graduates to a real pool as the curve completes.
          </p>
          {launched.token && (
            <p className="text-pcs-textDim break-all font-code">
              Address:{" "}
              <a
                href={`${explorer}/token/${launched.token}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-pcs-primary hover:underline"
              >
                {launched.token}
              </a>
            </p>
          )}
          <a
            href={`${explorer}/tx/${launched.tx}`}
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
