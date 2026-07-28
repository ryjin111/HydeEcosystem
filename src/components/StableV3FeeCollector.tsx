import { useEffect, useState } from "react";
import { BanknotesIcon } from "@heroicons/react/24/outline";
import toast from "react-hot-toast";
import { formatUnits, type Address, type PublicClient, type WalletClient } from "viem";
import { useAccount, usePublicClient, useSwitchChain, useWalletClient } from "wagmi";
import type { NetworkConfig } from "../utils/constants";
import {
  collectStableV3CreatorFees,
  quoteStableV3CreatorFees,
  type StableV3CreatorFeeQuote,
} from "../utils/stableV3Fees";
import { v3ChainRow } from "../utils/chainRegistry";
import { Button, Card, SectionLabel } from "./ui/kit";

type Props = {
  network: NetworkConfig;
  token: { address: Address; symbol: string; decimals: number };
  compact?: boolean;
};

function displayAmount(value: bigint, decimals: number): string {
  const numeric = Number(formatUnits(value, decimals));
  if (!Number.isFinite(numeric) || numeric === 0) return "0";
  if (numeric < 0.000001) return "<0.000001";
  return numeric.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

function shortAddress(value: string): string {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function errorCopy(error: unknown): string {
  const value = error as { shortMessage?: string; message?: string };
  const message = value?.shortMessage || value?.message || "Creator fee collection failed.";
  return message.length > 120 ? `${message.slice(0, 117)}…` : message;
}

export function StableV3FeeCollector({ network, token, compact = false }: Props) {
  const row = v3ChainRow(network.id);
  const { address, isConnected, chainId } = useAccount();
  const publicClient = usePublicClient({ chainId: network.id });
  const { data: walletClient } = useWalletClient({ chainId: network.id });
  const { switchChain } = useSwitchChain();
  const [quote, setQuote] = useState<StableV3CreatorFeeQuote | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collecting, setCollecting] = useState(false);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    if (!publicClient || !row) {
      setQuote(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setQuote(null);
    setError(null);
    quoteStableV3CreatorFees({
      publicClient: publicClient as PublicClient,
      chainId: network.id,
      token: token.address,
      caller: address,
    })
      .then((next) => {
        if (!cancelled) setQuote(next);
      })
      .catch((cause) => {
        if (!cancelled) {
          setQuote(null);
          setError(errorCopy(cause));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [address, network.id, publicClient, refresh, row, token.address]);

  if (!row) return null;

  const hasFees = !!quote && (quote.grossToken > 0n || quote.grossNumeraire > 0n);
  const wrongNetwork = isConnected && chainId !== network.id;
  const collect = async () => {
    if (!publicClient || !walletClient || !address) return;
    const toastId = `stable-v3-fees-${token.address}`;
    try {
      setCollecting(true);
      toast.loading("Checking current V3 fees…", { id: toastId });
      await collectStableV3CreatorFees({
        publicClient: publicClient as PublicClient,
        walletClient: walletClient as WalletClient,
        chainId: network.id,
        token: token.address,
        account: address,
      });
      toast.success("Creator fees sent directly to the launch creator.", { id: toastId, duration: 6000 });
      setRefresh((value) => value + 1);
    } catch (cause) {
      toast.error(errorCopy(cause), { id: toastId, duration: 7000 });
    } finally {
      setCollecting(false);
    }
  };

  const content = (
    <>
      <div className="flex items-start justify-between gap-3">
        <div>
          <SectionLabel>Creator fees</SectionLabel>
          <p className="mt-1 text-[11px] leading-5 text-pcs-textDim">
            95% is paid directly in both pool assets. There is no separate V3 claim balance.
          </p>
        </div>
        <BanknotesIcon className="h-5 w-5 shrink-0 text-pcs-primary" />
      </div>

      {loading ? (
        <div className="mt-3 h-16 animate-pulse rounded-xl border border-pcs-border bg-white/[0.02]" />
      ) : error ? (
        <p className="mt-3 rounded-lg border border-pcs-warning/25 bg-pcs-warning/5 px-3 py-2 text-[11px] leading-5 text-pcs-warning">
          Fee read unavailable: {error}
        </p>
      ) : quote ? (
        <div className={`mt-3 grid gap-2 ${compact ? "grid-cols-2" : ""}`}>
          <div className="rounded-xl border border-pcs-border bg-black/10 px-3 py-2.5">
            <p className="font-code text-[9px] uppercase tracking-wider text-pcs-textDim">
              Creator {row.numeraire.symbol}
            </p>
            <p className="mt-1 truncate font-mono text-sm font-semibold tabular-nums text-pcs-text">
              {displayAmount(quote.creatorNumeraire, row.numeraire.decimals)}
            </p>
          </div>
          <div className="rounded-xl border border-pcs-border bg-black/10 px-3 py-2.5">
            <p className="font-code text-[9px] uppercase tracking-wider text-pcs-textDim">
              Creator {token.symbol}
            </p>
            <p className="mt-1 truncate font-mono text-sm font-semibold tabular-nums text-pcs-text">
              {displayAmount(quote.creatorToken, token.decimals)}
            </p>
          </div>
        </div>
      ) : null}

      <div className="mt-3">
        {!isConnected ? (
          <Button className="w-full" disabled>Connect wallet to collect</Button>
        ) : wrongNetwork ? (
          <Button className="w-full" variant="secondary" onClick={() => switchChain({ chainId: network.id })}>
            Switch to {network.name}
          </Button>
        ) : (
          <Button className="w-full" disabled={loading || !hasFees || collecting || !walletClient} onClick={collect}>
            {collecting ? "Collecting…" : hasFees ? "Collect creator fees" : "No fees available"}
          </Button>
        )}
      </div>

      {quote && (
        <p className="mt-2 text-[9px] leading-4 text-pcs-textDim">
          Anyone can trigger collection; payout is locked to creator {shortAddress(quote.creator)}.
        </p>
      )}
    </>
  );

  return compact
    ? <div className="mt-3 border-t border-pcs-border pt-3">{content}</div>
    : <Card variant="panel">{content}</Card>;
}
