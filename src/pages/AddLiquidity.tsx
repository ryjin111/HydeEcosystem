import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { V4LiquidityCard } from "../components/V4LiquidityCard";
import { ComingChainNotice } from "../components/ComingChainNotice";
import { TokenImage } from "../components/TokenImage";
import { useHydeLaunches } from "../hooks/useDopplerTokens";
import { chainEngineCapabilities, chainV3Capability, isHydeLaunchLive } from "../utils/chainRegistry";
import { fetchLaunchMeta } from "../utils/launchMeta";
import type { DopplerPool } from "../utils/dopplerConfig";
import type { NetworkConfig, TokenInfo } from "../utils/constants";
import { isGatewayLive } from "../utils/constants";

type Props = {
  network: NetworkConfig;
  tokens: TokenInfo[];
  onAddCustomToken: (token: { address: `0x${string}`; symbol: string; name: string; decimals: number }) => void;
};

const short = (value: string) => `${value.slice(0, 7)}…${value.slice(-5)}`;

function StableLiquidityRow({ pool, explorer }: { pool: DopplerPool; explorer: string }) {
  const [image, setImage] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchLaunchMeta(pool.chainId, pool.address).then((meta) => {
      if (!cancelled) setImage(meta?.image || null);
    });
    return () => { cancelled = true; };
  }, [pool.address, pool.chainId]);

  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-pcs-border/70 px-4 py-3 last:border-b-0">
      <TokenImage
        src={image}
        symbol={pool.baseToken.symbol}
        className="h-10 w-10 shrink-0 rounded-xl text-sm"
      />
      <Link to={`/token/${pool.address}?network=${pool.chainId}`} className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-pcs-text">
          {pool.baseToken.name}{" "}
          <span className="font-code text-[11px] text-pcs-textDim">${pool.baseToken.symbol}</span>
        </p>
        <p className="mt-0.5 font-code text-[9px] uppercase tracking-wider text-pcs-primary">
          Permanent V3 position · 1% pool
        </p>
      </Link>
      {pool.poolAddress && (
        <a
          href={`${explorer}/address/${pool.poolAddress}`}
          target="_blank"
          rel="noreferrer"
          className="rounded-md border border-pcs-border px-2.5 py-1.5 font-code text-[10px] text-pcs-textSub transition hover:border-pcs-primary/35 hover:text-pcs-primary"
        >
          Pool {short(pool.poolAddress)} ↗
        </a>
      )}
    </div>
  );
}

function StableLiquidityPage({ network }: { network: NetworkConfig }) {
  const { pools, loading, error, refetch } = useHydeLaunches(network.id);
  const explorer = network.explorerUrl.replace(/\/$/, "");
  return (
    <div className="hyde-page mx-auto w-full max-w-[1000px] space-y-4" data-depth-label="Stable · permanent liquidity">
      <section className="trench-board-header">
        <div className="relative z-[1] max-w-2xl">
          <p className="protocol-kicker"><span className="live-ping" />Stable V3 · custody live</p>
          <h1 className="mt-3 font-display text-3xl font-semibold tracking-[-0.035em] text-pcs-text sm:text-4xl">
            Liquidity enters once. <span className="trench-title-accent">It never leaves.</span>
          </h1>
          <p className="mt-3 max-w-xl text-sm leading-6 text-pcs-textSub">
            Every Hydeout Stable launch creates a canonical concentrated V3 position and transfers it
            into permanent custody. Manual add/remove controls are intentionally not part of this launch route.
          </p>
        </div>
      </section>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ["Tracked positions", loading || error ? "—" : pools.length.toLocaleString("en-US")],
          ["Principal custody", "Permanent"],
          ["Pool fee tier", "1%"],
          ["Creator fee share", "95%"],
        ].map(([label, value]) => (
          <div key={label} className="sonar-metric rounded-xl border border-pcs-border bg-pcs-card p-4">
            <p className="text-[10px] uppercase tracking-wider text-pcs-textDim">{label}</p>
            <p className="mt-2 font-code text-lg font-semibold text-pcs-text">{value}</p>
          </div>
        ))}
      </div>

      <section className="overflow-hidden rounded-2xl border border-pcs-border bg-pcs-card">
        <div className="flex items-center justify-between border-b border-pcs-border px-4 py-3">
          <div>
            <p className="text-sm font-semibold text-pcs-text">Canonical launch pools</p>
            <p className="mt-0.5 text-[10px] text-pcs-textDim">On-chain HydeV3Pad launch records</p>
          </div>
          <span className="rounded-full border border-pcs-success/25 bg-pcs-success/[0.08] px-2.5 py-1 font-code text-[9px] uppercase tracking-wider text-pcs-success">
            Live
          </span>
        </div>
        {error ? (
          <div className="px-5 py-8 text-center">
            <p className="text-sm text-pcs-textSub">Liquidity records are temporarily unavailable.</p>
            <button type="button" onClick={refetch} className="btn-ghost-term mt-3 px-3 py-1.5 text-xs">Retry</button>
          </div>
        ) : loading ? (
          <div className="px-5 py-8 text-center text-sm text-pcs-textDim">Reading Stable launch pools…</div>
        ) : pools.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-pcs-textDim">No Stable V3 launch positions found yet.</div>
        ) : (
          pools.map((pool) => (
            <StableLiquidityRow key={`${pool.chainId}-${pool.address}`} pool={pool} explorer={explorer} />
          ))
        )}
      </section>
    </div>
  );
}

