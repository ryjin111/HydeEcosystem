import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { parseEther, zeroAddress } from "viem";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import toast from "react-hot-toast";
import { DopplerSDK, DAY_SECONDS, type DopplerSDKConfig } from "@whetstone-research/doppler-sdk";
import { useDopplerPools } from "../hooks/useDopplerTokens";
import type { DopplerPool } from "../utils/dopplerConfig";

const UNICHAIN_CHAIN_ID = 130;

/* ─── helpers ─────────────────────────────────────────────────────────────── */

function fmtLiquidity(raw: string | null): string {
  const n = parseFloat(raw ?? "0");
  if (!n) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/* ─── Pool card (Explore tab) ─────────────────────────────────────────────── */

const CHAIN_LABELS: Record<number, string> = {
  57073: "Ink",
  130: "Unichain",
};

function PoolCard({ pool, onTrade }: { pool: DopplerPool; onTrade: (addr: string, chainId: number) => void }) {
  const bt = pool.baseToken;
  const chainLabel = CHAIN_LABELS[pool.chainId] ?? `chain ${pool.chainId}`;
  return (
    <div
      className="rounded-2xl p-4 flex flex-col gap-3 border transition hover:border-pcs-primary/40"
      style={{ background: "#0d1220", borderColor: "rgba(0,212,255,0.10)" }}
    >
      {/* Token identity */}
      <div className="flex items-center gap-3">
        <div
          className="h-10 w-10 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0"
          style={{ background: "rgba(0,212,255,0.12)", color: "#00d4ff" }}
        >
          {bt.symbol.slice(0, 2).toUpperCase()}
        </div>
        <div className="min-w-0">
          <p className="font-semibold text-pcs-text truncate">{bt.name}</p>
          <p className="text-xs text-pcs-textDim">{bt.symbol}</p>
        </div>
        <div className="ml-auto flex items-center gap-1.5 flex-shrink-0">
          <span
            className="text-[10px] font-semibold px-2 py-0.5 rounded-full uppercase tracking-wide"
            style={{ background: "rgba(255,255,255,0.06)", color: "#9ca3af" }}
          >
            {chainLabel}
          </span>
          <span
            className="text-[10px] font-semibold px-2 py-0.5 rounded-full uppercase tracking-wide"
            style={{
              background: pool.type === "v4" ? "rgba(168,85,247,0.15)" : "rgba(0,212,255,0.10)",
              color: pool.type === "v4" ? "#a855f7" : "#00d4ff",
            }}
          >
            {pool.type}
          </span>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-xl px-3 py-2" style={{ background: "rgba(255,255,255,0.03)" }}>
          <p className="text-pcs-textDim mb-0.5">Liquidity</p>
          <p className="font-semibold text-pcs-text">{fmtLiquidity(pool.dollarLiquidity)}</p>
        </div>
        <div className="rounded-xl px-3 py-2" style={{ background: "rgba(255,255,255,0.03)" }}>
          <p className="text-pcs-textDim mb-0.5">Volume</p>
          <p className="font-semibold text-pcs-text">{fmtLiquidity(pool.volumeUsd)}</p>
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-pcs-textDim">{timeAgo(pool.createdAt)}</span>
        <button
          onClick={() => onTrade(bt.address, pool.chainId)}
          className="text-xs font-semibold px-3 py-1.5 rounded-xl transition"
          style={{ background: "rgba(0,212,255,0.10)", color: "#00d4ff" }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(0,212,255,0.18)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "rgba(0,212,255,0.10)")}
        >
          Trade →
        </button>
      </div>
    </div>
  );
}

/* ─── Launch form ─────────────────────────────────────────────────────────── */

// Fixed auction params (bankr-style defaults — not exposed to user)
const AUCTION = {
  totalSupply:    "100000000000", // 100B
  sellPercent:    70,
  durationDays:   7,
  marketCapStart: 20000,          // $20K starting mcap
  marketCapMin:   3000,           // $3K floor
};

