import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import { formatEther } from "viem";
import toast from "react-hot-toast";
import { useHydeLaunches } from "../hooks/useDopplerTokens";
import type { DopplerPool } from "../utils/dopplerConfig";
import { LaunchTokenForm } from "../components/LaunchTokenForm";
import { TokenImage } from "../components/TokenImage";
import { fetchLaunchMeta } from "../utils/launchMeta";
import { hydeVaultAbi, MAINNET_HOODIE_FEE_VAULT, MAINNET_WETH_FEE_VAULT, ROBINHOOD_TESTNET_VAULT } from "../utils/constants";
import { isClaimConfirmed, type ReplacedReason } from "../utils/txStatus";
import { readFeeState, runHarvest, feeDisplayState, nextHarvestStep, type FeeState, type HarvestStep, type StepStatus } from "../utils/hoodieFees";

const ROBINHOOD_CHAIN_ID = 4663;
const RH_TESTNET_CHAIN_ID = 46630;

/** The fee vault a pool's creator fees settle into, by (chain, numeraire) — HOODIE vault for HOODIE
 *  pairs, WETH vault for WETH pairs, testnet vault on 46630. `claimCreator(token)` pays the creator. */
function feeVaultFor(pool: DopplerPool): `0x${string}` {
  if (pool.chainId === RH_TESTNET_CHAIN_ID) return ROBINHOOD_TESTNET_VAULT as `0x${string}`;
  return (pool.quoteToken?.symbol === "HOODIE" ? MAINNET_HOODIE_FEE_VAULT : MAINNET_WETH_FEE_VAULT) as `0x${string}`;
}

// Harvest stepper visuals (shiro 23903 — visible 3-step progress, never a one-shot spinner).
const STEP_LABEL: Record<HarvestStep, string> = { collect: "Collect", settle: "Settle", claim: "Claim" };
const stepColor = (s: StepStatus | "idle"): string =>
  s === "done" ? "#34C77B" : s === "confirming" ? "#E0A32E" : s === "failed" ? "#F6465D" : "#7A828E";
const stepMark = (s: StepStatus | "idle"): string =>
  s === "done" ? "✓" : s === "failed" ? "✕" : s === "confirming" ? "…" : s === "skipped" ? "·" : "○";
const fmtHoodieAmt = (v: bigint): string => Number(formatEther(v)).toLocaleString("en-US", { maximumFractionDigits: 2 });

/* ─── helpers ─────────────────────────────────────────────────────────────── */

