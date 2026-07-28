import { useEffect, useState } from "react";
import { formatUnits, toHex, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { useAccount, usePublicClient, useSwitchChain, useWalletClient } from "wagmi";
import toast from "react-hot-toast";
import { Badge, Button, SectionLabel } from "./ui/kit";
import { TokenImage } from "./TokenImage";
import {
  executeStableV3Launch,
  previewStableV3Launch,
  type StableV3LaunchPreview,
  type StableV3LaunchStep,
} from "../utils/stableV3Launch";
import { v3ChainRow } from "../utils/chainRegistry";
import { AVATAR_SIZE, preCheckImageFile } from "../utils/imageValidation";
import { saveLaunchMeta } from "../utils/launchMeta";

/** Normalize a picked PNG/JPG into the same exact square avatar used by V4 before pinning it. */
async function toAvatarBlob(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = AVATAR_SIZE;
    canvas.height = AVATAR_SIZE;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("no 2d context");
    const scale = Math.max(AVATAR_SIZE / bitmap.width, AVATAR_SIZE / bitmap.height);
    const width = bitmap.width * scale;
    const height = bitmap.height * scale;
    context.drawImage(
      bitmap,
      (AVATAR_SIZE - width) / 2,
      (AVATAR_SIZE - height) / 2,
      width,
      height,
    );
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("encode failed"))),
        "image/png",
      );
    });
  } finally {
    bitmap.close?.();
  }
}

const STEP_COPY: Record<StableV3LaunchStep, string> = {
  approve: "Approve 1 USDT0 in your wallet…",
  "approve-confirm": "Waiting for the USDT0 approval…",
  launch: "Confirm the token launch…",
  "launch-confirm": "Creating the pool and permanently locking liquidity…",
};

