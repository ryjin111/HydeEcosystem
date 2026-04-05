import { useCallback, useEffect, useState } from "react";
import { useAccount, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { keccak256, toBytes } from "viem";
import toast from "react-hot-toast";
import { hydeTokenFactoryAbi } from "../utils/constants";

/* ─── Constants ──────────────────────────────────────────────────────────── */

const FACTORY   = "0x9532Dc6534122443a0C14F0Ec6407447f262fF42" as const;
const OP_CHAIN_ID = 10;
const RPC       = "https://mainnet.optimism.io";

const TOKEN_LAUNCHED_TOPIC = "0xe6909668d179e62e5187846d18f40674b9798fa796e6303f68f49f8a0fca8735";
const FEES_COLLECTED_TOPIC = keccak256(toBytes("FeesCollected(address,uint256,uint256,uint256,uint256,uint256,uint256)"));
const LAUNCHES_SELECTOR    = keccak256(toBytes("launches(address)")).slice(0, 10); // 0x + 4 bytes
const FACTORY_DEPLOY_BLOCK = "0x" + (149_000_000).toString(16);
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

/* ─── Types ──────────────────────────────────────────────────────────────── */

type FeeHistory = {
  totalWethToCreator:  bigint;
  totalTokenToCreator: bigint;
  collectCount:        number;
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
    const d = hex.slice(2);
    if (d.length < 128) return "";
    const len = parseInt(d.slice(64, 128), 16);
    if (!len || len > 1000) return "";
    return Buffer.from(d.slice(128, 128 + len * 2), "hex").toString("utf8").replace(/\0/g, "");
  } catch { return ""; }
}

function fmtEth(wei: bigint): string {
  if (wei === 0n) return "0";
  return parseFloat((Number(wei) / 1e18).toFixed(6)).toString();
}

function fmtToken(wei: bigint, symbol: string): string {
  if (wei === 0n) return `0 ${symbol}`;
  const n = Number(wei) / 1e18;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M ${symbol}`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(2)}K ${symbol}`;
  return `${n.toFixed(2)} ${symbol}`;
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
): Promise<{ id: string; result: unknown }[]> {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requests),
  });
  if (!r.ok) throw new Error(`RPC ${r.status}`);
  return r.json();
}

function parseFeesCollectedData(data: string): { wethToCreator: bigint; tokenToCreator: bigint } {
  const d = data.slice(2);
  return {
    wethToCreator:  BigInt("0x" + d.slice(0, 64)),
    tokenToCreator: BigInt("0x" + d.slice(192, 256)),
  };
}

function padAddr(addr: string): string {
  return "0x" + addr.slice(2).toLowerCase().padStart(64, "0");
}

/* ─── Core fetch logic ───────────────────────────────────────────────────── */

/** Fetch fee history for one token address */
async function fetchFeeHistory(tokenAddr: string): Promise<FeeHistory> {
  const logs = await rpcPost({
    jsonrpc: "2.0", id: 1, method: "eth_getLogs",
    params: [{ address: FACTORY,
               topics: [FEES_COLLECTED_TOPIC, padAddr(tokenAddr)],
               fromBlock: FACTORY_DEPLOY_BLOCK, toBlock: "latest" }],
  }) as { data: string }[];

  let totalWethToCreator  = 0n;
  let totalTokenToCreator = 0n;
  for (const log of logs ?? []) {
    const { wethToCreator, tokenToCreator } = parseFeesCollectedData(log.data);
    totalWethToCreator  += wethToCreator;
    totalTokenToCreator += tokenToCreator;
  }
  return { totalWethToCreator, totalTokenToCreator, collectCount: (logs ?? []).length };
}

/** Check if address is a Hyde-launched token — returns creator if so, null otherwise */
async function resolveAsToken(addr: string): Promise<string | null> {
  const callData = LAUNCHES_SELECTOR + addr.slice(2).toLowerCase().padStart(64, "0");
  const result = await rpcPost({
    jsonrpc: "2.0", id: 1, method: "eth_call",
    params: [{ to: FACTORY, data: callData }, "latest"],
  }) as string;

  if (!result || result === "0x" || result.length < 130) return null;
  const tokenOut = "0x" + result.slice(26, 66); // first 32-byte word is token address
  return tokenOut.toLowerCase() === ZERO_ADDR ? null : tokenOut;
}

