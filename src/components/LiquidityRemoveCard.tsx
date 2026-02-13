import { useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { formatUnits, maxUint256, parseUnits, zeroAddress } from "viem";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import type { NetworkConfig, TokenInfo } from "../utils/constants";
import { erc20Abi, factoryAbi, routerAbi } from "../utils/constants";
import { calcMinAmount, formatAmount } from "../utils/format";
import { TokenSelector } from "./TokenSelector";

type LiquidityRemoveCardProps = {
  network: NetworkConfig;
  tokens: TokenInfo[];
  onAddCustomToken: (token: {
    address: `0x${string}`;
    symbol: string;
    name: string;
    decimals: number;
  }) => void;
};

export function LiquidityRemoveCard({ network, tokens, onAddCustomToken }: LiquidityRemoveCardProps) {
  const { address, isConnected, chainId } = useAccount();
  const publicClient = usePublicClient({ chainId: network.id });
  const { data: walletClient } = useWalletClient({ chainId: network.id });

  const [tokenA, setTokenA] = useState<TokenInfo | undefined>(tokens[0]);
  const [tokenB, setTokenB] = useState<TokenInfo | undefined>(tokens[1]);
  const [pairAddress, setPairAddress] = useState<`0x${string}` | undefined>();
  const [lpAmount, setLpAmount] = useState("");
  const [slippage, setSlippage] = useState("0.50");
  const [deadlineMins, setDeadlineMins] = useState("20");
  const [loading, setLoading] = useState(false);
  const [lpBalance, setLpBalance] = useState<bigint>(0n);
  const [lpAllowance, setLpAllowance] = useState<bigint>(0n);
  const [estimatedA, setEstimatedA] = useState<bigint>(0n);
  const [estimatedB, setEstimatedB] = useState<bigint>(0n);

  const chainMismatch = isConnected && chainId !== network.id;
  const slippageBps = Math.floor(Number(slippage || "0") * 100);

  useEffect(() => {
    setTokenA(tokens[0]);
    setTokenB(tokens[1]);
  }, [tokens]);

  const fetchPairAndState = async () => {
    if (!publicClient || !tokenA || !tokenB || !address) {
      return;
    }
    try {
      const pair = await publicClient.readContract({
        address: network.factory,
        abi: factoryAbi,
        functionName: "getPair",
        args: [tokenA.address, tokenB.address]
      });

      const resolvedPair = pair as `0x${string}`;
      setPairAddress(resolvedPair);
      if (resolvedPair === zeroAddress) {
        setLpBalance(0n);
        setLpAllowance(0n);
        setEstimatedA(0n);
        setEstimatedB(0n);
        return;
      }

      const [balance, allowance] = await Promise.all([
        publicClient.readContract({
          address: resolvedPair,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [address]
        }),
        publicClient.readContract({
          address: resolvedPair,
          abi: erc20Abi,
          functionName: "allowance",
          args: [address, network.router]
        })
      ]);

      setLpBalance(balance as bigint);
      setLpAllowance(allowance as bigint);
    } catch {
      toast.error("Failed to fetch pair info");
      setPairAddress(undefined);
    }
  };

  useEffect(() => {
    void fetchPairAndState();
  }, [publicClient, tokenA, tokenB, address]);

  useEffect(() => {
    const preview = async () => {
      if (!publicClient || !tokenA || !tokenB || !pairAddress || pairAddress === zeroAddress || !lpAmount) {
        setEstimatedA(0n);
        setEstimatedB(0n);
        return;
      }
      try {
        const parsedLiquidity = parseUnits(lpAmount, 18);
        const [reserveAInPair, reserveBInPair, totalSupply] = await Promise.all([
          publicClient.readContract({
            address: tokenA.address,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [pairAddress]
          }),
          publicClient.readContract({
            address: tokenB.address,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [pairAddress]
          }),
          publicClient.readContract({
            address: pairAddress,
            abi: erc20Abi,
            functionName: "totalSupply"
          })
        ]);

        const supply = totalSupply as bigint;
        if (supply === 0n) {
          setEstimatedA(0n);
          setEstimatedB(0n);
          return;
        }
        setEstimatedA(((reserveAInPair as bigint) * parsedLiquidity) / supply);
        setEstimatedB(((reserveBInPair as bigint) * parsedLiquidity) / supply);
      } catch {
        setEstimatedA(0n);
        setEstimatedB(0n);
      }
    };
    void preview();
  }, [lpAmount, pairAddress, tokenA, tokenB, publicClient]);

  const approveLpIfNeeded = async (parsedLiquidity: bigint) => {
    if (!walletClient || !publicClient || !address || !pairAddress) {
      return false;
    }
    // Read fresh allowance from chain — React state may be stale in this closure
    const currentAllowance = await publicClient.readContract({
      address: pairAddress,
      abi: erc20Abi,
      functionName: "allowance",
      args: [address, network.router]
    }) as bigint;
    if (currentAllowance >= parsedLiquidity) {
      return true;
    }
    try {
      toast.loading("Approving LP token...", { id: "approve-lp" });
      const hash = await walletClient.writeContract({
        address: pairAddress,
        abi: erc20Abi,
        functionName: "approve",
        args: [network.router, maxUint256],
        account: address,
        chain: walletClient.chain
      });
      await publicClient.waitForTransactionReceipt({ hash });
      toast.success("LP approval done", { id: "approve-lp" });
      return true;
    } catch {
      toast.error("LP approval failed", { id: "approve-lp" });
      return false;
    }
  };

  const removeLiquidity = async () => {
    if (!walletClient || !publicClient || !address || !tokenA || !tokenB) {
      toast.error("Connect wallet first");
      return;
    }
    if (chainMismatch) {
      toast.error("Switch to selected network first");
      return;
    }
    if (!pairAddress || pairAddress === zeroAddress) {
      toast.error("Pair does not exist");
      return;
    }
    if (!lpAmount || Number(lpAmount) <= 0) {
      toast.error("Enter LP amount");
      return;
    }

    try {
      setLoading(true);
      const parsedLiquidity = parseUnits(lpAmount, 18);
      const approved = await approveLpIfNeeded(parsedLiquidity);
      if (!approved) {
        return;
      }

      const amountAMin = calcMinAmount(estimatedA, slippageBps);
      const amountBMin = calcMinAmount(estimatedB, slippageBps);
      const deadline = BigInt(Math.floor(Date.now() / 1000) + Number(deadlineMins) * 60);

      toast.loading("Sending remove liquidity tx...", { id: "remove-liq" });
      const hash = await walletClient.writeContract({
        address: network.router,
        abi: routerAbi,
        functionName: "removeLiquidity",
        args: [tokenA.address, tokenB.address, parsedLiquidity, amountAMin, amountBMin, address, deadline],
        account: address,
        chain: walletClient.chain
      });
      await publicClient.waitForTransactionReceipt({ hash });
      toast.success("Liquidity removed", { id: "remove-liq" });
      await fetchPairAndState();
      setLpAmount("");
    } catch {
      toast.error("Remove liquidity failed", { id: "remove-liq" });
    } finally {
      setLoading(false);
    }
  };

  const previewText = useMemo(() => {
    if (!tokenA || !tokenB) return "0";
    return `${formatUnits(estimatedA, tokenA.decimals)} ${tokenA.symbol} + ${formatUnits(estimatedB, tokenB.decimals)} ${tokenB.symbol}`;
  }, [estimatedA, estimatedB, tokenA, tokenB]);

  return (
    <div className="card">
      <h2 className="mb-3 text-lg font-bold text-brand-blue">Remove Liquidity</h2>
      <div className="grid gap-4 md:grid-cols-2">
        <TokenSelector
          label="Pair Token A"
          selected={tokenA}
          tokens={tokens}
          onSelect={setTokenA}
          onAddCustom={onAddCustomToken}
        />
        <TokenSelector
          label="Pair Token B"
          selected={tokenB}
          tokens={tokens}
          onSelect={setTokenB}
          onAddCustom={onAddCustomToken}
        />
      </div>

      <div className="mt-4 rounded-xl border border-cyber-tealDeep bg-cyber-navy p-3 text-sm text-neutral-50">
        <p>LP Pair Address: {pairAddress ?? "Not found yet"}</p>
        <p>LP Balance: {formatAmount(lpBalance, 18, 6)}</p>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs font-semibold text-neutral-100">LP Amount to Remove</label>
          <input className="input" value={lpAmount} onChange={(e) => setLpAmount(e.target.value)} placeholder="0.0" />
          <p className="mt-1 text-xs text-neutral-100">Wallet LP Balance: {formatAmount(lpBalance, 18, 6)}</p>
        </div>
        <div className="rounded-xl border border-cyber-tealDeep bg-cyber-navy p-3 text-sm text-neutral-50">
          <p className="font-semibold text-brand-blue">Estimated Token Returns</p>
          <p className="mt-1">{previewText}</p>
        </div>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs font-semibold text-neutral-100">Slippage (%)</label>
          <input className="input" value={slippage} onChange={(e) => setSlippage(e.target.value)} />
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold text-neutral-100">Deadline (minutes)</label>
          <input className="input" value={deadlineMins} onChange={(e) => setDeadlineMins(e.target.value)} />
        </div>
      </div>

      <button
        className="btn-primary mt-4 w-full py-3"
        onClick={removeLiquidity}
        disabled={loading || chainMismatch || !isConnected || !tokenA || !tokenB || tokenA.address === tokenB.address}
      >
        {loading ? "Processing..." : chainMismatch ? "Switch Network" : "Remove"}
      </button>
    </div>
  );
}
