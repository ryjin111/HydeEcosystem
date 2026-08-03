import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import { formatUnits, maxUint256, type Address } from "viem";
import { ConnectorAlreadyConnectedError, useAccount, useConnect, usePublicClient, useSwitchChain, useWalletClient } from "wagmi";
import type { NetworkConfig } from "../utils/constants";
import {
  assertStableV3SwapDeployment,
  preflightStableV3Swap,
  quoteStableV3Swap,
  stableV3Amount,
  stableV3MinOut,
  stableV3SwapConfig,
  stableV3SwapErc20Abi,
  stableV3SwapRouterAbi,
  stableV3SwapTokens,
  type StableV3SwapSide,
} from "../utils/stableV3Swap";
import { Card, SectionLabel } from "./ui/kit";

const GREEN = "#34C77B";
const RED = "#F6465D";

type TokenMeta = { address: Address; symbol: string; name: string; decimals: number };
type Props = { network: NetworkConfig; token: TokenMeta };
type Protection = { maxWallet: bigint; expiry: number };

function displayAmount(value: bigint, decimals: number, max = 6): string {
  const numeric = Number(formatUnits(value, decimals));
  if (!Number.isFinite(numeric)) return "0";
  if (numeric > 0 && numeric < 0.000001) return "<0.000001";
  return numeric.toLocaleString("en-US", { maximumFractionDigits: max });
}

function errorCopy(error: unknown, fallback: string): string {
  const value = error as { shortMessage?: string; message?: string };
  const message = value?.shortMessage || value?.message || fallback;
  if (/insufficient allowance/i.test(message)) return "Approval is required.";
  if (/insufficient.*balance|transfer amount exceeds balance/i.test(message)) return "Insufficient balance.";
  if (/max.?wallet|wallet cap/i.test(message)) return "Launch wallet cap would be exceeded.";
  return message.length > 92 ? `${message.slice(0, 89)}…` : message;
}