/** Mode A: input is a token address → show single token */
async function fetchSingleToken(tokenAddr: string): Promise<TokenRow[]> {
  const [nameHex, symbolHex, fees] = await Promise.all([
    rpcPost({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: tokenAddr, data: "0x06fdde03" }, "latest"] }) as Promise<string>,
    rpcPost({ jsonrpc: "2.0", id: 2, method: "eth_call", params: [{ to: tokenAddr, data: "0x95d89b41" }, "latest"] }) as Promise<string>,
    fetchFeeHistory(tokenAddr),
  ]);

  return [{
    address: tokenAddr,
    name:    decodeString(nameHex)   || "Unknown",
    symbol:  decodeString(symbolHex) || "???",
    fees,
  }];
}

/** Mode B: input is a creator address → show all their tokens */
async function fetchByCreator(creatorAddr: string): Promise<TokenRow[]> {
  const launchLogs = await rpcPost({
    jsonrpc: "2.0", id: 1, method: "eth_getLogs",
    params: [{ address: FACTORY, topics: [TOKEN_LAUNCHED_TOPIC, null, padAddr(creatorAddr)],
               fromBlock: FACTORY_DEPLOY_BLOCK, toBlock: "latest" }],
  }) as { topics: string[] }[];

  if (!launchLogs || launchLogs.length === 0) return [];

  const tokenAddresses = launchLogs.map((l) => ("0x" + l.topics[1].slice(26)).toLowerCase());

  // Batch name + symbol + fee logs
  const metaReqs = tokenAddresses.flatMap((addr, i) => [
    { jsonrpc: "2.0", id: `n${i}`, method: "eth_call",   params: [{ to: addr, data: "0x06fdde03" }, "latest"] },
    { jsonrpc: "2.0", id: `s${i}`, method: "eth_call",   params: [{ to: addr, data: "0x95d89b41" }, "latest"] },
    { jsonrpc: "2.0", id: `f${i}`, method: "eth_getLogs", params: [{ address: FACTORY,
        topics: [FEES_COLLECTED_TOPIC, padAddr(addr)],
        fromBlock: FACTORY_DEPLOY_BLOCK, toBlock: "latest" }] },
  ]);

  const results = await rpcBatch(metaReqs);
  const byId = Object.fromEntries(results.map((r) => [r.id, r.result]));

  return tokenAddresses.map((addr, i) => {
    const feeLogs = (byId[`f${i}`] as { data: string }[]) ?? [];
    let totalWethToCreator = 0n, totalTokenToCreator = 0n;
    for (const log of feeLogs) {
      const { wethToCreator, tokenToCreator } = parseFeesCollectedData(log.data);
      totalWethToCreator  += wethToCreator;
      totalTokenToCreator += tokenToCreator;
    }
    return {
      address: addr,
      name:    decodeString(byId[`n${i}`] as string ?? "") || "Unknown",
      symbol:  decodeString(byId[`s${i}`] as string ?? "") || "???",
      fees: { totalWethToCreator, totalTokenToCreator, collectCount: feeLogs.length },
    };
  });
}

/** Smart lookup: auto-detects token vs creator address */
async function fetchTokens(input: string): Promise<{ rows: TokenRow[]; mode: "token" | "creator" }> {
  const tokenCreator = await resolveAsToken(input);
  if (tokenCreator !== null) {
    // input IS a token address
    const rows = await fetchSingleToken(input);
    return { rows, mode: "token" };
  }
  // input is a creator wallet address
  const rows = await fetchByCreator(input);
  return { rows, mode: "creator" };
}

/* ─── CollectButton ──────────────────────────────────────────────────────── */

