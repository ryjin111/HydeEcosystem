# Hydeout Own-Stack Protocol Plan (Level 2)

**Status:** Level-2 rationale doc. **`CONTRACT_SPEC_L3.md` is the single current BUILD TRUTH** — where this doc and L3 differ, **L3 wins.** This doc is kept for the *why*; the *what-to-build* lives in L3.

> **Superseded-here → see L3 (kami audit 2026-07-13):**
> - Decisions now **LOCKED**: graduation = **A (permanently locked LP)**; anti-snipe = **(b) time-boxed max-wallet**; fee **95/5**; **$1** immutable stablecoin launch fee; **creator = msg.sender** (no caller-supplied creator).
> - **Topology folded:** L3 = **HydeERC20 impl + HydeTokenFactory + HydeFeeCollector** (three contracts). The Level-2 sketch of separate `HydeLaunch`/`HydeGraduation`/`HydeLocker` is **absorbed** — launch+seeding live in the factory; graduation-label + permanent LP custody live in the collector (locked by absence of a withdraw path, no separate locker).
> - **Owner power reduced to pause-new-launches only.** Any Level-2 "template-setting authority" / config setters (e.g. §2.4) are **void** — all economic config is `immutable` (L3 §3).

**Author:** gojo (senior protocol) · **Reviewer gate:** kami · **Date:** 2026-07-10 (L3 folded 2026-07-13)

---

## 1. Goal & why own-stack

Clint's directive: **Hydeout runs its own launch stack, not Doppler; fees are Hyde's; and we can be "first on any new chain the moment it deploys."**

The load-bearing reason own-stack is *required* (not just nicer): **we can only launch where Doppler is already deployed.** On a brand-new chain Doppler won't be there, so a Doppler-dependent Hydeout is *blocked* until they ship — the opposite of first-mover. NOXA is first-on-new-chains precisely because its stack is **self-contained** and depends only on a vanilla Uniswap deploy. To match that, Hyde's launch contracts must depend on **nothing but a standard Uniswap** on the target chain.

**Pattern reference:** NOXA's architecture (single-sided Uniswap V3 LP, instant trade, milestone graduation, protocol fee) is the *shape* we mirror. But per @kami: NOXA's contracts are **unverified/black-box** — we define Hyde's contracts and invariants **independently and from first principles**, with no assumptions copied from their bytecode. NOXA is a design reference, not a source.

---

## 2. Proposed architecture (Hyde-owned contracts)

All contracts Hyde-authored, Foundry-tested, source-verified on the chain's explorer (preserves our ✓Verified differentiator).

| Contract | Responsibility | Notes / invariants |
|---|---|---|
| **HydeTokenFactory** | Deploys each launch token as an **EIP-1167 minimal-proxy clone** of a verified `HydeERC20` implementation; **charges the $1 flat launch fee (§2.5) atomically before deploy** | Cheap deploys; clones inherit the verified impl → ✓Verified badge reads true for every launch (calibrated: proxy→verified-impl path already works on Blockscout). Immutable token params set at clone init. Fee transfer is the first state-changing step → reverts with no token on payment failure or on an unconfigured-stablecoin chain. |
| **HydeERC20** (implementation) | ERC-20 token logic (supply, optional max-wallet, permit) | **1B supply, 100% to the launch pool** (fair-launch invariant, no team/pre-mint). One verified impl, cloned N times. |
| **HydeLaunch** | Creates the token + seeds **single-sided Uniswap V3 LP** (protocol-owned position) → token tradeable immediately | Depends only on the chain's Uniswap V3 factory/position-manager. No bonding-curve state machine to maintain. |
| **HydeFeeCollector** | Collects the V3 LP swap fees, splits **95% creator / 5% Hyde treasury** (pending §3), permissionless `collect(token)` | Creator recipient immutable at launch (registered creator, per existing decision). Treasury address immutable/owner-set. **No burn** unless Clint adds it (keeps honesty copy simple). |
| **HydeGraduation** | Threshold detection + graduation action | Model TBD — see §4. |
| **HydeLocker** (if locked-LP model) | Permanently locks the protocol LP position | Only if §4 picks the locked-LP model. |

**Fee invariant:** the collector is the LP fee owner; on `collect`, creator gets 95%, Hyde treasury gets 5% (§3). Reverts on any transfer failure (reuse the `_safeTransfer` hardening already audited in HydeFeeSplitter). Never a silent partial split.

