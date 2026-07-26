// Chain-driven launch view: ONE chain context → ONE launch experience (clint 24306 / kami 24307).
// No inner chain toggle, no V3/V4 choice grid. The chain (global selector, or a ?launchChain deep-link)
// determines the single engine, and only that engine's launch UI renders:
//   V4 chain (Robinhood) → the real V4 launch form.
//   V3 chain (Stable)    → the fail-closed V3 "coming" panel (disabled until evidence.launch).
// Engine + copy are DERIVED from the registry (chainEngineCapabilities + ENGINE_META), never cross-mixed.
import { useState } from "react";
import { LaunchTokenForm } from "./LaunchTokenForm";
import { chainEngineCapabilities, ENGINE_META, type LaunchEngine } from "../utils/chainRegistry";
import { Button, SectionLabel } from "./ui/kit";

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");

/** Fail-closed V3/coming launch panel — Stable-V3 copy from ENGINE_META (95/5 · locked), the Stable seed
 *  FDV/launch cost, and a DISABLED CTA. No fabricated numbers; nothing executes until deploy. */
function ComingLaunchBody({ chainId, chainName }: { chainId: number; chainName: string }) {
  const meta = ENGINE_META["v3-single-sided"];
  return (
    <div className="term-panel mx-auto w-full max-w-[680px] rounded-lg p-6 sm:p-8">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="font-display text-lg font-semibold text-pcs-text">Launch a token</h2>
        <span className="font-mono text-[11px] text-pcs-textDim">{chainName} · {chainId}</span>
      </div>
      <p className="mb-4 text-xs text-pcs-textSub">{meta.title} — {meta.subtitle}</p>

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
        <div className="flex justify-between text-pcs-textDim"><span>Starting FDV</span><span className="font-mono text-pcs-text">$5,000</span></div>
        <div className="flex justify-between text-pcs-textDim"><span>Fee split</span><span className="text-pcs-text">{meta.feeSplitLabel}</span></div>
        <div className="flex justify-between text-pcs-textDim"><span>Launch cost</span><span className="font-mono text-pcs-text">1 USDT0</span></div>
      </div>

      <Button variant="primary" size="lg" className="mt-5 w-full" disabled>
        Launch on {chainName} — Coming soon
      </Button>
      <p className="mt-3 text-center text-[11px] text-pcs-textDim">🔒 {meta.trustLine}</p>
    </div>
  );
}

/** Render one engine's launch body. V3 today is always the fail-closed "coming" panel (until
 *  evidence.launch); V4 is the real launch form. */
function EngineBody({ engine, chainId, chainName }: { engine: LaunchEngine; chainId: number; chainName: string }) {
  if (engine === "v3-single-sided") return <ComingLaunchBody chainId={chainId} chainName={chainName} />;
  return (
    <div className="terminal-launch-form">
      <LaunchTokenForm chainId={chainId} />
    </div>
  );
}

/** 2+ live engines on one chain (none today): a minimal engine-mode selector over the registry-derived
 *  engines. Kept so the render rule holds if a chain (e.g. Robinhood) ever passes a second engine row. */
function MultiEngineLaunch({ engines, chainId, chainName }: { engines: LaunchEngine[]; chainId: number; chainName: string }) {
  const [picked, setPicked] = useState<LaunchEngine>(engines[0]);
  return (
    <div className="mx-auto flex w-full max-w-[680px] flex-col gap-3">
      <div className="grid grid-cols-2 gap-1 rounded-lg border border-pcs-border bg-pcs-input p-1">
        {engines.map((e) => (
          <button
            key={e}
            onClick={() => setPicked(e)}
            className={cx(
              "rounded-md py-2 text-xs font-semibold transition",
              picked === e ? "border border-pcs-primary/40 bg-pcs-primary/15 text-pcs-primaryBright" : "border border-transparent text-pcs-textSub hover:text-pcs-text",
            )}
          >
            {ENGINE_META[e].title}
          </button>
        ))}
      </div>
      <EngineBody engine={picked} chainId={chainId} chainName={chainName} />
    </div>
  );
}

export function EngineAwareLaunch({ defaultChainId = 4663 }: { defaultChainId?: number }) {
  // Chain context = the GLOBAL network selector (App → LaunchpadPage → here). No launch-only deep-link:
  // one chain context, every surface (subtitle/ticker/sidebar/form) derives from it (kami 24313).
  const chainId = defaultChainId;
  const chainName = chainEngineCapabilities(chainId)[0]?.name ?? `Chain ${chainId}`;

  // Render rule (kami 24310 / gojo 24308): DERIVED from the registry, never hardcoded. A chain shows the
  // engines that pass their verified row (status != unsupported): 0 → one Coming-Soon state; 1 → that engine
  // directly, no selector/ghost; 2+ → a selector over just those engines (none have 2+ today).
  const engines = chainEngineCapabilities(chainId).filter((c) => c.status !== "unsupported");

  if (engines.length === 0) {
    return (
      <div className="term-panel mx-auto w-full max-w-[680px] rounded-lg p-8 text-center">
        <p className="text-sm text-pcs-textSub">Launching isn’t available on {chainName} yet.</p>
        <p className="mt-1 text-xs text-pcs-textDim">This chain has no verified launch engine.</p>
      </div>
    );
  }

  if (engines.length === 1) {
    return <EngineBody engine={engines[0].engine} chainId={chainId} chainName={chainName} />;
  }

  // 2+ live engines (none today) — engine-mode selector over the registry-derived engines.
  return <MultiEngineLaunch engines={engines.map((c) => c.engine)} chainId={chainId} chainName={chainName} />;
}
