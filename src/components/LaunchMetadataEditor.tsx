import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { useAccount, useSwitchChain, useWalletClient } from "wagmi";
import type { WalletClient } from "viem";
import { AVATAR_SIZE, preCheckImageFile } from "../utils/imageValidation";
import { saveLaunchMeta, type LaunchMeta } from "../utils/launchMeta";
import { TokenImage } from "./TokenImage";
import { Button, SectionLabel } from "./ui/kit";

type Props = {
  chainId: number;
  token: string;
  symbol: string;
  creator: string;
  initialMeta: LaunchMeta | null;
  onSaved: (meta: LaunchMeta) => void;
};

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

/** Creator-only recovery/editor for off-chain launch metadata. It gives launches whose original
 * post-confirmation signature failed a permanent retry path from the token page. */
export function LaunchMetadataEditor({
  chainId,
  token,
  symbol,
  creator,
  initialMeta,
  onSaved,
}: Props) {
  const { address, chainId: walletChainId } = useAccount();
  const { data: walletClient } = useWalletClient({ chainId });
  const { switchChain } = useSwitchChain();
  const [open, setOpen] = useState(false);
  const [image, setImage] = useState(initialMeta?.image ?? "");
  const [description, setDescription] = useState(initialMeta?.description ?? "");
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setImage(initialMeta?.image ?? "");
    setDescription(initialMeta?.description ?? "");
  }, [initialMeta?.image, initialMeta?.description, token]);

  if (!address || address.toLowerCase() !== creator.toLowerCase()) return null;

  const chainMismatch = walletChainId !== chainId;
  const hasImage = image.startsWith("ipfs://");
  const hasAnything = hasImage || description.trim().length > 0;

  const uploadImage = async (file: File | undefined) => {
    if (!file) return;
    const check = preCheckImageFile(file);
    if (!check.ok) {
      toast.error(check.error);
      return;
    }

    setUploading(true);
    setError(null);
    const toastId = "token-meta-pin";
    toast.loading("Preparing & pinning image…", { id: toastId });
    try {
      const blob = await toAvatarBlob(file);
      const response = await fetch("/api/pin-image", {
        method: "POST",
        headers: { "Content-Type": "image/png" },
        body: blob,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || typeof data?.uri !== "string" || !data.uri.startsWith("ipfs://")) {
        throw new Error(data?.error || `Image upload failed (${response.status})`);
      }
      setImage(data.uri);
      toast.success("Image pinned to IPFS.", { id: toastId });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message.slice(0, 180));
      toast.error("Image upload failed.", { id: toastId });
    } finally {
      setUploading(false);
    }
  };

  const save = async () => {
    if (!walletClient || !address || !hasAnything) return;
    setSaving(true);
    setError(null);
    try {
      await saveLaunchMeta(walletClient as WalletClient, address, {
        chainId,
        token,
        image,
        description,
      });
      const saved = { image, description: description.trim() };
      onSaved(saved);
      setOpen(false);
      toast.success("Token image & description saved.");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const cancelled = /reject|denied|cancelled/i.test(message);
      setError(cancelled ? "You cancelled the metadata signature." : message.slice(0, 180));
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-pcs-primary/25 bg-pcs-primary/[0.05] px-4 py-3">
        <div>
          <p className="text-xs font-semibold text-pcs-text">Creator metadata</p>
          <p className="mt-0.5 text-[10px] leading-4 text-pcs-textDim">
            {initialMeta?.image || initialMeta?.description
              ? "Update the image or description with a free creator signature."
              : "Attach the image and description that were missed after launch."}
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
          {initialMeta?.image || initialMeta?.description ? "Edit metadata" : "Add image & description"}
        </Button>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-pcs-primary/30 bg-pcs-cardLight p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <SectionLabel>Creator metadata</SectionLabel>
          <p className="mt-1 text-[11px] leading-5 text-pcs-textDim">
            Upload to IPFS, then confirm one free wallet signature. No transaction or gas.
          </p>
        </div>
        <button
          type="button"
          className="text-xs text-pcs-textDim transition hover:text-pcs-text"
          onClick={() => setOpen(false)}
        >
          Close
        </button>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-[150px,1fr]">
        <div>
          <SectionLabel>Token image</SectionLabel>
          {hasImage ? (
            <div className="relative mt-1.5 aspect-square overflow-hidden rounded-xl border border-pcs-border">
              <TokenImage src={image} symbol={symbol} className="h-full w-full rounded-xl text-3xl" />
              <button
                type="button"
                onClick={() => setImage("")}
                className="absolute bottom-2 right-2 rounded-md border border-white/15 bg-black/70 px-2 py-1 text-[10px] font-semibold text-white/85"
              >
                Remove
              </button>
            </div>
          ) : (
            <label
              htmlFor="creator-token-image"
              className={`mt-1.5 flex aspect-square items-center justify-center rounded-xl border border-dashed border-pcs-primary/35 bg-pcs-primary/[0.06] px-3 text-center text-xs font-semibold text-pcs-primaryBright ${
                uploading ? "cursor-wait opacity-60" : "cursor-pointer hover:border-pcs-primary/60"
              }`}
            >
              {uploading ? "Pinning…" : "Upload PNG or JPG"}
              <input
                id="creator-token-image"
                type="file"
                accept="image/png,image/jpeg"
                className="hidden"
                disabled={uploading}
                onChange={(event) => uploadImage(event.target.files?.[0])}
              />
            </label>
          )}
          <p className="mt-1.5 text-[9px] leading-4 text-pcs-textDim">Auto-cropped to 500×500 and pinned to IPFS.</p>
        </div>

        <label className="flex min-w-0 flex-col">
          <SectionLabel>Description</SectionLabel>
          <textarea
            className="input mt-1.5 min-h-[132px] flex-1 resize-none"
            value={description}
            maxLength={280}
            placeholder="Tell people what this token is about."
            onChange={(event) => setDescription(event.target.value)}
          />
          <div className="mt-1.5 flex justify-between text-[9px] text-pcs-textDim">
            <span>Stored with the creator-authenticated launch metadata.</span>
            <span className="font-mono">{description.length}/280</span>
          </div>
        </label>
      </div>

      {error && (
        <p className="mt-3 rounded-lg border border-pcs-warning/30 bg-pcs-warning/5 px-3 py-2 text-[11px] text-pcs-warning">
          {error}
        </p>
      )}

      <div className="mt-4 flex justify-end">
        {chainMismatch ? (
          <Button onClick={() => switchChain({ chainId })}>Switch network to save</Button>
        ) : (
          <Button disabled={!hasAnything || uploading || saving || !walletClient} onClick={save}>
            {saving ? "Confirm signature…" : "Save image & description"}
          </Button>
        )}
      </div>
    </div>
  );
}