export function StableV3SwapCard({ network, token }: Props) {
  const { address, isConnected, chainId } = useAccount();
  const { switchChain } = useSwitchChain();
  const { connectAsync, connectors, isPending: connecting } = useConnect();
  const publicClient = usePublicClient({ chainId: network.id });
  const { data: walletClient } = useWalletClient({ chainId: network.id });
  const config = useMemo(() => stableV3SwapConfig(network.id), [network.id]);

  const [side, setSide] = useState<StableV3SwapSide>("buy");
  const [amount, setAmount] = useState("");
  const [slippageBps, setSlippageBps] = useState(100);
  const [quoteOut, setQuoteOut] = useState<bigint | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [tokenBalance, setTokenBalance] = useState<bigint | null>(null);
  const [allowance, setAllowance] = useState<bigint | null>(null);
  const [protection, setProtection] = useState<Protection | null>(null);
  const [approving, setApproving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  const quoteRequest = useRef(0);

  const connectWallet = async () => {
    const connector = connectors[0];
    if (!connector) return toast.error("Wallet connector not found.");
    try {
      await connectAsync({ connector });
    } catch (cause) {
      if (!(cause instanceof ConnectorAlreadyConnectedError)) toast.error("Wallet connection failed.");
    }
  };

  const isBuy = side === "buy";
  const input = isBuy
    ? { address: config.numeraire, symbol: config.numeraireSymbol, decimals: config.numeraireDecimals }
    : { address: token.address, symbol: token.symbol, decimals: token.decimals };
  const output = isBuy
    ? { address: token.address, symbol: token.symbol, decimals: token.decimals }
    : { address: config.numeraire, symbol: config.numeraireSymbol, decimals: config.numeraireDecimals };
  const amountIn = stableV3Amount(amount, input.decimals);
  const wrongNetwork = isConnected && chainId !== network.id;

  useEffect(() => {
    const timer = window.setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!publicClient) return;
    let cancelled = false;
    Promise.all([
      publicClient.readContract({ address: token.address, abi: stableV3SwapErc20Abi, functionName: "maxWallet" }),
      publicClient.readContract({ address: token.address, abi: stableV3SwapErc20Abi, functionName: "maxWalletExpiry" }),
    ]).then(([maxWallet, expiry]) => {
      if (!cancelled) setProtection({ maxWallet, expiry: Number(expiry) });
    }).catch(() => {
      if (!cancelled) setProtection(null);
    });
    return () => { cancelled = true; };
  }, [publicClient, token.address]);

  useEffect(() => {
    if (!publicClient || !address) {
      setBalance(null);
      setTokenBalance(null);
      setAllowance(null);
      return;
    }
    let cancelled = false;
    Promise.all([
      publicClient.readContract({ address: input.address, abi: stableV3SwapErc20Abi, functionName: "balanceOf", args: [address] }),
      publicClient.readContract({ address: token.address, abi: stableV3SwapErc20Abi, functionName: "balanceOf", args: [address] }),
      publicClient.readContract({ address: input.address, abi: stableV3SwapErc20Abi, functionName: "allowance", args: [address, config.router] }),
    ]).then(([inputBalance, launchTokenBalance, inputAllowance]) => {
      if (cancelled) return;
      setBalance(inputBalance);
      setTokenBalance(launchTokenBalance);
      setAllowance(inputAllowance);
    }).catch(() => {
      if (!cancelled) {
        setBalance(null);
        setTokenBalance(null);
        setAllowance(null);
      }
    });
    return () => { cancelled = true; };
  }, [publicClient, address, input.address, token.address, config.router, refresh]);

  useEffect(() => {
    const request = ++quoteRequest.current;
    if (!publicClient || amountIn <= 0n) {
      setQuoteOut(null);
      setQuoteError(null);
      setQuoting(false);
      return;
    }
    setQuoting(true);
    setQuoteError(null);
    const timer = window.setTimeout(() => {
      quoteStableV3Swap(publicClient, network.id, token.address, side, amountIn)
        .then((quote) => {
          if (request !== quoteRequest.current) return;
          setQuoteOut(quote.amountOut);
          setQuoteError(null);
        })
        .catch((error) => {
          if (request !== quoteRequest.current) return;
          setQuoteOut(null);
          setQuoteError(errorCopy(error, "Quote unavailable."));
        })
        .finally(() => {
          if (request === quoteRequest.current) setQuoting(false);
        });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [publicClient, amountIn, balance, input.symbol, network.id, token.address, side]);

  const protectionActive = !!protection && nowSec < protection.expiry;
  const secondsLeft = protection ? Math.max(0, protection.expiry - nowSec) : 0;
  const capExceeded = protectionActive && isBuy && tokenBalance !== null && quoteOut !== null
    && protection !== null && tokenBalance + quoteOut > protection.maxWallet;
  const needsApproval = isConnected && amountIn > 0n && (allowance === null || allowance < amountIn);
  const insufficient = balance !== null && amountIn > balance;
  const canSwap = isConnected && !wrongNetwork && !needsApproval && amountIn > 0n
    && quoteOut !== null && !quoteError && !insufficient && !capExceeded;

  const selectSide = (next: StableV3SwapSide) => {
    setSide(next);
    setAmount("");
    setQuoteOut(null);
    setQuoteError(null);
  };

  const setPercent = (percent: number) => {
    if (balance === null) return;
    setAmount(formatUnits((balance * BigInt(percent)) / 100n, input.decimals));
  };

  const approve = async () => {
    if (!walletClient || !publicClient || !address) return;
    const toastId = "stable-v3-approve";
    try {
      setApproving(true);
      toast.loading(`Approve ${input.symbol} in your wallet…`, { id: toastId });
      const hash = await walletClient.writeContract({
        address: input.address,
        abi: stableV3SwapErc20Abi,
        functionName: "approve",
        args: [config.router, maxUint256],
        account: address,
        chain: walletClient.chain,
      });
      toast.loading("Confirming approval…", { id: toastId });
      const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
      if (receipt.status !== "success") throw new Error("Approval reverted on-chain.");
      toast.success(`${input.symbol} approved`, { id: toastId });
      setRefresh((value) => value + 1);
    } catch (error) {
      toast.error(errorCopy(error, "Approval failed."), { id: toastId });
    } finally {
      setApproving(false);
    }
  };

  const swap = useCallback(async () => {
    if (!walletClient || !publicClient || !address || quoteOut === null || amountIn <= 0n) return;
    const toastId = "stable-v3-swap";
    try {
      setSubmitting(true);
      toast.loading("Checking live price…", { id: toastId });
      await assertStableV3SwapDeployment(publicClient, network.id);
      const freshQuote = await quoteStableV3Swap(publicClient, network.id, token.address, side, amountIn);
      const minimumOut = stableV3MinOut(freshQuote.amountOut, slippageBps);
      await preflightStableV3Swap(
        publicClient,
        network.id,
        address,
        token.address,
        side,
        amountIn,
        minimumOut,
      );
      const { tokenIn, tokenOut } = stableV3SwapTokens(network.id, token.address, side);
      toast.loading("Confirm swap in your wallet…", { id: toastId });
      const hash = await walletClient.writeContract({
        address: config.router,
        abi: stableV3SwapRouterAbi,
        functionName: "exactInputSingle",
        args: [{
          tokenIn,
          tokenOut,
          fee: config.feeTier,
          recipient: address,
          amountIn,
          amountOutMinimum: minimumOut,
          sqrtPriceLimitX96: 0n,
        }],
        value: 0n,
        account: address,
        chain: walletClient.chain,
      });
      toast.loading("Swap submitted…", { id: toastId });
      const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
      if (receipt.status !== "success") throw new Error("Swap reverted on-chain.");
      toast.success(`${isBuy ? "Bought" : "Sold"} ${token.symbol}`, { id: toastId });
      setAmount("");
      setQuoteOut(null);
      setRefresh((value) => value + 1);
    } catch (error) {
      toast.error(errorCopy(error, "Swap failed."), { id: toastId });
    } finally {
      setSubmitting(false);
    }
  }, [
    walletClient, publicClient, address, quoteOut, amountIn, network.id, token.address,
    token.symbol, side, slippageBps, config.router, config.feeTier, isBuy,
  ]);

  const minimumReceived = quoteOut === null ? null : stableV3MinOut(quoteOut, slippageBps);
  const protectionMinutes = Math.floor(secondsLeft / 60);
  const protectionSeconds = String(secondsLeft % 60).padStart(2, "0");

  return (
    <Card variant="panel" data-testid="stable-v3-swap">
      <div className="flex items-center justify-between">
        <SectionLabel>Trade</SectionLabel>
        <span className="rounded-md border border-pcs-primary/25 bg-pcs-primary/10 px-1.5 py-0.5 font-mono text-[9px] font-semibold text-pcs-primaryBright">
          V3 · 1% pool
        </span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-1 rounded-xl border border-[#22252D] bg-white/[0.03] p-1">
        {(["buy", "sell"] as const).map((next) => {
          const active = side === next;
          const color = next === "buy" ? GREEN : RED;
          return (
            <button
              key={next}
              type="button"
              onClick={() => selectSide(next)}
              className="rounded-lg py-2 text-sm font-bold uppercase tracking-wide transition"
              style={active ? { background: color, color: "#04121C" } : { color: "#8B93A1" }}
            >
              {next}
            </button>
          );
        })}
      </div>

      <div className="mt-3 rounded-2xl border border-[#1C1F26] bg-white/[0.02] p-3">
        <div className="mb-1.5 flex items-center justify-between text-xs text-pcs-textDim">
          <span>You pay</span>
          {balance !== null && <span>Balance: {displayAmount(balance, input.decimals, 4)}</span>}
        </div>
        <div className="flex items-center gap-2">
          <input
            aria-label={`Amount of ${input.symbol} to swap`}
            className="min-w-0 flex-1 bg-transparent text-2xl font-semibold text-pcs-text outline-none placeholder:text-pcs-textDim"
            value={amount}
            onChange={(event) => {
              if (/^\d*\.?\d*$/.test(event.target.value)) setAmount(event.target.value);
            }}
            placeholder="0.0"
            inputMode="decimal"
          />
          <span className="shrink-0 rounded-lg bg-white/[0.05] px-2.5 py-1 text-sm font-semibold text-pcs-text">
            {input.symbol}
          </span>
        </div>
        <div className="mt-2 flex gap-1.5">
          {[25, 50, 100].map((percent) => (
            <button
              key={percent}
              type="button"
              onClick={() => setPercent(percent)}
              disabled={balance === null}
              className="rounded-md px-2 py-0.5 text-[10px] font-bold text-pcs-primary transition hover:bg-pcs-primary/10 disabled:opacity-40"
            >
              {percent === 100 ? "MAX" : `${percent}%`}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-2 rounded-2xl border border-[#1C1F26] bg-white/[0.02] p-3">
        <div className="mb-1.5 text-xs text-pcs-textDim">You receive (estimated)</div>
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1 truncate text-2xl font-semibold text-pcs-text">
            {quoting ? "…" : quoteOut !== null ? displayAmount(quoteOut, output.decimals) : <span className="text-pcs-textDim">0.0</span>}
          </div>
          <span className="shrink-0 rounded-lg bg-white/[0.05] px-2.5 py-1 text-sm font-semibold text-pcs-text">
            {output.symbol}
          </span>
        </div>
      </div>

      <div className="mt-2 space-y-1 px-1 text-xs">
        <div className="flex items-center justify-between">
          <span className="text-pcs-textDim">Max slippage</span>
          <div className="flex items-center gap-1">
            {[50, 100, 300].map((bps) => (
              <button
                key={bps}
                type="button"
                onClick={() => setSlippageBps(bps)}
                className={`rounded px-1.5 py-0.5 text-[11px] font-medium transition ${slippageBps === bps ? "bg-pcs-primary text-pcs-bg" : "text-pcs-textDim hover:text-pcs-text"}`}
              >
                {bps / 100}%
              </button>
            ))}
          </div>
        </div>
        {minimumReceived !== null && (
          <div className="flex items-center justify-between gap-3">
            <span className="text-pcs-textDim">Minimum received</span>
            <span className="truncate text-pcs-textSub">{displayAmount(minimumReceived, output.decimals)} {output.symbol}</span>
          </div>
        )}
      </div>

      {protectionActive && protection && (
        <div className="mt-3 rounded-xl border border-pcs-warning/25 bg-pcs-warning/[0.06] p-2.5 text-[11px] leading-relaxed">
          <div className="flex items-center justify-between">
            <span className="font-semibold text-pcs-warning">Launch protection</span>
            <span className="font-mono text-pcs-textSub">{protectionMinutes}m {protectionSeconds}s</span>
          </div>
          <p className="mt-1 text-pcs-textDim">
            {isBuy ? "Buys are capped at 2% of supply per wallet for the first 10 minutes. Selling is unrestricted." : "Selling is unrestricted during launch protection."}
          </p>
        </div>
      )}

      <div className="mt-4">
        {!isConnected ? (
          <button type="button" onClick={connectWallet} disabled={connecting}
            className="w-full rounded-xl bg-pcs-primary py-3 text-sm font-bold text-pcs-bg disabled:opacity-50">
            {connecting ? "Connecting…" : "Connect wallet"}
          </button>
        ) : wrongNetwork ? (
          <button
            type="button"
            onClick={() => switchChain({ chainId: network.id })}
            className="w-full rounded-xl py-3 text-sm font-bold text-[#04121C]"
            style={{ background: GREEN }}
          >
            Switch to Stable
          </button>
        ) : needsApproval ? (
          <button
            type="button"
            onClick={approve}
            disabled={approving || amountIn <= 0n}
            className="w-full rounded-xl py-3 text-sm font-bold text-[#04121C] transition disabled:opacity-50"
            style={{ background: GREEN }}
          >
            {approving ? "Approving…" : `Approve ${input.symbol}`}
          </button>
        ) : (
          <button
            type="button"
            onClick={swap}
            disabled={!canSwap || submitting}
            className="w-full rounded-xl py-3 text-sm font-bold transition disabled:opacity-50"
            style={{
              background: canSwap ? (isBuy ? GREEN : RED) : "#22252D",
              color: canSwap ? "#04121C" : "#6B7280",
            }}
          >
            {submitting ? (isBuy ? "Buying…" : "Selling…")
              : amountIn <= 0n ? "Enter an amount"
              : insufficient ? `Insufficient ${input.symbol}`
              : quoting ? "Fetching quote…"
              : capExceeded ? "Launch wallet cap exceeded"
              : quoteError || (isBuy ? `Buy ${token.symbol}` : `Sell ${token.symbol}`)}
          </button>
        )}
      </div>

      <p className="mt-2.5 text-center text-[10px] text-pcs-textDim">
        Routed on-chain through Stable SwapRouter02. Quote and minimum received are checked before signing.
      </p>
    </Card>
  );
}
