import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { parseEther, zeroAddress } from "viem";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import toast from "react-hot-toast";
import { DopplerSDK, DAY_SECONDS, type DopplerSDKConfig } from "@whetstone-research/doppler-sdk";
import { useDopplerPools } from "../hooks/useDopplerTokens";
import type { DopplerPool } from "../utils/dopplerConfig";

const INK_CHAIN_ID = 57073;

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

function PoolCard({ pool, onTrade }: { pool: DopplerPool; onTrade: (addr: string) => void }) {
  const bt = pool.baseToken;
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
        <span
          className="ml-auto text-[10px] font-semibold px-2 py-0.5 rounded-full uppercase tracking-wide flex-shrink-0"
          style={{
            background: pool.type === "v4" ? "rgba(168,85,247,0.15)" : "rgba(0,212,255,0.10)",
            color: pool.type === "v4" ? "#a855f7" : "#00d4ff",
          }}
        >
          {pool.type}
        </span>
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
          onClick={() => onTrade(bt.address)}
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

type LaunchForm = {
  name: string;
  symbol: string;
  totalSupply: string;
  sellPercent: string;
  durationDays: string;
  marketCapStart: string;
  marketCapMin: string;
  ethPriceUsd: string;
};

const DEFAULTS: LaunchForm = {
  name: "",
  symbol: "",
  totalSupply: "100000000000",  // 100B — matches bankr-style micro-price launches
  sellPercent: "70",
  durationDays: "7",
  marketCapStart: "20000",      // $20K starting mcap (confirmed from live Doppler launches)
  marketCapMin: "3000",         // $3K floor (~15% of start)
  ethPriceUsd: "",
};

function useEthPrice() {
  const [price, setPrice] = useState<string | null>(null);
  const [fetching, setFetching] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setFetching(true);
    fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd")
      .then((r) => r.json())
      .then((d) => {
        const p = d?.ethereum?.usd;
        if (!cancelled && p) setPrice(String(Math.round(p)));
      })
      .catch(() => {/* silent — user can enter manually */})
      .finally(() => { if (!cancelled) setFetching(false); });
    return () => { cancelled = true; };
  }, []);

  return { price, fetching };
}

