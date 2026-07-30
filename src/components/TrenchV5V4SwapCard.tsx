import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import {
  encodeAbiParameters,
  formatUnits,
  keccak256,
  maxUint160,
  maxUint256,
  maxUint48,
  parseAbiParameters,
  parseUnits,
  type Address,
} from "viem";
import { useAccount, usePublicClient, useSwitchChain, useWalletClient } from "wagmi";
import {
  erc20Abi,
  HYDE_DYNAMIC_FEE,
  hydeHookAbi,
  hydeLaunchTokenAbi,
  permit2Abi,
  universalRouterExecuteAbi,
  V4_CONTRACTS_BY_CHAIN,
  v4QuoterAbi,
  type NetworkConfig,
} from "../utils/constants";
import { buildSwapTemplatePayload } from "../utils/v4Encoding";
import { verifyTrenchV5Runtime } from "../utils/trenchV5";
import { Card, SectionLabel } from "./ui/kit";

const GREEN = "#34C77B";
const RED = "#F6465D";

type TokenMeta = {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
};

type Props = {
  network: NetworkConfig;
  token: TokenMeta;
};

type Route = {
  hook: Address;
  numeraire: Address;
  tickSpacing: number;
};

type Protection = {
  maxWallet: bigint;
  expiry: number;
  launchTime: number;
  window: number;
  startFee: number;
  baseFee: number;
};

function units(value: string, decimals: number): bigint {
  try {
    return value && Number(value) > 0 ? parseUnits(value, decimals) : 0n;
  } catch {
    return 0n;
  }
}

function display(value: bigint, decimals: number, maximumFractionDigits = 6): string {
  const amount = Number(formatUnits(value, decimals));
  if (!Number.isFinite(amount)) return "0";
  if (amount > 0 && amount < 0.000001) return "<0.000001";
  return amount.toLocaleString("en-US", { maximumFractionDigits });
}

function poolId(token: Address, route: Route): `0x${string}` {
  const [currency0, currency1] = token.toLowerCase() < route.numeraire.toLowerCase()
    ? [token, route.numeraire]
    : [route.numeraire, token];
  return keccak256(encodeAbiParameters(
    parseAbiParameters("address,address,uint24,int24,address"),
    [currency0, currency1, HYDE_DYNAMIC_FEE, route.tickSpacing, route.hook],
  ));
}

function friendlyError(error: unknown, fallback: string): string {
  const value = error as { shortMessage?: string; message?: string };
  const message = value?.shortMessage || value?.message || fallback;
  if (/allowance|transfer.*amount/i.test(message)) return "Approval is required.";
  if (/insufficient.*balance/i.test(message)) return "Insufficient balance.";
  if (/max.?wallet|wallet cap/i.test(message)) return "Launch wallet cap would be exceeded.";
  if (/slippage|too little|minimum/i.test(message)) return "Price moved. Refresh the quote or raise slippage.";
  return message.length > 92 ? `${message.slice(0, 89)}...` : message;
}

function liveFeePips(now: number, protection: Protection): number {
  const elapsed = now - protection.launchTime;
  if (elapsed >= protection.window || protection.window <= 0) return protection.baseFee;
  if (elapsed <= 0) return protection.startFee;
  return Math.round(
    protection.baseFee
      + ((protection.startFee - protection.baseFee) * (protection.window - elapsed)) / protection.window,
  );
}

/**
 * Direct Universal Router execution for a verified V5 V4 WETH/token pool.
 * This deliberately does not use the legacy Hyde gateway or a legacy hook.
 */
