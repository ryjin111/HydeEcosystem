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
import { simulateHoodieLaunch, executeHoodieLaunch, type HoodieLaunchStep } from "../utils/hoodieLaunch";
import { ROBINHOOD_MAINNET, ROBINHOOD_TESTNET, V4_CONTRACTS_BY_CHAIN } from "../utils/constants";
import { preCheckImageFile, AVATAR_SIZE } from "../utils/imageValidation";
import { saveLaunchMeta } from "../utils/launchMeta";
import { TokenImage } from "./TokenImage";

/* ─── component ────────────────────────────────────────────────────────────── */

const RH_TESTNET_ID = ROBINHOOD_TESTNET.id;

/**
 * Resize/center-crop any picked image to an exact AVATAR_SIZE² PNG (kami locked spec).
 * Re-encoding through a canvas both normalizes dimensions (so the server's exact-500×500 gate
 * always passes for a legit image) AND rasterizes — any vector/script content is flattened to
 * pixels. The server still independently validates the uploaded bytes.
 */
async function toAvatarBlob(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  try {
    const S = AVATAR_SIZE;
    const canvas = document.createElement("canvas");
    canvas.width = S;
    canvas.height = S;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    const scale = Math.max(S / bitmap.width, S / bitmap.height); // cover
    const w = bitmap.width * scale;
    const h = bitmap.height * scale;
    ctx.drawImage(bitmap, (S - w) / 2, (S - h) / 2, w, h);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode failed"))), "image/png"),
    );
  } finally {
    bitmap.close?.();
  }
}

/** Toast copy for the testnet own-stack launch — now a single payable tx (no faucet/approve). */
const HYDE_STEP_LABEL: Record<HydeLaunchStep, string> = {
  launch: "Confirm launch in wallet…",
  confirm: "Launching through your factory…",
};

/** Toast copy for the HOODIE shared-launcher — a single payable launch tx (no per-user launcher deploy). */
const HOODIE_STEP_LABEL: Record<HoodieLaunchStep, string> = {
  launch: "Confirm launch in wallet…",
  confirm: "Launching HOODIE-paired…",
};