function LaunchForm() {
  const { address, chainId, isConnected } = useAccount();
  const publicClient = usePublicClient({ chainId: INK_CHAIN_ID });
  const { data: walletClient } = useWalletClient({ chainId: INK_CHAIN_ID });

  const { price: liveEthPrice, fetching: ethPriceFetching } = useEthPrice();
  const [form, setForm] = useState<LaunchForm>(DEFAULTS);
  const [submitting, setSubmitting] = useState(false);

  // Populate ETH price once the live fetch returns
  useEffect(() => {
    if (liveEthPrice) setForm((f) => ({ ...f, ethPriceUsd: liveEthPrice }));
  }, [liveEthPrice]);

  const chainMismatch = isConnected && chainId !== INK_CHAIN_ID;

  const set = (k: keyof LaunchForm) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const handleLaunch = async () => {
    if (!address || !publicClient || !walletClient) return;
    if (!form.name.trim() || !form.symbol.trim()) {
      toast.error("Token name and symbol are required");
      return;
    }

    const totalSupply = parseEther(form.totalSupply);
    const sellPercent = Math.max(1, Math.min(99, Number(form.sellPercent)));
    const numTokensToSell = (totalSupply * BigInt(sellPercent)) / 100n;
    const durationSecs = Math.max(1, Number(form.durationDays)) * DAY_SECONDS;
    const marketCapStart = Number(form.marketCapStart);
    const marketCapMin = Number(form.marketCapMin);
    const ethPriceUsd = Number(form.ethPriceUsd);

    if (marketCapMin >= marketCapStart) {
      toast.error("Min market cap must be less than starting market cap");
      return;
    }
    if (ethPriceUsd <= 0) {
      toast.error("ETH price must be greater than 0");
      return;
    }

    setSubmitting(true);
    try {
      const sdk = new DopplerSDK({
        publicClient: publicClient as DopplerSDKConfig["publicClient"],
        walletClient: walletClient as DopplerSDKConfig["walletClient"],
        chainId: INK_CHAIN_ID,
      });

      // Convert USD market caps → ETH proceeds (sell% of FDV at each cap / ETH price)
      const maxProceeds = parseEther(String((marketCapStart * sellPercent) / 100 / ethPriceUsd));
      const minProceeds = parseEther(String((marketCapMin * sellPercent) / 100 / ethPriceUsd));

      const params = sdk
        .buildDynamicAuction()
        .tokenConfig({ name: form.name.trim(), symbol: form.symbol.trim().toUpperCase(), tokenURI: "" })
        .saleConfig({ initialSupply: totalSupply, numTokensToSell, numeraire: zeroAddress })
        .withMarketCapRange({
          marketCap: { start: marketCapStart, min: marketCapMin },
          numerairePrice: ethPriceUsd,
          minProceeds,
          maxProceeds,
          duration: durationSecs,
        })
        .withMigration({ type: "uniswapV2" })
        .withGovernance({ type: "default" })
        .withUserAddress(address)
        .build();

      toast.loading("Launching token…", { id: "launch" });
      const result = await sdk.factory.createDynamicAuction(params);
      toast.success(`Token launched! ${result.tokenAddress ?? ""}`, { id: "launch", duration: 8000 });
      setForm(DEFAULTS);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(msg.length > 100 ? msg.slice(0, 100) + "…" : msg, { id: "launch" });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="w-full max-w-lg mx-auto rounded-2xl p-6 flex flex-col gap-5"
      style={{ background: "#0d1220", border: "1px solid rgba(0,212,255,0.10)" }}
    >
      <div>
        <h2 className="text-lg font-bold text-pcs-text">Launch a Token</h2>
        <p className="text-xs text-pcs-textDim mt-1">
          Powered by{" "}
          <a
            href="https://docs.doppler.lol"
            target="_blank"
            rel="noreferrer"
            className="text-pcs-primary hover:underline"
          >
            Doppler Protocol
          </a>{" "}
          — fair Dutch auction liquidity bootstrapping on Ink.
        </p>
      </div>

      {/* Token identity */}
      <div className="grid grid-cols-2 gap-3">
        <LabeledInput label="Token Name" placeholder="My Token" value={form.name} onChange={set("name")} />
        <LabeledInput label="Symbol" placeholder="MTK" value={form.symbol} onChange={set("symbol")} maxLength={8} />
      </div>

      {/* Supply */}
      <div className="grid grid-cols-2 gap-3">
        <LabeledInput
          label="Total Supply"
          placeholder="100000000000"
          value={form.totalSupply}
          onChange={set("totalSupply")}
          hint="Token units (no decimals)"
        />
        <LabeledInput
          label="% For Sale"
          placeholder="70"
          value={form.sellPercent}
          onChange={set("sellPercent")}
          hint="1–99%"
        />
      </div>

      {/* Auction parameters */}
      <div className="rounded-xl p-4 flex flex-col gap-3" style={{ background: "rgba(255,255,255,0.02)" }}>
        <p className="text-xs font-semibold text-pcs-textDim uppercase tracking-wide">Auction Parameters</p>

        <LabeledInput
          label="Duration (days)"
          placeholder="7"
          value={form.durationDays}
          onChange={set("durationDays")}
          hint="1–30 days"
        />

        <div className="grid grid-cols-2 gap-3">
          <LabeledInput
            label="Starting Market Cap (USD)"
            placeholder="20000"
            value={form.marketCapStart}
            onChange={set("marketCapStart")}
            hint="Initial FDV target"
          />
          <LabeledInput
            label="Min Market Cap (USD)"
            placeholder="3000"
            value={form.marketCapMin}
            onChange={set("marketCapMin")}
            hint="Price floor (~15% of start)"
          />
        </div>

        <LabeledInput
          label="ETH Price (USD)"
          placeholder={ethPriceFetching ? "Fetching…" : "e.g. 3000"}
          value={form.ethPriceUsd}
          onChange={set("ethPriceUsd")}
          hint={ethPriceFetching ? "Fetching live price…" : "Auto-fetched · editable"}
        />
      </div>

      {/* Info box */}
      <div
        className="text-xs text-pcs-textDim rounded-xl p-3 leading-relaxed"
        style={{ background: "rgba(0,212,255,0.04)", border: "1px solid rgba(0,212,255,0.08)" }}
      >
        After the auction ends, remaining ETH + unsold tokens automatically migrate to a Uniswap V2 pool on Ink,
        making your token instantly tradeable on HydeSwap.
      </div>

      {/* Submit */}
      {chainMismatch ? (
        <div className="text-center text-sm text-yellow-400 py-2">
          Switch your wallet to Ink (chain 57073) to launch.
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

function LabeledInput({
  label,
  placeholder,
  value,
  onChange,
  hint,
  maxLength,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  hint?: string;
  maxLength?: number;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium text-pcs-textDim">{label}</label>
      <input
        type="text"
        placeholder={placeholder}
        value={value}
        onChange={onChange}
        maxLength={maxLength}
        className="w-full rounded-xl px-3 py-2 text-sm text-pcs-text outline-none focus:ring-1 focus:ring-pcs-primary/50"
        style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(0,212,255,0.10)" }}
      />
      {hint && <p className="text-[10px] text-pcs-textDim">{hint}</p>}
    </div>
  );
}

/* ─── Page ────────────────────────────────────────────────────────────────── */

export function LaunchpadPage() {
  const [tab, setTab] = useState<"explore" | "launch">("explore");
  const { pools, loading, refetch } = useDopplerPools(INK_CHAIN_ID);
  const navigate = useNavigate();

  const handleTrade = (tokenAddress: string) => {
    // Navigate to swap page — the token will be available in the token selector
    // since useDopplerTokens populates the global list
    navigate(`/swap?out=${tokenAddress}`);
  };

  return (
    <div className="max-w-6xl mx-auto px-4 w-full">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-pcs-text">Launchpad</h1>
        <p className="text-sm text-pcs-textDim mt-1">
          Fair token launches powered by Doppler Dutch auctions on Ink.
          Every launched token is auto-discoverable in HydeSwap.
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
              {loading ? "Loading…" : `${pools.length} token${pools.length !== 1 ? "s" : ""} launched on Ink`}
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
                key={`${pool.address}-${pool.baseToken.address}`}
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
