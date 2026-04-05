import { useCallback, useEffect, useState } from "react";
import { useAccount, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { keccak256, toBytes } from "viem";
import toast from "react-hot-toast";
import { hydeTokenFactoryAbi } from "../utils/constants";

/* ─── Constants ──────────────────────────────────────────────────────────── */

const FACTORY = "0x9532Dc6534122443a0C14F0Ec6407447f262fF42" as const;
const WETH     = "0x4200000000000000000000000000000000000006";
const OP_CHAIN_ID = 10;
const RPC = "https://mainnet.optimism.io";

const TOKEN_LAUNCHED_TOPIC  = "0xe6909668d179e62e5187846d18f40674b9798fa796e6303f68f49f8a0fca8735";
const FEES_COLLECTED_TOPIC  = keccak256(toBytes("FeesCollected(address,uint256,uint256,uint256,uint256,uint256,uint256)"));
const FACTORY_DEPLOY_BLOCK  = "0x" + (149_000_000).toString(16);

/* ─── Types ──────────────────────────────────────────────────────────────── */

type FeeHistory = {
  totalWethToCreator:  bigint;
  totalTokenToCreator: bigint;
  collectCount:        number;
  lastCollectedBlock:  string | null;
};

type TokenRow = {
  address: string;
  name:    string;
  symbol:  string;
  fees:    FeeHistory;
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
    return Buffer.from(data.slice(128, 128 + len * 2), "hex").toString("utf8").replace(/\0/g, "");
  } catch { return ""; }
}

function fmtEth(wei: bigint, decimals = 6): string {
  if (wei === 0n) return "0";
  const s = (Number(wei) / 1e18).toFixed(decimals);
  return parseFloat(s).toString();
}

function fmtToken(wei: bigint): string {
  if (wei === 0n) return "0";
  const n = Number(wei) / 1e18;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(2)}K`;
  return n.toFixed(2);
}

async function rpcPost(body: object): Promise<unknown> {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`RPC ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message ?? "RPC error");
  return j.result;
}

async function rpcBatch(
  requests: { jsonrpc: string; id: string; method: string; params: unknown[] }[]
): Promise<{ id: string; result: string }[]> {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requests),
  });
  if (!r.ok) throw new Error(`RPC ${r.status}`);
  return r.json();
}

function parseFeesCollectedData(data: string): { wethToCreator: bigint; tokenToCreator: bigint } {
  const d = data.slice(2); // strip 0x
  // layout: wethToCreator | wethToTeam | wethToEcosystem | tokenToCreator | tokenToTeam | tokenToEcosystem
  const wethToCreator  = BigInt("0x" + d.slice(0, 64));
  const tokenToCreator = BigInt("0x" + d.slice(192, 256));
  return { wethToCreator, tokenToCreator };
}

/* ─── Data fetching ──────────────────────────────────────────────────────── */

async function fetchTokensByCreator(creatorAddress: string): Promise<TokenRow[]> {
  const paddedCreator = "0x" + creatorAddress.slice(2).toLowerCase().padStart(64, "0");

  // 1. Get TokenLaunched logs for this creator
  const launchLogs = await rpcPost({
    jsonrpc: "2.0", id: 1, method: "eth_getLogs",
    params: [{ address: FACTORY, topics: [TOKEN_LAUNCHED_TOPIC, null, paddedCreator],
               fromBlock: FACTORY_DEPLOY_BLOCK, toBlock: "latest" }],
  }) as { topics: string[] }[];

  if (!launchLogs || launchLogs.length === 0) return [];

  const tokenAddresses = launchLogs.map((l) => ("0x" + l.topics[1].slice(26)).toLowerCase());

  // 2. Batch: name + symbol for each token AND FeesCollected logs for each token
  const nameSymbolReqs = tokenAddresses.flatMap((addr, i) => [
    { jsonrpc: "2.0", id: `n${i}`, method: "eth_call",  params: [{ to: addr, data: "0x06fdde03" }, "latest"] },
    { jsonrpc: "2.0", id: `s${i}`, method: "eth_call",  params: [{ to: addr, data: "0x95d89b41" }, "latest"] },
  ]);

  const feeLogReqs = tokenAddresses.map((addr, i) => ({
    jsonrpc: "2.0", id: `f${i}`, method: "eth_getLogs",
    params: [{ address: FACTORY,
               topics: [FEES_COLLECTED_TOPIC, "0x" + addr.slice(2).padStart(64, "0")],
               fromBlock: FACTORY_DEPLOY_BLOCK, toBlock: "latest" }],
  }));

  const batchResults = await rpcBatch([...nameSymbolReqs, ...feeLogReqs]);
  const byId = Object.fromEntries(batchResults.map((r) => [r.id, r.result]));

  return tokenAddresses.map((addr, i) => {
    const name   = decodeString(byId[`n${i}`] ?? "") || "Unknown";
    const symbol = decodeString(byId[`s${i}`] ?? "") || "???";

    // Parse fee history
    const feeLogs: { data: string; blockNumber: string }[] =
      (byId[`f${i}`] as unknown as { data: string; blockNumber: string }[]) ?? [];

    let totalWethToCreator  = 0n;
    let totalTokenToCreator = 0n;
    let lastCollectedBlock: string | null = null;

    for (const log of feeLogs) {
      const { wethToCreator, tokenToCreator } = parseFeesCollectedData(log.data);
      totalWethToCreator  += wethToCreator;
      totalTokenToCreator += tokenToCreator;
      lastCollectedBlock = log.blockNumber; // logs are in order, last wins
    }

    return {
      address: addr,
      name,
      symbol,
      fees: { totalWethToCreator, totalTokenToCreator, collectCount: feeLogs.length, lastCollectedBlock },
    };
  });
}