/** Compact USD — only ever called with a real number (tiles that lack data aren't rendered). */
function fmtUsd(n: number): string {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toPrecision(2)}`; // sub-$1 curve prices keep significant digits
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Creator-claimable WETH (vault wei as a decimal string) → BigInt, fail-neutral to 0n for sorting. */
function claimableBig(wei: string | null | undefined): bigint {
  try { return BigInt(wei ?? "0"); } catch { return 0n; }
}

/** Claimable-fee display in the pool's numeraire (`unit` = HOODIE for HOODIE pairs, WETH for WETH pairs;
 *  kami 23889 — never hardcode WETH). Honest: null read = "Unavailable"; a real "0" = settled-zero (legit,
 *  not fabricated); otherwise the amount (kami acceptance — never invent a value). */
function fmtClaimable(wei: string | null | undefined, unit = "WETH"): string {
  if (wei == null) return "Unavailable";
  try {
    const n = parseFloat(formatEther(BigInt(wei)));
    if (n === 0) return `0 ${unit}`;
    return `${n < 0.0001 ? n.toExponential(2) : n.toFixed(4)} ${unit}`;
  } catch {
    return "Unavailable";
  }
}

/* ─── Pool card (Explore tab) ─────────────────────────────────────────────── */

const CHAIN_LABELS: Record<number, string> = {
  4663: "Robinhood Chain",
  46630: "Robinhood Testnet",
};

/** Bigger launch card (clint 21605): the token NAME + $TICKER read in full (no more "A…" crush),
 *  with MCAP shown large. The per-card "ROBINHOOD CHAIN" pill is dropped — every launch is on the
 *  same chain (stated in the page/footer), and repeating it was what squeezed the name column.
 *  Metrics are honesty-gated: MCAP/Liquidity render ONLY when the DEXScreener pair is real
 *  (graduated + indexed); curve-stage tokens show the on-chain curve % instead — never a fake $. */
export function PoolCard({ pool, onTrade, showClaimable = false, onClaimed }: { pool: DopplerPool; onTrade: (addr: string, chainId: number) => void; showClaimable?: boolean; onClaimed?: () => void }) {
  const bt = pool.baseToken;
  const chainLabel = CHAIN_LABELS[pool.chainId] ?? `chain ${pool.chainId}`;
  const graduated = pool.type === "v2";
  const hasMcap = pool.marketCapUsd != null && pool.marketCapUsd > 0;
  const hasPrice = pool.priceUsd != null && pool.priceUsd > 0;
  const hasVol = pool.volumeUsd != null && parseFloat(pool.volumeUsd) > 0;
  // A real seed mcap with no trades yet gets a "new" marker so identical pre-trade caps
  // don't read as a placeholder (shiro).
  const untraded = hasMcap && !hasVol;

  // Image-forward look (clint / pump-style): own-stack tokens carry their image in the launch-meta
  // index (fail-neutral read → monogram). Mainnet chains return null here and use the monogram too.
  const [image, setImage] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchLaunchMeta(pool.chainId, bt.address).then((m) => { if (!cancelled) setImage(m?.image || null); });
    return () => { cancelled = true; };
  }, [pool.chainId, bt.address]);

  // One-tap copy of the token's contract address (clint). Async + honest: success is shown only after
  // the Clipboard write actually resolves; an absent/rejected API shows "copy failed", never a false
  // "✓ copied" (kami).
  const [copyState, setCopyState] = useState<"idle" | "ok" | "fail">("idle");
  const copyAddr = async () => {
    try {
      await navigator.clipboard.writeText(bt.address);
      setCopyState("ok");
    } catch {
      setCopyState("fail");
    }
    setTimeout(() => setCopyState("idle"), 1400);
  };

  // Settled-fee claim (My Launches only). SAFE by construction: the button renders ONLY when the vault's
  // creatorClaimable read is > 0, and `claimCreator` reverts only NOTHING (0) — so it can't revert on gas
  // (kami 23894). Collect/Settle stay non-interactive until gojo's live proof; a raw-but-unsettled balance
  // isn't wired here yet (LILHOODIE reads all-zero today → "No settled fees yet").
  const { address: wallet } = useAccount();
  const publicClient = usePublicClient({ chainId: pool.chainId });
  const { data: walletClient } = useWalletClient({ chainId: pool.chainId });
  const [claiming, setClaiming] = useState(false);
  const [claimed, setClaimed] = useState(false); // optimistic lock: hide the button the instant a claim lands
  const claimable = claimableBig(pool.creatorClaimable);
  const claimUnit = pool.quoteToken?.symbol ?? "WETH";
  const doClaim = async () => {
    if (!walletClient || !publicClient || !wallet) return;
    const vault = feeVaultFor(pool);
    const settle = () => { setClaimed(true); onClaimed?.(); }; // lock button + refetch the feed → read goes to 0
    try {
      setClaiming(true);
      toast.loading("Claiming fees…", { id: "claim" });
      // Fresh preflight immediately before the write (kami 23897): claim is permissionless, so the balance
      // can be drained between the displayed read and our submit. A NOTHING here = already claimed by someone
      // (or us) → lock + refresh, NEVER fire a reverting tx.
      try {
        await publicClient.simulateContract({ address: vault, abi: hydeVaultAbi, functionName: "claimCreator", args: [bt.address as `0x${string}`], account: wallet });
      } catch (sim) {
        if (/nothing/i.test(sim instanceof Error ? sim.message : "")) { toast.success("Already claimed", { id: "claim" }); settle(); return; }
        throw sim;
      }
      const hash = await walletClient.writeContract({
        address: vault, abi: hydeVaultAbi, functionName: "claimCreator",
        args: [bt.address as `0x${string}`], account: wallet, chain: walletClient.chain,
      });
      // viem resolves a reverted receipt AND every replacement receipt — including a successful
      // CANCELLATION self-tx — so we must classify before trusting success (kami 23902/23908). A claim
      // counts only for the original tx or a repriced speed-up; a cancel/replace/revert is NOT a claim.
      let replacedReason: ReplacedReason | null = null;
      const receipt = await publicClient.waitForTransactionReceipt({ hash, onReplaced: (r) => { replacedReason = r.reason as ReplacedReason; } });
      if (!isClaimConfirmed(receipt.status, replacedReason)) {
        if (replacedReason === "cancelled") toast("Claim cancelled", { id: "claim" });
        else toast.error("Claim didn't go through — refreshing", { id: "claim" });
        onClaimed?.(); // refetch to the truth; never false-success/lock
        return;
      }
      toast.success(`Claimed ${claimUnit} fees`, { id: "claim" });
      settle();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      if (/reject|denied/i.test(msg)) toast.error("Claim rejected", { id: "claim" });
      else if (/nothing/i.test(msg)) { toast.success("Already claimed", { id: "claim" }); settle(); }
      else toast.error("Claim failed", { id: "claim" });
    } finally { setClaiming(false); }
  };

  // ── Collect & Claim harvest (HOODIE pairs) ─ accrued-but-unsettled creator fees. The pending figure is
  // the REAL collect-sim output (gojo 23899) — read on card mount; the button runs the permissionless
  // collect→settle→claim pipeline as a resumable stepper. Only a user's own click/sign broadcasts; the app
  // never fires it (kami 23913). LT-leg swap-settle is a follow-up (rawLT ~0 today).
  const isHoodieFeePair = showClaimable && pool.chainId === ROBINHOOD_CHAIN_ID && pool.quoteToken?.symbol === "HOODIE";
  const [feeState, setFeeState] = useState<FeeState | null>(null);
  const [feeError, setFeeError] = useState(false); // read failed → "Unavailable", NEVER fail-open to 0 (kami #3)
  const [harvesting, setHarvesting] = useState(false);
  const [harvestFailed, setHarvestFailed] = useState(false);
  const [steps, setSteps] = useState<Record<HarvestStep, StepStatus | "idle">>({ collect: "idle", settle: "idle", claim: "idle" });
  const refreshFees = useCallback(async () => {
    if (!isHoodieFeePair || !publicClient) { setFeeState(null); setFeeError(false); return; }
    try { setFeeState(await readFeeState({ client: publicClient, token: bt.address as `0x${string}`, chainId: pool.chainId })); setFeeError(false); }
    catch { setFeeState(null); setFeeError(true); } // any failed sub-call → Unavailable
  }, [isHoodieFeePair, publicClient, bt.address, pool.chainId]);
  useEffect(() => { let off = false; if (!off) void refreshFees(); return () => { off = true; }; }, [refreshFees, claimed]);

  const startHarvest = async () => {
    if (!walletClient || !publicClient || !wallet) return;
    setHarvesting(true); setHarvestFailed(false);
    setSteps({ collect: "idle", settle: "idle", claim: "idle" });
    try {
      toast.loading("Harvesting fees…", { id: "harvest" });
      const { claimed: didClaim, ltPending } = await runHarvest({
        publicClient, walletClient, token: bt.address as `0x${string}`, wallet, chainId: pool.chainId,
        onStep: (step, status) => setSteps((s) => ({ ...s, [step]: status })),
      });
      // ltPending: true = LT fees remain · null = LT read failed (unknown — never imply "fully done",
      // kami 23937) · false = clear. The refetch below shows the authoritative post-harvest state regardless.
      if (ltPending === true) toast.success(didClaim ? "Numeraire fees claimed · token-side fees still settling" : "Token-side fees still settling", { id: "harvest" });
      else if (ltPending === null) toast.success("Harvest complete — refreshing to confirm…", { id: "harvest" });
      else toast.success(didClaim ? "Fees claimed" : "Already harvested", { id: "harvest" });
      onClaimed?.();
      await refreshFees();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      if (/reject|denied|cancelled/i.test(msg)) toast.error("Harvest cancelled — you can Resume", { id: "harvest" });
      else if (/price unstable|slippage|settle_dev|floor/i.test(msg)) toast.error("Settlement temporarily unavailable · price unstable", { id: "harvest" });
      else toast.error(msg && msg.length > 0 && msg.length < 56 ? msg : "Harvest didn't complete — you can Resume", { id: "harvest" });
      setHarvestFailed(true);
      onClaimed?.();
      await refreshFees(); // truth-driven refetch (kami #2): collapses to Claim X / lt-pending / none per fresh state
    } finally { setHarvesting(false); }
  };

  // Fee affordance — fresh feeState preferred over the (possibly stale) feed; optimistic `claimed` zeroes it.
  // For HOODIE pairs a failed read is `null` → "Unavailable" (never fail-open to the feed's 0 — kami #3).
  const feeLoading = isHoodieFeePair && !feeState && !feeError && !claimed;
  const effClaimable: bigint | null = claimed
    ? 0n
    : isHoodieFeePair
      ? feeError ? null : feeState?.claimable ?? 0n
      : pool.creatorClaimable == null ? null : claimable;
  const pendingHoodie = isHoodieFeePair && feeState ? feeState.pendingHoodie : 0n;
  const rawLTPending = isHoodieFeePair && feeState ? feeState.rawLT : 0n;
  const feeDisp = feeDisplayState(effClaimable, pendingHoodie, rawLTPending);
  // Resume label follows the actual first not-done step, not a hardcoded string (kami #2).
  const firstUndone = nextHarvestStep(steps);
  const resumeLabel = firstUndone === "collect" ? "Resume — Collect" : firstUndone === "claim" ? "Resume — Claim" : "Resume — Settle & Claim";

  // Whole card is the trade target (clint 23774: "this entire one is clickable, less hassle").
  // A11y (kami 23788): the card wrapper is NON-interactive; a single absolute full-card native
  // <button> overlay (rendered last, below) is the one focus stop — Enter/Space activate it natively,
  // no nested interactive content. The address-copy control is a SIBLING of that overlay (not nested)
  // raised above it by z-index, so it stays reliably exposed and copying never navigates. Focus ring
  // and hover-lift render on the VISIBLE wrapper (focus-within / hover), not the transparent overlay
  // (shiro 23791). Inline border-color is dropped so the hover:border-* class actually renders.
  const trade = () => onTrade(bt.address, pool.chainId);
  return (
    <div
      className="group relative rounded-2xl overflow-hidden flex flex-col border border-[#22252D] transition duration-[120ms] cursor-pointer hover:-translate-y-0.5 hover:border-pcs-primary/40 focus-within:border-pcs-primary/40 focus-within:ring-2 focus-within:ring-pcs-primary/70"
      style={{ background: "#121419" }}
    >
      {/* Image-forward header — the token image leads the card (pump-style). TokenImage falls back to a
          colored monogram when there's no image or it fails to load; the status pill overlays it. */}
      <div className="relative">
        <TokenImage src={image} symbol={bt.symbol} className="h-40 w-full text-4xl" style={{ borderRadius: 0, borderWidth: 0 }} />
        <span
          className="absolute top-3 right-3 text-[10px] font-semibold px-2 py-0.5 rounded-full uppercase tracking-wide"
          style={{ background: graduated ? "rgba(52,199,123,0.92)" : "rgba(46,159,230,0.92)", color: "#0B0D10" }}
        >
          {graduated ? "Graduated" : "Live"}
        </span>
      </div>

      <div className="p-4 flex flex-col gap-3">
        {/* Name + ticker */}
        <div className="min-w-0">
          <p className="font-display text-[15px] font-semibold text-pcs-text truncate leading-tight">{bt.name}</p>
          <p className="text-xs text-pcs-textDim mt-0.5">${bt.symbol}</p>
        </div>

        {/* Contract address — truncated + one-tap copy (clint). Real keyboard-focusable button, a
            SIBLING of the full-card overlay raised above it (z-20) so clicks/Enter here copy and
            never reach the overlay — no stopPropagation needed since it's not nested (kami 23788). */}
        <button
          onClick={copyAddr}
          title="Copy contract address"
          aria-label={`Copy contract address ${bt.address}`}
          className="relative z-20 flex items-center gap-1.5 w-fit rounded-md -mx-1 px-1 text-[11px] font-mono text-pcs-textDim hover:text-pcs-textSub transition focus:outline-none focus-visible:ring-2 focus-visible:ring-pcs-primary/70"
        >
          <span>{bt.address.slice(0, 6)}&hellip;{bt.address.slice(-4)}</span>
          <span
            className="text-[10px]"
            style={{ color: copyState === "ok" ? "#34C77B" : copyState === "fail" ? "#E8A33D" : undefined }}
          >
            {copyState === "ok" ? "✓ copied" : copyState === "fail" ? "copy failed" : "⧉"}
          </span>
        </button>

        {/* Market cap + price — real values only; honest "Not indexed" when unpriced, never $0.00 (kami). */}
        {hasMcap || hasPrice ? (
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-xl px-3 py-2" style={{ background: "rgba(255,255,255,0.03)" }}>
              <p className="text-[10px] uppercase tracking-wide text-pcs-textDim mb-0.5">Market cap</p>
              <p className="text-sm font-semibold text-pcs-text tabular-nums truncate">
                {hasMcap ? fmtUsd(pool.marketCapUsd as number) : <span className="text-pcs-textDim font-medium">Not indexed</span>}
                {untraded && hasMcap && <span className="ml-1 text-[9px] font-medium text-pcs-textDim uppercase">new</span>}
              </p>
            </div>
            <div className="rounded-xl px-3 py-2" style={{ background: "rgba(255,255,255,0.03)" }}>
              <p className="text-[10px] uppercase tracking-wide text-pcs-textDim mb-0.5">Price</p>
              <p className="text-sm font-semibold text-pcs-text tabular-nums truncate">
                {hasPrice ? fmtUsd(pool.priceUsd as number) : <span className="text-pcs-textDim font-medium">Not indexed</span>}
              </p>
            </div>
          </div>
        ) : (
          // Neither mcap nor price is third-party indexed (brand-new / testnet own-stack). Honest single
          // row — never a fabricated $0.00 (kami acceptance).
          <div className="rounded-xl px-3 py-2" style={{ background: "rgba(255,255,255,0.03)" }}>
            <p className="text-[10px] uppercase tracking-wide text-pcs-textDim mb-0.5">Market cap &middot; price</p>
            <p className="text-sm font-medium text-pcs-textDim">New launch &middot; not yet indexed</p>
          </div>
        )}

        {/* Claimable creator fees — shown only on My Launches. Real fees from the pair's vault, in the pool's
            numeraire (HOODIE / WETH); honest "Unavailable" for a null read, settled-zero for a real 0 — never
            fabricated (kami 23889). The one-click harvest itself lands with gojo's collect→settle→claim proof. */}
        {showClaimable && (
          <div
            className="rounded-xl px-3 py-2 space-y-2"
            style={{ background: "rgba(52,199,123,0.06)", border: "1px solid rgba(52,199,123,0.22)" }}
          >
            <div className="flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-wide text-pcs-textDim">
                {feeDisp === "awaiting" ? "Fees awaiting settlement" : feeDisp === "lt-pending" ? "Token-side fees" : "Claimable fees"}
              </span>
              <span
                className="text-sm font-semibold tabular-nums"
                style={{ color: feeDisp === "claim" || feeDisp === "awaiting" ? "#34C77B" : "#7A828E" }}
              >
                {/* claim = settled amount · awaiting = real collect-sim pending (~X, never "you earned
                    nothing" — shiro 23890/gojo 23899) · lt-pending = token-side fees exist, LT settle is a
                    follow-up (not "none") · none = settled-zero · unavailable = a failed read (never 0). */}
                {feeLoading
                  ? "Checking…"
                  : feeDisp === "unavailable"
                    ? "Unavailable"
                    : feeDisp === "claim"
                      ? fmtClaimable((effClaimable ?? 0n).toString(), claimUnit)
                      : feeDisp === "awaiting"
                        ? `~${fmtHoodieAmt(pendingHoodie)} HOODIE`
                        : feeDisp === "lt-pending"
                          ? "Settling"
                          : "No settled fees yet"}
              </span>
            </div>

            {!feeLoading && feeDisp === "claim" && (
              <button
                type="button"
                data-testid="claim-fees"
                onClick={(e) => { e.stopPropagation(); void doClaim(); }}
                disabled={claiming || !walletClient}
                className="relative z-20 w-full rounded-lg py-1.5 text-xs font-bold text-pcs-bg transition disabled:opacity-50"
                style={{ background: "#34C77B" }}
              >
                {claiming ? "Claiming…" : `Claim ${claimUnit}`}
              </button>
            )}

            {!feeLoading && feeDisp === "awaiting" && (
              <div className="space-y-1.5">
                {(harvesting || harvestFailed) && (
                  <div className="flex items-center justify-center gap-1.5 text-[10px] font-medium" data-testid="harvest-steps">
                    {(["collect", "settle", "claim"] as HarvestStep[]).map((st, i) => (
                      <span key={st} className="flex items-center gap-1">
                        {i > 0 && <span className="text-pcs-textDim">→</span>}
                        <span style={{ color: stepColor(steps[st]) }}>{stepMark(steps[st])} {STEP_LABEL[st]}</span>
                      </span>
                    ))}
                  </div>
                )}
                {!harvesting && (
                  <button
                    type="button"
                    data-testid="collect-claim"
                    onClick={(e) => { e.stopPropagation(); void startHarvest(); }}
                    disabled={!walletClient}
                    className="relative z-20 w-full rounded-lg py-1.5 text-xs font-bold text-pcs-bg transition disabled:opacity-50"
                    style={{ background: "#34C77B" }}
                  >
                    {harvestFailed ? resumeLabel : "Collect & Claim"}
                  </button>
                )}
                {harvesting && (
                  <p className="text-center text-[10px] text-pcs-textDim">Confirm each step in your wallet…</p>
                )}
              </div>
            )}

            {/* Token-side (LT) fees exist but the oracle-gated LT settle is a follow-up — honest, not "none". */}
            {!feeLoading && feeDisp === "lt-pending" && (
              <p className="text-[10px] leading-relaxed text-pcs-textDim">
                Token-side trading fees are accruing and will be claimable once LT settlement ships.
              </p>
            )}
          </div>
        )}

        {/* Curve progress — real % of the launch inventory BOUGHT, on-chain (non-graduated). Tooltip
            flags it's a live two-way level (rises on net buys, dips on net sells) — shiro 21736. */}
        {!graduated && pool.progress !== null && (
          <div title="% of the launch curve bought so far — rises on net buys, dips on net sells (a live level, not a one-way counter)">
            <div className="flex justify-between text-[10px] text-pcs-textDim mb-1">
              <span>Curve bought</span>
              <span className="tabular-nums">{pool.progress < 1 && pool.progress > 0 ? "<1" : Math.round(pool.progress)}%</span>
            </div>
            <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.06)" }}>
              <div
                className="h-full rounded-full"
                style={{ width: `${Math.max(pool.progress, pool.progress > 0 ? 2 : 0)}%`, background: "#2E9FE6" }}
              />
            </div>
          </div>
        )}

        {/* Footer — chain + age + Trade */}
        <div className="flex items-center justify-between mt-1">
          <span className="text-xs text-pcs-textDim truncate">{chainLabel} · {timeAgo(pool.createdAt)}</span>
          {/* Visual "Trade →" affordance only — the real control is the full-card overlay below;
              pointer-events-none lets clicks here fall through to it, brightens with the card on hover. */}
          <span
            aria-hidden="true"
            className="pointer-events-none text-xs font-semibold px-4 py-2 rounded-lg flex-shrink-0 transition group-hover:brightness-125"
            style={{ background: "rgba(46,159,230,0.12)", color: "#54B4F0" }}
          >
            Trade →
          </span>
        </div>
      </div>

      {/* Full-card click target — a single native <button> covering the card, sibling to the copy
          control (which sits above it via z-index). Native button = Enter/Space + focus for free;
          the visible focus ring / hover-lift live on the wrapper above (kami 23788, shiro 23791). */}
      <button
        type="button"
        aria-label={`Trade ${bt.name} ($${bt.symbol})`}
        onClick={trade}
        className="absolute inset-0 z-10 rounded-2xl outline-none"
      />
    </div>
  );
}

/* ─── Page ────────────────────────────────────────────────────────────────── */

const RH_TESTNET_ID = 46630;

export function LaunchpadPage({ chainId = ROBINHOOD_CHAIN_ID }: { chainId?: number }) {
  // Tab is URL-driven (?tab=launch|mine) so the sidebar "Launch a Token" reliably lands on the form.
  // The second tab is now "My Launches" (personal) — browsing all launches lives on the Landing (clint
  // ①). Accept the legacy ?tab=explore so old links still land on the tab. Default = launch.
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get("tab");
  const tab: "mine" | "launch" = tabParam === "mine" || tabParam === "explore" ? "mine" : "launch";
  const setTab = (t: "mine" | "launch") => setSearchParams({ tab: t });
  // Network-aware: on Robinhood Testnet this reads the LIVE own-stack factory; else the Doppler rail.
  const isTestnet = chainId === RH_TESTNET_ID;
  const { pools, loading, refetch } = useHydeLaunches(chainId);
  const navigate = useNavigate();
  const { address } = useAccount();

  // My Launches = the connected wallet's own-stack launches (creator/creatorClaimable are null on the
  // Doppler mainnet rail, so it's empty there). Sorted by claimable fees (desc) or market cap.
  const [sort, setSort] = useState<"claimable" | "mcap">("claimable");
  const mine = useMemo(
    () => (address ? pools.filter((p) => p.creator && p.creator.toLowerCase() === address.toLowerCase()) : []),
    [pools, address]
  );
  const shown = useMemo(() => {
    const arr = [...mine];
    if (sort === "claimable") {
      arr.sort((a, b) => {
        const av = claimableBig(a.creatorClaimable), bv = claimableBig(b.creatorClaimable);
        if (bv > av) return 1;
        if (bv < av) return -1;
        return a.address.localeCompare(b.address); // stable tie order
      });
    } else {
      arr.sort((a, b) => (b.marketCapUsd ?? 0) - (a.marketCapUsd ?? 0) || a.address.localeCompare(b.address));
    }
    return arr;
  }, [mine, sort]);

  const handleTrade = (tokenAddress: string, poolChainId: number) => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(tokenAddress)) return;
    // Hyde launches live on Robinhood mainnet (4663) OR the testnet own-stack (46630) — allow both;
    // the swap page trades on whichever network is selected in the dropdown (matches the board).
    if (poolChainId !== ROBINHOOD_CHAIN_ID && poolChainId !== RH_TESTNET_ID) return;
    navigate(`/swap?out=${tokenAddress}`);
  };

  return (
    <div className="max-w-6xl mx-auto px-4 w-full">
      {/* Testnet indicator — unmistakable; nothing can read as mainnet/real money (shiro #1). */}
      {isTestnet && (
        <div
          className="mb-4 flex items-center gap-2.5 rounded-xl px-4 py-2.5 text-sm"
          style={{ background: "rgba(224,163,46,0.10)", border: "1px solid rgba(224,163,46,0.35)", color: "#E0A32E" }}
        >
          <span className="text-base">🧪</span>
          <span>
            <span className="font-semibold">TESTNET — Robinhood 46630.</span> Live sandbox · custody-locked LP.
            Play money only — no real funds.
          </span>
        </div>
      )}

      {/* Header */}
      <div className="mb-8">
        <h1 className="font-display text-2xl font-semibold text-pcs-text">Launchpad</h1>
        <p className="text-sm text-pcs-textSub mt-1">
          {isTestnet
            ? "Live launches on Robinhood Testnet — custody-locked liquidity."
            : "Live token launches on Robinhood Chain."}
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 p-1 rounded-xl w-fit" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid #1C1F26" }}>
        {(["launch", "mine"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className="px-5 py-2 rounded-lg text-sm font-semibold transition"
            style={
              tab === t
                ? { background: "rgba(46,159,230,0.14)", color: "#54B4F0" }
                : { color: "#5D6470" }
            }
          >
            {t === "mine" ? "My Launches" : "Launch a Token"}
          </button>
        ))}
      </div>

      {/* My Launches tab — the connected wallet's own launches. Both live rails are own-stack now (mainnet
          4663 WETH factory + HOODIE engine, testnet 46630 factory), and BOTH carry indexed `creator` in
          their launch events, so "yours" is computable on either — no more testnet-only gate (clint 23887 /
          kami 23889: mainnet launches weren't reflecting because this was hidden off-testnet). */}
      {tab === "mine" && (
        <div>
          {/* Sort + refresh */}
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <label className="flex items-center gap-1.5 text-xs text-pcs-textDim">
              Sort
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as "claimable" | "mcap")}
                className="rounded-lg bg-pcs-card px-2 py-1 text-xs font-medium text-pcs-textSub outline-none cursor-pointer focus-visible:ring-2 focus-visible:ring-pcs-primary/70"
                style={{ border: "1px solid #22252D" }}
              >
                <option value="claimable">Claimable fees</option>
                <option value="mcap">Market cap</option>
              </select>
            </label>
            <button
              onClick={refetch}
              className="text-xs text-pcs-primary hover:underline"
              disabled={loading}
            >
              {loading ? "Refreshing…" : "Refresh"}
            </button>
          </div>

          <p className="text-sm text-pcs-textDim">
            {loading ? "Loading…" : `${shown.length} of your launch${shown.length !== 1 ? "es" : ""}`}
          </p>
          <p className="text-[11px] text-pcs-textDim/70 mt-0.5 mb-4">
            Live on-chain reads · your own launches
          </p>

          {/* Empty states — connect prompt (disconnected) / you-haven't-launched (connected, none) */}
          {!address ? (
            <div className="rounded-2xl p-10 text-center" style={{ background: "#121419", border: "1px solid #22252D" }}>
              <p className="text-pcs-textDim text-sm">Connect your wallet to see your launches.</p>
            </div>
          ) : !loading && shown.length === 0 ? (
            <div className="rounded-2xl p-10 text-center" style={{ background: "#121419", border: "1px solid #22252D" }}>
              <p className="text-pcs-textDim text-sm">You haven't launched any tokens yet.</p>
              <p className="text-pcs-textDim text-xs mt-1">Browse everyone's launches on the home page.</p>
              <button onClick={() => setTab("launch")} className="btn-primary mt-4 px-5 py-2 text-sm">
                Launch a Token
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {shown.map((pool) => (
                <PoolCard
                  key={`${pool.chainId}-${pool.address}-${pool.baseToken.address}`}
                  pool={pool}
                  onTrade={handleTrade}
                  showClaimable
                  onClaimed={refetch}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Launch tab — network-aware: own-stack HydeTokenFactory on testnet, Doppler rail on mainnet */}
      {tab === "launch" && <LaunchTokenForm chainId={chainId} />}
    </div>
  );
}
