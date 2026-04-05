import { useCallback, useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { usePrivy } from "@privy-io/react-auth";
import { useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import toast from "react-hot-toast";
import { hydeTokenFactoryAbi } from "../utils/constants";

/* ─── Constants ──────────────────────────────────────────────────────────── */

const FACTORY = "0x9532Dc6534122443a0C14F0Ec6407447f262fF42" as const;
const OP_CHAIN_ID = 10;
const RPC = "https://mainnet.optimism.io";
// keccak256("TokenLaunched(address,address,uint256,uint160,int24,int24)")
const TOKEN_LAUNCHED_TOPIC = "0xe6909668d179e62e5187846d18f40674b9798fa796e6303f68f49f8a0fca8735";
const FACTORY_DEPLOY_BLOCK = "0x" + (149_000_000).toString(16);

/* ─── Types ──────────────────────────────────────────────────────────────── */

type TokenRow = {
  address: string;
  name: string;
  symbol: string;
};

/* ─── Helpers ────────────────────────────────────────────────────────────── */

function decodeString(hex: string): string {
  if (!hex || hex === "0x" || hex.length < 4) return "";
  try {
    const data = hex.slice(2);
    if (data.length < 128) return "";
    const len = parseInt(data.slice(64, 128), 16);
    if (!len || len > 1000) return "";
    const strHex = data.slice(128, 128 + len * 2);
    return Buffer.from(strHex, "hex").toString("utf8").replace(/\0/g, "");
  } catch {
    return "";
  }
}

async function jsonRpcBatch(
  requests: { jsonrpc: string; id: string; method: string; params: unknown[] }[]
): Promise<{ id: string; result: string }[]> {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requests),
  });
  if (!r.ok) throw new Error(`RPC HTTP ${r.status}`);
  return r.json();
}

async function fetchUserTokens(creatorAddress: string): Promise<TokenRow[]> {
  // Pad address to 32 bytes for topic filter
  const paddedCreator = "0x" + creatorAddress.slice(2).toLowerCase().padStart(64, "0");

  const logsRes = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getLogs",
      params: [
        {
          address: FACTORY,
          topics: [TOKEN_LAUNCHED_TOPIC, null, paddedCreator],
          fromBlock: FACTORY_DEPLOY_BLOCK,
          toBlock: "latest",
        },
      ],
    }),
  });
  const logsBody = await logsRes.json();
  const logs: { topics: string[] }[] = logsBody.result ?? [];

  if (logs.length === 0) return [];

  // topic[1] = token address (indexed)
  const tokenAddresses = logs.map((l) => ("0x" + l.topics[1].slice(26)).toLowerCase());

  // Batch-fetch name() + symbol() for each token
  const requests = tokenAddresses.flatMap((addr, i) => [
    { jsonrpc: "2.0", id: `n${i}`, method: "eth_call", params: [{ to: addr, data: "0x06fdde03" }, "latest"] },
    { jsonrpc: "2.0", id: `s${i}`, method: "eth_call", params: [{ to: addr, data: "0x95d89b41" }, "latest"] },
  ]);

  const results = await jsonRpcBatch(requests);
  const byId = Object.fromEntries(results.map((r) => [r.id, r.result]));

  return tokenAddresses.map((addr, i) => ({
    address: addr,
    name: decodeString(byId[`n${i}`]) || "Unknown",
    symbol: decodeString(byId[`s${i}`]) || "???",
  }));
}

/* ─── CollectButton ──────────────────────────────────────────────────────── */

function CollectButton({ token }: { token: TokenRow }) {
  const { writeContract, data: txHash, isPending, reset } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash });

  useEffect(() => {
    if (isSuccess) {
      toast.success(`Fees collected for ${token.symbol}!`);
      reset();
    }
  }, [isSuccess, token.symbol, reset]);

  const handleCollect = () => {
    writeContract(
      {
        address: FACTORY,
        abi: hydeTokenFactoryAbi,
        functionName: "collectFees",
        args: [token.address as `0x${string}`],
        chainId: OP_CHAIN_ID,
      },
      {
        onError: (err) => {
          toast.error(err.message.slice(0, 80));
        },
      }
    );
  };

  const busy = isPending || isConfirming;

  return (
    <button
      onClick={handleCollect}
      disabled={busy}
      className="text-xs font-semibold px-4 py-1.5 rounded-xl transition disabled:opacity-50 disabled:cursor-not-allowed"
      style={{ background: "rgba(0,212,255,0.10)", color: "#00d4ff", border: "1px solid rgba(0,212,255,0.20)" }}
      onMouseEnter={(e) => {
        if (!busy) (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,212,255,0.20)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,212,255,0.10)";
      }}
    >
      {isPending ? "Confirm…" : isConfirming ? "Confirming…" : "Collect Fees"}
    </button>
  );
}

