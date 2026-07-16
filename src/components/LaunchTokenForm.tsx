import { useEffect, useState } from "react";
import type { PublicClient, WalletClient } from "viem";
import { useAccount, usePublicClient, useSwitchChain, useWalletClient } from "wagmi";
import toast from "react-hot-toast";
import {
  ROBINHOOD_CHAIN_ID,
  simulateRobinhoodLaunch,
  executeRobinhoodLaunch,
} from "../utils/dopplerLaunch";
import { simulateHydeLaunch, executeHydeLaunch, type HydeLaunchStep } from "../utils/hydeLaunch";
import { ROBINHOOD_MAINNET, ROBINHOOD_TESTNET } from "../utils/constants";
import { TokenImage } from "./TokenImage";

/* ─── component ────────────────────────────────────────────────────────────── */

const RH_TESTNET_ID = ROBINHOOD_TESTNET.id;

/** Toast copy for each step of the testnet own-stack launch (faucet → approve → launch). */
const HYDE_STEP_LABEL: Record<HydeLaunchStep, string> = {
  faucet: "Funding $1 test USDG (faucet)…",
  approve: "Approve the $1 launch fee…",
  launch: "Confirm launch in wallet…",
  confirm: "Launching through your factory…",
};

export function LaunchTokenForm({ chainId = ROBINHOOD_CHAIN_ID }: { chainId?: number }) {
  // On Robinhood Testnet the form launches through the LIVE Hyde own-stack (HydeTokenFactory);
  // on mainnet it rides the Doppler rail (own-stack not deployed there yet). Everything below
  // flips by this one flag — same #6 boundary the board uses.
  const isTestnet = chainId === RH_TESTNET_ID;
  const { address, chainId: walletChainId, isConnected } = useAccount();
  const publicClient = usePublicClient({ chainId });
  const { data: walletClient } = useWalletClient({ chainId });
  const { switchChain } = useSwitchChain();

  const [name,       setName]       = useState("");
  const [symbol,     setSymbol]     = useState("");
  const [imageUrl,   setImageUrl]   = useState("");
  const [description, setDescription] = useState("");
  const [preview,    setPreview]    = useState<{ tokenAddress: string } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [launched,   setLaunched]   = useState<{ token: string; tx: string } | null>(null);
  const [recipientConfirmed, setRecipientConfirmed] = useState(false);

  // Creator address is immutable on-chain — a stale confirmation or preview
  // must not survive a wallet switch
  useEffect(() => { setRecipientConfirmed(false); setPreview(null); setPreviewError(null); }, [address]);
  // A preview belongs to exactly one input set — any edit (or network flip) invalidates it
  useEffect(() => { setPreview(null); setRecipientConfirmed(false); setPreviewError(null); }, [name, symbol, imageUrl, description, chainId]);

  // Small images embed straight into the on-chain metadata (data URI) — no
  // pinning service, no server, permanent. Size-gated: tokenURI is calldata.
  // (Doppler rail only — own-stack HydeERC20 stores no tokenURI, so testnet hides this.)
  const MAX_EMBED_BYTES = 24 * 1024;
  const handleImageFile = (file: File | undefined) => {
    if (!file) return;
    if (!/^image\/(png|jpeg|gif|webp|svg\+xml)$/.test(file.type)) {
      toast.error("Use a PNG, JPG, GIF, WebP or SVG image."); return;
    }
    if (file.size > MAX_EMBED_BYTES) {
      toast.error("Image too large to store on-chain (max 24 KB) — paste an image URL instead."); return;
    }
    const reader = new FileReader();
    reader.onload = () => setImageUrl(reader.result as string);
    reader.readAsDataURL(file);
  };

  const imageUrlValid = !imageUrl
    || /^https:\/\/.+/.test(imageUrl) || /^ipfs:\/\/.+/.test(imageUrl) || /^data:image\//.test(imageUrl);

  const chainMismatch = isConnected && walletChainId !== chainId;
  const formValid = !!name.trim() && !!symbol.trim();

  const handlePreview = async () => {
    if (!address || !publicClient || !formValid) return;
    setPreviewing(true);
    setPreviewError(null);
    const toastId = "hyde-preview";
    try {
      toast.loading(isTestnet ? "Simulating launch on your own-stack…" : "Simulating launch on Robinhood Chain…", { id: toastId });
      if (isTestnet) {
        const sim = await simulateHydeLaunch(publicClient as PublicClient, chainId, { name, symbol, creator: address });
        setPreview({ tokenAddress: sim.tokenAddress });
      } else {
        const sim = await simulateRobinhoodLaunch(publicClient as PublicClient, {
          name, symbol, imageUrl: imageUrl || undefined, description: description || undefined, creator: address,
        });
        setPreview({ tokenAddress: sim.tokenAddress });
      }
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
      let result: { tokenAddress: string; transactionHash: string };
      if (isTestnet) {
        toast.loading(HYDE_STEP_LABEL.faucet, { id: toastId });
        result = await executeHydeLaunch(
          publicClient as PublicClient,
          walletClient as WalletClient,
          chainId,
          { name, symbol, creator: address },
          (step) => toast.loading(HYDE_STEP_LABEL[step], { id: toastId }),
        );
      } else {
        toast.loading("Confirm in wallet…", { id: toastId });
        result = await executeRobinhoodLaunch(
          publicClient as PublicClient,
          walletClient as WalletClient,
          { name, symbol, imageUrl: imageUrl || undefined, description: description || undefined, creator: address }
        );
      }
      toast.success("Token launched!", { id: toastId, duration: 8000 });
      setLaunched({ token: result.tokenAddress, tx: result.transactionHash });
      setName(""); setSymbol(""); setImageUrl(""); setDescription(""); setPreview(null); setRecipientConfirmed(false);
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

  const explorer = isTestnet ? ROBINHOOD_TESTNET.explorerUrl : ROBINHOOD_MAINNET.explorerUrl;
  const targetName = isTestnet ? ROBINHOOD_TESTNET.name : ROBINHOOD_MAINNET.name;

  return (
    <div
      className="w-full max-w-md mx-auto rounded-2xl p-6 flex flex-col gap-5 shadow-card"
      style={{ background: "#121419", border: "1px solid #22252D" }}
    >
      {/* Header */}
      <div>
        <h2 className="font-display text-lg font-semibold text-pcs-text">Launch a Token</h2>
        <p className="text-xs text-pcs-textSub mt-1">
          {isTestnet
            ? "Launch on the LIVE Hyde own-stack (Robinhood Testnet) — your factory, custody-locked liquidity from block 1."
            : "Price-discovery launch on Robinhood Chain — tradeable from the first block."}
        </p>
      </div>

      {/* Terms banner — flips by network (own-stack LIVE on testnet · Doppler rail on mainnet) */}
      {isTestnet ? (
        <>
          <div
            className="rounded-xl px-4 py-3 text-xs flex flex-col gap-1.5"
            style={{ background: "rgba(255,255,255,0.03)", border: "1px solid #22252D" }}
          >
            <div className="flex justify-between text-pcs-textDim">
              <span>Total supply</span>
              <span className="text-pcs-text font-medium">1,000,000,000 (100% on the launch curve)</span>
            </div>
            <div className="flex justify-between text-pcs-textDim">
              <span>Launch fee</span>
              <span className="text-pcs-text font-medium">$1 flat (test USDG — auto-funded)</span>
            </div>
            <div className="flex justify-between text-pcs-textDim">
              <span>Trading fees</span>
              <span className="text-pcs-text font-medium">90% creator · 5% Hyde · 5% locked LP</span>
            </div>
            <div className="flex justify-between text-pcs-textDim">
              <span>Liquidity</span>
              <span className="text-pcs-text font-medium">Custody-locked from block 1 — no migration</span>
            </div>
            <div className="flex justify-between text-pcs-textDim">
              <span>Initial cost</span>
              <span className="text-pcs-text font-medium">$1 test USDG + gas</span>
            </div>
          </div>

          {/* LIVE · own-stack — present-tense here because on testnet the Hyde stack IS deployed + running. */}
          <div className="rounded-xl px-4 py-3" style={{ background: "rgba(52,199,123,0.07)", border: "1px solid rgba(52,199,123,0.30)" }}>
            <p className="text-[10px] font-semibold tracking-wide" style={{ color: "#34C77B" }}>● LIVE · HYDE OWN-STACK</p>
            <p className="mt-1 font-mono text-[11px]" style={{ color: "#8A93A2" }}>
              Launches route through YOUR HydeTokenFactory — all 1B single-sided-seeded, the position NFT held in
              the collector's permanent custody (un-ruggable, grows as it earns fees) · anti-snipe max-wallet.
            </p>
          </div>
        </>
      ) : (
        <>
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
              {/* Split verified from the on-chain RehypeDopplerHookMigrator source:
                  AIRLOCK_OWNER_FEE_BPS = 500 — Doppler takes 5% OF the fee, the
                  rest routes to the creator. Hydeout takes nothing. */}
              <span className="text-pcs-text font-medium">95% creator · 5% Doppler · 0% Hydeout</span>
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

          {/* Coming with the Hyde stack — future-tense only (§2.C / §3.3); flips live when the
              own-stack HydeTokenFactory deploys. Never a present-tense claim on the current rail. */}
          <div className="rounded-xl px-4 py-3" style={{ background: "rgba(224,163,46,0.06)", border: "1px solid rgba(224,163,46,0.25)" }}>
            <p className="text-[10px] font-semibold tracking-wide" style={{ color: "#E0A32E" }}>COMING · HYDE STACK</p>
            <p className="mt-1 font-mono text-[11px]" style={{ color: "#8A93A2" }}>
              $1 flat launch fee · 90% creator · 5% Hyde · 5% auto-locked liquidity (un-ruggable, grows as it earns fees) · anti-snipe max-wallet
            </p>
          </div>
        </>
      )}

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

      {/* Token image + description — Doppler rail only. Own-stack HydeERC20 stores no tokenURI, so on
          testnet we hide these rather than silently drop them (honesty). */}
      {!isTestnet ? (
        <>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-pcs-textSub">Token Image <span className="text-pcs-textDim font-normal">(optional)</span></label>
            <div className="flex items-center gap-2">
              <input
                className="input flex-1 font-code"
                placeholder="https:// or ipfs:// image URL"
                value={imageUrl.startsWith("data:") ? "" : imageUrl}
                onChange={(e) => setImageUrl(e.target.value.trim())}
                disabled={imageUrl.startsWith("data:")}
              />
              <label
                className="text-xs font-semibold px-3 py-2 rounded-xl cursor-pointer transition flex-shrink-0"
                style={{ background: "rgba(46,159,230,0.12)", color: "#54B4F0" }}
              >
                Upload
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
                  className="hidden"
                  onChange={(e) => handleImageFile(e.target.files?.[0])}
                />
              </label>
            </div>
            {imageUrl && imageUrlValid && (
              <div className="flex items-center gap-2 mt-1">
                <TokenImage
                  src={imageUrl}
                  symbol={symbol}
                  className="h-10 w-10 rounded-full flex-shrink-0 text-sm"
                  style={{ border: "1px solid #22252D" }}
                />
                <p className="text-[11px] text-pcs-textDim flex-1">
                  {imageUrl.startsWith("data:")
                    ? "Embedded — stored permanently on-chain with the token."
                    : "Referenced by URL in the on-chain metadata."}
                </p>
                <button
                  className="text-[11px] text-pcs-textDim hover:text-pcs-text transition"
                  onClick={() => setImageUrl("")}
                >
                  Remove
                </button>
              </div>
            )}
            {imageUrl && !imageUrlValid && (
              <p className="text-[11px]" style={{ color: "#E8A33D" }}>Must be an https://, ipfs:// or uploaded image.</p>
            )}
            <p className="text-[10px] text-pcs-textDim">Uploads up to 24 KB are embedded on-chain forever; larger images should be hosted and pasted as a URL.</p>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-pcs-textSub">Description <span className="text-pcs-textDim font-normal">(optional)</span></label>
            <textarea
              className="input resize-none"
              rows={2}
              placeholder="One or two lines about the token"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={280}
            />
          </div>
        </>
      ) : (
        <p className="text-[11px] text-pcs-textDim -mt-1">
          Own-stack tokens are name + symbol only (no on-chain image/description yet).
        </p>
      )}

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
          <div className="flex justify-between items-center text-xs">
            <span className="text-pcs-textDim">Token</span>
            <span className="text-pcs-text font-medium flex items-center gap-2">
              {!isTestnet && imageUrl && imageUrlValid && (
                <TokenImage src={imageUrl} symbol={symbol} className="h-5 w-5 rounded-full text-[8px]" style={{ border: "1px solid #22252D" }} />
              )}
              {name.trim()} <span className="font-code">{symbol.trim()}</span>
            </span>
          </div>
          {!isTestnet && (imageUrl || description) && (
            <div className="flex justify-between text-xs">
              <span className="text-pcs-textDim">Metadata</span>
              <span className="text-pcs-text font-medium">
                {[imageUrl ? (imageUrl.startsWith("data:") ? "image embedded on-chain" : "image by URL") : null,
                  description ? "description" : null].filter(Boolean).join(" + ")}
              </span>
            </div>
          )}

          {/* 2. Supply split — 100% of supply goes to the launch curve */}
          <div className="flex flex-col gap-1">
            <div className="flex justify-between text-xs">
              <span className="text-pcs-textDim">Supply</span>
              <span className="text-pcs-text font-medium tabular-nums">1,000,000,000 total</span>
            </div>
            <div className="flex justify-between text-[11px] text-pcs-textDim">
              <span>{isTestnet
                ? "100% single-sided-seeded into the pool — nothing pre-minted or held back"
                : "100% to the launch curve — nothing pre-minted or held back"}</span>
            </div>
            <div className="h-1 rounded-full overflow-hidden" style={{ background: "#22252D" }}>
              <div className="h-full" style={{ width: "100%", background: "#2E9FE6" }} />
            </div>
          </div>

          {/* 3. Fee */}
          <div className="flex flex-col gap-0.5">
            <div className="flex justify-between text-xs">
              <span className="text-pcs-textDim">Launch fee</span>
              <span className="text-pcs-text font-medium">{isTestnet ? "$1 flat (test USDG · auto-funded)" : "3% → 1% over the first hour"}</span>
            </div>
            <p className="text-[11px] text-pcs-textDim">{isTestnet
              ? "The $1 test USDG is faucet-funded + approved automatically before launch."
              : "High early fee = sniping is unprofitable by design."}</p>
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
          onClick={() => switchChain({ chainId })}
        >
          Switch to {targetName}
        </button>
      ) : !preview ? (
        <button
          className="btn-neon w-full py-3 text-sm"
          onClick={handlePreview}
          disabled={!formValid || (!isTestnet && !imageUrlValid) || previewing}
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
            {isTestnet
              ? "It's live on your own-stack pool now — all 1B seeded, liquidity custody-locked and growing every trade."
              : "It's live on the launch curve now — liquidity graduates to a real pool as the curve completes."}
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
