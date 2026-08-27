// Chain-driven launch view: ONE chain context → ONE launch experience (clint 24306 / kami 24307).
// No inner chain toggle, no V3/V4 choice grid. The chain (global selector, or a ?launchChain deep-link)
// determines the single engine, and only that engine's launch UI renders:
//   V4 chain (Robinhood) → the real V4 launch form.
//   V3 chain (Stable)    → the live V3 form only when deployment evidence passes; otherwise "coming".
// Engine + copy are DERIVED from the registry (chainEngineCapabilities + ENGINE_META), never cross-mixed.
import { useState } from "react";
import { TrenchV5LaunchForm } from "./TrenchV5LaunchForm";
import { StableV3LaunchForm } from "./StableV3LaunchForm";
import { chainEngineCapabilities, ENGINE_META, type LaunchEngine } from "../utils/chainRegistry";
import { NETWORKS } from "../utils/constants";
import { Button, SectionLabel } from "./ui/kit";
import type { TrenchV5Readiness } from "../hooks/useTrenchV5Ready";
import { isTrenchV5Configured, isTrenchV5PubliclyAvailable } from "../utils/trenchV5";

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");

/** Fail-closed launch panel. It names the intended engine but never exposes a
 * transaction control before Hydeout's chain-specific contracts are deployed. */
function ComingLaunchBody({
  chainId,
  chainName,
  engine,
  error,
  onRetry,
}: {
  chainId: number;
  chainName: string;
  engine: LaunchEngine;
  error?: string | null;
  onRetry?: () => void;
}) {
  const meta = ENGINE_META[engine];
  const isV4 = engine === "v4-hook";
  const publicMainnetPending = !isTrenchV5PubliclyAvailable(chainId);
  return (
    <div className="term-panel mx-auto w-full max-w-[680px] rounded-lg p-6 sm:p-8">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="font-display text-lg font-semibold text-pcs-text">Launch a token</h2>
        <span className="font-mono text-[11px] text-pcs-textDim">{chainName} · {chainId}</span>
      </div>
      <p className="mb-4 text-xs text-pcs-textSub">V5 · Trench Curve — {meta.title} graduation rail</p>

      <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block">
          <SectionLabel>Name</SectionLabel>
          <input disabled placeholder="e.g. Hoodie Coin" className="mt-1 w-full rounded-lg border border-pcs-border bg-pcs-input px-3 py-2.5 text-sm text-pcs-text placeholder:text-pcs-textDim disabled:opacity-60" />
        </label>
        <label className="block">
          <SectionLabel>Symbol</SectionLabel>
          <input disabled placeholder="HOODIE" className="mt-1 w-full rounded-lg border border-pcs-border bg-pcs-input px-3 py-2.5 font-code text-sm text-pcs-text placeholder:text-pcs-textDim disabled:opacity-60" />
        </label>
      </div>

      <div className="flex flex-col gap-2 rounded-lg border border-pcs-border bg-white/[0.02] px-4 py-4 text-xs">
        <div className="flex justify-between text-pcs-textDim"><span>Protocol rail</span><span className="text-pcs-text">{isV4 ? "Trench Curve → locked V4" : "Trench Curve → locked V3"}</span></div>
        <div className="flex justify-between text-pcs-textDim"><span>Curve / reserve</span><span className="text-pcs-text">80% / 20%</span></div>
        <div className="flex justify-between text-pcs-textDim"><span>Fee split</span><span className="text-pcs-text">{meta.feeSplitLabel}</span></div>
        <div className="flex justify-between text-pcs-textDim">
          <span>Availability</span>
          <span className="font-mono text-pcs-text">{publicMainnetPending ? "Public mainnet pending" : "Awaiting verification"}</span>
        </div>
      </div>

      {publicMainnetPending ? (
        <Button variant="primary" size="lg" className="mt-5 w-full" disabled>
          Launch on {chainName} — Coming soon
        </Button>
      ) : error && onRetry ? (
        <Button variant="secondary" size="lg" className="mt-5 w-full" onClick={onRetry}>
          Retry deployment verification
        </Button>
      ) : (
        <Button variant="primary" size="lg" className="mt-5 w-full" disabled>
          Launch unavailable
        </Button>
      )}
      <p className="mt-3 text-center text-[11px] leading-5 text-pcs-textDim">
        {publicMainnetPending
          ? `${chainName} launches are disabled until its public mainnet is live and Hydeout re-verifies the complete deployment.`
          : error
          ? error
          : isV4
          ? "The V4 rail is implemented. Launches open only after the V5 factory, graduator, and permanent locker are deployed and runtime-hash verified."
          : "The V3 rail is implemented. Launches open only after the chain-specific V5 factory, graduator, and permanent locker are deployed and runtime-hash verified."}
      </p>
    </div>
  );
}

function VerifyingLaunchBody({ chainName, chainId }: { chainName: string; chainId: number }) {
  return (
    <div className="term-panel mx-auto w-full max-w-[680px] rounded-lg p-8 text-center" aria-live="polite">
      <div className="mx-auto h-6 w-6 animate-spin rounded-full border-2 border-pcs-primary/25 border-t-pcs-primary" />
      <p className="mt-4 text-sm font-semibold text-pcs-text">Verifying {chainName} deployment…</p>
      <p className="mt-1 text-xs text-pcs-textDim">Checking chain {chainId}, runtime hashes, and protocol bindings.</p>
    </div>
  );
}

/** Render one engine's launch body. Stable V3 becomes executable only after its registry capability
 *  passes the generated deployment/hash/binding evidence gate; otherwise the disabled panel remains. */
