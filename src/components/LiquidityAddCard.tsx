import { useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { formatUnits, maxUint256, parseUnits, zeroAddress } from "viem";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import type { NetworkConfig, TokenInfo } from "../utils/constants";
import { erc20Abi, routerAbi } from "../utils/constants";
import { calcMinAmount, formatAmount } from "../utils/format";
import { TokenSelector } from "./TokenSelector";

type LiquidityAddCardProps = {
  network: NetworkConfig;
  tokens: TokenInfo[];
  onAddCustomToken: (token: {
    address: `0x${string}`;
    symbol: string;
    name: string;
    decimals: number;
  }) => void;
};

export function LiquidityAddCard({ network, tokens, onAddCustomToken }: LiquidityAddCardProps) {
  const { address, isConnected, chainId } = useAccount();
  const publicClient = usePublicClient({ chainId: network.id });
  const { data: walletClient } = useWalletClient({ chainId: network.id });

  const [tokenA, setTokenA] = useState<TokenInfo | undefined>(tokens[0]);
  const [tokenB, setTokenB] = useState<TokenInfo | undefined>(tokens[1]);
  const [amountA, setAmountA] = useState("");
  const [amountB, setAmountB] = useState("");
  const [slippage, setSlippage] = useState("0.50");
  const [deadlineMins, setDeadlineMins] = useState("20");
  const [loading, setLoading] = useState(false);
  const [balances, setBalances] = useState<Record<string, bigint>>({});

  const chainMismatch = isConnected && chainId !== network.id;
  const slippageBps = Math.floor(Number(slippage || "0") * 100);

  useEffect(() => {
    setTokenA(tokens[0]);
    setTokenB(tokens[1]);
  }, [tokens]);

  const fetchState = async () => {
    if (!publicClient || !address || !tokenA || !tokenB) {
      return;
    }
    try {
      const fetchBal = async (t: TokenInfo) =>
        t.isNative
          ? publicClient.getBalance({ address })
          : (publicClient.readContract({
              address: t.address,
              abi: erc20Abi,
              functionName: "balanceOf",
              args: [address],
            }) as Promise<bigint>);

      const [balA, balB] = await Promise.all([fetchBal(tokenA), fetchBal(tokenB)]);

      setBalances({
        [tokenA.address]: balA as bigint,
        [tokenB.address]: balB as bigint,
      });
    } catch {
      toast.error("Failed to load balances");
    }
  };

  useEffect(() => {
    void fetchState();
  }, [publicClient, address, tokenA, tokenB]);

  const approveToken = async (token: TokenInfo, amount: bigint) => {
    if (!walletClient || !publicClient || !address) {
      return false;
    }
    // Native ETH never needs approval
    if (token.isNative) return true;

    // Read fresh allowance from chain
    const currentAllowance = (await publicClient.readContract({
      address: token.address,
      abi: erc20Abi,
      functionName: "allowance",
      args: [address, network.router],
    })) as bigint;
    if (currentAllowance >= amount) return true;

    try {
      toast.loading(`Approving ${token.symbol}...`, { id: `approve-${token.address}` });
      const hash = await walletClient.writeContract({
        address: token.address,
        abi: erc20Abi,
        functionName: "approve",
        args: [network.router, maxUint256],
        account: address,
        chain: walletClient.chain,
      });
      await publicClient.waitForTransactionReceipt({ hash });
      toast.success(`${token.symbol} approved`, { id: `approve-${token.address}` });
      return true;
    } catch {
      toast.error(`Approval failed for ${token.symbol}`, { id: `approve-${token.address}` });
      return false;
    }
  };

  const lpPreview = useMemo(() => {
    if (!amountA || !amountB || !tokenA || !tokenB) {
      return "0";
    }
    return `${amountA} ${tokenA.symbol} + ${amountB} ${tokenB.symbol}`;
  }, [amountA, amountB, tokenA, tokenB]);

  const supply = async () => {
    if (!walletClient || !publicClient || !address || !tokenA || !tokenB) {
      toast.error("Connect wallet first");
      return;
    }
    if (chainMismatch) {
      toast.error("Switch to selected network first");
      return;
    }
    if (!amountA || !amountB) {
      toast.error("Enter both token amounts");
      return;
    }
    try {
      setLoading(true);
      const parsedA = parseUnits(amountA, tokenA.decimals);
      const parsedB = parseUnits(amountB, tokenB.decimals);

      const okA = await approveToken(tokenA, parsedA);
      if (!okA) return;
      const okB = await approveToken(tokenB, parsedB);
      if (!okB) return;

      const minA = calcMinAmount(parsedA, slippageBps);
      const minB = calcMinAmount(parsedB, slippageBps);
      const deadline = BigInt(Math.floor(Date.now() / 1000) + Number(deadlineMins) * 60);

      toast.loading("Sending add liquidity tx...", { id: "add-liq" });

      // Determine if one side is native ETH
      const nativeToken = tokenA.isNative ? tokenA : tokenB.isNative ? tokenB : null;
      const erc20Token = nativeToken === tokenA ? tokenB : nativeToken === tokenB ? tokenA : null;

      let hash: `0x${string}`;
      if (nativeToken && erc20Token) {
        const isANative = tokenA.isNative;
        const parsedToken = isANative ? parsedB : parsedA;
        const parsedETH = isANative ? parsedA : parsedB;
        const minToken = isANative ? minB : minA;
        const minETH = isANative ? minA : minB;

        hash = await walletClient.writeContract({
          address: network.router,
          abi: routerAbi,
          functionName: "addLiquidityETH",
          args: [erc20Token.address, parsedToken, minToken, minETH, address, deadline],
          value: parsedETH,
          account: address,
          chain: walletClient.chain,
        });
      } else {
        hash = await walletClient.writeContract({
          address: network.router,
          abi: routerAbi,
          functionName: "addLiquidity",
          args: [tokenA.address, tokenB.address, parsedA, parsedB, minA, minB, address, deadline],
          account: address,
          chain: walletClient.chain,
        });
      }

      await publicClient.waitForTransactionReceipt({ hash });
      toast.success("Liquidity supplied", { id: "add-liq" });
      await fetchState();
      setAmountA("");
      setAmountB("");
    } catch {
      toast.error("Add liquidity failed", { id: "add-liq" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="card">
      <h2 className="mb-3 text-lg font-bold text-brand-blue">Add Liquidity</h2>
      <div className="grid gap-4 md:grid-cols-2">
        <TokenSelector
          label="Token A"
          selected={tokenA}
          tokens={tokens}
          onSelect={setTokenA}
          onAddCustom={onAddCustomToken}
        />
        <TokenSelector
          label="Token B"
          selected={tokenB}
          tokens={tokens}
          onSelect={setTokenB}
          onAddCustom={onAddCustomToken}
        />
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs font-semibold text-neutral-100">Amount {tokenA?.symbol ?? "A"}</label>
          <input className="input" value={amountA} onChange={(e) => setAmountA(e.target.value)} placeholder="0.0" />
          <p className="mt-1 text-xs text-neutral-100">
            Balance: {formatAmount(balances[tokenA?.address ?? zeroAddress], tokenA?.decimals ?? 18)}
          </p>
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold text-neutral-100">Amount {tokenB?.symbol ?? "B"}</label>
          <input className="input" value={amountB} onChange={(e) => setAmountB(e.target.value)} placeholder="0.0" />
          <p className="mt-1 text-xs text-neutral-100">
            Balance: {formatAmount(balances[tokenB?.address ?? zeroAddress], tokenB?.decimals ?? 18)}
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
          <p className="font-semibold text-brand-blue">LP Preview</p>
          <p>{lpPreview}</p>
        </div>
      </div>

      <button
        className="btn-primary mt-4 w-full py-3"
        onClick={supply}
        disabled={loading || chainMismatch || !isConnected || !tokenA || !tokenB || tokenA.address === tokenB.address}
      >
        {loading ? "Processing..." : chainMismatch ? "Switch Network" : "Supply"}
      </button>
    </div>
  );
}
