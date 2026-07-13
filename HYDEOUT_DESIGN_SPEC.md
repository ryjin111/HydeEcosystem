# Hydeout — UI Design Spec v2 (board-first · pump.fun-behavior)

**Author:** shiro (senior designer) · **Scope:** frontend design system + board-first launchpad screens.
**Status:** direction approved by kami (msgs 21090/21095/21097/21099). Supersedes the Wave-A
noxa-era screen definitions below §2. Design system (§1) + honesty rules (§3) carry over.

**Reference (behavior only):** pump.fun. We copy its *behaviors* — land-on-the-board, live coin
grid, bonding-curve/graduation progress, real-time trade tape, quick actions — **never its
layout, copy, branding, or trade dress.** Visual system, layout, and wording are Hyde's own.

**Approved visual mocks (build to these):**
- `D:\agentmanagerworks\hydeout-shots\board-mockup.{html,png}` — Board / home
- `D:\agentmanagerworks\hydeout-shots\coin-mockup.{html,png}` — Coin page
- `D:\agentmanagerworks\hydeout-shots\launch-mockup.{html,png}` — $1 Launch flow

**Zero protocol change to ship the current rail.** Keep `src/utils/`, `src/hooks/`, wagmi, Doppler
SDK, contracts, CI. Own-stack (`CONTRACT_SPEC_L3.md`) swaps the data adapter later; UI is
protocol-agnostic and carries over.

---

## 1. Design system ("credible-finance, elevated" — dark, Hyde-blue, no neon)

### Color
- **Base:** bg `#0B0C0F` · surface `#121419` · elevated `#171A21` · hairline `#22252D`
- **Text:** `#E8EBF0` / muted `#8A93A2` / faint `#5B6472`
- **Accent:** Hyde-blue `#2E9FE6` · hover `#54B4F0`
- **Semantic:** success/graduated `#34C77B` · danger/sell `#E5484D` · amber (warn/soon) `#E0A32E`
- **No gradients, no glows** except a single optional hero card. Flat = the credible tell.

### Type — Space Grotesk display · Inter UI · IBM Plex Mono numbers/addresses
- Every `$` / `%` / address / count = **mono, tabular-nums**. Labels = uppercase-tracked, muted.

### Layout
- 4pt grid. Card radius 13–14px. Card padding 13–18px. Max content ~1240px.

### `✓ Verified` trust badge — our real edge
- Green pill "✓ Verified stack". gojo-gated to the shared `getLaunchImplementation()` bytecode
  resolver → shows ✓ only when the impl is genuinely `is_verified`; honest neutral otherwise.
  Appears on board cards + coin-page header.

### Motion
- 150ms hover. Live values flash-on-update (green up / red down). Live-ticker slide. Nothing gratuitous.

---

## 2. Screens (v2 — board-first)

### A. Board — `/` (the home; replaces the form-first landing)
Land straight on the live coin board, not a form.
- **Live trade ticker** (top strip): real recent buys/sells + new-launch/graduated events.
- **King of the Hill** hero: the hot coin — art, name/ticker, creator, sparkline, market cap,
  24h vol, holders, **bonding-curve → graduation bar**.
- **Almost Graduated** column: the coins nearing the graduation milestone, each a mini curve bar.
- **Filter tabs:** New · Almost Graduated · Graduated · **sort** (Trending/Top/New) · **search**.
- **Coin card grid:** art · name/ticker · creator · age · **market cap** · holders · **curve %** ·
  **`✓ Verified` + `90% creator` chips** · **quick-buy presets (0.1/0.5/1 + Buy)**.
  - Quick-buy obeys the same rail-aware execution rule as the coin-page widget (§3.2).

### B. Coin page — `/token/:address`
- **Header:** art · name `$TICKER` · creator · age · **contract addr (copy + explorer)** ·
  `✓ Verified stack` · live price + 24h.
- **Chart** with timeframe tabs (5m/1h/24h/7d).
- **Graduation bar:** `{pct}% to graduation · {raised}/{target} Ξ`. This is a **milestone/liquidity
  label ONLY — never a trading gate** (see §3.1).
- **Tabs:** Trades (live tape, default) · Holders. **Comments deferred** — hide the tab until a
  real indexed source + a moderation/abuse policy exist; never ship an empty or unmoderated feed.