function freshSalt(): Hex {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

function shortAddress(value: string): string {
  return `${value.slice(0, 7)}…${value.slice(-5)}`;
}

export function StableV3LaunchForm({
  chainId,
  chainName,
  onLaunched,
}: {
  chainId: number;
  chainName: string;
  onLaunched?: () => void;
}) {
  const row = v3ChainRow(chainId);
  const { address, chainId: walletChainId, isConnected } = useAccount();
  const publicClient = usePublicClient({ chainId });
  const { data: walletClient } = useWalletClient({ chainId });
  const { switchChain } = useSwitchChain();

  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [description, setDescription] = useState("");
  const [uploading, setUploading] = useState(false);
  const [salt, setSalt] = useState<Hex>(() => freshSalt());
  const [preview, setPreview] = useState<StableV3LaunchPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [recipientConfirmed, setRecipientConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [activeStep, setActiveStep] = useState<StableV3LaunchStep | null>(null);
  const [metaState, setMetaState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [metaError, setMetaError] = useState<string | null>(null);
  const [launched, setLaunched] = useState<{
    token: Address;
    pool: Address;
    tx: string;
    tokenId: bigint;
    image: string;
    description: string;
  } | null>(null);

  useEffect(() => {
    setPreview(null);
    setPreviewError(null);
    setRecipientConfirmed(false);
  }, [name, symbol, imageUrl, description, address, chainId]);

  if (!row) return null;

  const pad = row.launchpad.pad;
  const explorer = row.explorer.replace(/\/$/, "");
  const chainMismatch = isConnected && walletChainId !== chainId;
  const formValid = name.trim().length > 0 && /^[A-Z0-9]{1,10}$/.test(symbol);
  const hasImage = imageUrl.startsWith("ipfs://");

  const saveMetaFor = async (token: string, image: string, tokenDescription: string) => {
    if (!walletClient || !address) {
      setMetaState("error");
      setMetaError("Wallet not connected — reconnect and retry.");
      return;
    }
    setMetaState("saving");
    setMetaError(null);
    try {
      await saveLaunchMeta(walletClient as WalletClient, address, {
        chainId,
        token,
        image,
        description: tokenDescription,
      });
      setMetaState("saved");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const cancelled = /reject|denied|cancelled/i.test(message);
      setMetaState("error");
      setMetaError(cancelled ? "You cancelled the metadata signature." : message.slice(0, 160));
    }
  };

  const handleImageFile = async (file: File | undefined) => {
    if (!file) return;
    const check = preCheckImageFile(file);
    if (!check.ok) {
      toast.error(check.error);
      return;
    }
    setUploading(true);
    const toastId = "stable-v3-pin";
    toast.loading("Preparing & pinning image…", { id: toastId });
    try {
      const blob = await toAvatarBlob(file);
      const response = await fetch("/api/pin-image", {
        method: "POST",
        headers: { "Content-Type": "image/png" },
        body: blob,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        toast.error(
          response.status === 503
            ? "Image uploads aren't available yet — you can launch without an image."
            : (data?.error || "Image upload failed."),
          { id: toastId, duration: 6000 },
        );
        return;
      }
      setImageUrl(data.uri as string);
      toast.success("Image pinned to IPFS.", { id: toastId });
    } catch {
      toast.error("Couldn't upload that image — try a different PNG or JPG.", { id: toastId });
    } finally {
      setUploading(false);
    }
  };

  const handlePreview = async () => {
    if (!address || !publicClient || !formValid) return;
    setPreviewing(true);
    setPreviewError(null);
    try {
      toast.loading("Checking the live Stable deployment…", { id: "stable-v3-preview" });
      const result = await previewStableV3Launch(publicClient as PublicClient, chainId, {
        name,
        symbol,
        creator: address,
        salt,
      });
      setPreview(result);
      toast.success("Pre-flight passed.", { id: "stable-v3-preview" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setPreviewError(message);
      setPreview(null);
      toast.error("Pre-flight failed.", { id: "stable-v3-preview" });
    } finally {
      setPreviewing(false);
    }
  };

  const handleLaunch = async () => {
    if (!address || !publicClient || !walletClient || !preview || !recipientConfirmed) return;
    setSubmitting(true);
    setActiveStep(null);
    try {
      const result = await executeStableV3Launch(
        publicClient as PublicClient,
        walletClient as WalletClient,
        chainId,
        { name, symbol, creator: address, salt },
        (step) => {
          setActiveStep(step);
          toast.loading(STEP_COPY[step], { id: "stable-v3-launch" });
        },
      );
      const savedImage = imageUrl;
      const savedDescription = description;
      setLaunched({
        token: result.tokenAddress,
        pool: result.poolAddress,
        tx: result.transactionHash,
        tokenId: result.tokenId,
        image: savedImage,
        description: savedDescription,
      });
      toast.success("Token launched on Stable.", { id: "stable-v3-launch", duration: 8000 });
      setName("");
      setSymbol("");
      setImageUrl("");
      setDescription("");
      setSalt(freshSalt());
      setPreview(null);
      setRecipientConfirmed(false);
      onLaunched?.();
      if (savedImage.startsWith("ipfs://") || savedDescription.trim()) {
        void saveMetaFor(result.tokenAddress, savedImage, savedDescription);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const cancelled = /reject|denied|cancelled/i.test(message);
      toast.error(cancelled ? "Transaction cancelled." : message.slice(0, 150), {
        id: "stable-v3-launch",
        duration: 7000,
      });
    } finally {
      setSubmitting(false);
      setActiveStep(null);
    }
  };

  return (
    <div className="mx-auto w-full max-w-[760px] overflow-hidden rounded-xl border border-pcs-border bg-pcs-card shadow-card">
      <div className="relative overflow-hidden border-b border-pcs-border px-5 py-5 sm:px-6">
        <div
          className="pointer-events-none absolute -right-16 -top-20 h-56 w-56 rounded-full border border-pcs-primary/10"
          aria-hidden="true"
        >
          <span className="absolute inset-7 rounded-full border border-pcs-primary/10" />
          <span className="absolute inset-16 rounded-full border border-pcs-primary/15" />
        </div>
        <div className="relative flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <Badge tone="success">● LIVE</Badge>
              <Badge tone="accent">V3 · SINGLE-SIDED</Badge>
              <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-pcs-textDim">
                Stable · 988
              </span>
            </div>
            <h2 className="font-display text-xl font-semibold text-pcs-text">Launch into the trench.</h2>
            <p className="mt-1 max-w-xl text-xs leading-relaxed text-pcs-textSub">
              One billion tokens seed a concentrated USDT0 pool. The LP position goes directly into
              permanent custody—no migration, no liquidity withdrawal.
            </p>
          </div>
          <a
            href={`${explorer}/address/${pad}`}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-md border border-pcs-border px-2.5 py-1.5 font-mono text-[10px] text-pcs-textDim transition hover:border-pcs-primary/40 hover:text-pcs-primary"
          >
            PAD {shortAddress(pad)} ↗
          </a>
        </div>
      </div>

      <div className="grid gap-0 lg:grid-cols-[1fr,260px]">
        <div className="space-y-4 p-5 sm:p-6">
          <div className="grid gap-3 sm:grid-cols-[1fr,160px]">
            <label className="block">
              <SectionLabel>Token name</SectionLabel>
              <input
                className="input mt-1.5"
                placeholder="e.g. Trench Shark"
                value={name}
                maxLength={64}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="block">
              <SectionLabel>Symbol</SectionLabel>
              <input
                className="input mt-1.5 font-code"
                placeholder="SHARK"
                value={symbol}
                maxLength={10}
                onChange={(event) => setSymbol(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
              />
            </label>
          </div>

          <div className="grid gap-3 rounded-xl border border-pcs-border bg-white/[0.015] p-3.5 sm:grid-cols-[150px,1fr]">
            <div>
              <SectionLabel>Token image</SectionLabel>
              {!hasImage ? (
                <label
                  htmlFor="stable-v3-token-image"
                  className={`mt-1.5 flex aspect-square items-center justify-center rounded-xl border border-dashed border-pcs-primary/35 bg-pcs-primary/[0.06] px-3 text-center text-xs font-semibold text-pcs-primaryBright transition ${
                    uploading ? "cursor-wait opacity-60" : "cursor-pointer hover:border-pcs-primary/60 hover:bg-pcs-primary/[0.09]"
                  }`}
                >
                  {uploading ? "Pinning…" : "Upload PNG or JPG"}
                  <input
                    id="stable-v3-token-image"
                    type="file"
                    accept="image/png,image/jpeg"
                    className="hidden"
                    disabled={uploading}
                    onChange={(event) => handleImageFile(event.target.files?.[0])}
                  />
                </label>
              ) : (
                <div className="relative mt-1.5 aspect-square overflow-hidden rounded-xl border border-pcs-border">
                  <TokenImage src={imageUrl} symbol={symbol} className="h-full w-full rounded-xl text-3xl" />
                  <button
                    type="button"
                    onClick={() => setImageUrl("")}
                    className="absolute bottom-2 right-2 rounded-md border border-white/15 bg-black/70 px-2 py-1 text-[10px] font-semibold text-white/85 backdrop-blur transition hover:text-white"
                  >
                    Remove
                  </button>
                </div>
              )}
              <p className="mt-1.5 text-[9px] leading-4 text-pcs-textDim">
                Auto-cropped to 500×500 and pinned to IPFS.
              </p>
            </div>

            <label className="flex min-w-0 flex-col">
              <SectionLabel>Description</SectionLabel>
              <textarea
                className="input mt-1.5 min-h-[116px] flex-1 resize-none"
                placeholder="Tell people what this token is about."
                value={description}
                maxLength={280}
                onChange={(event) => setDescription(event.target.value)}
              />
              <div className="mt-1.5 flex items-center justify-between gap-3 text-[9px] text-pcs-textDim">
                <span>Optional · attached after launch with a free signature.</span>
                <span className="font-mono">{description.length}/280</span>
              </div>
            </label>
          </div>

          {previewError && (
            <div className="rounded-lg border border-pcs-warning/30 bg-pcs-warning/5 px-3.5 py-3">
              <p className="text-xs font-semibold text-pcs-warning">Pre-flight did not pass</p>
              <p className="mt-1 break-words font-mono text-[10px] leading-relaxed text-pcs-textDim">
                {previewError.slice(0, 320)}
              </p>
            </div>
          )}

          {preview && address && (
            <div className="rounded-lg border border-pcs-primary/25 bg-pcs-primary/[0.04]">
              <div className="flex items-center gap-3 border-b border-pcs-border px-3.5 py-3">
                <TokenImage
                  src={imageUrl}
                  symbol={symbol}
                  className="h-10 w-10 shrink-0 rounded-lg text-sm"
                  style={{ border: "1px solid #22252D" }}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-pcs-text">
                    {name.trim()} <span className="font-mono text-xs text-pcs-textSub">${symbol}</span>
                  </p>
                  <p className="mt-0.5 truncate text-[10px] text-pcs-textDim">
                    {description.trim() || "No description added"}
                  </p>
                </div>
                <span className="shrink-0 font-mono text-[9px] uppercase tracking-wider text-pcs-primary">
                  V3 preview
                </span>
              </div>
              <div className="grid grid-cols-2 divide-x divide-pcs-border border-b border-pcs-border">
                <div className="px-3.5 py-3">
                  <p className="text-[10px] uppercase tracking-widest text-pcs-textDim">USDT0 balance</p>
                  <p className="mt-1 font-mono text-sm font-semibold text-pcs-text">
                    {Number(formatUnits(preview.balance, 6)).toLocaleString("en-US", { maximumFractionDigits: 4 })}
                  </p>
                </div>
                <div className="px-3.5 py-3">
                  <p className="text-[10px] uppercase tracking-widest text-pcs-textDim">Wallet actions</p>
                  <p className="mt-1 text-sm font-semibold text-pcs-text">
                    {preview.needsApproval ? "2 confirmations" : "1 confirmation"}
                  </p>
                </div>
              </div>
              <div className="space-y-2 px-3.5 py-3 text-xs">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-pcs-textDim">Token address</span>
                  <span className="max-w-[70%] break-all text-right font-mono text-[10px] text-pcs-text">
                    {preview.tokenAddress ?? "Assigned after approval"}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-pcs-textDim">Fee authorization</span>
                  <span className={preview.needsApproval ? "text-pcs-warning" : "text-pcs-success"}>
                    {preview.needsApproval ? "1 USDT0 approval required" : "Ready"}
                  </span>
                </div>
                <div className="border-t border-pcs-border pt-2">
                  <p className="text-pcs-textDim">Permanent creator and 95% fee recipient</p>
                  <p className="mt-1 break-all font-mono text-[10px] text-pcs-text">{address}</p>
                  <label className="mt-2 flex cursor-pointer items-start gap-2 text-[11px] text-pcs-textSub">
                    <input
                      type="checkbox"
                      className="mt-0.5 accent-pcs-primary"
                      checked={recipientConfirmed}
                      onChange={(event) => setRecipientConfirmed(event.target.checked)}
                    />
                    <span>I confirm this wallet is the permanent creator fee recipient.</span>
                  </label>
                </div>
              </div>
            </div>
          )}

          {!isConnected ? (
            <div className="rounded-lg border border-dashed border-pcs-border px-4 py-3 text-center text-xs text-pcs-textDim">
              Connect your wallet to run the launch pre-flight.
            </div>
          ) : chainMismatch ? (
            <Button className="w-full" size="lg" onClick={() => switchChain({ chainId })}>
              Switch to {chainName}
            </Button>
          ) : !preview ? (
            <Button
              className="w-full"
              size="lg"
              disabled={!formValid || previewing}
              onClick={handlePreview}
            >
              {previewing ? "Checking deployment…" : "Preview launch"}
            </Button>
          ) : (
            <Button
              className="w-full"
              size="lg"
              disabled={!recipientConfirmed || submitting}
              onClick={handleLaunch}
            >
              {submitting
                ? activeStep
                  ? STEP_COPY[activeStep]
                  : "Preparing launch…"
                : preview.needsApproval
                  ? "Approve 1 USDT0 & launch"
                  : "Launch token"}
            </Button>
          )}

          <p className="text-center font-mono text-[10px] text-pcs-textDim">
            Gas uses Stable’s native 18-decimal USDT0. The 1-USDT0 launch fee is the separate 6-decimal ERC-20.
          </p>
        </div>

        <aside className="border-t border-pcs-border bg-white/[0.015] p-5 lg:border-l lg:border-t-0">
          <SectionLabel>Token preview</SectionLabel>
          <div className="mt-3 rounded-xl border border-pcs-border bg-black/10 p-3">
            <div className="flex items-center gap-3">
              <TokenImage
                src={imageUrl}
                symbol={symbol}
                className="h-14 w-14 shrink-0 rounded-xl text-xl"
                style={{ border: "1px solid #22252D" }}
              />
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-pcs-text">{name.trim() || "Your token"}</p>
                <p className="mt-0.5 truncate font-mono text-[10px] text-pcs-textDim">
                  ${symbol || "TICKER"}
                </p>
              </div>
            </div>
            <p className="mt-3 line-clamp-3 text-[10px] leading-relaxed text-pcs-textDim">
              {description.trim() || "Your image will lead the card; your story will live on the token page."}
            </p>
          </div>

          <div className="my-4 border-t border-pcs-border" />

          <SectionLabel>Launch profile</SectionLabel>
          <div className="mt-3 space-y-3">
            {[
              ["Starting FDV", "$4,995.43"],
              ["Range ceiling", "$49,819.60"],
              ["Launch fee", "1 USDT0"],
              ["Pool fee tier", "1%"],
              ["Creator fees", "95%"],
              ["Hyde fees", "5%"],
            ].map(([label, value]) => (
              <div key={label} className="flex items-center justify-between gap-3 text-xs">
                <span className="text-pcs-textDim">{label}</span>
                <span className="font-mono font-semibold text-pcs-text">{value}</span>
              </div>
            ))}
          </div>

          <div className="my-4 border-t border-pcs-border" />

          <div className="space-y-3">
            <div className="flex gap-2.5">
              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-pcs-primary" />
              <div>
                <p className="text-xs font-medium text-pcs-text">Permanent LP custody</p>
                <p className="mt-0.5 text-[10px] leading-relaxed text-pcs-textDim">The position cannot be removed or migrated.</p>
              </div>
            </div>
            <div className="flex gap-2.5">
              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-pcs-primary" />
              <div>
                <p className="text-xs font-medium text-pcs-text">Anti-snipe window</p>
                <p className="mt-0.5 text-[10px] leading-relaxed text-pcs-textDim">2% max wallet for the first 10 minutes; selling remains open.</p>
              </div>
            </div>
            <div className="flex gap-2.5">
              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-pcs-primary" />
              <div>
                <p className="text-xs font-medium text-pcs-text">Canonical V3 pool</p>
                <p className="mt-0.5 text-[10px] leading-relaxed text-pcs-textDim">Trading is live on the canonical V3 pool; Hydeout links to the verified pool externally.</p>
              </div>
            </div>
          </div>
        </aside>
      </div>

      {launched && (
        <div className="border-t border-pcs-success/25 bg-pcs-success/[0.06] px-5 py-4 sm:px-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-pcs-success">Token launched and liquidity locked.</p>
              <p className="mt-1 font-mono text-[10px] text-pcs-textSub">
                Token {shortAddress(launched.token)} · Pool {shortAddress(launched.pool)} · NFT #{launched.tokenId.toString()}
              </p>
            </div>
            <div className="flex gap-2">
              <a href={`${explorer}/address/${launched.token}`} target="_blank" rel="noopener noreferrer" className="btn-ghost-term rounded-md px-3 py-1.5 text-xs">
                Token ↗
              </a>
              <a href={`${explorer}/tx/${launched.tx}`} target="_blank" rel="noopener noreferrer" className="btn-terminal rounded-md px-3 py-1.5 text-xs">
                Transaction ↗
              </a>
            </div>
          </div>
          {(launched.image || launched.description.trim()) && (
            <div className="mt-3 border-t border-pcs-success/20 pt-3 text-[11px]">
              {metaState === "saving" && (
                <p className="text-pcs-textSub">
                  Confirm the free wallet signature to attach the image and description.
                </p>
              )}
              {metaState === "saved" && (
                <p className="font-semibold text-pcs-success">✓ Image and description attached.</p>
              )}
              {metaState === "error" && (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="font-semibold text-pcs-warning">The token is live, but its metadata was not saved.</p>
                    {metaError && <p className="mt-0.5 break-all text-pcs-textDim">{metaError}</p>}
                  </div>
                  <button
                    type="button"
                    onClick={() => saveMetaFor(launched.token, launched.image, launched.description)}
                    className="rounded-md border border-pcs-primary/30 bg-pcs-primary/10 px-3 py-1.5 text-xs font-semibold text-pcs-primaryBright transition hover:bg-pcs-primary/15"
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