/* ─── Page ────────────────────────────────────────────────────────────────── */

export function ClaimFeesPage() {
  const { authenticated, login, ready } = usePrivy();
  const { address } = useAccount();
  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetched, setFetched] = useState(false);

  const load = useCallback(async (addr: string) => {
    setLoading(true);
    try {
      const rows = await fetchUserTokens(addr);
      setTokens(rows);
    } catch {
      toast.error("Failed to load tokens");
    } finally {
      setLoading(false);
      setFetched(true);
    }
  }, []);

  useEffect(() => {
    if (authenticated && address) {
      load(address);
    } else {
      setTokens([]);
      setFetched(false);
    }
  }, [authenticated, address, load]);

  return (
    <div className="w-full max-w-2xl mx-auto px-4">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-pcs-text">Claim Fees</h1>
        <p className="text-sm text-pcs-textDim mt-1">
          Collect your 60% creator share of LP fees from tokens you launched.
        </p>
      </div>

      {/* Not connected */}
      {!authenticated && (
        <div
          className="rounded-2xl p-10 text-center"
          style={{ background: "#0d1220", border: "1px solid rgba(0,212,255,0.08)" }}
        >
          <p className="text-pcs-textDim text-sm mb-4">Connect your account to see your launched tokens.</p>
          <button
            onClick={login}
            disabled={!ready}
            className="px-5 py-2 rounded-xl text-sm font-semibold transition disabled:opacity-50"
            style={{ background: "rgba(0,212,255,0.12)", color: "#00d4ff", border: "1px solid rgba(0,212,255,0.20)" }}
            onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(0,212,255,0.22)")}
            onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(0,212,255,0.12)")}
          >
            Login with X
          </button>
        </div>
      )}

      {/* Loading */}
      {authenticated && loading && (
        <div className="space-y-3">
          {Array.from({ length: 2 }).map((_, i) => (
            <div
              key={i}
              className="h-16 rounded-2xl animate-pulse"
              style={{ background: "rgba(255,255,255,0.03)" }}
            />
          ))}
        </div>
      )}

      {/* No tokens */}
      {authenticated && !loading && fetched && tokens.length === 0 && (
        <div
          className="rounded-2xl p-10 text-center"
          style={{ background: "#0d1220", border: "1px solid rgba(0,212,255,0.08)" }}
        >
          <p className="text-pcs-textDim text-sm">
            No tokens found for this address.
          </p>
          <p className="text-xs text-pcs-textDim mt-2 opacity-60">
            Launch a token on the Launchpad to start earning fees.
          </p>
        </div>
      )}

      {/* Token list */}
      {authenticated && !loading && tokens.length > 0 && (
        <div className="space-y-3">
          {tokens.map((token) => (
            <div
              key={token.address}
              className="rounded-2xl px-5 py-4 flex items-center justify-between gap-4"
              style={{ background: "#0d1220", border: "1px solid rgba(0,212,255,0.08)" }}
            >
              {/* Token info */}
              <div className="flex items-center gap-3 min-w-0">
                <div
                  className="h-9 w-9 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0"
                  style={{ background: "rgba(0,212,255,0.12)", color: "#00d4ff" }}
                >
                  {token.symbol.slice(0, 2).toUpperCase()}
                </div>
                <div className="min-w-0">
                  <p className="font-semibold text-pcs-text text-sm truncate">{token.name}</p>
                  <p className="text-xs text-pcs-textDim font-mono truncate">{token.symbol}</p>
                </div>
              </div>

              {/* Collect button */}
              <CollectButton token={token} />
            </div>
          ))}

          {/* Info note */}
          <p className="text-[11px] text-pcs-textDim text-center pt-1 opacity-60">
            Fees are split 60% creator · 30% team · 10% ecosystem and sent directly to registered addresses.
          </p>
        </div>
      )}
    </div>
  );
}