**Chain adapter (the whole per-chain surface):** `{ chainId, rpc, explorer, uniswapV3Factory, positionManager, swapRouter, quoter, wrappedNative }`. If those exist on a chain, Hyde launches there — no other dependency. **Hard dependency caveat (per @kami #7):** this plan requires a **compatible Uniswap V3** (or a Hyde-supported AMM with the same single-sided-LP semantics) on the target chain. "Any new chain" therefore means **"any new chain that has a compatible Uniswap V3 / supported AMM."** A chain with no such AMM cannot be supported under this plan without an additional AMM-adapter workstream — flag, don't silently claim coverage.

### 2.1 Launch parameter model (per @kami #2 — all immutable at launch)

Set once at token creation, **stored immutable in the clone init; no post-launch update path for any of them:**
- **Initial price** — encoded as the starting V3 tick (single price point for single-sided liquidity). Chosen from a small set of **market-cap presets** (mirrors the tick-preset approach; no external price feed needed).
- **V3 tick range** — the single-sided position's tick band (from the initial tick upward). Preset per launch template.
- **Liquidity amount** — the full **1B token supply** deposited single-sided (fair-launch invariant; no numéraire seeded by protocol).
- **Fee tier** — the Uniswap V3 pool fee tier the pool is created at (the swap fee that later splits 95/5).
- **Graduation threshold** — net-buy / accumulated-numéraire level that flips the token to Graduated (§4). Preset, immutable.
- **Creator address** — immutable fee recipient (registered at launch; see 2.2).
- **Anti-snipe window** (if enabled, see 2.3) — block/time window + max-wallet cap, immutable.

Invariant: **nobody (not creator, not Hyde admin) can mutate price/range/supply/threshold/creator after launch.** The only post-launch action is permissionless fee `collect` and (at threshold) permissionless `graduate`.

### 2.2 Fee custody mechanics (per @kami #3 — prevents anyone intercepting the creator share)

Uniswap V3 fees are collectable by the **owner of the position NFT.** To keep the creator's 95% un-interceptable:
- The **HydeFeeCollector contract owns the position NFT** (not an EOA, not the treasury, not the creator). No admin function transfers the NFT or redirects its `collect()` output.
- `collect(token)` is **permissionless**: anyone can trigger it. It calls the V3 `collect`, then splits the received fees **atomically** — 95% pushed to the immutable `creator` address, 5% to the immutable `treasury`. Reverts (via `_safeTransfer`, reusing the audited splitter hardening) if either leg fails; **no partial split, no accrual to an admin-controlled buffer.**
- **Treasury and creator recipients are immutable** for that token; `treasuryBps` immutable and **capped at 500 (5%)**. There is **no owner path** that can raise Hyde's cut, change the creator recipient, or sweep the position — those are the load-bearing invariants an audit must confirm.

### 2.3 Anti-snipe stance (per @kami #4 — Level-2 drops Doppler's 3%→1% decay)

Own-stack uses a **fixed V3 fee tier**, so Doppler's dynamic 3%→1% decay does **not** carry over. Options:
- **(a) No dynamic anti-snipe in v1** — accept it (like a plain V3 launch). Honest copy: no anti-snipe claim at all.
- **(b) Hyde-native time-boxed max-wallet (gojo-rec)** — because we own `HydeERC20`, enforce a **max-wallet cap for a short launch window** (e.g. first N blocks / minutes), then it lifts. This is NOXA's actual anti-snipe mechanism, it's enforceable on-chain in our own token, and it's honest/auditable.

**Recommendation: (b)**, presented in copy exactly as what it is — "max-wallet cap for the first X minutes after launch, then lifts. No permanent restriction." **Do NOT** reuse the old "3%→1% decay" anti-snipe copy on own-stack (it would be false). Clint/kami to confirm (a) vs (b); default (b).

### 2.4 Deploy permissions & ownership (per @kami #6)

- **HydeTokenFactory owner:** Hyde deployer/multisig — can set launch templates + the default treasury/bps, **cannot touch already-launched tokens** (their params are immutable in the clone).
- **Treasury address:** set at factory level for new launches; **immutable per-token once launched.** Changing the platform treasury affects only *future* launches, never past ones.
- **Emergency controls:** none that can move user/creator value. At most a **pause on NEW launches** (factory-level), never a pause/seize on live tokens, LPs, or fee collection. State explicitly what (if anything) is pausable.
- **Renounce/lock before public launch:** the `HydeERC20` implementation and `HydeFeeCollector` logic are non-upgradeable (clones point at a fixed impl); document that there is no proxy-admin upgrade path over token/fee logic. Factory template-setting authority is retained (needed to add chains/templates) but is **incapable of altering live tokens** — that boundary is the key security claim.

### 2.5 Launch fee — $1 flat, immutable, factory-level (Clint 2026-07-13, kami 21083)

A **flat $1 fee to create a token**, paid to the Hyde treasury *before* the token is deployed. This is a **distinct revenue line from the 95/5 trading-fee split** (§2.2): a one-time creation charge, not a slice of ongoing LP fees. It is exactly the "separate flat launch/graduation fee" the §3 rationale reserved as Hyde's revenue lever (so we never need to raise the 5%).

- **Denominated in a stablecoin, never native.** The fee is **exactly `launchFeeAmount` units of the chain's configured canonical USD stablecoin** (e.g. `1_000_000` for 6-decimal USDC = $1.00; `1e18` for an 18-decimal stable). **No native-token "≈ $1" conversion, no oracle** — a native "about a dollar" would fluctuate and require a price feed; a fixed stablecoin unit is exact and feed-free.
- **Per-chain config gates the whole feature.** The chain adapter (§2/§5) gains `{ stablecoin: address, launchFeeAmount: uint256, supportsPermit: bool }`. **If a chain has no configured, verified USD-stablecoin address + amount, launches are DISABLED on that chain** — the factory reverts and the launch UI is gated. Never launch for free, never fall back to native. Flag, don't silently degrade.
- **Paid atomically, before token creation, or the launch reverts.** The fee transfer is the **first state-changing step** of `launch(...)`, ahead of `_deployClone`/LP seeding. If payment fails (insufficient balance/allowance, a `false`-returning or no-return stablecoin) it **reverts with no token created, no LP seeded, no side effects.** Reuse the audited `_safeTransfer`/`_safeTransferFrom` hardening from HydeFeeSplitter — no partial charge, no accrual buffer.
- **Recipient is the immutable Hyde treasury.** Paid to the same immutable `treasury` recipient (or a fixed `launchFeeTreasury` set at deploy). **Immutable for each deployment configuration** — no owner path redirects it on a live deployment.
- **Amount/stablecoin/treasury are `immutable` (kami audit pt.1) — NO owner toggle on the live factory.** `launchFeeAmount`, `stablecoin`, and the fee treasury are constructor-set immutables; **a different amount, stablecoin, chain, or treasury = a separately deployed immutable factory.** There is no setter and no path that re-charges or alters an already-launched token. (Resolves the earlier fixed-vs-adjustable question in favor of fixed — strongest honesty story.)
- **Exact-amount guard (kami audit pt.2):** use `SafeERC20` and assert the treasury **received exactly `launchFeeAmount`** (balance-delta check) so a fee-on-transfer / rebasing stablecoin cannot short-pay. `approve`+`transferFrom` is the universal route; `permit` only where genuinely supported.
- **Event:** emit **`LaunchFeePaid(address creator, address token, address stablecoin, uint256 amount)`** on success, alongside `LaunchCreated`.

**Payment paths (two, grounded in ERC-20 reality):**
1. **approve + transferFrom (always available):** creator calls `stablecoin.approve(factory, amount)`, then `factory.launch(params)`; the factory does `safeTransferFrom(creator, treasury, amount)` first. Two txs for the creator.
2. **EIP-2612 permit (gasless approval, one tx) — only where the stablecoin supports 2612:** `factory.launchWithPermit(params, Permit{value, deadline, v, r, s})`; the factory calls `stablecoin.permit(creator, factory, value, deadline, v,r,s)` then `safeTransferFrom`. Gated by the adapter's `supportsPermit` flag — if the configured stablecoin lacks `permit`, only path (1) is exposed (the UI hides the one-tx option rather than failing at the node).

**Required tests (Foundry; feed into §6):**
- Happy path: exact `amount` lands at treasury, clone deployed, `LaunchFeePaid` + `LaunchCreated` emitted, ordering = fee-before-deploy.
- Revert + **no token created** on: insufficient allowance · insufficient balance · `false`-returning stablecoin · no-return (non-standard) stablecoin.
- Permit path: valid permit → succeeds with **no prior approve**; expired/invalid/replayed permit → reverts (and no token).
- Chain-gate: stablecoin unset / `launchFeeAmount == 0` → launch reverts (feature disabled), no token.
- Decimals correctness: `$1` resolves to `1e6` for a 6-dec stable and `1e18` for an 18-dec stable (config-driven, asserted per fixture).
- Immutability: no reachable setter redirects a live deployment's treasury recipient; future-launch config change is not retroactive.
- Fuzz + safety: arbitrary amounts/decimals; **no reentrancy** through the stablecoin transfer prior to clone deploy (fee transfer must not hand control to an attacker mid-launch).

---

## 3. DECISIONS

1. **Fee split — ✅ CONFIRMED by Clint 2026-07-10:** `95% creator / 5% Hyde treasury`. Locked into the fee model. (Rationale: creator-friendly acquisition edge; Hyde earns on aggregate volume; matches market-standard skim. Any additional Hyde revenue should come from a separate flat launch/graduation fee, NOT from raising the 5%.)
2. **Launch fee — ✅ CONFIRMED by Clint 2026-07-13 (kami 21083):** flat **$1 in the chain's canonical USD stablecoin**, paid to Hyde treasury atomically before token creation (full spec §2.5). This is the realized "separate flat fee" from decision #1's rationale — distinct from the trading-fee split. **Amount/stablecoin/treasury are `immutable` per deployment (kami audit pt.1) — no owner toggle.**
3. **Graduation model — ✅ LOCKED (clint/kami 2026-07-13): Option A — permanently locked LP** (milestone label only, liquidity never migrates). Was open; now decided. (§4 Option A is the build target; Option B is not built.)
4. **Anti-snipe — ✅ LOCKED: (b) time-boxed max-wallet** in `HydeERC20` (auto-expiring, never blocks selling). See L3 §2.
5. **Hyde treasury address** + **funded deployer key** on each target chain (needed only at deploy time, not for the spec) — plus the **per-chain deployment manifest** (stablecoin addr/decimals/amount) L3 §8 requires.

---

## 4. Graduation models — the two options (per @kami)

Both are honest and shippable; they differ in trust story and UX/copy.

### Option A — Permanent locked LP (NOXA-style)
- At launch, protocol LP is added single-sided; at a **net-buy/liquidity threshold** the token is marked "Graduated"; **the LP is locked forever** in HydeLocker. Liquidity never moves.
- **Pros:** simplest; strongest rug-resistance story ("liquidity locked permanently, can't be pulled"); no migration code/edge-cases; matches the reference.
- **Cons:** "graduation" is largely a milestone label (liquidity was always live); protocol permanently custodies the LP position; fees accrue in that single V3 position forever.
- **UX/copy (per @kami #5 — exact product language if A is chosen):** liquidity is **live and tradeable from block 0** and **never migrates**, so "graduation" is a **milestone label only, not a trading unlock.** Copy must say this precisely — e.g. token page: *"Trading is live from launch on this token's Uniswap pool."* and for the threshold: *"Milestone: 100% — liquidity permanently locked."* **Never** imply "trading opens at graduation" or "graduates to a real pool" (the pool was always real). The board's Auction/Graduated states become **Live / Locked** (or "Trading / Milestone reached") under Option A — @shiro to finalize the exact words at wiring.

### Option B — V2/V3 migration (Doppler-style, what Wave A does today)
- Token trades on the initial single-sided position; at threshold, **migrate liquidity into a fresh full-range Uniswap pool** (like today's `uniswapV2MigratorSplit`).
- **Pros:** familiar "bonding → graduated to real pool" mental model; deeper post-graduation liquidity; matches current Wave A copy so migration is smoother.
- **Cons:** migration is the highest-risk code path (value moves; must be atomic + attack-resistant); more to audit.
- **UX/copy:** "Graduated — migrated to a Uniswap pool" (current copy carries over).

**My recommendation:** **Option A (locked LP)** for Level-2 v1 — it's simpler, lower audit surface, and gives the sharpest honest trust line ("liquidity locked forever, 95% fees to creator, verified contracts, no third-party protocol"). Revisit B later if deeper graduated liquidity is wanted. **Clint's call.**

---

## 5. Chain-portability checklist (per new chain, before we claim support)

1. **RPC + explorer** endpoints (explorer must support contract verification for the ✓ badge).
2. **Uniswap presence:** V3 factory + position manager + swap router + quoter (Option A/B both need V3; migration target if B).
3. **Wrapped-native** token address (trading-fee denomination).
3a. **Canonical USD stablecoin** address + `launchFeeAmount` (decimals-correct $1) + `supportsPermit` flag (§2.5). **No verified stablecoin configured → launches DISABLED on that chain** (never native, never free). This is a hard gate on claiming support for a chain.
4. **Event indexing** that works in-browser or via a thin indexer — **no block-0/all-asset scans** (reuse the bounded/chunked `fetchHydePools` shape already built).
5. **Fee/graduation semantics** re-checked by gojo before any per-chain copy ships (fees, thresholds, decimals).
6. **Smoke test on-chain:** launch → board reads it → token page → ✓ verify badge → chart fallback → fee collect path → graduation. All green before "supported."

---

## 6. Security gates (before mainnet value)

- **Foundry unit + fuzz tests** on every contract (reuse the splitter's false-returning-token / no-return-token hardening patterns; ≥256-run fuzz on fee math + split).
- **Integration simulation** of a full lifecycle on a fork/testnet: launch → trades accrue fees → collect (95/5 exact) → graduation → post-graduation state.
- **Source verification** on the chain explorer for factory + implementation + collector (+ locker/migrator).
- **External audit** before real value on mainnet. No mainnet launch of value-bearing contracts pre-audit.
- **Invariant checks:** creator recipient immutable; treasury bps immutable & capped; fair-launch supply (100% to pool); no admin path that can drain creator fees or unlock locked LP (Option A).
- **Launch-fee tests (§2.5):** exact-amount-to-treasury + revert-no-token on payment failure (bad allowance/balance, false-return / no-return stablecoin), permit path (valid succeeds w/o approve, expired/replayed reverts), chain-gate revert when stablecoin unset, decimals correctness ($1 = 1e6 / 1e18), treasury immutability, and a reentrancy check on the pre-deploy fee transfer.

---

## 7. Migration path — Doppler Wave A → Hyde own-stack

The UI is **protocol-agnostic** (talks through `utils/` + `hooks/`), so the swap is at the data/adapter layer, not the UI.

- **UI hooks that change:** `useDopplerTokens`/`fetchHydePools` → read the **Hyde factory's** launch events instead of Doppler's Airlock; `useVerifiedStatus` unchanged (still proxy→impl). Swap component points at Hyde's V3 position/router instead of the Doppler gateway.
- **Copy that changes (one gated pass, only when live):** fee line `95% creator · 5% Doppler · 0% platform` → **`95% creator · 5% Hyde`**; hero subhead → drop "Doppler · Rehype," add "verified contracts · no third-party protocol" (shiro has this ready). Restrictions/graduation copy re-checked per §4 choice.
- **Existing Doppler launches (the current 30+/60 on 4663):** they stay on Doppler and remain tradeable via their existing path. Decision needed: **(a)** keep showing them on the board via a Doppler read-adapter (dual-source during transition), or **(b)** cut the board over to Hyde-only launches. Recommend **(a)** during transition so the board isn't empty at cutover, then Hyde-native launches accumulate. *(Non-blocking; flag for kami/clint at wiring time.)*
- **HydeFeeSplitter:** **superseded** by HydeFeeCollector's native 95/5 — *if* Clint confirms native 5% Hyde in own-stack. Otherwise it remains a Level-1 option on the current Doppler lane.

---

## 8. Phases & honest effort

1. **Spec** (this doc) → kami review.
2. **Contracts + Foundry tests** (factory, ERC20 impl, launch, fee collector, graduation/locker).
3. **Fork/testnet integration + smoke** (per @kami #1 — 4663 is *mainnet*, not a testnet): run against a **local Foundry fork of Robinhood mainnet 4663** (has the real Uniswap V3 to test against), and **Robinhood testnet 46630** *only if* it carries the required Uniswap V3 deps (verify first). Name the actual environment in the run, never call 4663 a testnet.
4. **External audit.**
5. **Mainnet 4663** deploy + verify + wire UI/copy (one gated slice).
6. **New-chain adapters** (§5 checklist per chain) → the "first on any new chain" payoff.

**Honest framing:** this is a **real protocol build with a real security surface** — phases 2–4 are the weight, and value must not go live pre-audit. It does **not** block the current Wave A app finishing on Doppler as the shell. UI investment carries over 100%.

---

## 9. Open items summary

- [x] Clint: confirm **95/5 (5% Hyde)** fee split — ✅ confirmed 2026-07-10.
- [x] Clint: **$1 flat launch fee** (stablecoin, atomic, immutable) — ✅ confirmed 2026-07-13; spec'd §2.5 (kami 21083). *(Sub-point open: fee fixed-per-deployment vs owner-adjustable-within-cap.)*
- [x] kami: review spec against gate list — ✅ PASS w/ 7 revisions (all folded in: §2.1 launch params · §2.2 fee custody · §2.3 anti-snipe · §2.4 ownership · §2/§5 chain-V3 caveat · §4 Option-A copy · §8 fork/testnet wording). *(§2.5 launch fee added 2026-07-13 — pending kami re-gate.)*
- [ ] Clint: choose **graduation model A (locked LP, rec) vs B (migration)** (§4).
- [ ] Clint: confirm **anti-snipe (a) none vs (b) time-boxed max-wallet** (§2.3, default b).
- [ ] Clint: Hyde treasury address + funded deployer key (at deploy time).
- [ ] gojo: on the 2 remaining Clint decisions, expand §2 into per-contract interface specs + invariants for the build phase.
