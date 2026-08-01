import { useCallback, useEffect, useState } from "react";
import { formatUnits, type Address } from "viem";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import toast from "react-hot-toast";
import type { NetworkConfig } from "../utils/constants";
import {
  verifyTrenchV5Runtime,
  type VerifiedTrenchV5Runtime,
} from "../utils/trenchV5";
import { quoteTrenchV5ClaimAll, runTrenchV5ClaimAll } from "../utils/trenchV5Fees";
import { Button, SectionLabel } from "./ui/kit";

function displayAmount(amount: bigint | null, decimals: number, symbol: string): string {
  if (amount == null) return "Unavailable";
  const numeric = Number(formatUnits(amount, decimals));
  if (!Number.isFinite(numeric) || numeric === 0) return `0 ${symbol}`;
  if (numeric < 0.000001) return `<0.000001 ${symbol}`;
  return `${numeric.toLocaleString("en-US", { maximumSignificantDigits: 7 })} ${symbol}`;
}

export function TrenchV5FeeCollector({
  network,
  token,
  graduated,
  compact = false,
}: {
  network: NetworkConfig;
  token: { address: Address; symbol: string; decimals: number };
  graduated: boolean;
  compact?: boolean;
}) {
  const { address } = useAccount();
  const publicClient = usePublicClient({ chainId: network.id });
  const { data: walletClient } = useWalletClient({ chainId: network.id });
  const [runtime, setRuntime] = useState<VerifiedTrenchV5Runtime | null>(null);
  const [tokenFees, setTokenFees] = useState<bigint | null>(null);
  const [quoteFees, setQuoteFees] = useState<bigint | null>(null);
  const [claiming, setClaiming] = useState(false);
  const quoteSymbol = network.id === 988 ? "USDT0" : "WETH";
  const quoteDecimals = network.id === 988 ? 6 : 18;

  const refresh = useCallback(async () => {
    if (!publicClient) return;
    try {
      const checked = await verifyTrenchV5Runtime(network.id);
      const projected = await quoteTrenchV5ClaimAll({
        publicClient,
        locker: checked.locker,
        token: token.address,
        numeraire: checked.numeraire,
        includeCollect: graduated,
        account: address,
      });
      setRuntime(checked);
      setTokenFees(projected.tokenAmount);
      setQuoteFees(projected.quoteAmount);
    } catch {
      setRuntime(null);
      setTokenFees(null);
      setQuoteFees(null);
    }
  }, [address, graduated, network.id, publicClient, token.address]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const claimAll = async () => {
    if (!runtime || !publicClient || !walletClient || !address) return;
    setClaiming(true);
    try {
      await runTrenchV5ClaimAll({
        publicClient,
        walletClient,
        locker: runtime.locker,
        token: token.address,
        numeraire: runtime.numeraire,
        includeCollect: graduated,
        account: address,
      });
      toast.success(graduated ? "All creator fees collected and claimed." : "All creator fees claimed.");
      await refresh();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      toast.error(/reject|denied|cancel/i.test(message) ? "Claim cancelled." : "Fee claim failed.");
    } finally {
      setClaiming(false);
    }
  };

  const rows = [
    { symbol: token.symbol, decimals: token.decimals, amount: tokenFees, label: "Token-side fees" },
    { symbol: quoteSymbol, decimals: quoteDecimals, amount: quoteFees, label: "Quote-side fees" },
  ] as const;
  const hasFees = rows.some((row) => row.amount != null && row.amount > 0n);
  const unavailable = tokenFees == null || quoteFees == null;

  return (
    <div className={`rounded-xl border border-pcs-primary/20 bg-pcs-primary/[0.045] ${compact ? "p-3" : "p-4"}`}>
      <SectionLabel>V5 creator fees</SectionLabel>
      <p className="mt-1 text-[10px] leading-4 text-pcs-textDim">
        {graduated
          ? "One transaction harvests every locked position and claims both pool assets."
          : "One transaction claims both pool assets credited during the live curve."}
      </p>
      <div className="mt-3 space-y-2">
        {rows.map((row) => (
          <div key={row.symbol} className="flex items-center justify-between gap-3 rounded-lg border border-pcs-border bg-black/10 px-3 py-2">
            <div>
              <p className="font-mono text-xs font-semibold text-pcs-text">
                {displayAmount(row.amount, row.decimals, row.symbol)}
              </p>
              <p className="mt-0.5 text-[9px] uppercase tracking-wider text-pcs-textDim">{row.label}</p>
            </div>
          </div>
        ))}
      </div>
      <Button
        className="mt-3 w-full"
        disabled={!walletClient || claiming || !runtime || !hasFees}
        onClick={claimAll}
      >
        {claiming
          ? "Collecting and claiming…"
          : hasFees
            ? graduated ? "Collect & claim all" : "Claim all fees"
            : unavailable ? "Fees unavailable" : "No fees available"}
      </Button>
      <p className="mt-2 text-center text-[9px] leading-4 text-pcs-textDim">
        One wallet confirmation. Payouts always go to the creator recorded on-chain.
      </p>
    </div>
  );
}