function CollectButton({ token, onCollected }: { token: TokenRow; onCollected: () => void }) {
  const { writeContract, data: txHash, isPending, reset } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash });

  useEffect(() => {
    if (isSuccess) { toast.success(`Fees collected for ${token.symbol}!`); reset(); onCollected(); }
  }, [isSuccess, token.symbol, reset, onCollected]);

  const busy = isPending || isConfirming;
  return (
    <button
      onClick={() => writeContract(
        { address: FACTORY, abi: hydeTokenFactoryAbi, functionName: "collectFees",
          args: [token.address as `0x${string}`], chainId: OP_CHAIN_ID },
        { onError: (err) => toast.error(err.message.slice(0, 80)) }
      )}
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
  const hasHistory = fees.collectCount > 0;
  return (
    <div className="rounded-2xl p-5 flex flex-col gap-4" style={{ background: "#0d1220", border: "1px solid rgba(0,212,255,0.08)" }}>
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <div className="h-10 w-10 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0"
               style={{ background: "rgba(0,212,255,0.12)", color: "#00d4ff" }}>
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
        <div className="rounded-xl px-3 py-2.5" style={{ background: "rgba(255,255,255,0.03)" }}>
          <p className="text-[10px] text-pcs-textDim uppercase tracking-wide mb-1">WETH earned (creator 60%)</p>
          <p className="text-sm font-bold text-pcs-text">{hasHistory ? `${fmtEth(fees.totalWethToCreator)} WETH` : "—"}</p>
        </div>
        <div className="rounded-xl px-3 py-2.5" style={{ background: "rgba(255,255,255,0.03)" }}>
          <p className="text-[10px] text-pcs-textDim uppercase tracking-wide mb-1">{token.symbol} earned (creator 60%)</p>
          <p className="text-sm font-bold text-pcs-text">{hasHistory ? fmtToken(fees.totalTokenToCreator, token.symbol) : "—"}</p>
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between text-[11px] text-pcs-textDim">
        <span>{hasHistory ? `Collected ${fees.collectCount}× total` : "No collections yet"}</span>
        <span className="flex items-center gap-1 font-semibold" style={{ color: "#00d4ff" }}>
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
  const [input, setInput]     = useState("");
  const [tokens, setTokens]   = useState<TokenRow[]>([]);
  const [mode, setMode]       = useState<"token" | "creator" | null>(null);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched]   = useState(false);
  const [searchedAddr, setSearchedAddr] = useState("");

  useEffect(() => {
    if (isConnected && address && !input) setInput(address);
  }, [isConnected, address]);

  const load = useCallback(async (addr: string) => {
    setLoading(true);
    setTokens([]);
    setSearched(false);
    try {
      const { rows, mode: m } = await fetchTokens(addr);
      setTokens(rows);
      setMode(m);
      setSearchedAddr(addr);
      setSearched(true);
    } catch {
      toast.error("Failed to fetch — check the address and try again");
    } finally {
      setLoading(false);
    }
  }, []);

  const handleSearch = () => {
    const addr = input.trim();
    if (!isAddress(addr)) { toast.error("Enter a valid 0x address"); return; }
    load(addr);
  };

  const handleCollected = () => { if (searchedAddr) load(searchedAddr); };

  const modeLabel = mode === "token"
    ? "token address"
    : mode === "creator" ? "creator wallet" : "";

  return (
    <div className="w-full max-w-2xl mx-auto px-4">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-pcs-text">Claim Fees</h1>
        <p className="text-sm text-pcs-textDim mt-1">
          Paste a <strong className="text-pcs-text">token address</strong> to see its fees, or a{" "}
          <strong className="text-pcs-text">creator wallet</strong> to see all their tokens.
          Anyone can trigger collection — fees always go to the registered creator.
        </p>
      </div>

      {/* Search */}
      <div className="flex items-center gap-2 rounded-2xl px-4 py-3 mb-2"
           style={{ background: "#0d1220", border: "1px solid rgba(0,212,255,0.12)" }}>
        <input
          type="text"
          placeholder="Token address or creator wallet (0x…)"
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
        <p className="text-[11px] text-pcs-textDim mb-3 px-1">
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
          <p className="text-pcs-textDim text-sm">
            {mode === "token"
              ? "This token was not launched via HydeTokenFactory."
              : "No tokens found for this creator address."}
          </p>
          <p className="text-xs text-pcs-textDim mt-2 opacity-60 font-mono break-all">{searchedAddr}</p>
        </div>
      )}

      {/* Results */}
      {!loading && tokens.length > 0 && (
        <div className="space-y-4">
          <p className="text-xs text-pcs-textDim px-1">
            {mode === "token"
              ? <>Showing fees for token <span className="font-mono">{searchedAddr.slice(0, 6)}…{searchedAddr.slice(-4)}</span></>
              : <>{tokens.length} token{tokens.length !== 1 ? "s" : ""} by creator <span className="font-mono">{searchedAddr.slice(0, 6)}…{searchedAddr.slice(-4)}</span></>
            }
            {modeLabel && <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded" style={{ background: "rgba(0,212,255,0.08)", color: "#00d4ff" }}>{modeLabel}</span>}
          </p>
          {tokens.map((token) => (
            <TokenCard key={token.address} token={token} onCollected={handleCollected} />
          ))}
          <p className="text-[11px] text-pcs-textDim text-center pt-1 opacity-60">
            Earned amounts = creator's 60% share from all past collections.
            Pending fees accrue continuously and are claimed on next collect.
          </p>
        </div>
      )}
    </div>
  );
}