export function TrenchV5V4SwapCard({ network, token }: Props) {
  const { address, isConnected, chainId } = useAccount();
  const publicClient = usePublicClient({ chainId: network.id });
  const { data: walletClient } = useWalletClient({ chainId: network.id });
  const { switchChain } = useSwitchChain();
  const contracts = V4_CONTRACTS_BY_CHAIN[network.id];

  const [route, setRoute] = useState<Route | null>(null);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  const [slippage, setSlippage] = useState("1");
  const [quoteOut, setQuoteOut] = useState<bigint | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [inputBalance, setInputBalance] = useState<bigint | null>(null);
  const [launchTokenBalance, setLaunchTokenBalance] = useState<bigint | null>(null);
  const [erc20Allowance, setErc20Allowance] = useState<bigint | null>(null);
  const [permit2Allowance, setPermit2Allowance] = useState<{ amount: bigint; expiration: number } | null>(null);
  const [protection, setProtection] = useState<Protection | null>(null);
  const [poolExists, setPoolExists] = useState<boolean | null>(null);
  const [approving, setApproving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const quoteRequest = useRef(0);

  const isBuy = side === "buy";
  const wrongNetwork = isConnected && chainId !== network.id;
  const input = route && isBuy
    ? { address: route.numeraire, symbol: "WETH", decimals: 18 }
    : { address: token.address, symbol: token.symbol, decimals: token.decimals };
  const output = route && isBuy
    ? { address: token.address, symbol: token.symbol, decimals: token.decimals }
    : { address: route?.numeraire ?? network.weth, symbol: "WETH", decimals: 18 };
  const amountIn = units(amount, input.decimals);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setRoute(null);
    setRouteError(null);
    verifyTrenchV5Runtime(network.id)
      .then((runtime) => {
        if (cancelled) return;
        if (
          runtime.manifest.engine !== "v4-hook"
          || !runtime.hook
          || !runtime.tickSpacing
          || runtime.numeraire.toLowerCase() !== network.weth.toLowerCase()
        ) throw new Error("The verified V5 V4 route is incomplete.");
        setRoute({
          hook: runtime.hook,
          numeraire: runtime.numeraire,
          tickSpacing: runtime.tickSpacing,
        });
      })
      .catch((error) => {
        if (!cancelled) setRouteError(friendlyError(error, "V5 route verification failed."));
      });
    return () => {
      cancelled = true;
    };
  }, [network.id, network.weth]);

  useEffect(() => {
    if (!publicClient || !route) return;
    let cancelled = false;
    Promise.all([
      publicClient.readContract({
        address: route.hook,
        abi: hydeHookAbi,
        functionName: "active",
        args: [poolId(token.address, route)],
      }),
      publicClient.readContract({
        address: route.hook,
        abi: hydeHookAbi,
        functionName: "antiSnipeWindow",
      }),
      publicClient.readContract({
        address: route.hook,
        abi: hydeHookAbi,
        functionName: "startFee",
      }),
      publicClient.readContract({
        address: route.hook,
        abi: hydeHookAbi,
        functionName: "baseFee",
      }),
      publicClient.readContract({
        address: token.address,
        abi: hydeLaunchTokenAbi,
        functionName: "maxWallet",
      }),
      publicClient.readContract({
        address: token.address,
        abi: hydeLaunchTokenAbi,
        functionName: "maxWalletExpiry",
      }),
    ]).then(([active, window, startFee, baseFee, maxWallet, expiry]) => {
      if (cancelled) return;
      const [exists, activeToken, launchTime] = active;
      const keyMatches = exists && activeToken.toLowerCase() === token.address.toLowerCase();
      setPoolExists(keyMatches);
      setProtection(keyMatches ? {
        maxWallet,
        expiry: Number(expiry),
        launchTime: Number(launchTime),
        window: Number(window),
        startFee: Number(startFee),
        baseFee: Number(baseFee),
      } : null);
    }).catch(() => {
      if (!cancelled) {
        setPoolExists(null);
        setProtection(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [publicClient, route, token.address]);

  useEffect(() => {
    if (!publicClient || !address || !route) {
      setInputBalance(null);
      setLaunchTokenBalance(null);
      setErc20Allowance(null);
      setPermit2Allowance(null);
      return;
    }
    let cancelled = false;
    Promise.all([
      publicClient.readContract({
        address: input.address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [address],
      }),
      publicClient.readContract({
        address: token.address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [address],
      }),
      publicClient.readContract({
        address: input.address,
        abi: erc20Abi,
        functionName: "allowance",
        args: [address, contracts.permit2],
      }),
      publicClient.readContract({
        address: contracts.permit2,
        abi: permit2Abi,
        functionName: "allowance",
        args: [address, input.address, contracts.universalRouter],
      }),
    ]).then(([balance, tokenBalance, allowance, permitAllowance]) => {
      if (cancelled) return;
      const [permitAmount, expiration] = permitAllowance;
      setInputBalance(balance);
      setLaunchTokenBalance(tokenBalance);
      setErc20Allowance(allowance);
      setPermit2Allowance({ amount: permitAmount, expiration: Number(expiration) });
    }).catch(() => {
      if (!cancelled) {
        setInputBalance(null);
        setLaunchTokenBalance(null);
        setErc20Allowance(null);
        setPermit2Allowance(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [
    publicClient,
    address,
    route,
    input.address,
    token.address,
    contracts.permit2,
    contracts.universalRouter,
    refresh,
  ]);

  const quote = useCallback(async (routeValue: Route, exactAmount: bigint): Promise<bigint> => {
    if (!publicClient || exactAmount <= 0n) throw new Error("Enter an amount.");
    const zeroForOne = input.address.toLowerCase() < output.address.toLowerCase();
    const currency0 = zeroForOne ? input.address : output.address;
    const currency1 = zeroForOne ? output.address : input.address;
    const simulation = await publicClient.simulateContract({
      address: contracts.quoter,
      abi: v4QuoterAbi,
      functionName: "quoteExactInputSingle",
      args: [{
        poolKey: {
          currency0,
          currency1,
          fee: HYDE_DYNAMIC_FEE,
          tickSpacing: routeValue.tickSpacing,
          hooks: routeValue.hook,
        },
        zeroForOne,
        exactAmount,
        hookData: "0x",
      }],
    });
    const [amountOut] = simulation.result;
    if (amountOut <= 0n) throw new Error("No output is available for this amount.");
    return amountOut;
  }, [publicClient, input.address, output.address, contracts.quoter]);

  useEffect(() => {
    const request = ++quoteRequest.current;
    if (!route || amountIn <= 0n) {
      setQuoteOut(null);
      setQuoteError(null);
      setQuoting(false);
      return;
    }
    if (inputBalance !== null && amountIn > inputBalance) {
      setQuoteOut(null);
      setQuoteError(`Insufficient ${input.symbol}`);
      setQuoting(false);
      return;
    }
    setQuoting(true);
    setQuoteError(null);
    const timer = window.setTimeout(() => {
      quote(route, amountIn)
        .then((result) => {
          if (request !== quoteRequest.current) return;
          setQuoteOut(result);
          setQuoteError(null);
        })
        .catch((error) => {
          if (request !== quoteRequest.current) return;
          setQuoteOut(null);
          setQuoteError(friendlyError(error, "Quote unavailable."));
        })
        .finally(() => {
          if (request === quoteRequest.current) setQuoting(false);
        });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [route, amountIn, inputBalance, input.symbol, quote]);

  const protectionActive = !!protection && now < protection.expiry;
  const secondsLeft = protection ? Math.max(0, protection.expiry - now) : 0;
  const capExceeded = protectionActive && isBuy && protection !== null
    && launchTokenBalance !== null && quoteOut !== null
    && launchTokenBalance + quoteOut > protection.maxWallet;
  const needsApproval = isConnected && amountIn > 0n && (
    erc20Allowance === null
    || permit2Allowance === null
    || erc20Allowance < amountIn
    || permit2Allowance.amount < amountIn
    || permit2Allowance.expiration <= now
  );
  const insufficient = inputBalance !== null && amountIn > inputBalance;
  const canSwap = Boolean(
    route
    && poolExists === true
    && isConnected
    && !wrongNetwork
    && !needsApproval
    && amountIn > 0n
    && quoteOut !== null
    && !quoteError
    && !insufficient
    && !capExceeded,
  );

  const approve = async () => {
    if (!walletClient || !publicClient || !address) return;
    const toastId = "v5-v4-approve";
    try {
      setApproving(true);
      toast.loading(`Approving ${input.symbol} (1/2)...`, { id: toastId });
      const tokenApproval = await walletClient.writeContract({
        address: input.address,
        abi: erc20Abi,
        functionName: "approve",
        args: [contracts.permit2, maxUint256],
        account: address,
        chain: walletClient.chain,
      });
      await publicClient.waitForTransactionReceipt({ hash: tokenApproval, confirmations: 1 });
      toast.loading(`Approving ${input.symbol} (2/2)...`, { id: toastId });
      const routerApproval = await walletClient.writeContract({
        address: contracts.permit2,
        abi: permit2Abi,
        functionName: "approve",
        args: [input.address, contracts.universalRouter, maxUint160, Number(maxUint48)],
        account: address,
        chain: walletClient.chain,
      });
      await publicClient.waitForTransactionReceipt({ hash: routerApproval, confirmations: 1 });
      toast.success(`${input.symbol} approved`, { id: toastId });
      setRefresh((value) => value + 1);
    } catch (error) {
      toast.error(friendlyError(error, "Approval failed."), { id: toastId });
    } finally {
      setApproving(false);
    }
  };

  const swap = async () => {
    if (!route || !walletClient || !publicClient || !address || quoteOut === null || amountIn <= 0n) return;
    const toastId = "v5-v4-swap";
    try {
      setSubmitting(true);
      toast.loading("Checking the live V5 pool...", { id: toastId });
      await verifyTrenchV5Runtime(network.id);
      const freshOut = await quote(route, amountIn);
      const { commands, inputs } = buildSwapTemplatePayload({
        tokenIn: input.address,
        tokenOut: output.address,
        fee: HYDE_DYNAMIC_FEE,
        tickSpacing: route.tickSpacing,
        hooks: route.hook,
        recipient: address,
        amountIn: formatUnits(amountIn, input.decimals),
        amountOutQuoted: formatUnits(freshOut, output.decimals),
        slippagePercent: slippage,
        decimalsIn: input.decimals,
        decimalsOut: output.decimals,
        chainId: network.id,
        sweep: false,
      });
      await publicClient.simulateContract({
        account: address,
        address: contracts.universalRouter,
        abi: universalRouterExecuteAbi,
        functionName: "execute",
        args: [commands, inputs],
        value: 0n,
      });
      toast.loading("Confirm the swap in your wallet...", { id: toastId });
      const hash = await walletClient.writeContract({
        address: contracts.universalRouter,
        abi: universalRouterExecuteAbi,
        functionName: "execute",
        args: [commands, inputs],
        value: 0n,
        account: address,
        chain: walletClient.chain,
      });
      toast.loading("Swap submitted...", { id: toastId });
      const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
      if (receipt.status !== "success") throw new Error("Swap reverted on-chain.");
      toast.success(`${isBuy ? "Bought" : "Sold"} ${token.symbol}`, { id: toastId });
      setAmount("");
      setQuoteOut(null);
      setRefresh((value) => value + 1);
    } catch (error) {
      toast.error(friendlyError(error, "Swap failed."), { id: toastId });
    } finally {
      setSubmitting(false);
    }
  };

  const setSideClean = (next: "buy" | "sell") => {
    setSide(next);
    setAmount("");
    setQuoteOut(null);
    setQuoteError(null);
  };

  const setPercent = (percent: number) => {
    if (inputBalance === null) return;
    setAmount(formatUnits((inputBalance * BigInt(percent)) / 100n, input.decimals));
  };

  const rate = quoteOut !== null && amountIn > 0n
    ? `1 ${input.symbol} = ${display(
      (quoteOut * (10n ** BigInt(input.decimals))) / amountIn,
      output.decimals,
    )} ${output.symbol}`
    : null;

  return (
    <Card variant="panel" data-testid="trench-v5-v4-swap">
      <div className="flex items-center justify-between">
        <SectionLabel>Trade</SectionLabel>
        <span className="rounded-md border border-pcs-primary/25 bg-pcs-primary/10 px-1.5 py-0.5 font-mono text-[9px] font-semibold text-pcs-primaryBright">
          V5 · V4 · WETH
        </span>
      </div>

      {!route && (
        <div className="mt-3 rounded-xl border border-pcs-border bg-white/[0.02] px-3 py-3 text-xs text-pcs-textDim">
          {routeError ?? "Verifying the V5 hook and pool route..."}
        </div>
      )}

      <div className="mt-3 grid grid-cols-2 gap-1 rounded-xl border border-[#22252D] bg-white/[0.03] p-1">
        {(["buy", "sell"] as const).map((next) => (
          <button
            key={next}
            type="button"
            onClick={() => setSideClean(next)}
            className="rounded-lg py-2 text-sm font-bold uppercase tracking-wide transition"
            style={side === next
              ? { background: next === "buy" ? GREEN : RED, color: "#04121C" }
              : { color: "#8B93A1" }}
          >
            {next}
          </button>
        ))}
      </div>

      <div className="mt-3 rounded-2xl border border-[#1C1F26] bg-white/[0.02] p-3">
        <div className="mb-1.5 flex items-center justify-between text-xs text-pcs-textDim">
          <span>You pay</span>
          {inputBalance !== null && <span>Balance: {display(inputBalance, input.decimals, 4)}</span>}
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
              disabled={inputBalance === null}
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
            {quoting
              ? <span className="text-pcs-textDim">...</span>
              : quoteOut !== null
                ? display(quoteOut, output.decimals)
                : <span className="text-pcs-textDim">0.0</span>}
          </div>
          <span className="shrink-0 rounded-lg bg-white/[0.05] px-2.5 py-1 text-sm font-semibold text-pcs-text">
            {output.symbol}
          </span>
        </div>
      </div>

      {rate && (
        <div className="mt-2 flex items-center justify-between px-1 text-xs">
          <span className="text-pcs-textDim">Rate</span>
          <span className="text-pcs-textSub">{rate}</span>
        </div>
      )}
      <div className="mt-1 flex items-center justify-between px-1 text-xs">
        <span className="text-pcs-textDim">Max slippage</span>
        <div className="flex items-center gap-1">
          {["0.5", "1", "3"].map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setSlippage(value)}
              className={`rounded px-1.5 py-0.5 text-[11px] font-medium transition ${
                slippage === value
                  ? "bg-pcs-primary text-pcs-bg"
                  : "text-pcs-textDim hover:text-pcs-text"
              }`}
            >
              {value}%
            </button>
          ))}
        </div>
      </div>

      {protectionActive && protection && (
        <div className="mt-3 rounded-xl border border-pcs-warning/25 bg-pcs-warning/[0.06] p-2.5 text-[11px] leading-relaxed">
          <div className="flex items-center justify-between gap-2">
            <span className="font-semibold text-pcs-warning">
              Launch protection · {Math.floor(secondsLeft / 60)}m {String(secondsLeft % 60).padStart(2, "0")}s
            </span>
            <span className="font-mono text-pcs-textSub">
              fee {(liveFeePips(now, protection) / 10_000).toFixed(2)}%
            </span>
          </div>
          <p className="mt-1 text-pcs-textDim">
            {isBuy
              ? "Buys are capped per wallet during launch. Selling is unrestricted."
              : "Selling is unrestricted during launch."}
          </p>
        </div>
      )}

      <div className="mt-4">
        {wrongNetwork && isConnected ? (
          <button
            type="button"
            onClick={() => switchChain({ chainId: network.id })}
            className="w-full rounded-xl bg-pcs-primary py-3 text-sm font-bold text-pcs-bg"
          >
            Switch to {network.name}
          </button>
        ) : needsApproval && isConnected ? (
          <button
            type="button"
            onClick={approve}
            disabled={approving || amountIn <= 0n}
            className="w-full rounded-xl py-3 text-sm font-bold text-pcs-bg transition disabled:opacity-50"
            style={{ background: GREEN }}
          >
            {approving ? "Approving..." : `Approve ${input.symbol}`}
          </button>
        ) : (
          <button
            type="button"
            onClick={swap}
            disabled={!canSwap || submitting}
            className="w-full rounded-xl py-3 text-sm font-bold transition disabled:opacity-50"
            style={{
              background: canSwap ? (isBuy ? GREEN : RED) : "#22252D",
              color: canSwap ? "#04121C" : "#6b7280",
            }}
          >
            {submitting
              ? (isBuy ? "Buying..." : "Selling...")
              : !isConnected
                ? "Connect wallet"
                : !route
                  ? "V5 route unavailable"
                  : poolExists === false
                    ? "Verified pool not found"
                    : amountIn <= 0n
                      ? "Enter an amount"
                      : insufficient
                        ? `Insufficient ${input.symbol}`
                        : quoting
                          ? "Fetching quote..."
                          : capExceeded
                            ? "Launch wallet cap exceeded"
                            : quoteError
                              ? quoteError
                              : quoteOut === null
                                ? "Enter an amount"
                                : isBuy
                                  ? `Buy ${token.symbol}`
                                  : `Sell ${token.symbol}`}
          </button>
        )}
      </div>

      <p className="mt-2.5 text-center text-[10px] text-pcs-textDim">
        Verified V5 hook · direct Uniswap Universal Router · fresh quote and preflight before signing.
      </p>
    </Card>
  );
}