/* ─── CollectButton ──────────────────────────────────────────────────────── */

function CollectButton({ token, onCollected }: { token: TokenRow; onCollected: () => void }) {
  const { writeContract, data: txHash, isPending, reset } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash });

  useEffect(() => {
    if (isSuccess) {
      toast.success(`Fees collected for ${token.symbol}!`);
      reset();
      onCollected();
    }
  }, [isSuccess, token.symbol, reset, onCollected]);

  const handleCollect = () => {
    writeContract(
      { address: FACTORY, abi: hydeTokenFactoryAbi, functionName: "collectFees",
        args: [token.address as `0x${string}`], chainId: OP_CHAIN_ID },
      { onError: (err) => toast.error(err.message.slice(0, 80)) }
    );
  };

  const busy = isPending || isConfirming;
  return (
    <button
      onClick={handleCollect}
      disabled={busy}
      className="flex-shrink-0 text-xs font-semibold px-4 py-2 rounded-xl transition disabled:opacity-50 disabled:cursor-not-allowed"
      style={{ background: "rgba(0,212,255,0.10)", color: "#00d4ff", border: "1px solid rgba(0,212,255,0.20)" }}
      onMouseEnter={(e) => { if (!busy) (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,212,255,0.20)"; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(0,212,255,0.10)"; }}
    >
      {isPending ? "Confirm…" : isConfirming ? "Confirming…" : "Collect Fees"}
    </button>
  );
}

/* ─── TokenCard ──────────────────────────────────────────────────────────── */

