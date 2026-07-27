import { useEffect, useState } from "react";
import { formatUnits, toHex, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { useAccount, usePublicClient, useSwitchChain, useWalletClient } from "wagmi";
import toast from "react-hot-toast";
import { Badge, Button, SectionLabel } from "./ui/kit";
import {
  executeStableV3Launch,
  previewStableV3Launch,
  type StableV3LaunchPreview,
  type StableV3LaunchStep,
} from "../utils/stableV3Launch";
import { v3ChainRow } from "../utils/chainRegistry";

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

export function StableV3LaunchForm({ chainId, chainName }: { chainId: number; chainName: string }) {
  const row = v3ChainRow(chainId);
  const { address, chainId: walletChainId, isConnected } = useAccount();
  const publicClient = usePublicClient({ chainId });
  const { data: walletClient } = useWalletClient({ chainId });
  const { switchChain } = useSwitchChain();

  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [salt, setSalt] = useState<Hex>(() => freshSalt());
  const [preview, setPreview] = useState<StableV3LaunchPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [recipientConfirmed, setRecipientConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [activeStep, setActiveStep] = useState<StableV3LaunchStep | null>(null);
  const [launched, setLaunched] = useState<{
    token: Address;
    pool: Address;
    tx: string;
    tokenId: bigint;
  } | null>(null);

  useEffect(() => {
    setPreview(null);
    setPreviewError(null);
    setRecipientConfirmed(false);
  }, [name, symbol, address, chainId]);

  if (!row) return null;

  const pad = row.launchpad.pad;
  const explorer = row.explorer.replace(/\/$/, "");
  const chainMismatch = isConnected && walletChainId !== chainId;
  const formValid = name.trim().length > 0 && /^[A-Z0-9]{1,10}$/.test(symbol);

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
      setLaunched({
        token: result.tokenAddress,
        pool: result.poolAddress,
        tx: result.transactionHash,
        tokenId: result.tokenId,
      });
      toast.success("Token launched on Stable.", { id: "stable-v3-launch", duration: 8000 });
      setName("");
      setSymbol("");
      setSalt(freshSalt());
      setPreview(null);
      setRecipientConfirmed(false);
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
                <p className="mt-0.5 text-[10px] leading-relaxed text-pcs-textDim">Trading is external for now; Hyde’s in-app V3 swap is not enabled.</p>
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
        </div>
      )}
    </div>
  );
}
