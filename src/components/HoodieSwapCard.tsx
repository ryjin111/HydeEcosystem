// In-app Buy/Sell for own-stack HOODIE-numeraire launches on 4663 (shiro 23777/23850). Trades go
// straight through the canonical UniversalRouter `execute()` (the Hyde gateway is NOT deployed on 4663),
// with a HOODIE→Permit2→router 2-step approval that persists (gojo 23870 → one-click on later trades).
// Quote + preflight run on eth_simulateV1 via the configured public RPC (kami 23869): an accurate fill
// that already prices trade impact, so `minOut` only buffers block drift and a fresh-block re-sim blocks
// any tx that would revert. Launch protection (anti-snipe fee decay + 1% max-wallet) is read live from the
// hook + token and shown ONLY while active — once expired the card is a plain clean swap (shiro 23867).
import { useCallback, useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import { formatUnits, maxUint160, maxUint256, maxUint48, type Address } from "viem";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import type { NetworkConfig } from "../utils/constants";
import { erc20Abi, permit2Abi, hydeHookAbi, hydeLaunchTokenAbi, universalRouterExecuteAbi } from "../utils/constants";
import {
  buildHoodieSwap, simulateHoodieSwap, hoodiePoolId, hoodieSwapContracts, launchFeePips, toUnits,
} from "../utils/hoodieSwap";
import { Card, SectionLabel } from "./ui/kit";

const GREEN = "#34C77B";
const RED = "#F6465D";

type TokenMeta = { address: Address; symbol: string; name: string; decimals: number };
type Props = { network: NetworkConfig; token: TokenMeta };

type Protection = { launchTime: number; expiry: number; maxWallet: bigint; window: number; startFee: number; baseFee: number };

const fmt = (v: bigint, decimals: number, max = 6) => {
  const n = Number(formatUnits(v, decimals));
  if (!Number.isFinite(n)) return "0";
  if (n > 0 && n < 1e-6) return "<0.000001";
  return n.toLocaleString("en-US", { maximumFractionDigits: max });
};
const mmss = (s: number) => `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;

export function HoodieSwapCard({ network, token }: Props) {
  const { address, isConnected, chainId } = useAccount();
  const publicClient = usePublicClient({ chainId: network.id });
  const { data: walletClient } = useWalletClient({ chainId: network.id });
  const { hoodie, universalRouter, permit2 } = hoodieSwapContracts(network.id);

  const [side, setSide] = useState<"buy" | "sell">("buy");
  const isBuy = side === "buy";
  const inMeta = isBuy ? { address: hoodie, symbol: "HOODIE", decimals: 18 } : { address: token.address, symbol: token.symbol, decimals: token.decimals };
  const outMeta = isBuy ? { address: token.address, symbol: token.symbol, decimals: token.decimals } : { address: hoodie, symbol: "HOODIE", decimals: 18 };

  const [amountIn, setAmountIn] = useState("");
  const [slippage, setSlippage] = useState("1"); // tight — sim already prices full impact (gojo 23870)
  const [simOut, setSimOut] = useState<bigint | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [inBalance, setInBalance] = useState<bigint | null>(null);
  const [tokenBalance, setTokenBalance] = useState<bigint | null>(null); // launch-token balance (for max-wallet)
  const [erc20Allow, setErc20Allow] = useState<bigint | null>(null);
  const [permit2Allow, setPermit2Allow] = useState<{ amount: bigint; expiration: number } | null>(null);
  const [protection, setProtection] = useState<Protection | null>(null);
  const [poolExists, setPoolExists] = useState<boolean | null>(null);
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  const [refreshTick, setRefreshTick] = useState(0);

  const chainMismatch = isConnected && chainId !== network.id;
  const amountUnits = toUnits(amountIn, inMeta.decimals);

  // 1s countdown tick (browser Date is fine here — the workflow-only restriction doesn't apply to app code).
  useEffect(() => {
    const id = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  // ── Protection params (per token): pool existence + launchTime from the hook, max-wallet from the token.
  useEffect(() => {
    if (!publicClient) return;
    let cancelled = false;
    (async () => {
      try {
        const { hook } = hoodieSwapContracts(network.id);
        const poolId = hoodiePoolId(token.address, network.id);
        const [active, window, startFee, baseFee, maxWallet, expiry] = await Promise.all([
          publicClient.readContract({ address: hook, abi: hydeHookAbi, functionName: "active", args: [poolId] }),
          publicClient.readContract({ address: hook, abi: hydeHookAbi, functionName: "antiSnipeWindow" }),
          publicClient.readContract({ address: hook, abi: hydeHookAbi, functionName: "startFee" }),
          publicClient.readContract({ address: hook, abi: hydeHookAbi, functionName: "baseFee" }),
          publicClient.readContract({ address: token.address, abi: hydeLaunchTokenAbi, functionName: "maxWallet" }),
          publicClient.readContract({ address: token.address, abi: hydeLaunchTokenAbi, functionName: "maxWalletExpiry" }),
        ]);
        if (cancelled) return;
        const [exists, , launchTime] = active as readonly [boolean, Address, bigint];
        setPoolExists(exists); // NEVER inferred from tick-liquidity=0 — the hook is the source of truth (gojo)
        setProtection({
          launchTime: Number(launchTime), expiry: Number(expiry as bigint), maxWallet: maxWallet as bigint,
          window: Number(window as bigint), startFee: Number(startFee as bigint), baseFee: Number(baseFee as bigint),
        });
      } catch {
        if (!cancelled) { setPoolExists(null); setProtection(null); }
      }
    })();
    return () => { cancelled = true; };
  }, [publicClient, token.address, network.id]);

  // ── Balances + allowances for the CURRENT input token (re-read on side/user/refresh, not per keystroke).
  useEffect(() => {
    if (!publicClient || !address) { setInBalance(null); setTokenBalance(null); setErc20Allow(null); setPermit2Allow(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const [inBal, tokBal, allowErc, allowP2] = await Promise.all([
          publicClient.readContract({ address: inMeta.address, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
          publicClient.readContract({ address: token.address, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
          publicClient.readContract({ address: inMeta.address, abi: erc20Abi, functionName: "allowance", args: [address, permit2] }),
          publicClient.readContract({ address: permit2, abi: permit2Abi, functionName: "allowance", args: [address, inMeta.address, universalRouter] }),
        ]);
        if (cancelled) return;
        setInBalance(inBal as bigint);
        setTokenBalance(tokBal as bigint);
        setErc20Allow(allowErc as bigint);
        const [amount, expiration] = allowP2 as readonly [bigint, number, number];
        setPermit2Allow({ amount: amount as bigint, expiration: Number(expiration) });
      } catch {
        if (!cancelled) { setInBalance(null); setErc20Allow(null); setPermit2Allow(null); }
      }
    })();
    return () => { cancelled = true; };
  }, [publicClient, address, inMeta.address, token.address, permit2, universalRouter, refreshTick]);

  // Permit2 persists across trades (gojo 23870): one-click once both legs cover the amount and haven't expired.
  const needsApprove = !!address && amountUnits > 0n && (
    erc20Allow === null || permit2Allow === null ||
    erc20Allow < amountUnits || permit2Allow.amount < amountUnits || permit2Allow.expiration <= nowSec
  );

  // ── Accurate quote via eth_simulateV1 (debounced). minOut=0 → max fill → true expected output.
  const quoteIdRef = useRef(0);
  useEffect(() => {
    const id = ++quoteIdRef.current;
    if (!publicClient || !address || amountUnits === 0n) { setSimOut(null); setQuoteErr(null); setQuoting(false); return; }
    if (inBalance !== null && amountUnits > inBalance) { setSimOut(null); setQuoteErr(`Insufficient ${inMeta.symbol}`); setQuoting(false); return; }
    setQuoting(true);
    const t = setTimeout(async () => {
      const sim = await simulateHoodieSwap({
        client: publicClient, user: address, token: token.address, decimals: token.decimals,
        isBuy, amountIn, amountOutQuoted: "0", slippagePercent: "0", chainId: network.id,
      });
      if (id !== quoteIdRef.current) return;
      setQuoting(false);
      if (sim.ok) { setSimOut(sim.out); setQuoteErr(null); }
      else { setSimOut(null); setQuoteErr(sim.reason ?? "Quote unavailable"); }
    }, 350);
    return () => clearTimeout(t);
  }, [publicClient, address, amountIn, side, inBalance, token.address, token.decimals, network.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Derived protection state
  const protActive = !!protection && nowSec < protection.expiry;
  const secondsLeft = protection ? Math.max(0, protection.expiry - nowSec) : 0;
  const feePct = protection ? launchFeePips(nowSec, protection.launchTime, protection.window, protection.startFee, protection.baseFee) / 1e6 * 100 : null;
  // 1% max-wallet caps only BUYs during the window; sells are never gated (gojo 23855).
  const capExceeded = protActive && isBuy && tokenBalance !== null && simOut !== null && protection !== null
    && tokenBalance + simOut > protection.maxWallet;

  const canSwap = Boolean(
    isConnected && !chainMismatch && !needsApprove && amountUnits > 0n && simOut !== null && !quoteErr && !capExceeded
    && inBalance !== null && amountUnits <= inBalance
  );

  const doApprove = async () => {
    if (!walletClient || !address) return;
    try {
      setApproving(true);
      toast.loading(`Approving ${inMeta.symbol}… (1/2)`, { id: "approve" });
      const h1 = await walletClient.writeContract({ address: inMeta.address, abi: erc20Abi, functionName: "approve", args: [permit2, maxUint256], account: address, chain: walletClient.chain });
      await publicClient!.waitForTransactionReceipt({ hash: h1 });
      toast.loading(`Approving ${inMeta.symbol}… (2/2)`, { id: "approve" });
      const h2 = await walletClient.writeContract({ address: permit2, abi: permit2Abi, functionName: "approve", args: [inMeta.address, universalRouter, maxUint160, Number(maxUint48)], account: address, chain: walletClient.chain });
      await publicClient!.waitForTransactionReceipt({ hash: h2 });
      toast.success(`${inMeta.symbol} approved`, { id: "approve" });
      setRefreshTick((t) => t + 1);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      toast.error(/reject|denied/i.test(msg) ? "Approval rejected" : "Approval failed", { id: "approve" });
    } finally { setApproving(false); }
  };

  const doSwap = useCallback(async () => {
    if (!walletClient || !publicClient || !address || simOut === null) return;
    const toastId = "hoodie-swap";
    try {
      setSubmitting(true);
      // Fresh-block preflight with the REAL minOut (kami 23869): block any tx that would revert.
      toast.loading("Checking price…", { id: toastId });
      const preflight = await simulateHoodieSwap({
        client: publicClient, user: address, token: token.address, decimals: token.decimals,
        isBuy, amountIn, amountOutQuoted: formatUnits(simOut, outMeta.decimals), slippagePercent: slippage, chainId: network.id,
      });
      if (!preflight.ok) { toast.error(preflight.reason ?? "Swap would revert — try again", { id: toastId }); setSubmitting(false); return; }
      const { commands, inputs } = buildHoodieSwap({
        token: token.address, decimals: token.decimals, isBuy, recipient: address,
        amountIn, amountOutQuoted: formatUnits(simOut, outMeta.decimals), slippagePercent: slippage, chainId: network.id,
      });
      toast.loading("Confirm in wallet…", { id: toastId });
      const hash = await walletClient.writeContract({
        address: universalRouter, abi: universalRouterExecuteAbi, functionName: "execute",
        args: [commands, inputs], value: 0n, account: address, chain: walletClient.chain,
      });
      toast.loading("Swapping…", { id: toastId });
      await publicClient.waitForTransactionReceipt({ hash });
      toast.success(`${isBuy ? "Bought" : "Sold"} ${token.symbol}`, { id: toastId });
      setAmountIn(""); setSimOut(null); setRefreshTick((t) => t + 1);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      if (/reject|denied/i.test(msg)) toast.error("Transaction rejected", { id: toastId });
      else toast.error(`Swap failed: ${msg.slice(0, 70)}`, { id: toastId });
    } finally { setSubmitting(false); }
  }, [walletClient, publicClient, address, simOut, isBuy, amountIn, slippage, token, outMeta.decimals, universalRouter, network.id]);

  const priceLine = simOut !== null && amountUnits > 0n
    ? `1 ${inMeta.symbol} ≈ ${fmt((simOut * (10n ** BigInt(inMeta.decimals))) / amountUnits, outMeta.decimals, 6)} ${outMeta.symbol}`
    : null;

  const setPct = (pct: number) => {
    if (inBalance === null) return;
    const v = (inBalance * BigInt(pct)) / 100n;
    setAmountIn(formatUnits(v, inMeta.decimals));
  };

  return (
    <Card variant="panel" data-testid="hoodie-swap">
      <div className="flex items-center justify-between">
        <SectionLabel>Trade</SectionLabel>
        {poolExists === false && <span className="text-[11px] text-pcs-textDim">pool not found</span>}
      </div>

      {/* Segmented Buy / Sell */}
      <div className="mt-3 grid grid-cols-2 gap-1 rounded-xl p-1" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid #22252D" }}>
        {(["buy", "sell"] as const).map((s) => {
          const on = side === s;
          const color = s === "buy" ? GREEN : RED;
          return (
            <button key={s} type="button" data-testid={`hoodie-side-${s}`} onClick={() => { setSide(s); setAmountIn(""); setSimOut(null); setQuoteErr(null); }}
              className="rounded-lg py-2 text-sm font-bold uppercase tracking-wide transition"
              style={on ? { background: color, color: "#04121C" } : { color: "#8B93A1" }}>
              {s}
            </button>
          );
        })}
      </div>

      {/* Amount in */}
      <div className="mt-3 rounded-2xl p-3" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid #1C1F26" }}>
        <div className="mb-1.5 flex items-center justify-between text-xs">
          <span className="text-pcs-textDim">You pay</span>
          {inBalance !== null && (
            <span className="text-pcs-textDim">Balance: {fmt(inBalance, inMeta.decimals, 4)} {inMeta.symbol}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <input className="min-w-0 flex-1 bg-transparent text-2xl font-semibold text-pcs-text outline-none placeholder:text-pcs-textDim"
            value={amountIn} onChange={(e) => { if (/^\d*\.?\d*$/.test(e.target.value)) setAmountIn(e.target.value); }}
            placeholder="0.0" inputMode="decimal" />
          <span data-testid="hoodie-pay-sym" className="shrink-0 rounded-lg px-2.5 py-1 text-sm font-semibold text-pcs-text" style={{ background: "rgba(255,255,255,0.05)" }}>{inMeta.symbol}</span>
        </div>
        <div className="mt-2 flex gap-1.5">
          {[25, 50, 100].map((p) => (
            <button key={p} type="button" onClick={() => setPct(p)} disabled={inBalance === null}
              className="rounded-md px-2 py-0.5 text-[10px] font-bold text-pcs-primary transition hover:bg-pcs-primary/10 disabled:opacity-40">
              {p === 100 ? "MAX" : `${p}%`}
            </button>
          ))}
        </div>
      </div>

      {/* Amount out (estimated, accurate sim) */}
      <div className="mt-2 rounded-2xl p-3" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid #1C1F26" }}>
        <div className="mb-1.5 text-xs text-pcs-textDim">You receive (estimated)</div>
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1 truncate text-2xl font-semibold text-pcs-text">
            {quoting ? <span className="text-pcs-textDim">…</span> : simOut !== null ? fmt(simOut, outMeta.decimals, 6) : <span className="text-pcs-textDim">0.0</span>}
          </div>
          <span className="shrink-0 rounded-lg px-2.5 py-1 text-sm font-semibold text-pcs-text" style={{ background: "rgba(255,255,255,0.05)" }}>{outMeta.symbol}</span>
        </div>
      </div>

      {priceLine && (
        <div className="mt-2 flex items-center justify-between px-1 text-xs">
          <span className="text-pcs-textDim">Rate</span>
          <span className="text-pcs-textSub">{priceLine}</span>
        </div>
      )}
      <div className="mt-1 flex items-center justify-between px-1 text-xs">
        <span className="text-pcs-textDim">Max slippage</span>
        <div className="flex items-center gap-1">
          {["0.5", "1", "3"].map((v) => (
            <button key={v} type="button" onClick={() => setSlippage(v)}
              className={`rounded px-1.5 py-0.5 text-[11px] font-medium transition ${slippage === v ? "bg-pcs-primary text-pcs-bg" : "text-pcs-textDim hover:text-pcs-text"}`}>{v}%</button>
          ))}
        </div>
      </div>

      {/* Launch protection — shown ONLY while active; hidden entirely once expired (shiro 23867). */}
      {protActive && protection && (
        <div data-testid="hoodie-protection" className="mt-3 rounded-xl p-2.5 text-[11px] leading-relaxed" style={{ background: "rgba(232,163,61,0.06)", border: "1px solid rgba(232,163,61,0.25)" }}>
          <div className="flex items-center justify-between">
            <span className="font-semibold text-pcs-warning">Launch protection · {mmss(secondsLeft)} left</span>
            {feePct !== null && <span className="font-mono text-pcs-textSub">fee {feePct.toFixed(2)}% → {(protection.baseFee / 1e6 * 100).toFixed(0)}%</span>}
          </div>
          <p className="mt-1 text-pcs-textDim">
            {isBuy ? "Buys are capped at 1% of supply per wallet during launch. Selling is unrestricted." : "Selling is unrestricted during launch."}
          </p>
        </div>
      )}

      {/* Action */}
      <div className="mt-4">
        {needsApprove && !chainMismatch && isConnected ? (
          <button data-testid="hoodie-action" onClick={doApprove} disabled={approving || amountUnits === 0n}
            className="w-full rounded-xl py-3 text-sm font-bold text-pcs-bg transition disabled:opacity-50"
            style={{ background: GREEN }}>
            {approving ? "Approving…" : `Approve ${inMeta.symbol}`}
          </button>
        ) : (
          <button data-testid="hoodie-action" onClick={doSwap} disabled={!canSwap || submitting}
            className="w-full rounded-xl py-3 text-sm font-bold transition disabled:opacity-50"
            style={{ background: canSwap ? (isBuy ? GREEN : RED) : "#22252D", color: canSwap ? "#04121C" : "#6b7280" }}>
            {submitting ? (isBuy ? "Buying…" : "Selling…")
              : !isConnected ? "Connect wallet"
              : chainMismatch ? "Wrong network"
              : amountUnits === 0n ? "Enter an amount"
              : inBalance !== null && amountUnits > inBalance ? `Insufficient ${inMeta.symbol}`
              : quoting ? "Fetching quote…"
              : capExceeded ? `Max 1% per wallet · ${mmss(secondsLeft)} left`
              : quoteErr ? quoteErr
              : simOut === null ? "Enter an amount"
              : isBuy ? `Buy ${token.symbol}` : `Sell ${token.symbol}`}
          </button>
        )}
      </div>

      <p className="mt-2.5 text-center text-[10px] text-pcs-textDim">
        Routed on-chain via the Hyde pool. Quote &amp; min-received simulated before you sign.
      </p>
    </Card>
  );
}