function TokenCard({ token, onCollected }: { token: TokenRow; onCollected: () => void }) {
  const { fees } = token;
  const hasFeeHistory = fees.collectCount > 0;

  return (
    <div
      className="rounded-2xl p-5 flex flex-col gap-4"
      style={{ background: "#0d1220", border: "1px solid rgba(0,212,255,0.08)" }}
    >
      {/* Top row: avatar + name + collect button */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <div
            className="h-10 w-10 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0"
            style={{ background: "rgba(0,212,255,0.12)", color: "#00d4ff" }}
          >
            {token.symbol.slice(0, 2).toUpperCase()}
          </div>
          <div className="min-w-0">
            <p className="font-semibold text-pcs-text text-sm truncate">{token.name}</p>
            <p className="text-xs text-pcs-textDim font-mono truncate">{token.symbol}</p>
          </div>
        </div>
        <CollectButton token={token} onCollected={onCollected} />
      </div>

      {/* Fee stats */}
      <div className="grid grid-cols-2 gap-3">
        {/* WETH earned */}
        <div className="rounded-xl px-3 py-2.5" style={{ background: "rgba(255,255,255,0.03)" }}>
          <p className="text-[10px] text-pcs-textDim uppercase tracking-wide mb-1">WETH earned (creator)</p>
          <p className="text-sm font-bold text-pcs-text">
            {hasFeeHistory ? `${fmtEth(fees.totalWethToCreator)} WETH` : "—"}
          </p>
        </div>
        {/* Token earned */}
        <div className="rounded-xl px-3 py-2.5" style={{ background: "rgba(255,255,255,0.03)" }}>
          <p className="text-[10px] text-pcs-textDim uppercase tracking-wide mb-1">{token.symbol} earned (creator)</p>
          <p className="text-sm font-bold text-pcs-text">
            {hasFeeHistory ? `${fmtToken(fees.totalTokenToCreator)} ${token.symbol}` : "—"}
          </p>
        </div>
      </div>

      {/* Bottom meta */}
      <div className="flex items-center justify-between text-[11px] text-pcs-textDim">
        <span>
          {hasFeeHistory
            ? `Collected ${fees.collectCount}× — amounts above are creator's 60% share`
            : "No collections yet"}
        </span>
        <span
          className="flex items-center gap-1 font-semibold"
          style={{ color: "#00d4ff" }}
        >
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
          Pending fees
        </span>
      </div>
    </div>
  );
}

/* ─── Page ────────────────────────────────────────────────────────────────── */

export function ClaimFeesPage() {
  const { address, isConnected } = useAccount();
  const [input, setInput]       = useState("");
  const [tokens, setTokens]     = useState<TokenRow[]>([]);
  const [loading, setLoading]   = useState(false);
  const [searched, setSearched] = useState(false);
  const [searchedAddr, setSearchedAddr] = useState("");

  // Auto-fill when wallet connects
  useEffect(() => {
    if (isConnected && address && !input) setInput(address);
  }, [isConnected, address]);

  const load = useCallback(async (addr: string) => {
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
  }, []);

  const handleSearch = () => {
    const addr = input.trim();
    if (!isAddress(addr)) { toast.error("Enter a valid 0x address"); return; }
    load(addr);
  };

  // Refresh after a successful collection to update fee history
  const handleCollected = () => {
    if (searchedAddr) load(searchedAddr);
  };

  return (
    <div className="w-full max-w-2xl mx-auto px-4">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-pcs-text">Claim Fees</h1>
        <p className="text-sm text-pcs-textDim mt-1">
          Look up any creator address to see claimable LP fees. Anyone can trigger collection —
          fees always route on-chain to the registered creator (60% share).
        </p>
      </div>

      {/* Search bar */}
      <div
        className="flex items-center gap-2 rounded-2xl px-4 py-3 mb-2"
        style={{ background: "#0d1220", border: "1px solid rgba(0,212,255,0.12)" }}
      >
        <input
          type="text"
          placeholder="Creator address (0x…)"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSearch()}
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
      {isConnected && address && input.toLowerCase() !== address.toLowerCase() && (
        <p className="text-[11px] text-pcs-textDim mb-4 px-1">
          <button onClick={() => setInput(address)} className="underline hover:text-pcs-primary transition">
            Use my connected wallet
          </button>
        </p>
      )}

      <div className="mt-4" />

      {/* Loading */}
      {loading && (
        <div className="space-y-3">
          {[0, 1].map((i) => (
            <div key={i} className="h-36 rounded-2xl animate-pulse" style={{ background: "rgba(255,255,255,0.03)" }} />
          ))}
        </div>
      )}

      {/* No results */}
      {!loading && searched && tokens.length === 0 && (
        <div className="rounded-2xl p-10 text-center" style={{ background: "#0d1220", border: "1px solid rgba(0,212,255,0.08)" }}>
          <p className="text-pcs-textDim text-sm">No tokens found for this address.</p>
          <p className="text-xs text-pcs-textDim mt-2 opacity-60 font-mono break-all">{searchedAddr}</p>
        </div>
      )}

      {/* Token cards */}
      {!loading && tokens.length > 0 && (
        <div className="space-y-4">
          <p className="text-xs text-pcs-textDim px-1">
            {tokens.length} token{tokens.length !== 1 ? "s" : ""} by{" "}
            <span className="font-mono">{searchedAddr.slice(0, 6)}…{searchedAddr.slice(-4)}</span>
          </p>
          {tokens.map((token) => (
            <TokenCard key={token.address} token={token} onCollected={handleCollected} />
          ))}
          <p className="text-[11px] text-pcs-textDim text-center pt-1 opacity-60">
            Earned amounts reflect creator's 60% share from all past collections.
            Pending fees accrue continuously and are claimed on next collection.
          </p>
        </div>
      )}
    </div>
  );
}
