import { useCallback, useEffect, useState } from "react";
import { useAccount, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import toast from "react-hot-toast";
import { hydeTokenFactoryAbi } from "../utils/constants";

/* ─── Constants ──────────────────────────────────────────────────────────── */

const FACTORY = "0x9532Dc6534122443a0C14F0Ec6407447f262fF42" as const;
const OP_CHAIN_ID = 10;
const RPC = "https://mainnet.optimism.io";
const TOKEN_LAUNCHED_TOPIC = "0xe6909668d179e62e5187846d18f40674b9798fa796e6303f68f49f8a0fca8735";
const FACTORY_DEPLOY_BLOCK = "0x" + (149_000_000).toString(16);

/* ─── Types ──────────────────────────────────────────────────────────────── */

type TokenRow = {
  address: string;
  name: string;
  symbol: string;
};

/* ─── Helpers ────────────────────────────────────────────────────────────── */

function isAddress(val: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(val.trim());
}

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

async function fetchTokensByCreator(creatorAddress: string): Promise<TokenRow[]> {
  const paddedCreator = "0x" + creatorAddress.slice(2).toLowerCase().padStart(64, "0");

  const logsRes = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getLogs",
      params: [{
        address: FACTORY,
        topics: [TOKEN_LAUNCHED_TOPIC, null, paddedCreator],
        fromBlock: FACTORY_DEPLOY_BLOCK,
        toBlock: "latest",
      }],
    }),
  });
  const logsBody = await logsRes.json();
  const logs: { topics: string[] }[] = logsBody.result ?? [];
  if (logs.length === 0) return [];

  const tokenAddresses = logs.map((l) => ("0x" + l.topics[1].slice(26)).toLowerCase());

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
        onError: (err) => toast.error(err.message.slice(0, 80)),
      }
    );
  };

  const busy = isPending || isConfirming;

  return (
    <button
      onClick={handleCollect}
      disabled={busy}
      className="flex-shrink-0 text-xs font-semibold px-4 py-1.5 rounded-xl transition disabled:opacity-50 disabled:cursor-not-allowed"
      style={{ background: "rgba(0,212,255,0.10)", color: "#00d4ff", border: "1px solid rgba(0,212,255,0.20)" }}
      onMouseEnter={(e) => { if (!busy) (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,212,255,0.20)"; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,212,255,0.10)"; }}
    >
      {isPending ? "Confirm…" : isConfirming ? "Confirming…" : "Collect Fees"}
    </button>
  );
}

/* ─── Page ────────────────────────────────────────────────────────────────── */

export function ClaimFeesPage() {
  const { address, isConnected } = useAccount();
  const [input, setInput] = useState("");
  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [searchedAddr, setSearchedAddr] = useState("");

  // Auto-fill input when wallet connects
  useEffect(() => {
    if (isConnected && address && !input) {
      setInput(address);
    }
  }, [isConnected, address]);

  const handleSearch = useCallback(async () => {
    const addr = input.trim();
    if (!isAddress(addr)) {
      toast.error("Enter a valid 0x address");
      return;
    }
    setLoading(true);
    setTokens([]);
    setSearched(false);
    try {
      const rows = await fetchTokensByCreator(addr);
      setTokens(rows);
      setSearchedAddr(addr);
      setSearched(true);
    } catch {
      toast.error("Failed to fetch tokens");
    } finally {
      setLoading(false);
    }
  }, [input]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleSearch();
  };

  return (
    <div className="w-full max-w-2xl mx-auto px-4">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-pcs-text">Claim Fees</h1>
        <p className="text-sm text-pcs-textDim mt-1">
          Enter a creator address to view and collect their LP fee share.
          Fees always route on-chain to the registered creator — anyone can trigger collection.
        </p>
      </div>

      {/* Search bar */}
      <div
        className="flex items-center gap-2 rounded-2xl px-4 py-3 mb-6"
        style={{ background: "#0d1220", border: "1px solid rgba(0,212,255,0.12)" }}
      >
        <input
          type="text"
          placeholder="Creator address (0x…)"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          className="flex-1 bg-transparent text-sm text-pcs-text placeholder-pcs-textDim outline-none font-mono"
        />
        <button
          onClick={handleSearch}
          disabled={loading}
          className="text-xs font-semibold px-4 py-1.5 rounded-xl transition disabled:opacity-50"
          style={{ background: "rgba(0,212,255,0.12)", color: "#00d4ff", border: "1px solid rgba(0,212,255,0.20)" }}
          onMouseEnter={(e) => { if (!loading) (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,212,255,0.22)"; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,212,255,0.12)"; }}
        >
          {loading ? "Loading…" : "Look up"}
        </button>
      </div>

      {/* Wallet hint */}
      {isConnected && address && (
        <p className="text-[11px] text-pcs-textDim mb-4 -mt-3 px-1">
          Connected wallet auto-filled.{" "}
          {input.toLowerCase() !== address.toLowerCase() && (
            <button
              onClick={() => setInput(address)}
              className="underline hover:text-pcs-primary transition"
            >
              Reset to my address
            </button>
          )}
        </p>
      )}

      {/* Loading skeleton */}
      {loading && (
        <div className="space-y-3">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="h-16 rounded-2xl animate-pulse" style={{ background: "rgba(255,255,255,0.03)" }} />
          ))}
        </div>
      )}

      {/* No results */}
      {!loading && searched && tokens.length === 0 && (
        <div
          className="rounded-2xl p-10 text-center"
          style={{ background: "#0d1220", border: "1px solid rgba(0,212,255,0.08)" }}
        >
          <p className="text-pcs-textDim text-sm">No tokens found for this address.</p>
          <p className="text-xs text-pcs-textDim mt-2 opacity-60 font-mono break-all">{searchedAddr}</p>
        </div>
      )}

      {/* Token list */}
      {!loading && tokens.length > 0 && (
        <div className="space-y-3">
          <p className="text-xs text-pcs-textDim px-1 mb-1">
            {tokens.length} token{tokens.length !== 1 ? "s" : ""} found for{" "}
            <span className="font-mono">{searchedAddr.slice(0, 6)}…{searchedAddr.slice(-4)}</span>
          </p>

          {tokens.map((token) => (
            <div
              key={token.address}
              className="rounded-2xl px-5 py-4 flex items-center justify-between gap-4"
              style={{ background: "#0d1220", border: "1px solid rgba(0,212,255,0.08)" }}
            >
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
              <CollectButton token={token} />
            </div>
          ))}

          <p className="text-[11px] text-pcs-textDim text-center pt-1 opacity-60">
            60% creator · 30% team · 10% ecosystem — fees route on-chain regardless of who triggers collection.
          </p>
        </div>
      )}
    </div>
  );
}
