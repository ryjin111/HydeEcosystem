# V3 Line — Multichain UI Design Pass (§7 of `CONTRACT_SPEC_V3_LINE.md`, detailed)

**Author:** shiro (design) · **Date:** 2026-07-24 · **Grounded in the real frontend, not a mockup.**

> **Key finding:** the "switch chain, it always matches" machinery **already exists** — `src/utils/chainRegistry.ts` is the
> fail-closed capability registry I designed (msg 23063, kami-accepted 23060/23065). It derives `status: live|coming|unsupported`
> from **evidence artifacts, never hand-set booleans**, and the switcher "migrates chains as they genuinely light up." That IS
> gojo's verified-or-hidden gate, already shipped. **BUT it is V4-only.** The V3 line is therefore **NOT new UI architecture** —
> it's three additive extensions to existing code. That's why clint's "it always matches" is a guarantee, not a hope: the
> fail-closed derivation already enforces it; we just add a second evidence source.

---

## The three concrete extensions (all additive, zero rewrite)

### 1. `ChainCapability` gains an engine discriminator + numeraire (in `chainRegistry.ts`)

Today `ChainCapability` (lines 36–62) has `nativeSymbol` but **no launch-numeraire and no engine field**. Add:

```ts
export type LaunchEngine = "v4-hook" | "v3-single-sided";

export interface NumeraireInfo {
  address: string;
  symbol: string;        // config only — NEVER an on-chain symbol() call (Stable reverts)
  decimals: number;      // config literal — NEVER read on-chain (§2 of the contract spec)
  displayDecimals: number; // drives price formatting (see #3)
  usdPegged: boolean;    // true for USDT0/USDC → render "$", false for WETH → render symbol/Ξ
}

export interface ChainCapability {
  // ...existing fields unchanged...
  engine: LaunchEngine;        // NEW — which stack the data hooks talk to
  numeraire: NumeraireInfo;    // NEW — the launch/pricing asset for this chain
}
```