- **Right rail:**
  - **Trade widget — rail-aware (§3.2).** Current rail: primary **"Trade on live pair ↗"** +
    "Trading is live on this token's pair." The Buy/Sell + amount + presets are shown
    **reference-only / dimmed & non-interactive** ("Native Hyde swap · preview — not live on this
    rail") until native swap actually executes and carries the selected side/amount.
  - **Market** card: mcap · price · 24h vol · liquidity · holders · total supply — each maps to a
    live adapter field or is hidden. Never simulated.
  - **Trust** card: **LIVE** = ✓ Verified stack, **90% creator fees**. **"Hyde stack" (future-tense)**
    = $1 launch, **90/5/5 fee split** (90% creator · 5% buyback & burn · 5% Hydeout), LP locked
    forever, anti-snipe max-wallet (§3.3, §3.9).
  - **Links:** website · X · explorer.

### C. Launch flow — `/launch`
Dead-simple, pump.fun-behavior, Hyde skin.
- **Name** → **ticker** (the only on-chain fields — token contracts need name/symbol only; never
  put image bytes on-chain for a $1 launch).
- **Coin image + socials = optional OFF-CHAIN metadata via IPFS** — an `ipfs://<CID>` reference
  (not embedded), rendered through a **configurable IPFS gateway**; no generic URL / third-party
  upload provider. When no verified `ipfs://` image exists, render a **generated monogram/fallback**.
  **On the current rail, hide the image/social fields unless their values can actually persist** —
  don't show inputs that silently drop.
- **Creator & fee-recipient confirm block:** connected wallet shown full-mono + checkbox gate
  ("this wallet is the immutable creator — 90% of trading fees route here permanently"). Resets
  on wallet switch. (Creator = `msg.sender`; matches L3 §creator-spoof fix.)
- **Live board-card preview** (right) updates as the form fills (monogram until an image persists).
- **"What you get":** Launch cost (this rail) = **Gas only** · supply 1B · **90% creator** ·
  **Trading is live from launch** (state only where the active rail supports it — never "block 1").
- **"Coming with the Hyde stack"** (future-tense): **$1 flat launch fee** · **90/5/5 fee split**
  (90% creator · 5% buyback & burn · 5% Hydeout) · LP locked forever · anti-snipe max-wallet.
  Primary button today = **"Launch token · Gas only"**; the $1 flips live only when the own-stack
  factory deploys.

### D. Portfolio — `/portfolio/:address`
Carry the shipped honest Profile (real Blockscout holdings, ✓Verified filter, one "Hyde Tokens
Held" stat, roadmap line — no fabricated created/portfolio). Restyle to v2 cards only.

### Global
- **Header:** logo · Board / Launch / Portfolio · search · chain pill (Robinhood 4663) · wallet.

---

## 3. Honesty states (kami-mandated — bake into component states, not a paragraph)

**3.1 No "trading opens at graduation" anywhere in Hydeout.** Where the active rail supports it,
trading is live from launch. Graduation = milestone / permanently-locked-liquidity label only.
The curve bar never implies a trade unlock.

**3.2 Rail-aware trade action.**
- Current rail: primary action = **"Trade on live pair ↗"**; copy "Trading is live on this
  token's pair." In-app Buy/Sell + amount controls are **visibly reference-only or disabled**
  unless the selected side/amount is actually carried into the destination trade — never imply
  Hyde executes or pre-fills an order it cannot submit.
- Native Hyde swap unavailable → "Native Hyde swap is not available for this rail yet." **Never
  cite graduation as the reason.**
- Hyde own-stack: trade available from launch; after milestone → "Milestone reached · liquidity
  permanently locked."

**3.3 Own-stack features stay future-tense until deployed.** $1 flat launch, LP-locked-forever,
anti-snipe max-wallet = "Hyde stack" / "coming" treatment, never present-tense claims, until the
`CONTRACT_SPEC_L3.md` contracts are deployed and wired. Trust chips split LIVE vs Hyde-stack.

**3.4 Every displayed metric/control maps to live adapter data or is hidden/disabled** — nothing
simulated in shipped UI. Mock placeholder content is illustrative only and must not ship as data.

**3.5 All fee/graduation/restriction copy is gojo source-true.** No guaranteed-return/APY framing.

**3.6 No on-chain image bytes; media is optional IPFS metadata.** Token contracts carry
name/symbol only. Image/socials = optional `ipfs://<CID>` reference (not embedded), rendered
through a configurable IPFS gateway — no generic URL / third-party upload provider — with a
generated monogram fallback. **Hide any field whose value can't actually persist on the active
rail** rather than showing an input that silently drops.

**3.7 "Trading is live from launch," never "block 1."** State it only where the active rail is
known to support launch-time trading; "block 1" is imprecise and can overclaim across adapters.

**3.8 Comments deferred.** No Comments tab in the first build unless a real indexed source + a
moderation/abuse policy exist; hide the tab, don't ship an empty or unmoderated feed.

**3.9 Fee split = clint-confirmed 90/5/5, honesty-bucketed.** Trading fees route **90% creator ·
5% buyback & burn · 5% Hydeout** (supersedes the old 95/5). Display rules:
- **Headline creator chip = `90% creator`** (was 95%) everywhere it appears.
- The **buyback&burn (5%) and Hydeout (5%) legs are own-stack economics** — they only exist once
  the `CONTRACT_SPEC_L3.md` factory deploys. Per §3.3 they carry the **future-tense "Hyde stack"**
  treatment; do not present them as present-tense/current-rail claims. The full 90/5/5 breakdown
  lives in the Hyde-stack trust panel, not the LIVE chip.
- Copy stays **gojo source-true** (§3.5): "buyback & burn" describes a mechanism, never an implied
  price floor or guaranteed return.

## 4. Per-screen look-gate bar (shiro)
One-card system · Hyde-blue accent, no neon · mono numbers · graduation bar = milestone not gate ·
live ticker/tape real · trade controls rail-aware & honest (§3.2) · LIVE vs Hyde-stack split ·
metrics map-or-hide · responsive/mobile clean. Builder = **bords** (per kami routing).
