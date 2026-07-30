import { useEffect, useState } from "react";
import { formatUnits, toHex, type Hex, type PublicClient, type WalletClient } from "viem";
import { useAccount, usePublicClient, useSwitchChain, useWalletClient } from "wagmi";
import toast from "react-hot-toast";
import { Button, SectionLabel } from "./ui/kit";
import { TokenImage } from "./TokenImage";
import { ENGINE_META, v3ChainRow, type LaunchEngine } from "../utils/chainRegistry";
import { NETWORKS } from "../utils/constants";
import { AVATAR_SIZE, preCheckImageFile } from "../utils/imageValidation";
import { saveLaunchMeta } from "../utils/launchMeta";
import {
  executeTrenchV5Launch,
  previewTrenchV5Launch,
  trenchV5Manifest,
  type TrenchV5LaunchPreview,
  type TrenchV5LaunchStep,
} from "../utils/trenchV5";

const STEP_COPY: Record<TrenchV5LaunchStep, string> = {
  approve: "Approve the launch fee…",
  "approve-confirm": "Waiting for fee approval…",
  launch: "Confirm the V5 launch…",
  "launch-confirm": "Seeding the Trench Curve…",
};

function freshSalt(): Hex {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

function formatRouteFdv(value: bigint, decimals: number, symbol: string): string {
  const amount = Number(formatUnits(value, decimals));
  const formatted = amount.toLocaleString("en-US", {
    maximumFractionDigits: amount < 10 ? 4 : 2,
  });
  return symbol === "USDT0" || symbol === "USDC" ? `$${formatted}` : `${formatted} ${symbol}`;
}

async function toAvatarBlob(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = AVATAR_SIZE;
    canvas.height = AVATAR_SIZE;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("No 2D canvas context.");
    const scale = Math.max(AVATAR_SIZE / bitmap.width, AVATAR_SIZE / bitmap.height);
    const width = bitmap.width * scale;
    const height = bitmap.height * scale;
    context.drawImage(bitmap, (AVATAR_SIZE - width) / 2, (AVATAR_SIZE - height) / 2, width, height);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("Image encoding failed."))),
        "image/png",
      );
    });
  } finally {
    bitmap.close?.();
  }
}