export function LaunchTokenForm({ chainId = ROBINHOOD_CHAIN_ID }: { chainId?: number }) {
  // Own-stack launch lane: a chain uses OUR HydeTokenFactory (not Doppler) whenever one is configured.
  // Both testnet (46630) and mainnet (4663, deployed 2026-07-21) now have one → mainnet WETH launches
  // route through our factory `0x710f…509f`, same as testnet. Everything below flips by this one flag.
  const usesOwnStack = !!V4_CONTRACTS_BY_CHAIN[chainId]?.hydeTokenFactory;
  const { address, chainId: walletChainId, isConnected } = useAccount();
  const publicClient = usePublicClient({ chainId });
  const { data: walletClient } = useWalletClient({ chainId });
  const { switchChain } = useSwitchChain();

  // Base pair the launch pairs against (clint 23448). WETH uses the live own-stack HydeTokenFactory.
  // HOODIE routes through the ONE shared launcher (clint 23752) — a single-tx launch, same flow shape as
  // WETH, just $HOODIE-based; the engine attributes the actual caller as the creator.
  const [pair, setPair] = useState<"weth" | "hoodie">("weth");
  const isHoodie = pair === "hoodie";

  const [name,       setName]       = useState("");
  const [symbol,     setSymbol]     = useState("");
  const [imageUrl,   setImageUrl]   = useState("");
  const [description, setDescription] = useState("");
  const [preview,    setPreview]    = useState<{ tokenAddress: string } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [uploading,  setUploading]  = useState(false);
  const [launched,   setLaunched]   = useState<{ token: string; tx: string; image: string; description: string } | null>(null);
  const [recipientConfirmed, setRecipientConfirmed] = useState(false);
  // Own-stack metadata save (creator-signed, off-chain) — tracked separately from the launch so a
  // metadata hiccup never implies the token failed. "error" arms an explicit retry (kami 22853).
  const [metaState, setMetaState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [metaError, setMetaError] = useState<string | null>(null);

  /** Sign + persist off-chain image/description for a just-launched own-stack token. Isolated from
   *  the launch: on failure it flips to an explicit retry, the token stays live. */
  const saveMetaFor = async (token: string, image: string, description: string) => {
    if (!walletClient || !address) {
      setMetaState("error");
      setMetaError("Wallet not connected — reconnect and hit retry.");
      return;
    }
    setMetaState("saving");
    setMetaError(null);
    try {
      await saveLaunchMeta(walletClient as WalletClient, address, { chainId, token, image, description });
      setMetaState("saved");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = (err as { code?: number })?.code;
      const cancelled = code === 4001 || /rejected|denied|cancell?ed/i.test(msg);
      setMetaState("error");
      setMetaError(cancelled ? "You cancelled the signature." : (msg.length > 140 ? msg.slice(0, 140) + "…" : msg));
    }
  };

  // Creator address is immutable on-chain — a stale confirmation or preview
  // must not survive a wallet switch
  useEffect(() => { setRecipientConfirmed(false); setPreview(null); setPreviewError(null); }, [address]);
  // A preview belongs to exactly one input set — any edit (or network flip) invalidates it
  useEffect(() => { setPreview(null); setRecipientConfirmed(false); setPreviewError(null); }, [name, symbol, imageUrl, description, chainId, pair]);

  // Upload-only (v1): the chosen file is pinned to IPFS by our own server gate
  // (/api/pin-image — 2 MB cap + magic-byte raster sniff, browser MIME never trusted),
  // and we store ONLY the returned ipfs://CID as the token image. No on-chain embed,
  // no pasted URLs/data URIs — one flow, one validator, content-addressed + immutable.
  // Own-stack HydeERC20 stores no tokenURI, so image/description are persisted through launch metadata.
  const handleImageFile = async (file: File | undefined) => {
    if (!file) return;
    const pre = preCheckImageFile(file); // fast UX pre-check; server is authoritative
    if (!pre.ok) { toast.error(pre.error); return; }
    setUploading(true);
    const toastId = "hyde-pin";
    toast.loading("Preparing & pinning image…", { id: toastId });
    let blob: Blob;
    try {
      blob = await toAvatarBlob(file); // exact 500×500 PNG (rasterized, dimension-normalized)
    } catch {
      toast.error("Couldn't read that image — try a different PNG or JPG.", { id: toastId });
      setUploading(false);
      return;
    }
    try {
      const res = await fetch("/api/pin-image", { method: "POST", headers: { "Content-Type": "image/png" }, body: blob });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(
          res.status === 503
            ? "Image uploads aren't available yet — you can launch without an image."
            : (data?.error || "Upload failed."),
          { id: toastId, duration: 6000 },
        );
        return;
      }
      setImageUrl(data.uri as string); // ipfs://<cid>
      toast.success("Image pinned to IPFS.", { id: toastId });
    } catch {
      toast.error("Upload failed — check your connection.", { id: toastId });
    } finally {
      setUploading(false);
    }
  };

  // imageUrl is either "" or a pinned ipfs://CID — the only accepted shape in upload-only v1.
  const hasImage = imageUrl.startsWith("ipfs://");

  const chainMismatch = isConnected && walletChainId !== chainId;
  const formValid = !!name.trim() && !!symbol.trim();

  const handlePreview = async () => {
    if (!address || !publicClient || !formValid) return;
    setPreviewing(true);
    setPreviewError(null);
    const toastId = "hyde-preview";
    try {
      toast.loading(`Simulating launch on ${targetName}…`, { id: toastId });
      if (isHoodie) {
        const sim = await simulateHoodieLaunch(publicClient as PublicClient, chainId, { name, symbol, creator: address });
        setPreview({ tokenAddress: sim.tokenAddress });
      } else if (usesOwnStack) {
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
    setMetaState("idle");
    setMetaError(null);
    const toastId = "hyde-launch";
    try {
      let result: { tokenAddress: string; transactionHash: string };
      if (isHoodie) {
        toast.loading(HOODIE_STEP_LABEL.launch, { id: toastId });
        result = await executeHoodieLaunch(
          publicClient as PublicClient,
          walletClient as WalletClient,
          chainId,
          { name, symbol, creator: address },
          (step) => toast.loading(HOODIE_STEP_LABEL[step], { id: toastId }),
        );
      } else if (usesOwnStack) {
        toast.loading(HYDE_STEP_LABEL.launch, { id: toastId });
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
      const savedImage = imageUrl;
      const savedDesc = description;
      setLaunched({ token: result.tokenAddress, tx: result.transactionHash, image: savedImage, description: savedDesc });
      setName(""); setSymbol(""); setImageUrl(""); setDescription(""); setPreview(null); setRecipientConfirmed(false);
      // Own-stack HydeERC20 stores no tokenURI → persist image/description off-chain (creator-signed).
      // Kicked off AFTER the launch is confirmed; a failure only affects the metadata, never the token.
      if (usesOwnStack && (savedImage.startsWith("ipfs://") || savedDesc.trim())) {
        void saveMetaFor(result.tokenAddress, savedImage, savedDesc);
      }
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

  const isRhTestnet = chainId === RH_TESTNET_ID;
  const explorer = isRhTestnet ? ROBINHOOD_TESTNET.explorerUrl : ROBINHOOD_MAINNET.explorerUrl;
  const targetName = isRhTestnet ? ROBINHOOD_TESTNET.name : ROBINHOOD_MAINNET.name;

  return (
    <div
      className="w-full max-w-md mx-auto rounded-2xl p-6 flex flex-col gap-5 shadow-card"
      style={{ background: "#121419", border: "1px solid #22252D" }}
    >
      {/* Pair selector (clint 23448) — the base a launch pairs against. WETH = the standard rail;
          HOODIE = the HOODIE-native launcher-launcher. Segmented pill, matching the page's tab style. */}
      <div className="grid grid-cols-2 gap-1 rounded-xl p-1" style={{ background: "#0E1014", border: "1px solid #22252D" }}>
        {([
          { key: "weth",   label: "WETH PAIR",   accent: "#54B4F0", tint: "rgba(46,159,230,0.14)" },
          { key: "hoodie", label: "HOODIE PAIR", accent: "#E0A32E", tint: "rgba(224,163,46,0.14)" },
        ] as const).map((opt) => {
          const on = pair === opt.key;
          return (
            <button
              key={opt.key}
              onClick={() => setPair(opt.key)}
              className="rounded-lg py-2 text-xs font-semibold tracking-wide transition"
              style={on
                ? { background: opt.tint, color: opt.accent, border: `1px solid ${opt.accent}55` }
                : { background: "transparent", color: "#5B6472", border: "1px solid transparent" }}
            >
              {opt.label}
            </button>
          );
        })}
      </div>

      {/* Header */}
      <div>
        <h2 className="font-display text-lg font-semibold text-pcs-text">Launch a Token</h2>
        <p className="text-xs text-pcs-textSub mt-1">
          {isHoodie
            ? "Launch permanently paired to $HOODIE — one transaction."
            : usesOwnStack
              ? `Launch on ${targetName} — custody-locked liquidity from block 1.`
              : "Price-discovery launch on Robinhood Chain — tradeable from the first block."}
        </p>
      </div>

      {/* Terms banner — pair-aware (clint 23448) then network-aware. HOODIE accurately separates the
          live on-chain stack from its not-yet-wired in-app action; WETH uses the live own-stack path. */}
      {isHoodie ? (
        <>
          <div
            className="rounded-xl px-4 py-3 text-xs flex flex-col gap-1.5"
            style={{ background: "rgba(255,255,255,0.03)", border: "1px solid #22252D" }}
          >
            <div className="flex justify-between text-pcs-textDim">
              <span>Base pair</span>
              <span className="font-medium" style={{ color: "#E0A32E" }}>$HOODIE — permanent, immutable</span>
            </div>
            <div className="flex justify-between text-pcs-textDim">
              <span>Total supply</span>
              <span className="text-pcs-text font-medium">1,000,000,000 (100% single-sided-seeded)</span>
            </div>
            <div className="flex justify-between text-pcs-textDim">
              <span>Launch fee</span>
              <span className="text-pcs-text font-medium">0.0004 ETH flat</span>
            </div>
            <div className="flex justify-between text-pcs-textDim">
              <span>Trading fees</span>
              <span className="text-pcs-text font-medium">90% creator · 5% Hyde · 5% locked LP</span>
            </div>
          </div>

          {/* HOODIE PAIR — LIVE on 4663 mainnet. ONE shared launcher (clint 23752); every creator launches
              through it in a single tx (nothing to deploy). Copy per shiro 23763. */}
          <div className="rounded-xl px-4 py-3" style={{ background: "rgba(52,199,123,0.06)", border: "1px solid rgba(52,199,123,0.25)" }}>
            <p className="text-[10px] font-semibold tracking-wide" style={{ color: "#34C77B" }}>● LIVE · HOODIE PAIR</p>
            <p className="mt-1 font-mono text-[11px]" style={{ color: "#8A93A2" }}>
              Every token launches permanently paired to $HOODIE — single-sided-seeded, liquidity
              custody-locked and growing as it earns fees. One transaction, nothing to deploy.
            </p>
          </div>
        </>
      ) : usesOwnStack ? (
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
              <span className="text-pcs-text font-medium">0.0004 ETH flat</span>
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
              <span className="text-pcs-text font-medium">0.0004 ETH + gas</span>
            </div>
          </div>

          {/* LIVE · own-stack — present-tense: the Hyde stack IS deployed + running on this chain
              (testnet 46630 and mainnet 4663). Network-named so mainnet never says "TESTNET". */}
          <div className="rounded-xl px-4 py-3" style={{ background: "rgba(52,199,123,0.07)", border: "1px solid rgba(52,199,123,0.30)" }}>
            <p className="text-[10px] font-semibold tracking-wide" style={{ color: "#34C77B" }}>● LIVE · {targetName.toUpperCase()}</p>
            <p className="mt-1 font-mono text-[11px]" style={{ color: "#8A93A2" }}>
              Launches route through HydeTokenFactory — all 1B single-sided-seeded, the position NFT held in
              the collector's permanent custody (permanently locked, grows as it earns fees) · anti-snipe max-wallet.
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
              0.0004 ETH flat launch fee · 90% creator · 5% Hyde · 5% auto-locked liquidity (permanently locked, grows as it earns fees) · anti-snipe max-wallet
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

      {/* Token image + description — optional on BOTH rails (clint #1). On the Doppler (mainnet) rail
          these ride the on-chain tokenURI; on the own-stack (testnet) HydeERC20 has no tokenURI, so
          they're saved as creator-signed OFF-CHAIN metadata after launch (image pinned to IPFS). */}
      <>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-pcs-textSub">Token Image <span className="text-pcs-textDim font-normal">(optional)</span></label>
            {!hasImage ? (
              <label
                className={`text-xs font-semibold px-3 py-2.5 rounded-xl transition flex items-center justify-center gap-2 ${uploading ? "opacity-60 cursor-wait" : "cursor-pointer"}`}
                style={{ background: "rgba(46,159,230,0.12)", color: "#54B4F0", border: "1px dashed rgba(46,159,230,0.35)" }}
              >
                {uploading ? "Pinning to IPFS…" : "Upload image"}
                <input
                  type="file"
                  accept="image/png,image/jpeg"
                  className="hidden"
                  disabled={uploading}
                  onChange={(e) => handleImageFile(e.target.files?.[0])}
                />
              </label>
            ) : (
              <div className="flex items-center gap-2 mt-1">
                <TokenImage
                  src={imageUrl}
                  symbol={symbol}
                  className="h-10 w-10 rounded-full flex-shrink-0 text-sm"
                  style={{ border: "1px solid #22252D" }}
                />
                <p className="text-[11px] text-pcs-textDim flex-1">On IPFS · content-addressed (immutable).</p>
                <button
                  className="text-[11px] text-pcs-textDim hover:text-pcs-text transition"
                  onClick={() => setImageUrl("")}
                >
                  Remove
                </button>
              </div>
            )}
            <p className="text-[10px] text-pcs-textDim">PNG or JPG · auto-cropped to 500×500 · pinned to IPFS, not stored on-chain.</p>
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
          {usesOwnStack && (
            <p className="text-[11px] text-pcs-textDim -mt-1">
              Optional — saved as off-chain metadata: the image is pinned to IPFS and indexed to your
              token. After launch you&rsquo;ll sign a free message (no gas) to attach it.
            </p>
          )}
      </>

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
              {hasImage && (
                <TokenImage src={imageUrl} symbol={symbol} className="h-5 w-5 rounded-full text-[8px]" style={{ border: "1px solid #22252D" }} />
              )}
              {name.trim()} <span className="font-code">{symbol.trim()}</span>
            </span>
          </div>
          {(imageUrl || description) && (
            <div className="flex justify-between text-xs">
              <span className="text-pcs-textDim">Metadata</span>
              <span className="text-pcs-text font-medium">
                {[hasImage ? "image on IPFS" : null,
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
              <span>{usesOwnStack
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
              <span className="text-pcs-text font-medium">{usesOwnStack ? "0.0004 ETH flat" : "3% → 1% over the first hour"}</span>
            </div>
            <p className="text-[11px] text-pcs-textDim">{isHoodie
              ? "The 0.0004 ETH fee rides in your launch tx (no approval) — one tx, permanently $HOODIE-paired."
              : usesOwnStack
              ? "The 0.0004 ETH fee is paid directly in your launch transaction — one tx, no approval."
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

      {/* Action buttons — both pairs run the full preview → confirm → launch flow, a single launch tx each
          (HOODIE routes through the shared launcher; WETH through the factory). */}
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
          disabled={!formValid || previewing || uploading}
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
          {recipientConfirmed ? (isHoodie ? "Launch HOODIE-paired" : "Launch Token") : "Confirm recipient to launch"}
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
            {usesOwnStack
              ? "It's live on the launch pool now — all 1B seeded, liquidity custody-locked and growing as it earns fees."
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

          {/* Off-chain metadata save status — isolated from the launch (which already succeeded). */}
          {usesOwnStack && (launched.image || launched.description.trim()) && (
            <div className="mt-1 pt-2 text-[11px]" style={{ borderTop: "1px solid rgba(255,255,255,0.08)" }}>
              {metaState === "saving" && (
                <p className="text-pcs-textDim">Saving image &amp; description… confirm the free signature in your wallet.</p>
              )}
              {metaState === "saved" && (
                <p style={{ color: "#34C77B" }}>✓ Image &amp; description saved.</p>
              )}
              {metaState === "error" && (
                <div className="flex flex-col gap-1.5">
                  <p style={{ color: "#E8A33D" }}>Couldn&rsquo;t save the image/description — your token is live regardless; this is only its off-chain metadata.</p>
                  {metaError && <p className="text-pcs-textDim break-all">{metaError}</p>}
                  <button
                    className="self-start rounded-lg px-3 py-1.5 text-xs font-semibold"
                    style={{ background: "rgba(46,159,230,0.14)", color: "#54B4F0" }}
                    onClick={() => saveMetaFor(launched.token, launched.image, launched.description)}
                  >
                    Retry signature
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