`engine` is the single switch the data layer reads: `v4-hook` → the existing `useDopplerTokens`/V4 path; `v3-single-sided` →
the new `HydeV3Pad`/`HydeV3FeeLocker` read hooks. **The components never branch on engine — only the data hook does.** Same
board, same coin page, same launch form (clint's "retain our design").

### 2. A V3 derivation path (parallel to `deriveCapability`, same fail-closed shape)

`deriveCapability` (lines 101–153) checks V4-specific config (`poolManager`, `stateView`, gateway bytecode). Add a sibling
`deriveV3Capability` that reads the **V3 row** and proves the V3 execution path — mirroring the existing fail-closed structure so
a half-configured V3 chain renders `coming`, never `live`:

```ts
function v3ExecutionPathProven(row: V3ChainRow, ev: ChainEvidence | undefined): boolean {
  // gojo's chainverify evidence, same "derived from a live read" rule as executionPathProven:
  return !!ev?.v3
    && ev.v3.npmFactory.toLowerCase() === row.v3Factory.toLowerCase()  // NPM.factory() binds ✓
    && ev.v3.feeTierTickSpacing > 0                                    // fee tier live ✓
    && ev.v3.poolProofResolves                                        // getPool(token,numeraire,tier) resolves ✓
    && ev.v3.pairedTokenDecimals === 18;                              // shape confirmation ✓
}
```

`status` derives exactly as today (`tradeReady && marketsReady && smoke.read && smoke.trade ? "live" : "coming"`). **Stable/988
is added as one `CANDIDATE` row with `engine: "v3-single-sided"`, `role: "launch+trade"`, numeraire = USDT0 (6-dec).** It goes
`live` only when gojo's `chainverify` evidence lands in `chainEvidence.ts` — same artifact discipline as the V4 chains. Until
then: `coming`. **Verified-or-hidden, for free, from the registry I already built.**

### 3. Numeraire-aware price formatting (in `format.ts`)

`format.ts` has `formatAmount(value, decimals, max)` — decimals-parameterized (good) but **no price/FDV formatter that switches
$ vs native**. Add:

```ts
// USD-pegged numeraire (USDT0/USDC, 6-dec) → "$1.23"; native numeraire (WETH, 18-dec) → "Ξ0.0000123".
export function formatPrice(value: bigint | number, n: NumeraireInfo): string {
  const num = typeof value === "bigint" ? Number(formatUnits(value, n.decimals)) : value;
  if (!Number.isFinite(num)) return n.usdPegged ? "$0" : `0 ${n.symbol}`;
  if (n.usdPegged) {
    // sub-cent prices (memecoin launches) need many sig-figs, not "$0.00"
    const frac = num < 0.01 ? 8 : 4;
    return `$${num.toLocaleString(undefined, { maximumFractionDigits: frac })}`;
  }
  return `${num.toLocaleString(undefined, { maximumFractionDigits: 8 })} ${n.symbol}`;
}

export function formatFdv(fdv: number, n: NumeraireInfo): string {
  return n.usdPegged ? `$${fdv.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
                     : `${fdv.toLocaleString()} ${n.symbol}`;
}
```

Every price/FDV render on the board + coin page reads the active chain's `capability.numeraire` and calls these. **No chain ever
shows a garbage number** (the $1.9T-class bug is a formatting-and-decimals bug; this is the UI half, the contract §2 is the math
half). A 6-dec USDT0 pool and an 18-dec WETH pool render correctly from the *same* component.

---

## Chain switcher + per-chain badge (UI, builds on existing)

The registry already carries `logo`, `shortName`, `status`, `role`. The switcher (migrating off the Robinhood-only `NETWORKS`
array, per the registry's own note) renders:

- **Switcher list:** each `chainCapabilities()` entry as a row — logo + name + a status pill. `live` = selectable; `coming` =
  shown disabled with a subtle "soon" (honest: we don't hide the roadmap, we gate selection). `unsupported` never appears.
- **Per-chain network badge** (on the header + every coin card): the chain logo + `shortName` chip so a Stable pool never
  visually blurs with a Robinhood one.
- **Launch form is CHAIN-CONTEXTUAL — one engine, no disabled ghost** (clint, 2026-07-24, msg 24306 — supersedes the earlier
  two-button V3/V4 picker of 24237/24241, which clint rejected as clutter after seeing it rendered). Each chain shows **only the
  engine it actually offers**, as a single engine-mode block (not a picker): **Stable/988 → V3 single-sided only**; **Robinhood/4663
  → V4 hook only**. Availability + copy still **derived fail-closed from `chainEngineCapability`** — an unavailable engine is never
  rendered at all (not shown-disabled). Only surface a real *selector* if a chain ever offers 2+ live engines simultaneously (none
  do today). Everywhere else (board, coin page, badges) engine stays plumbing. See the per-chain frame (shiro, msg 24309).
- **Numeraire chip:** where a pool shows its pair, the numeraire renders from config (`USDT0`/`WETH`), not an on-chain symbol.

### Copy locks (from the contract spec §0/§7 — design owns the words)

- **Graduation (Option A):** *"Trading is live from launch on this token's Uniswap pool."* + milestone *"liquidity permanently
  locked."* Board states = **Live / Locked**. NEVER "trading opens at graduation" / "graduates to a real pool."
- **Anti-snipe:** *"max-wallet cap for the first X minutes, then lifts."* NEVER fee-decay language (false on V3 — no dynamic-fee hook).
- **No-exit badge:** codehash proof the locker exposes no `decreaseLiquidity`/transfer/burn selector — the "can't-rug" trust line,
  same as the V4 custody badge.

### Launch-form engine selector — copy locks (kami-corrected, msg 24242; contract-confirmed by kuro 24243)

**Rule:** all chain-specific copy comes from `ENGINE_META` keyed by the derived engine (kuro's `57c1d4f`). V4 economics are
structurally unreachable on a V3 chain and vice-versa — the frame is only the visual binding of that single source of truth.
These strings map 1:1 to contract behavior; do not paraphrase in impl.

**Stable/988 — `v3-single-sided` (numeraire USDT0, 6-dec):** — shown as the ONLY engine on this chain (no V4 rendered at all).
- Engine-mode label: *"Single-sided pool — concentrated LP, permanently locked."*  (do NOT say "Available" — Stable is `coming`)
- **Fee split:** `95% creator · 5% Hyde`   (= `_split` BPS; NOT 90/5/5)
- **Launch cost:** `1 USDT0`   (= `launchFeeAmount 1e6`; NOT ETH/$1)
- **Starting FDV:** `$5,000`   (Stable fork seed)
- **Trust line:** `Liquidity permanently locked; principal cannot be removed.`   (NO V4 auto-compound "5% locks into LP" copy)
- **CTA (while `coming`):** disabled — `Launch on Stable — Coming soon` (enables only when `evidence.launch` passes).
- **V4 is NOT rendered on Stable** — per-chain single-engine (msg 24306). No disabled ghost, no "V4 unavailable" line; the chain
  simply shows its own engine.

**Robinhood 4663 — `v4-hook` (numeraire per row):** shown as the ONLY engine on this chain. Keeps the V4 branch copy (`90/5/5`,
auto-compound, native-ETH fee) — but renders **only if the 4663 row's V4 capability passes its gate**, never a `4663-only` hardcode.
V3 and V4 availability are each derived independently from their own verified rows.

---

## Undersea theme layer — "the hideout beneath the surface" (clint 24303, kami 24304, 2026-07-24)

A restrained premium **background/theme layer** — NOT a layout rewrite. hydeout = *hideout*, so the brand dives below the surface.

- **Depth gradient:** vertical deep-sea fall-off — lighter blue-navy near the "surface" (top) → near-black in "the deep" (bottom).
- **Caustic light:** soft **cyan→violet** god-rays from the top, low opacity + heavy blur, skewed. Subtle, never busy.
- **Particles:** a few faint drifting bubbles on brand surfaces only. No literal aquarium clutter, no heavy animation (respect
  `prefers-reduced-motion`).
- **The shark emerges from the glow:** `lo.png` on `mix-blend-mode: screen` inside a cyan/violet radial depth-glow (drops the black
  plate; the neon reads as bioluminescence). Hero + empty states.
- **Amber stays the action color** — primary CTAs remain amber for hierarchy (kami 24302). Accent = the shark's cyan/violet neon.
- **Dense forms stay solid, high-contrast** — launch/market panels are opaque dark surfaces over the sea, never glassy. Readability
  and scan-speed win over atmosphere on data surfaces (kami). The sea is felt on Landing/hero/empty states, quieted on forms/tables.

---

## Why this is safe to build in parallel with kuro's contracts

- All three changes are **additive** to `chainRegistry.ts` + `format.ts` — no change to any existing V4 chain's behavior (the
  V4 `deriveCapability` path is untouched; the V3 path is a new branch).
- Stable/988 stays `coming` until gojo's `chainEvidence.ts` V3 artifact lands — so shipping the UI extension **cannot** surface a
  broken chain before the contracts + verify gate are real. Fail-closed protects the parallelism.
- The `formatPrice`/`formatFdv` helpers can land + be unit-tested immediately (pure functions, both 6-dec and 18-dec fixtures) —
  the UI half of audit-item-#1's decimals coverage.

## Build order (design/UI, parallel to kuro's contract track)

1. `ChainCapability` += `engine` + `numeraire` (type-only, no behavior) → 2. `formatPrice`/`formatFdv` + unit fixtures (6/18-dec)
→ 3. `deriveV3Capability` + `V3ChainRow` type + Stable/988 candidate (renders `coming` until evidence) → 4. switcher migration to
`chainCapabilities()` + network badge → 5. wire the board/coin-page price renders through `formatPrice`. Gate on `vite preview`
(prod bundle), real pointer clicks on the switcher — per the prod-preview + real-click rules.