export function TrenchV5LaunchForm({
  chainId,
  chainName,
  engine,
  onLaunched,
}: {
  chainId: number;
  chainName: string;
  engine: LaunchEngine;
  onLaunched?: () => void;
}) {
  const manifest = trenchV5Manifest(chainId);
  const network = NETWORKS.find((item) => item.id === chainId);
  const meta = ENGINE_META[engine];
  const { address, chainId: walletChainId, isConnected } = useAccount();
  const publicClient = usePublicClient({ chainId });
  const { data: walletClient } = useWalletClient({ chainId });
  const { switchChain } = useSwitchChain();
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [description, setDescription] = useState("");
  const [image, setImage] = useState("");
  const [salt, setSalt] = useState<Hex>(() => freshSalt());
  const [uploading, setUploading] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [preview, setPreview] = useState<TrenchV5LaunchPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [activeStep, setActiveStep] = useState<TrenchV5LaunchStep | null>(null);

  useEffect(() => {
    setPreview(null);
    setError(null);
    setConfirmed(false);
  }, [name, symbol, address, chainId]);

  if (!manifest) return null;
  const chainMismatch = isConnected && walletChainId !== chainId;
  const formValid = name.trim().length > 0 && /^[A-Z0-9]{1,10}$/.test(symbol);
  const hasImage = image.startsWith("ipfs://");
  const destination = engine === "v3-single-sided" ? "Uniswap V3 locked positions" : "Uniswap V4 locked positions";
  const v3Numeraire = engine === "v3-single-sided" ? v3ChainRow(chainId)?.numeraire : undefined;
  const quoteDecimals = v3Numeraire?.decimals ?? 18;
  const quoteSymbol = v3Numeraire?.symbol ?? "WETH";

  const uploadImage = async (file: File | undefined) => {
    if (!file) return;
    const check = preCheckImageFile(file);
    if (!check.ok) {
      toast.error(check.error);
      return;
    }
    setUploading(true);
    toast.loading("Preparing and pinning image…", { id: "v5-image" });
    try {
      const blob = await toAvatarBlob(file);
      const response = await fetch("/api/pin-image", {
        method: "POST",
        headers: { "Content-Type": "image/png" },
        body: blob,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || typeof payload?.uri !== "string" || !payload.uri.startsWith("ipfs://")) {
        throw new Error(payload?.error || "Image upload failed.");
      }
      setImage(payload.uri);
      toast.success("Image pinned to IPFS.", { id: "v5-image" });
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Image upload failed.", { id: "v5-image" });
    } finally {
      setUploading(false);
    }
  };

  const runPreview = async () => {
    if (!address || !publicClient || !formValid) return;
    setPreviewing(true);
    setError(null);
    try {
      const result = await previewTrenchV5Launch(publicClient as PublicClient, chainId, {
        name, symbol, salt, creator: address,
      });
      setPreview(result);
      toast.success("V5 pre-flight passed.", { id: "v5-preview" });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      setPreview(null);
      toast.error("V5 pre-flight failed.", { id: "v5-preview" });
    } finally {
      setPreviewing(false);
    }
  };

  const launch = async () => {
    if (!address || !publicClient || !walletClient || !preview || !confirmed) return;
    setSubmitting(true);
    setActiveStep(null);
    try {
      const result = await executeTrenchV5Launch(
        publicClient as PublicClient,
        walletClient as WalletClient,
        chainId,
        { name, symbol, salt, creator: address },
        (step) => {
          setActiveStep(step);
          toast.loading(STEP_COPY[step], { id: "v5-launch" });
        },
      );
      toast.success("Hydeout V5 token launched.", { id: "v5-launch", duration: 8000 });
      if (image || description.trim()) {
        try {
          await saveLaunchMeta(walletClient as WalletClient, address, {
            chainId,
            token: result.tokenAddress,
            image,
            description,
          });
        } catch {
          toast("Launch succeeded. Metadata can be retried from the token page.", { icon: "ℹ️" });
        }
      }
      setName("");
      setSymbol("");
      setDescription("");
      setImage("");
      setSalt(freshSalt());
      setPreview(null);
      setConfirmed(false);
      onLaunched?.();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      toast.error(/reject|denied|cancel/i.test(message) ? "Transaction cancelled." : message.slice(0, 170), {
        id: "v5-launch",
        duration: 7000,
      });
    } finally {
      setSubmitting(false);
      setActiveStep(null);
    }
  };

  return (
    <div className="mx-auto grid w-full max-w-[980px] overflow-hidden rounded-2xl border border-pcs-border bg-pcs-card shadow-card lg:grid-cols-[1fr_300px]">
      <section className="space-y-4 p-5 sm:p-7">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-pcs-border pb-5">
          <div>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="rounded-md border border-pcs-primary/30 bg-pcs-primary/10 px-2 py-1 font-mono text-[9px] font-semibold tracking-wider text-pcs-primaryBright">
                V5 · TRENCH CURVE
              </span>
              <span className="rounded-md border border-pcs-border px-2 py-1 font-mono text-[9px] text-pcs-textDim">
                {engine === "v3-single-sided" ? "V3 GRADUATION" : "V4 GRADUATION"}
              </span>
            </div>
            <h2 className="font-display text-2xl font-semibold text-pcs-text">Launch into the trench.</h2>
            <p className="mt-1 max-w-xl text-xs leading-5 text-pcs-textSub">
              Trading starts inside the live pool. At 100%, a delayed oracle check converts the
              temporary curve position into permanently locked liquidity.
            </p>
          </div>
          <span className="font-mono text-[10px] text-pcs-textDim">{chainName} · {chainId}</span>
        </div>

        <div className="grid gap-3 sm:grid-cols-[1fr_170px]">
          <label>
            <SectionLabel>Token name</SectionLabel>
            <input className="input mt-1.5" value={name} maxLength={64} placeholder="Trench Shark"
              onChange={(event) => setName(event.target.value)} />
          </label>
          <label>
            <SectionLabel>Symbol</SectionLabel>
            <input className="input mt-1.5 font-code" value={symbol} maxLength={10} placeholder="SHARK"
              onChange={(event) => setSymbol(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} />
          </label>
        </div>

        <div className="grid gap-4 rounded-xl border border-pcs-border bg-white/[0.015] p-4 sm:grid-cols-[150px_1fr]">
          <div>
            <SectionLabel>Token image</SectionLabel>
            {hasImage ? (
              <div className="relative mt-1.5 aspect-square overflow-hidden rounded-xl border border-pcs-border">
                <TokenImage src={image} symbol={symbol} className="h-full w-full rounded-xl text-3xl" />
                <button type="button" onClick={() => setImage("")}
                  className="absolute bottom-2 right-2 rounded-md bg-black/75 px-2 py-1 text-[10px] text-white">
                  Remove
                </button>
              </div>
            ) : (
              <label className="mt-1.5 flex aspect-square cursor-pointer items-center justify-center rounded-xl border border-dashed border-pcs-primary/35 bg-pcs-primary/[0.05] px-3 text-center text-xs font-semibold text-pcs-primaryBright">
                {uploading ? "Pinning…" : "Upload PNG or JPG"}
                <input type="file" accept="image/png,image/jpeg" className="hidden" disabled={uploading}
                  onChange={(event) => uploadImage(event.target.files?.[0])} />
              </label>
            )}
          </div>
          <label className="flex min-w-0 flex-col">
            <SectionLabel>Description</SectionLabel>
            <textarea className="input mt-1.5 min-h-[120px] flex-1 resize-none" value={description}
              maxLength={280} placeholder="Tell the market what is surfacing."
              onChange={(event) => setDescription(event.target.value)} />
            <span className="mt-1 text-right font-mono text-[9px] text-pcs-textDim">{description.length}/280</span>
          </label>
        </div>

        {error && (
          <div className="rounded-lg border border-pcs-warning/30 bg-pcs-warning/5 px-3 py-2 text-[11px] text-pcs-warning">
            {error}
          </div>
        )}

        {preview && address && (
          <div className="rounded-xl border border-pcs-primary/25 bg-pcs-primary/[0.04] p-4 text-xs">
            <div className="flex items-center gap-3">
              <TokenImage src={image} symbol={symbol} className="h-11 w-11 rounded-lg text-sm" />
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold text-pcs-text">{name} <span className="font-code text-pcs-textSub">${symbol}</span></p>
                <p className="mt-1 font-mono text-[9px] text-pcs-textDim">
                  {preview.tokenAddress ?? "Token address assigned after fee approval"}
                </p>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 border-y border-pcs-border py-3">
              <div><span className="text-pcs-textDim">Curve / reserve</span><strong className="mt-1 block text-pcs-text">80% / 20%</strong></div>
              <div><span className="text-pcs-textDim">Wallet actions</span><strong className="mt-1 block text-pcs-text">{preview.needsApproval ? "2 confirmations" : "1 confirmation"}</strong></div>
              <div><span className="text-pcs-textDim">Opening FDV</span><strong className="mt-1 block text-pcs-text">{formatRouteFdv(preview.startFdvRaw, quoteDecimals, quoteSymbol)}</strong></div>
              <div><span className="text-pcs-textDim">Graduation FDV</span><strong className="mt-1 block text-pcs-text">{formatRouteFdv(preview.graduationFdvRaw, quoteDecimals, quoteSymbol)}</strong></div>
              <div className="col-span-2"><span className="text-pcs-textDim">Curve proceeds at terminal range</span><strong className="mt-1 block text-pcs-text">{formatRouteFdv(preview.expectedTerminalProceeds, quoteDecimals, quoteSymbol)}</strong></div>
            </div>
            <label className="mt-3 flex cursor-pointer items-start gap-2 text-[11px] text-pcs-textSub">
              <input type="checkbox" className="mt-0.5 accent-pcs-primary" checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)} />
              <span>I understand the curve is reversible before graduation and all graduated LP is permanent.</span>
            </label>
          </div>
        )}

        {!isConnected ? (
          <div className="rounded-lg border border-dashed border-pcs-border px-4 py-3 text-center text-xs text-pcs-textDim">
            Connect your wallet to run the V5 pre-flight.
          </div>
        ) : chainMismatch ? (
          <Button className="w-full" size="lg" onClick={() => switchChain({ chainId })}>Switch to {chainName}</Button>
        ) : !preview ? (
          <Button className="w-full" size="lg" disabled={!formValid || previewing || uploading} onClick={runPreview}>
            {previewing ? "Verifying V5 deployment…" : "Preview Trench Curve launch"}
          </Button>
        ) : (
          <Button className="w-full" size="lg" disabled={!confirmed || submitting} onClick={launch}>
            {submitting && activeStep ? STEP_COPY[activeStep] : preview.needsApproval ? "Approve fee & launch V5" : "Launch V5 token"}
          </Button>
        )}
      </section>

      <aside className="border-t border-pcs-border bg-black/10 p-5 lg:border-l lg:border-t-0 sm:p-6">
        <p className="commandbar-label">V5 route manifest</p>
        <div className="mt-4 space-y-3 text-xs">
          {[
            ["Curve allocation", "80% · pool-native"],
            ["Graduation reserve", "20%"],
            ["Destination", destination],
            ["Creator fees", `${meta.creatorShare}%`],
            ["Hydeout", "5%"],
            ["Auto LP", engine === "v4-hook" ? "5%" : "—"],
            ["Graduation guard", "Delay + mature TWAP"],
          ].map(([label, value]) => (
            <div key={label} className="flex items-start justify-between gap-3 border-b border-pcs-border/70 pb-3">
              <span className="text-pcs-textDim">{label}</span>
              <strong className="max-w-[58%] text-right font-medium text-pcs-text">{value}</strong>
            </div>
          ))}
        </div>
        <div className="mt-5 rounded-xl border border-pcs-primary/20 bg-pcs-primary/[0.04] p-3">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-pcs-primaryBright">Permanent means permanent</p>
          <p className="mt-1 text-[10px] leading-5 text-pcs-textDim">
            Graduation mints replacement NFTs directly to a locker with no transfer, approval,
            decrease, burn, withdrawal, or arbitrary-call path.
          </p>
        </div>
        {preview && (
          <p className="mt-4 break-all font-mono text-[9px] leading-4 text-pcs-textDim">
            Factory {manifest.factory}<br />
            Fee {formatUnits(preview.feeAmount, preview.feeNative ? 18 : (engine === "v3-single-sided" ? 6 : 18))} {preview.feeNative ? network?.currencySymbol : "fee token"}
          </p>
        )}
      </aside>
    </div>
  );
}