function EngineBody({
  engine,
  chainId,
  chainName,
  readiness,
  onLaunched,
}: {
  engine: LaunchEngine;
  chainId: number;
  chainName: string;
  readiness: TrenchV5Readiness;
  onLaunched?: () => void;
}) {
  if (readiness.checking) {
    return <VerifyingLaunchBody chainId={chainId} chainName={chainName} />;
  }
  if (!readiness.ready) {
    return <ComingLaunchBody chainId={chainId} chainName={chainName} engine={engine} error={readiness.error} onRetry={readiness.retry} />;
  }
  if (engine === "v3-single-sided" && !isTrenchV5Configured(chainId)) {
    return <StableV3LaunchForm chainId={chainId} chainName={chainName} onLaunched={onLaunched} />;
  }
  return <TrenchV5LaunchForm chainId={chainId} chainName={chainName} engine={engine} onLaunched={onLaunched} />;
}

function EngineRouteBanner({ engine, chainId, readiness }: { engine: LaunchEngine; chainId: number; readiness: TrenchV5Readiness }) {
  const meta = ENGINE_META[engine];
  const standaloneV3 = engine === "v3-single-sided" && !isTrenchV5Configured(chainId);
  const versionLabel = standaloneV3 ? "V3 launch" : "V5";
  return (
    <div className="engine-identity-bar">
      <div>
        <p className="commandbar-label">
          {readiness.checking
            ? `Verifying ${versionLabel} deployment`
            : readiness.ready
              ? `${versionLabel} deployment verified`
              : readiness.error
                ? `${versionLabel} verification unavailable`
                : `${versionLabel} deployment pending`}
        </p>
        <p className="mt-1 font-display text-sm font-semibold text-pcs-text">{standaloneV3 ? "V3 · Single-sided launch" : "V5 · Trench Curve"} <span className="text-pcs-textDim">/ {engine === "v4-hook" ? "V4" : "V3"}</span></p>
      </div>
      <div className="min-w-0 sm:text-right">
        <p className="font-code text-[11px] text-pcs-primaryBright">{meta.feeSplitLabel}</p>
        <p className="mt-1 text-[10px] leading-4 text-pcs-textDim">{meta.trustLine}</p>
      </div>
    </div>
  );
}

/** 2+ live engines on one chain (none today): a minimal engine-mode selector over the registry-derived
 *  engines. Kept so the render rule holds if a chain (e.g. Robinhood) ever passes a second engine row. */
function MultiEngineLaunch({
  engines,
  chainId,
  chainName,
  readiness,
  onLaunched,
}: {
  engines: LaunchEngine[];
  chainId: number;
  chainName: string;
  readiness: TrenchV5Readiness;
  onLaunched?: () => void;
}) {
  const [picked, setPicked] = useState<LaunchEngine>(engines[0]);
  return (
    <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-3">
      <div className="grid grid-cols-1 gap-2 rounded-xl border border-pcs-border bg-pcs-input p-2 sm:grid-cols-2">
        {engines.map((e) => (
          <button
            key={e}
            onClick={() => setPicked(e)}
            className={cx(
              "engine-route-button rounded-lg p-3 text-left text-xs transition",
              picked === e ? "border border-pcs-primary/40 bg-pcs-primary/15 text-pcs-primaryBright" : "border border-transparent text-pcs-textSub hover:text-pcs-text",
            )}
          >
            <span className="block font-semibold">{ENGINE_META[e].title}</span>
            <span className="mt-1 block font-code text-[10px]">{ENGINE_META[e].feeSplitLabel}</span>
          </button>
        ))}
      </div>
      <EngineRouteBanner engine={picked} chainId={chainId} readiness={readiness} />
      <EngineBody engine={picked} chainId={chainId} chainName={chainName} readiness={readiness} onLaunched={onLaunched} />
    </div>
  );
}

export function EngineAwareLaunch({
  defaultChainId = 4663,
  v5Readiness,
  onLaunched,
}: {
  defaultChainId?: number;
  v5Readiness: TrenchV5Readiness;
  onLaunched?: () => void;
}) {
  // Chain context = the GLOBAL network selector (App → LaunchpadPage → here). No launch-only deep-link:
  // one chain context, every surface (subtitle/ticker/sidebar/form) derives from it (kami 24313).
  const chainId = defaultChainId;
  const chainName = chainEngineCapabilities(chainId)[0]?.name
    ?? NETWORKS.find((network) => network.id === chainId)?.name
    ?? `Chain ${chainId}`;

  // Render rule (kami 24310 / gojo 24308): DERIVED from the registry, never hardcoded. A chain shows the
  // launch-capable engines from the registry: 0 → one Coming-Soon state; 1 → that engine
  // directly, no selector/ghost; 2+ → a selector over just those engines (none have 2+ today).
  const engines = chainEngineCapabilities(chainId).filter(
    (capability) => capability.role === "launch" || capability.role === "launch+trade",
  );

  if (engines.length === 0) {
    return (
      <div className="term-panel mx-auto w-full max-w-[680px] rounded-lg p-8 text-center">
        <p className="text-sm text-pcs-textSub">Launching isn’t available on {chainName} yet.</p>
        <p className="mt-1 text-xs text-pcs-textDim">This chain has no verified launch engine.</p>
      </div>
    );
  }

  if (engines.length === 1) {
    return (
      <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-3">
        <EngineRouteBanner engine={engines[0].engine} chainId={chainId} readiness={v5Readiness} />
        <EngineBody engine={engines[0].engine} chainId={chainId} chainName={chainName} readiness={v5Readiness} onLaunched={onLaunched} />
      </div>
    );
  }

  // 2+ live engines (none today) — engine-mode selector over the registry-derived engines.
  return <MultiEngineLaunch engines={engines.map((c) => c.engine)} chainId={chainId} chainName={chainName} readiness={v5Readiness} onLaunched={onLaunched} />;
}