function useEthPrice() {
  const [price, setPrice] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd")
      .then((r) => r.json())
      .then((d) => { if (!cancelled && d?.ethereum?.usd) setPrice(d.ethereum.usd); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  return price;
}

function LaunchForm() {
  const { address, chainId, isConnected } = useAccount();
  const publicClient = usePublicClient({ chainId: UNICHAIN_CHAIN_ID });
  const { data: walletClient } = useWalletClient({ chainId: UNICHAIN_CHAIN_ID });

  const ethPrice = useEthPrice();
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const chainMismatch = isConnected && chainId !== UNICHAIN_CHAIN_ID;

  const handleImage = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setImagePreview(reader.result as string);
    reader.readAsDataURL(file);
  };

  const handleLaunch = async () => {
    if (!address || !publicClient || !walletClient) return;
    if (!name.trim() || !symbol.trim()) {
      toast.error("Token name and symbol are required");
      return;
    }
    // Need ETH price to compute proceeds — fall back to 2000 if fetch not done yet
    const ethPriceUsd = ethPrice ?? 2000;

    const totalSupply = parseEther(AUCTION.totalSupply);
    const numTokensToSell = (totalSupply * BigInt(AUCTION.sellPercent)) / 100n;
    const durationSecs = AUCTION.durationDays * DAY_SECONDS;
    const maxProceeds = parseEther(String((AUCTION.marketCapStart * AUCTION.sellPercent) / 100 / ethPriceUsd));
    const minProceeds = parseEther(String((AUCTION.marketCapMin  * AUCTION.sellPercent) / 100 / ethPriceUsd));

    setSubmitting(true);
    try {
      const sdk = new DopplerSDK({
        publicClient: publicClient as DopplerSDKConfig["publicClient"],
        walletClient: walletClient as DopplerSDKConfig["walletClient"],
        chainId: UNICHAIN_CHAIN_ID,
      });

      // Build tokenURI from image (base64 JSON metadata)
      let tokenURI = "";
      if (imagePreview) {
        const meta = JSON.stringify({ name: name.trim(), symbol: symbol.trim().toUpperCase(), image: imagePreview });
        tokenURI = "data:application/json;base64," + btoa(unescape(encodeURIComponent(meta)));
      }

      const params = sdk
        .buildDynamicAuction()
        .tokenConfig({ name: name.trim(), symbol: symbol.trim().toUpperCase(), tokenURI })
        .saleConfig({ initialSupply: totalSupply, numTokensToSell, numeraire: zeroAddress })
        .withMarketCapRange({
          marketCap: { start: AUCTION.marketCapStart, min: AUCTION.marketCapMin },
          numerairePrice: ethPriceUsd,
          minProceeds,
          maxProceeds,
          duration: durationSecs,
        })
        .withMigration({
          type: "uniswapV4",
          fee: 3000,
          tickSpacing: 60,
          streamableFees: {
            lockDuration: 0,
            beneficiaries: [
              { beneficiary: address!, shares: 581000000000000000n },                                    // Creator  58.1%
              { beneficiary: "0x9C076a736D727F33c005145E0DB189Fd58D20110", shares: 400000000000000000n }, // HydeTeam 40.0%
              { beneficiary: "0xeb17B8c29717036161936A2179A88fe981B9CB80", shares:  19000000000000000n }, // Ecosystem 1.9%
            ],
          },
        })
        .withGovernance({ type: "default" })
        .withUserAddress(address)
        .build();

      toast.loading("Launching token…", { id: "launch" });
      const result = await sdk.factory.createDynamicAuction(params);
      toast.success(`Launched! ${result.tokenAddress ?? ""}`, { id: "launch", duration: 8000 });
      setName("");
      setSymbol("");
      setImagePreview(null);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(msg.length > 100 ? msg.slice(0, 100) + "…" : msg, { id: "launch" });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="w-full max-w-md mx-auto rounded-2xl p-6 flex flex-col gap-5"
      style={{ background: "#0d1220", border: "1px solid rgba(0,212,255,0.10)" }}
    >
      <div>
        <h2 className="text-lg font-bold text-pcs-text">Launch a Token</h2>
        <p className="text-xs text-pcs-textDim mt-1">
          Powered by{" "}
          <a href="https://docs.doppler.lol" target="_blank" rel="noreferrer" className="text-pcs-primary hover:underline">
            Doppler Protocol
          </a>{" "}
          — fair Dutch auction on Ink.
        </p>
      </div>

      {/* Image picker */}
      <div className="flex justify-center">
        <label className="cursor-pointer group relative">
          <div
            className="h-20 w-20 rounded-full flex items-center justify-center overflow-hidden transition"
            style={{ background: "rgba(0,212,255,0.08)", border: "2px dashed rgba(0,212,255,0.25)" }}
          >
            {imagePreview ? (
              <img src={imagePreview} alt="token" className="h-full w-full object-cover" />
            ) : (
              <div className="flex flex-col items-center gap-1 text-center">
                <span className="text-xl">🖼️</span>
                <span className="text-[9px] text-pcs-textDim leading-tight">Upload<br />photo</span>
              </div>
            )}
          </div>
          <input type="file" accept="image/*" className="hidden" onChange={handleImage} />
        </label>
      </div>

      {/* Name + Symbol */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-pcs-textDim">Token Name</label>
          <input
            type="text"
            placeholder="My Token"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-xl px-3 py-2.5 text-sm text-pcs-text outline-none focus:ring-1 focus:ring-pcs-primary/50"
            style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(0,212,255,0.10)" }}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-pcs-textDim">Ticker</label>
          <input
            type="text"
            placeholder="MTK"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            maxLength={8}
            className="w-full rounded-xl px-3 py-2.5 text-sm text-pcs-text outline-none focus:ring-1 focus:ring-pcs-primary/50 uppercase"
            style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(0,212,255,0.10)" }}
          />
        </div>
      </div>

      {/* Submit */}
      {chainMismatch ? (
        <div className="text-center text-sm text-yellow-400 py-2">
          Switch your wallet to Unichain (chain 130) to launch.
        </div>
      ) : (
        <button
          onClick={handleLaunch}
          disabled={!isConnected || submitting}
          className="w-full py-3 rounded-xl font-semibold text-sm transition"
          style={{
            background: isConnected && !submitting ? "rgba(0,212,255,0.15)" : "rgba(255,255,255,0.05)",
            color: isConnected && !submitting ? "#00d4ff" : "#6b7280",
            cursor: isConnected && !submitting ? "pointer" : "not-allowed",
          }}
        >
          {!isConnected ? "Connect Wallet" : submitting ? "Launching…" : "Launch Token"}
        </button>
      )}
    </div>
  );
}

/* ─── Page ────────────────────────────────────────────────────────────────── */

const INK_CHAIN_ID = 57073;

export function LaunchpadPage() {
  const [tab, setTab] = useState<"explore" | "launch">("explore");
  const { pools: unichainPools, loading: unichainLoading, refetch: refetchUnichain } = useDopplerPools(UNICHAIN_CHAIN_ID);
  const { pools: inkPools, loading: inkLoading, refetch: refetchInk } = useDopplerPools(INK_CHAIN_ID);
  const navigate = useNavigate();

  const pools = [...unichainPools, ...inkPools];
  const loading = unichainLoading || inkLoading;
  const refetch = () => { refetchUnichain(); refetchInk(); };

  const handleTrade = (tokenAddress: string, chainId: number) => {
    if (chainId === INK_CHAIN_ID) {
      // Hyde swap handles Ink tokens natively
      navigate(`/swap?out=${tokenAddress}`);
    } else {
      // Unichain tokens → Uniswap
      window.open(
        `https://app.uniswap.org/swap?outputCurrency=${tokenAddress}&chain=unichain`,
        "_blank",
        "noreferrer"
      );
    }
  };

  return (
    <div className="max-w-6xl mx-auto px-4 w-full">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-pcs-text">Launchpad</h1>
        <p className="text-sm text-pcs-textDim mt-1">
          Fair token launches powered by Doppler Dutch auctions.
          Launching on Unichain — Ink support coming soon.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 p-1 rounded-2xl w-fit" style={{ background: "rgba(255,255,255,0.04)" }}>
        {(["explore", "launch"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className="px-5 py-2 rounded-xl text-sm font-semibold transition capitalize"
            style={
              tab === t
                ? { background: "rgba(0,212,255,0.15)", color: "#00d4ff" }
                : { color: "#6b7280" }
            }
          >
            {t === "explore" ? "Explore Launches" : "Launch a Token"}
          </button>
        ))}
      </div>

      {/* Explore tab */}
      {tab === "explore" && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <p className="text-sm text-pcs-textDim">
              {loading ? "Loading…" : `${pools.length} token${pools.length !== 1 ? "s" : ""} launched on Unichain + Ink`}
            </p>
            <button
              onClick={refetch}
              className="text-xs text-pcs-primary hover:underline"
              disabled={loading}
            >
              {loading ? "Refreshing…" : "Refresh"}
            </button>
          </div>

          {!loading && pools.length === 0 && (
            <div
              className="rounded-2xl p-10 text-center"
              style={{ background: "#0d1220", border: "1px solid rgba(0,212,255,0.08)" }}
            >
              <p className="text-pcs-textDim text-sm">No launches found yet.</p>
              <p className="text-pcs-textDim text-xs mt-1">
                Be the first to launch a token on Ink!
              </p>
              <button
                onClick={() => setTab("launch")}
                className="mt-4 px-5 py-2 rounded-xl text-sm font-semibold"
                style={{ background: "rgba(0,212,255,0.10)", color: "#00d4ff" }}
              >
                Launch a Token
              </button>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {pools.map((pool) => (
              <PoolCard
                key={`${pool.chainId}-${pool.address}-${pool.baseToken.address}`}
                pool={pool}
                onTrade={handleTrade}
              />
            ))}
          </div>
        </div>
      )}

      {/* Launch tab */}
      {tab === "launch" && <LaunchForm />}
    </div>
  );
}