export function AddLiquidityPage({ network, tokens, onAddCustomToken }: Props) {
  const [mode, setMode] = useState<"add" | "remove">("add");

  const v3Capability = chainV3Capability(network.id);
  const hasEngine = chainEngineCapabilities(network.id).length > 0;
  if (!isHydeLaunchLive(network.id) || (!v3Capability && !isGatewayLive(network.id))) {
    return (
      <div className="pt-8">
        <ComingChainNotice
          chainName={network.name}
          feature="Adding liquidity"
          engine={v3Capability ? "v3-single-sided" : "v4-hook"}
          detail={!hasEngine
            ? `${network.name} has no verified Hydeout launch or liquidity engine yet. This control remains disabled until the Arc deployment is complete and verified.`
            : !v3Capability && isHydeLaunchLive(network.id)
            ? `${network.name}'s Hydeout launch contracts are live. External liquidity controls remain hidden until the in-app V4 execution gateway is deployed and verified.`
            : undefined}
        />
      </div>
    );
  }
  if (v3Capability?.status === "live") {
    return <StableLiquidityPage network={network} />;
  }
  if (v3Capability) {
    return (
      <div className="pt-8">
        <ComingChainNotice chainName={network.name} feature="Adding liquidity" />
      </div>
    );
  }

  return (
    <div className="max-w-[440px] mx-auto">
      {/* Add / Remove toggle */}
      <div
        className="mb-4 flex items-center rounded-2xl p-1 mx-auto"
        style={{ background: '#121419', border: '1px solid #22252D' }}
      >
        <button
          type="button"
          onClick={() => setMode("add")}
          className={`flex-1 flex items-center justify-center gap-1.5 rounded-xl px-4 py-2 text-sm font-semibold transition ${
            mode === "add"
              ? "bg-pcs-secondary text-white shadow-sm"
              : "text-pcs-textSub hover:text-pcs-text"
          }`}
        >
          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          Add
        </button>
        <button
          type="button"
          onClick={() => setMode("remove")}
          className={`flex-1 flex items-center justify-center gap-1.5 rounded-xl px-4 py-2 text-sm font-semibold transition ${
            mode === "remove"
              ? "bg-pcs-failure/80 text-white shadow-sm"
              : "text-pcs-textSub hover:text-pcs-text"
          }`}
        >
          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 12h-15" />
          </svg>
          Remove
        </button>
      </div>

      <V4LiquidityCard
        network={network}
        tokens={tokens}
        mode={mode}
        onAddCustomToken={onAddCustomToken}
      />
    </div>
  );
}
