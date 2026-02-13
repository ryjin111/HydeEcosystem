import { useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { formatUnits, maxUint256, parseUnits, zeroAddress } from "viem";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import type { NetworkConfig, TokenInfo } from "../utils/constants";
import { erc20Abi, routerAbi } from "../utils/constants";
import { calcMinAmount, formatAmount } from "../utils/format";
import { TokenSelector } from "./TokenSelector";

type SwapCardProps = {
  network: NetworkConfig;
  tokens: TokenInfo[];
  onAddCustomToken: (token: {
    address: `0x${string}`;
    symbol: string;
    name: string;
    decimals: number;
  }) => void;
};

type Balances = Record<string, bigint>;

export function SwapCard({ network, tokens, onAddCustomToken }: SwapCardProps) {
  const { address, isConnected, chainId } = useAccount();
  const publicClient = usePublicClient({ chainId: network.id });
  const { data: walletClient } = useWalletClient({ chainId: network.id });

  const [tokenIn, setTokenIn] = useState<TokenInfo | undefined>(tokens[0]);
  const [tokenOut, setTokenOut] = useState<TokenInfo | undefined>(tokens[1]);
  const [amountIn, setAmountIn] = useState("");
  const [amountOut, setAmountOut] = useState("");
  const [slippage, setSlippage] = useState("0.50");
  const [deadlineMins, setDeadlineMins] = useState("20");
  const [loading, setLoading] = useState(false);
  const [balances, setBalances] = useState<Balances>({});
  const [allowance, setAllowance] = useState<bigint>(0n);
  const [noLiquidity, setNoLiquidity] = useState(false);

  const chainMismatch = isConnected && chainId !== network.id;
  const slippageBps = Math.floor(Number(slippage || "0") * 100);

  useEffect(() => {
    setTokenIn(tokens[0]);
    setTokenOut(tokens[1]);
  }, [tokens]);

  const fetchBalancesAndAllowance = async () => {
    if (!publicClient || !address || !tokenIn || !tokenOut) {
      return;
    }
    try {
      const [balIn, balOut, allowanceIn] = await Promise.all([
        publicClient.readContract({
          address: tokenIn.address,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [address]
        }),
        publicClient.readContract({
          address: tokenOut.address,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [address]
        }),
        publicClient.readContract({
          address: tokenIn.address,
          abi: erc20Abi,
          functionName: "allowance",
          args: [address, network.router]
        })
      ]);

      setBalances({
        [tokenIn.address]: balIn as bigint,
        [tokenOut.address]: balOut as bigint
      });
      setAllowance(allowanceIn as bigint);
    } catch {
      toast.error("Failed to fetch balances/allowance");
    }
  };

  useEffect(() => {
    void fetchBalancesAndAllowance();
  }, [address, tokenIn, tokenOut, publicClient]);

  useEffect(() => {
    const quote = async () => {
      if (!publicClient || !tokenIn || !tokenOut || !amountIn || Number(amountIn) <= 0) {
        setAmountOut("");
        setNoLiquidity(false);
        return;
      }
      try {
        const parsedIn = parseUnits(amountIn, tokenIn.decimals);
        const amounts = await publicClient.readContract({
          address: network.router,
          abi: routerAbi,
          functionName: "getAmountsOut",
          args: [parsedIn, [tokenIn.address, tokenOut.address]]
        });
        const out = (amounts as bigint[])[1];
        setAmountOut(formatUnits(out, tokenOut.decimals));
        setNoLiquidity(false);
      } catch {
        setAmountOut("");
        setNoLiquidity(true);
      }
    };
    void quote();
  }, [amountIn, tokenIn, tokenOut, network.router, publicClient]);

  const minReceived = useMemo(() => {
    if (!amountOut || !tokenOut) {
      return "";
    }
    try {
      const parsed = parseUnits(amountOut, tokenOut.decimals);
      return formatUnits(calcMinAmount(parsed, slippageBps), tokenOut.decimals);
    } catch {
      return "";
    }
  }, [amountOut, slippageBps, tokenOut]);

  const approveIfNeeded = async (amountParsed: bigint) => {
    if (!walletClient || !publicClient || !address || !tokenIn) {
      return false;
    }
    if (allowance >= amountParsed) {
      return true;
    }
    try {
      setLoading(true);
      toast.loading("Approving token...", { id: "approve" });
      const hash = await walletClient.writeContract({
        address: tokenIn.address,
        abi: erc20Abi,
        functionName: "approve",
        args: [network.router, maxUint256],
        account: address,
        chain: walletClient.chain
      });
      await publicClient.waitForTransactionReceipt({ hash });
      toast.success("Approval confirmed", { id: "approve" });
      await fetchBalancesAndAllowance();
      return true;
    } catch {
      toast.error("Approval failed or rejected", { id: "approve" });
      return false;
    } finally {
      setLoading(false);
    }
  };

  const swap = async () => {
    if (!walletClient || !publicClient || !address || !tokenIn || !tokenOut) {
      toast.error("Connect wallet first");
      return;
    }
    if (chainMismatch) {
      toast.error("Switch to selected network first");
      return;
    }
    if (!amountIn || Number(amountIn) <= 0) {
      toast.error("Enter amount");
      return;
    }
    try {
      setLoading(true);
      const parsedIn = parseUnits(amountIn, tokenIn.decimals);
      const parsedOut = parseUnits(amountOut || "0", tokenOut.decimals);
      const minOut = calcMinAmount(parsedOut, slippageBps);
      const isApproved = await approveIfNeeded(parsedIn);
      if (!isApproved) {
        return;
      }

      const deadline = BigInt(Math.floor(Date.now() / 1000) + Number(deadlineMins) * 60);
      toast.loading("Sending swap transaction...", { id: "swap" });
      const hash = await walletClient.writeContract({
        address: network.router,
        abi: routerAbi,
        functionName: "swapExactTokensForTokens",
        args: [parsedIn, minOut, [tokenIn.address, tokenOut.address], address, deadline],
        account: address,
        chain: walletClient.chain
      });
      await publicClient.waitForTransactionReceipt({ hash });
      toast.success("Swap successful", { id: "swap" });
      await fetchBalancesAndAllowance();
      setAmountIn("");
      setAmountOut("");
    } catch {
      toast.error("Swap failed or rejected", { id: "swap" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="card">
      <h2 className="mb-3 text-lg font-bold text-brand-blue">Swap</h2>
      <div className="grid gap-4 md:grid-cols-2">
        <TokenSelector
          label="From Token"
          selected={tokenIn}
          tokens={tokens}
          onSelect={setTokenIn}
          onAddCustom={onAddCustomToken}
        />
        <TokenSelector
          label="To Token"
          selected={tokenOut}
          tokens={tokens}
          onSelect={setTokenOut}
          onAddCustom={onAddCustomToken}
        />
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs font-semibold text-neutral-100">Amount In</label>
          <input className="input" value={amountIn} onChange={(e) => setAmountIn(e.target.value)} placeholder="0.0" />
          <p className="mt-1 text-xs text-neutral-100">
            Balance: {formatAmount(balances[tokenIn?.address ?? zeroAddress], tokenIn?.decimals ?? 18)}
          </p>
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold text-neutral-100">Estimated Amount Out</label>
          <input className="input" value={amountOut} readOnly placeholder="0.0" />
          <p className="mt-1 text-xs text-neutral-100">
            Balance: {formatAmount(balances[tokenOut?.address ?? zeroAddress], tokenOut?.decimals ?? 18)}
          </p>
        </div>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-3">
        <div>
          <label className="mb-1 block text-xs font-semibold text-neutral-100">Slippage (%)</label>
          <input className="input" value={slippage} onChange={(e) => setSlippage(e.target.value)} />
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold text-neutral-100">Deadline (minutes)</label>
          <input className="input" value={deadlineMins} onChange={(e) => setDeadlineMins(e.target.value)} />
        </div>
        <div className="rounded-xl border border-cyber-tealDeep bg-cyber-navy p-3 text-xs text-neutral-50">
          <p className="font-semibold text-brand-blue">Min received</p>
          <p>{minReceived || "0"} {tokenOut?.symbol ?? ""}</p>
          <p className="mt-1 text-neutral-100">Price impact: estimated from router quote only</p>
        </div>
      </div>

      {noLiquidity && amountIn && Number(amountIn) > 0 && (
        <div
          className="mt-4 flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium"
          style={{ background: 'rgba(255, 152, 0, 0.08)', border: '1px solid rgba(255, 152, 0, 0.3)', color: '#ffab40' }}
        >
          <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
          </svg>
          No liquidity available for this pair
        </div>
      )}

      <button
        className="btn-primary mt-4 w-full py-3"
        onClick={swap}
        disabled={loading || chainMismatch || !isConnected || !tokenIn || !tokenOut || tokenIn.address === tokenOut.address || noLiquidity}
      >
        {loading ? "Processing..." : chainMismatch ? "Switch Network" : noLiquidity ? "No Liquidity" : "Swap"}
      </button>
    </div>
  );
}
