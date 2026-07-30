import { useCallback, useEffect, useState } from "react";
import { formatUnits, type Address } from "viem";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import toast from "react-hot-toast";
import type { NetworkConfig } from "../utils/constants";
import {
  trenchV5LockerAbi,
  verifyTrenchV5Runtime,
  type VerifiedTrenchV5Runtime,
} from "../utils/trenchV5";
import { Button, SectionLabel } from "./ui/kit";

export function TrenchV5FeeCollector({
  network,
  token,
  compact = false,
}: {
  network: NetworkConfig;
  token: { address: Address; symbol: string; decimals: number };
  compact?: boolean;
}) {
  const { address } = useAccount();
  const publicClient = usePublicClient({ chainId: network.id });
  const { data: walletClient } = useWalletClient({ chainId: network.id });
  const [runtime, setRuntime] = useState<VerifiedTrenchV5Runtime | null>(null);
  const [tokenFees, setTokenFees] = useState<bigint | null>(null);
  const [quoteFees, setQuoteFees] = useState<bigint | null>(null);
  const [claiming, setClaiming] = useState<Address | null>(null);
  const quoteSymbol = network.id === 988 ? "USDT0" : "WETH";
  const quoteDecimals = network.id === 988 ? 6 : 18;

  const refresh = useCallback(async () => {
    if (!publicClient) return;
    try {
      const checked = await verifyTrenchV5Runtime(network.id);
      const [tokenAmount, quoteAmount] = await Promise.all([
        publicClient.readContract({
          address: checked.locker,
          abi: trenchV5LockerAbi,
          functionName: "creatorClaimable",
          args: [token.address, token.address],
        }),
        publicClient.readContract({
          address: checked.locker,
          abi: trenchV5LockerAbi,
          functionName: "creatorClaimable",
          args: [token.address, checked.numeraire],
        }),
      ]);
      setRuntime(checked);
      setTokenFees(tokenAmount);
      setQuoteFees(quoteAmount);
    } catch {
      setRuntime(null);
      setTokenFees(null);
      setQuoteFees(null);
    }
  }, [network.id, publicClient, token.address]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const claim = async (asset: Address, symbol: string) => {
    if (!runtime || !publicClient || !walletClient || !address) return;
    setClaiming(asset);
    try {
      const simulation = await publicClient.simulateContract({
        address: runtime.locker,
        abi: trenchV5LockerAbi,
        functionName: "claimCreator",
        args: [token.address, asset],
        account: address,
      });
      const hash = await walletClient.writeContract(simulation.request);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("Claim reverted.");
      toast.success(`${symbol} creator fees claimed.`);
      await refresh();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      toast.error(/reject|denied|cancel/i.test(message) ? "Claim cancelled." : "Fee claim failed.");
    } finally {
      setClaiming(null);
    }
  };

  const rows = [
    { asset: token.address, symbol: token.symbol, decimals: token.decimals, amount: tokenFees },
    { asset: runtime?.numeraire ?? "0x0000000000000000000000000000000000000000", symbol: quoteSymbol, decimals: quoteDecimals, amount: quoteFees },
  ] as const;

  return (
    <div className={`rounded-xl border border-pcs-primary/20 bg-pcs-primary/[0.045] ${compact ? "p-3" : "p-4"}`}>
      <SectionLabel>V5 creator fees</SectionLabel>
      <p className="mt-1 text-[10px] leading-4 text-pcs-textDim">
        Pool assets accrue independently. Claiming {token.symbol} does not claim {quoteSymbol}.
      </p>
      <div className="mt-3 space-y-2">
        {rows.map((row) => {
          const ready = row.amount != null && row.amount > 0n && runtime;
          return (
            <div key={row.symbol} className="flex items-center justify-between gap-3 rounded-lg border border-pcs-border bg-black/10 px-3 py-2">
              <div>
                <p className="font-mono text-xs font-semibold text-pcs-text">
                  {row.amount == null ? "Unavailable" : `${Number(formatUnits(row.amount, row.decimals)).toLocaleString("en-US", { maximumSignificantDigits: 7 })} ${row.symbol}`}
                </p>
                <p className="mt-0.5 text-[9px] uppercase tracking-wider text-pcs-textDim">{row.symbol === token.symbol ? "Token-side fees" : "Quote-side fees"}</p>
              </div>
              {ready && (
                <Button
                  size="sm"
                  disabled={!walletClient || claiming !== null}
                  onClick={() => claim(row.asset as Address, row.symbol)}
                >
                  {claiming?.toLowerCase() === row.asset.toLowerCase() ? "Claiming…" : `Claim ${row.symbol}`}
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
