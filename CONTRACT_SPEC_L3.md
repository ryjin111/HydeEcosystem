# Hydeout Own-Stack — Level-3 Contract Spec & Threat Model

**Status:** BUILD SPEC — decisions locked, ready for kami audit → then kuro implements.
**Author:** gojo (senior protocol) · **Reviewer gate:** kami · **Builder:** kuro · **Date:** 2026-07-13
**Parent:** `PROTOCOL_PLAN.md` (Level-2). This doc pins the contract interfaces, invariants, and tests.
**Build path:** contract workspace under `D:\agentmanagerworks\` (kami 21085) — never in a shared app tree.

> "Checked for bugs" = layered testing + independent review, **never** a claim any contract is bug-free
> (kami). No public deploy / no push until review passes + a second independent review.

---

## 0. Locked decisions (clint/kami 2026-07-13)
> **One item is build-start-nonblocking but DEPLOYMENT-blocking (kami audit 21158.2):** the buyback-sink *consumer* (§9) is open, but the collector's immutable `buybackSink` **address + semantics must be fixed in the reviewed manifest before any deploy** (it's a constructor immutable, `!= address(0)`). Contract build may start now; deploy cannot until this is pinned.

- **Fee split (own-stack): 90% creator / 5% buyback&burn / 5% Hydeout** of LP trading fees — immutable `creatorBps=9000`, `buybackBps=500`, `hydeoutBps=500`, `sum==1e4` (clint 2026-07-13, msg 21123; supersedes the earlier 95/5 draft). *(The LIVE Doppler rail's 95/5 is a separate already-deployed system, NOT this contract — this L3 own-stack spec is the sole definition of 90/5/5.)*
- **Buyback&burn mechanism — PROPOSED Option A (pending kami audit + clint confirm, §9):** the 5% buyback leg is realised **swap-free in the permissionless hot path.** Fees accrue in BOTH the launch token (LT) and the numéraire (N). The **LT portion of the buyback leg is burned on `collect`** (direct supply reduction — no swap, no MEV); the **N portion accrues to a `buybackSink`** for a **separate, slippage-guarded buyback** (never an in-`collect` swap). Rationale: an atomic swap inside the permissionless `collect` is **sandwichable** and would force an oracle + reentrancy surface, breaking this spec's no-swap selector story (INV-14). Option B (atomic in-collect swap-and-burn) is documented+rejected for v1 in §7.12.
- Launch fee: **$1 flat in the chain's canonical USD stablecoin**, atomic, before deploy (PROTOCOL_PLAN §2.5).
- Graduation: **Option A — permanently locked LP** (milestone label only, liquidity never migrates).
- Anti-snipe: **(b) time-boxed max-wallet** in `HydeERC20`, expires; never permanent.
- Supply: **1B, 100% to the launch pool** (fair launch, no premint/team alloc).

---

## 1. System topology
Three authored contracts + a deterministic clone per launch:
- **`HydeERC20`** — one verified *implementation*, EIP-1167-cloned per launch (cheap deploy, inherited verification).
- **`HydeTokenFactory`** — permissionless `launch`; charges the $1 fee, deploys+inits the clone, seeds single-sided V3 LP, registers the position with the collector. Owner sets templates/config for **future** launches only.
- **`HydeFeeCollector`** — custodies each launch's V3 position NFT **forever** (locked LP by absence of any withdraw/transfer path); permissionless `collect` splits **90/5/5** (creator / buyback&burn / Hydeout) — burning the launch-token buyback leg swap-free; permissionless `graduate` flips the milestone label.

Per-chain surface = the adapter config (§5). No dependency beyond a compatible Uniswap V3 + a configured stablecoin.

---

## 2. `HydeERC20` (implementation, cloned)

**Inherits:** minimal ERC-20 + EIP-2612 `permit` (holder UX). **No owner. No mint-after-init. No blacklist. No pause.** (Non-seizable by design — the honesty/trust claim.) The **only** post-init supply mutation is `burn(uint256) onlyCollector`, which **decreases** `totalSupply` for the 5% buyback&burn leg (§4) — one-directional, callable solely by the immutable `COLLECTOR`, never mints, never seizes a holder's balance (it burns the collector's own accrued fee tokens). The burn has **no recipient** (supply-reducing), and the collector's own balance is max-wallet-exempt, so the max-wallet hook never interferes.

**Immutable-after-init storage (set once in `initialize`, no setters):**
| field | meaning |
|---|---|
| `name`, `symbol` | metadata |
| `TOTAL_SUPPLY` | constant `1_000_000_000e18`, 100% minted to `pool` recipient at init |
| `maxWallet` | max holder balance during the anti-snipe window (from `maxWalletBps` of supply) |
| `maxWalletExpiry` | `uint64` timestamp; window active while `block.timestamp < maxWalletExpiry` |
| `exempt[address]` | max-wallet exemptions — a **fixed set frozen at init**: ONLY the V3 pool, position manager, factory, collector, `address(0)`. **No `setExempt`, no owner-addable whitelist** → no privileged wallet can be granted a cap-dodge (kami audit pt.4). |

**`initialize(InitParams) external` — clone init model (kami audit pt.2):** an EIP-1167 minimal proxy **cannot bake per-clone `immutable`s**, so these are **once-set storage** written in `initialize` under an `initializer` guard (reverts on any second call) and an **`onlyFactory` check**: the impl stores `factory` and on `initialize` requires `factory == address(0) && msg.sender == factory_` — i.e. the *first and only* caller becomes the recorded factory. The factory clones then immediately calls `initialize` in the **same transaction** (steps 2–3 of §3), so there is **no window for a third party to front-run `initialize`** on the fresh clone. (Alternative considered: `LibClone.clone`-with-immutable-args to append factory/pool as true immutable-args — kept as an optimization, not v1; v1 uses guarded storage-init for simplicity + testability.) `initialize` mints 100% supply into the seeding flow (§3 step 4) and sets the max-wallet fields + the fixed exempt set (incl. the **precomputed** V3 pool address — deterministic from `uniV3Factory`+token0/token1+`feeTier`, so it's known before the pool exists).

**`initialize` config-bounds asserts (kami impl-audit 21164.2) — revert on any of:** `poolRecipient == address(0)` · `collector == address(0)` · `maxWalletBps == 0 || maxWalletBps > MAX_WALLET_BPS_CAP` · `maxWalletWindowSecs > MAX_WINDOW_CAP`. **Pinned policy bounds (manifest-confirmable):** `MAX_WALLET_BPS_CAP = 300` (≤3% of supply — tight enough to blunt snipers, loose enough not to brick ordinary opening buys) and `MAX_WINDOW_CAP = 3600` (≤1h anti-snipe window; `0` = window disabled). *(kuro's rebase enforces non-zero + `≤1e4`; these are the tighter numeric caps — flag to clint/kami if a different % is wanted, else these land.)*

**Transfer hook (max-wallet):** on any transfer, enforce the cap **only when the sender is a real market source** — skip it for protocol-internal flows:
```
if (block.timestamp < maxWalletExpiry && !exempt[to] && from != COLLECTOR)
    require(balanceOf(to) + amount <= maxWallet);
```
- **`to == address(0)` reverts (`ZERO_TO`) in `_transfer` (kami impl-audit 21164.1):** ordinary transfers can never burn/strand tokens at the zero address. Supply is reduced **only** by the distinct `onlyCollector burn` path (§4) that actually decrements `totalSupply` — never by a transfer-to-zero.
- **Recipients only** → caps sniper *accumulation*; **never blocks selling** (`from` is never restricted) → users always exit.
- **`from == COLLECTOR` bypasses the cap (kami audit pt.8):** fee `collect` pays launch-token fees to the (non-exempt) creator; without this a payout during the window could push the creator over `maxWallet` and **revert `collect`**. Exempting *the collector as sender* lets fee distribution through **without** exempting the creator's own market buys (a buy comes `from == pool`, still capped) and **without any owner-addable whitelist**. The collector only ever sends to the immutable creator/treasury, so no sniper benefit exists.
- After `maxWalletExpiry`: zero restriction, permanently. Expiry immutable — cannot be extended/re-armed.

**Events:** standard `Transfer`/`Approval`. (No custom admin events — there is no admin.)

---

## 3. `HydeTokenFactory`

**Owner (multisig) — MINIMAL power (kami audit pt.1):** the owner's **only** capability is **`pause()`/`unpause()` of NEW launches**. It **cannot** change the fee, stablecoin, treasury, bps, uniswap addresses, or any economic parameter on the live factory, and cannot call into / mutate / seize / pause any already-launched token, its LP, or its fees. **All economic config is immutable (constructor-set); a different chain, version, fee, stablecoin, or treasury = a separately deployed immutable factory, never an owner toggle.** That is the load-bearing security claim.

**Immutables (ALL set in the constructor, NO setters):**
- `IMPL` — the `HydeERC20` implementation.
- `COLLECTOR` — the `HydeFeeCollector`.
- Economic config, **all `immutable`**: `stablecoin`, `launchFeeAmount`, `supportsPermit`, `launchFeeTreasury`, `uniV3Factory`, `positionManager`, `swapRouter`, `quoter`, `wrappedNative`, `feeTier`, `maxWalletBps`, `maxWalletWindowSecs`, `graduationThreshold`. **The trading-fee split legs (`hydeoutTreasury`, `buybackSink`, `buybackBps`, `hydeoutBps`) live on the COLLECTOR, not here (kami audit 21158.1)** — `collect` executes on the collector, so its authoritative source must be a collector immutable, not a cross-contract read. `creatorBps` is stored nowhere — it's the enforced remainder `1e4 - buybackBps - hydeoutBps == 9000`, so the creator can never be short-changed by rounding or config drift.
- **Presets — NOT an `immutable` dynamic array (illegal in Solidity; kami audit pt.4).** Encode the fixed preset set as a hard-coded `pure` library / internal function `preset(uint8 id) → (int24 initialTick, int24 tickLower, int24 tickUpper, uint256 graduationThreshold)` reverting on an unknown id, **or** a small fixed count of individual `immutable` fields. Either way presets are compile-time constants — owner cannot add/alter them, no path to change launch economics.
- **Chain-gate is a deploy-time constant:** a factory whose `stablecoin == address(0) || launchFeeAmount == 0` **cannot be constructed for live use** (constructor requires a configured stablecoin+amount), so a live factory always charges exactly its immutable $1. There is no "disabled/native/free" runtime branch to exploit.

**External functions:**
- `launch(LaunchParams p) external nonReentrant returns (address token, uint256 tokenId)` — path 1.
- `launchWithPermit(LaunchParams p, Permit sig) external nonReentrant returns (address token, uint256 tokenId)` — path 2 (EIP-2612; only if `supportsPermit`). **`nonReentrant` is a code-level requirement on both paths (kami audit pt.7)**, not just threat-model text.
- `LaunchParams = { string name, string symbol, uint8 preset }` — **NO caller-supplied `creator` (kami audit pt.1).** **`creator := msg.sender`** and the $1 fee is pulled from `msg.sender`. This closes the allowance-drain/creator-spoof: you can only ever charge *yourself* and be your own fee recipient. *(Relayed/gasless launch, if ever wanted: a separate path requiring a `creator` **EIP-712 authorization** binding all params + a nonce — explicitly out of v1.)*
- **Owner-only: `pause()` / `unpause()` (new launches only). Nothing else.** No `setConfig`/`setTreasury`/`setTemplate` exists (economic config is immutable, above).

**`launch` ordering (single tx — all-or-revert):**
1. **`_chargeLaunchFee(msg.sender)`** — FIRST state change, **`SafeERC20`** + **exact-received assertion** (kami audit pt.2): pull to `this` (or measure treasury delta) via `safeTransferFrom(msg.sender, launchFeeTreasury, launchFeeAmount)` and **`require(received == launchFeeAmount)`** → fee-on-transfer/rebasing can't short-pay. Path 2 calls `permit(msg.sender, …)` first. `approve`+`transferFrom` universal; `permit` only if immutable `supportsPermit`. Revert ⇒ nothing created.
2. `_deployClone()` — `Clones.cloneDeterministic(IMPL, salt)`, `salt = keccak256(msg.sender, symbol, nonce++)` (monotonic `nonce` → **no salt collision** even for identical name+symbol from the same creator).
3. `token.initialize(...)` — same-tx, `onlyFactory`+`initializer`-guarded (no front-run window, §2). Mints 1B into the seeding flow; sets `maxWallet = supply*maxWalletBps/1e4`, `maxWalletExpiry = now + maxWalletWindowSecs`, and the fixed exempt set (incl. precomputed pool).
4. `_seedLiquidity()` — **exact V3 mint flow (kami audit pt.6):** compute pool addr (deterministic), create+init the pool at `feeTier`/preset tick if absent, then mint the **single-sided** position via `positionManager.mint(...)` with **`recipient = COLLECTOR`**. The **factory is the transient payer**: it holds the freshly-minted 1B only across this call and transfers it into the position inside the **`uniswapV3MintCallback`** (callback authorized to accept **only** a call from the expected precomputed pool, only while a launch is in-flight). **Invariant: after `mint`, factory and collector each hold `0` launch-token balance** — 100% is in the position (INV-15). If pool create/init or `mint` reverts, the whole `launch` reverts (fee + clone rolled back — no orphan token).
5. `COLLECTOR.register(token, msg.sender, tokenId)` — only-factory; stores immutable `{creator, tokenId}` (the Hydeout treasury + buyback sink are collector-level immutables, shared across launches — not per-token).
6. Emit `LaunchFeePaid` + `LaunchCreated`.

**Events:**
- `LaunchFeePaid(address indexed creator, address indexed token, address stablecoin, uint256 amount)`
- `LaunchCreated(address indexed token, address indexed creator, address pool, uint256 tokenId, uint8 preset)`
- `Paused(bool)` (the ONLY owner action). **No `ConfigUpdated`** — it would contradict the no-setter/immutable-config factory (kami audit pt.4).

---

## 4. `HydeFeeCollector`

**Collector immutables (constructor-set, NO setters — kami audit 21158.1):** `FACTORY` (deploy-cycle, below), `hydeoutTreasury`, `buybackSink`, `buybackBps (==500)`, `hydeoutBps (==500)`. These are the **authoritative source** for the `collect` split (it runs here, so it must not depend on a cross-contract read). The deployer supplies them to the collector constructor from the reviewed per-chain manifest (§8); a different split or recipient = a separately deployed collector+factory pair, never a setter. Constructor asserts `buybackBps == 500 && hydeoutBps == 500 && buybackBps + hydeoutBps < 1e4` and both recipients `!= address(0)` (a zero `buybackSink` would silently strand the N buyback leg).

**Deployment sequence (resolves the factory↔collector cycle — kami audit pt.3):** the factory needs `COLLECTOR` immutable and the collector's `onlyFactory` needs the factory address — a cycle. Resolve **without a post-deploy setter**: (1) compute the factory's **CREATE2-predicted address** from its deploy salt + init-code hash; (2) deploy `HydeFeeCollector` with that predicted address baked as its immutable `FACTORY`; (3) deploy `HydeTokenFactory` (with the collector immutable) **to that predicted address** (same CREATE2 salt). No init-seizure window — the collector trusts exactly one address, fixed at its construction; if the factory fails to land at the predicted address, deployment is aborted. *(Fallback if predict-deploy is impractical: a one-shot `initFactory(addr)` on the collector, callable **once** by the immutable deployer then permanently locked; test that a second call / non-deployer caller reverts.)*

**Custody:** holds every launch's V3 position NFT. Registry `positionOf[token] = {creator, tokenId, graduated}` written **once** by the factory (`onlyFactory` `register`), never mutated after — except the `graduated` flag (one-way, `graduate`) and the separate **monotonic** `graduationProgress[token]` counter advanced only by `collect` (never decreased; INV-20). (Fee recipients `hydeoutTreasury`/`buybackSink` are collector-level immutables, not stored per token.)

**LP is locked by ABSENCE of a code path (kami audit pt.3):** there is **no** `decreaseLiquidity`, `withdraw`, `burn`, `transferPosition`, `collect`-to-arbitrary-recipient, generic `execute`/`call`/`delegatecall`/`multicall`, or `approve`/`setApprovalForAll` on the position — and **no owner/admin function that can move or touch the NFT.** The collector grants **no ERC-721 or ERC-20 approvals** on the position to anyone. `onERC721Received` returns the selector but **never forwards or acts**. There is **no inheritance that introduces a transfer/approve/withdraw path** (collector inherits only minimal, audited bases — no `Ownable`-over-position, no proxy). The only external actions are `collect(token)` (recipient hard-wired to `this` then split) and `graduate(token)` (label). This is the "liquidity locked forever" guarantee — **provable by enumerating every selector** and showing none reach `positionManager.{transferFrom,decreaseLiquidity,burn,approve}` directly or transitively (INV-4 + selector test).

**External functions:**
- `collect(address token) external nonReentrant` — **permissionless (`nonReentrant`, code-level — kami audit pt.7).** Calls V3 `positionManager.collect(tokenId, recipient=this, max, max)` → receives accrued fees in token0/token1 → for **each** collected asset `amt`, split **90/5/5** (remainder-to-creator, so the two 5% legs are exact and the creator absorbs all rounding — creator ≥ 90%, never < ):
  ```
  hydeoutCut = amt * hydeoutBps / 1e4;              // 5% → Hydeout platform
  buybackCut = amt * buybackBps / 1e4;              // 5% → buyback&burn
  creatorCut = amt - hydeoutCut - buybackCut;       // remainder ⇒ no stranded dust
  safeTransfer(hydeoutTreasury, hydeoutCut);
  if (asset == token) HydeERC20(token).burn(buybackCut);   // LT leg: burn direct — supply↓, swap-free, MEV-free
  else                safeTransfer(buybackSink, buybackCut); // N leg: to sink for a separate guarded buyback
  safeTransfer(creator, creatorCut);
  ```
  **Graduation accumulator (kami impl-audit 21164.3):** on each collect, `graduationProgress[token] += <numéraire amount collected this call, gross, pre-split>`. This is a **monotonic, only-ever-increasing counter** — `collect` *advances* graduation, so a permissionless collect can **never reduce** progress (that's the whole fix vs the resettable `tokensOwed`). Uses the numéraire (`wrappedNative`/stable) leg only, so launch-token fee accrual can't inflate it.
  Atomic; **revert on any transfer/burn failure** (no partial split, no accrual buffer). Emits `FeesCollected` + (on a non-zero LT burn) `BuybackBurned`. Launch-token legs never revert on the max-wallet cap — the token hook exempts `from == COLLECTOR` (§2 pt.8); and a **real `burn` has no recipient** (it reduces `totalSupply` from the collector's own balance — kami audit 21158.4), so no max-wallet *recipient* check applies to the buyback burn at all.
  - **Burn semantics:** `HydeERC20.burn(uint256)` is a **restricted `onlyCollector` real burn** that reduces `totalSupply` (NOT a public burn, NOT a transfer to `address(0)` which most ERC-20s revert on). It is the **only** post-init supply-changing path and can **only decrease** supply → INV-5 becomes "supply == 1e9 at launch, monotonically non-increasing, no mint path." This is the sole exception to `HydeERC20`'s "no mint-after-init / no privileged supply mutation" claim and is deliberately one-directional + collector-gated.
- `graduate(address token) external` — **permissionless**. `require(!graduated)`, `require(graduationProgress[token] >= graduationThreshold)` (the **monotonic** accumulator above — NOT the resettable position `tokensOwed`, which permissionless `collect` zeroes and could be used to grief graduation, kami impl-audit 21164.3), set `graduated = true`, emit `Graduated`. **No liquidity moves** (Option A) — label only. **`graduate` stays implementation/deploy-BLOCKED until this metric + `graduationThreshold` value are pinned** (kuro has it stubbed to revert `GRADUATION_PENDING` meanwhile — correct); the accumulator design is pinned here, the threshold *number* is a manifest policy value.

**Immutable invariants per token:** `creator`, `tokenId` — no setter reaches them post-`register`. Fee legs `hydeoutTreasury`, `buybackSink`, `buybackBps(=500)`, `hydeoutBps(=500)` are **collector-level** immutables (constructor-set, shared across all launches on this collector, no setter).

**Events:** `FeesCollected(token, creator, creatorAmt0, hydeoutAmt0, buybackAmt0, creatorAmt1, hydeoutAmt1, buybackAmt1)`, `BuybackBurned(token, amountBurned)`, `Graduated(token, atMetric)`, `PositionRegistered(token, creator, tokenId)`.

---

## 5. Authority & immutability boundary (the audit's spine)
| Actor | CAN | CANNOT |
|---|---|---|
| **Anyone** | `launch` (pay $1), `collect` (splits 90/5/5, burns LT buyback leg), `graduate` | change any recipient, move LP, mint, mutate bps/params |
| **Factory owner (multisig)** | **pause / unpause NEW launches — and nothing else** | change fee/stablecoin/treasuries/bps (all immutable); touch any live token / its LP / its fees; raise buyback/hydeout bps; unlock LP; extend max-wallet; add a max-wallet exemption; seize/freeze; force/redirect a buyback |
| **Creator** | receive **90%** (remainder leg); is the immutable recipient | change their recipient after launch; touch LP; mint |
| **Token contract** | ERC-20 + permit; enforce max-wallet during window; `burn` **only** via `onlyCollector` (supply ↓, one-way) | mint after init; be paused/blacklisted (no such code); burn any wallet but the collector's own fee tokens |

**Global immutability claims (must hold under fuzz):** post-launch, *no* reachable function alters price/range/threshold/creator/treasuries/`buybackBps`/`hydeoutBps`, moves or reduces the LP position, or extends the max-wallet window. **Supply** is the sole exception — monotonically non-increasing via `onlyCollector burn` (§4), never increasing.

---

## 6. Failure-mode / revert catalog
- Launch fee `safeTransferFrom` fails (allowance/balance / false-return / no-return token) → **revert, no token, no pool.**
- Chain stablecoin unset or `launchFeeAmount==0` → **revert** (feature disabled).
- `launchWithPermit` on a non-2612 stablecoin, or expired/invalid/replayed permit → **revert.**
- `initialize` called twice or by non-factory → **revert.**
- `collect` transfer leg fails → **revert** (no partial split).
- `graduate` before threshold or twice → **revert.**
- V3 pool already exists at that tick/fee for the pair → factory handles deterministically (create-or-init), never silently mis-seed.
- Paused (new launches) → `launch` reverts; live tokens unaffected.

---

## 7. Threat model (attack → mitigation)
1. **Creator-share theft / fee redirect** → collector owns the NFT; recipients immutable; no redirect selector. INV-3.
2. **LP rug / liquidity pull** → no decreaseLiquidity/withdraw/transfer path anywhere; no admin path. INV-4.
3. **Free-launch / fee bypass** → fee is the first state change; revert-on-fail; chain-gate. INV-8.
4. **Reentrancy** — (a) during `_chargeLaunchFee`: nothing is deployed yet, so no half-built state to exploit; stablecoin is admin-configured (trusted set). (b) during `collect`: checks-effects-interactions + `nonReentrant`; fee tokens are the pool's token0/token1 (the launch token is trusted, numéraire is wrappedNative/stable). Guard both. INV-11.
5. **Max-wallet permanent trap** → window time-boxed, expiry immutable, and **selling is never restricted** → users always exit. INV-6.
6. **Init front-run / re-init** → `initializer` once-guard + `onlyFactory` + deterministic CREATE2 salt. INV-10.
7. **Rounding/dust in 90/5/5** → creator gets `amt - hydeoutCut - buybackCut` (remainder) → no stranded dust, split sums exactly, creator never underpaid. INV-1.
8. **bps escalation** → `buybackBps` & `hydeoutBps` immutable, each hard-capped at 500 (creator ≥ 9000 always), no setter. INV-2.
12. **Buyback swap MEV / sandwich (why Option A, not B)** → the permissionless `collect` performs **no swap**: the LT buyback leg is burned directly and the N leg only *accrues* to `buybackSink`. So there is no in-path price impact for an attacker to sandwich, no oracle to grief, and the clean "no collector selector reaches a swap/router" story holds (INV-14, INV-18). Any actual N→LT buyback is a **separate slippage-guarded action** (guarded `buyback()` or treasury-side) whose worst case is bounded slippage on that isolated call, never a drain of `collect`. Option B (atomic in-collect swap-and-burn) is rejected for v1 precisely because it re-imports all three surfaces.
13. **Malicious burn / supply griefing** → `burn` is `onlyCollector`, one-directional (cannot mint), and can only burn the collector's own accrued fee balance — no third party can burn another holder, inflate, or re-arm supply. INV-19.
9. **Owner overreach onto live tokens** → owner functions gated to future-launch config only; property-tested that no owner selector alters a launched token. INV-9.
10. **Snipe on pool init** → protocol seeds the only liquidity single-sided at a fixed preset tick (no open first-deposit), and max-wallet caps sniper accumulation in the opening window.
11. **Griefing `collect`/`graduate` spam** → both idempotent-safe (exact split / one-way flag); harmless, no state corruption.

---

## 8. Invariant / property test matrix (Foundry — fuzz ≥256 runs, invariant campaigns)
| # | Invariant | Kind |
|---|---|---|
| INV-1 | `creatorCut + hydeoutCut + buybackCut == collected`; `creatorCut == collected - collected*500/1e4 - collected*500/1e4` (remainder, no dust); creator never underpaid across fuzzed amounts/decimals | property + fuzz(amount, decimals) |
| INV-2 | `buybackBps == 500 && hydeoutBps == 500` always; `creatorBps == 9000` (derived remainder); no path raises either 5% leg | invariant |
| INV-3 | `creator`, `hydeoutTreasury`, `buybackSink`, `buybackBps`, `hydeoutBps` all unchanged by ANY call sequence — no reachable selector mutates a recipient or a split value | invariant (fuzz calldata) |
| INV-4 | position liquidity never decreases; NFT never leaves collector | invariant |
| INV-5 | `totalSupply == 1e9*1e18` at launch; minted 100% at init; **monotonically non-increasing** thereafter (only `onlyCollector burn` decreases it); no mint path reachable after init | property |
| INV-6 | max-wallet blocks recipient over cap **iff** `now < expiry`; never after; never blocks `from`(sell); expiry immutable | property + fuzz(buy/sell sequences, time warps) |
| INV-7 | any revert in `launch` ⇒ no token/pool/registry/state persisted (atomicity) | property (fail-injection stablecoin) |
| INV-8 | exactly `launchFeeAmount` moved creator→treasury once per successful launch; zero on revert | property |
| INV-9 | no owner/admin selector alters a live token's params, LP, or fees | invariant (owner-as-adversary) |
| INV-10 | `initialize` succeeds once; second call / non-factory caller reverts | unit |
| INV-11 | reentrant stablecoin/token cannot double-spend or corrupt state in `launch`/`collect` | property (malicious ERC-20/reentrancy mock) |
| INV-12 | factory economic config (fee/stablecoin/treasury/bps) is `immutable` — **no selector mutates it**; owner's only reachable state-change is pause/unpause | invariant (owner-as-adversary, full calldata fuzz) |
| INV-13 | fee-on-transfer/rebasing stablecoin ⇒ `received != amount` ⇒ **revert** (exact-amount guard); treasury never short-paid | property (fee-on-transfer mock) |
| INV-14 | **selector enumeration:** no collector selector reaches `positionManager.{transferFrom,decreaseLiquidity,burn,approve}` or grants any approval — directly or transitively | invariant / static |
| INV-15 | after `_seedLiquidity`, factory & collector each hold **0** launch-token balance (100% in the position) | property |
| INV-16 | `creator == msg.sender` on every launch; **no path charges a wallet other than the caller** (allowance-drain impossible) | property (attacker passes victim addr → cannot) |
| INV-17 | during the window, `collect` paying launch-token fees to a non-exempt creator **does not revert** (`from==COLLECTOR` bypass) | property |
| INV-18 | **selector enumeration (buyback):** no collector selector reaches a swap router / `swap` / `exactInput*` — the buyback path performs zero swap; LT leg only calls `HydeERC20.burn`, N leg only `safeTransfer(buybackSink)` | invariant / static |
| INV-19 | `HydeERC20.burn` only decreases `totalSupply`, only callable by `COLLECTOR`, only burns the collector's own balance; no caller can mint, re-arm, or burn a third party | unit + invariant (burn-as-adversary) |
| INV-20 | `graduationProgress[token]` is **monotonically non-decreasing** across ANY call sequence; **`collect` never reduces it** (advances only); `graduate` succeeds iff progress ≥ threshold and is one-way | invariant (collect/graduate-as-adversary, fuzz call ordering) |
| INV-21 | `_transfer` reverts on `to == address(0)`; no ordinary transfer reduces `totalSupply` (only `burn` does) | unit + property |
| INV-22 | `initialize` reverts on zero poolRecipient/collector, `maxWalletBps ∉ (0, MAX_WALLET_BPS_CAP]`, or `maxWalletWindowSecs > MAX_WINDOW_CAP` | unit |

**Deploy-time tests (kami audit pt.5 — these are CONSTRUCTOR/DEPLOY reverts, not launch reverts):**
- Factory with `stablecoin==0` or `launchFeeAmount==0` **fails to construct** (there is no live factory that can hit that gate at launch — so it's a deployment-revert test, not a `launch` test).
- **Per-chain deployment manifest (required):** on-chain code can't prove an ERC-20 equals one USD, so each deployment carries a **reviewed manifest** pinning `{chainId, stablecoin address, decimals, launchFeeAmount, treasury, uniswap addrs}`; gojo/kami sign off the manifest per chain before deploy. `launchFeeAmount` is asserted to match the stablecoin's decimals ($1 → 1e6 / 1e18) in the manifest check.
- Deploy-cycle: CREATE2-predicted factory address matches the deployed factory; collector's `FACTORY` immutable equals it; fallback `initFactory` (if used) reverts on 2nd call / non-deployer (**no init seizure** — pt.3).

**Plus, non-invariant coverage (incl. kami audit pt.5):** unit tests for each revert in §6; permit happy/expired/replay; **duplicate salt / same-name+symbol collision** (salt = `keccak(msg.sender, symbol, nonce++)` → identical-name launches both succeed at distinct addresses, never collide/overwrite a registry entry); **V3 `uniswapV3MintCallback` authorization** (only the expected precomputed pool may call it, only mid-launch → cannot be invoked to drain the transient payer); **failed pool-init/seeding atomicity** (pool create/init or mint reverts ⇒ whole `launch` reverts, fee rolled back, no orphan token/clone); **fee-rounding/dust** (creator = `amt - hydeoutCut - buybackCut`, sum-exact across fuzzed amounts/decimals); **buyback-burn** (LT leg reduces `totalSupply` by exactly `buybackCut`, `from==COLLECTOR` cap-bypass holds, `burn` reverts for non-collector callers); **pause-only-new-launches** (paused ⇒ `launch` reverts; a pre-pause token still trades/`collect`s/`graduate`s); **narrow-exemption** (no non-infra address is max-wallet-exempt and no function can add one). Fork-integration lifecycle on a **Foundry fork of Robinhood mainnet 4663** (real Uniswap V3): launch → trades accrue fees → `collect` **90/5/5 exact** (creator paid, Hydeout paid, LT-leg burned / N-leg to sink) → threshold → `graduate` → post-state. Static analysis (slither) clean or triaged; gas snapshot.

---

## 9. Open sub-decisions (non-blocking for build start; flag at wiring)
- **Buyback&burn realisation — DECISION NEEDED (clint/kami).** §0/§4 encode **Option A** (swap-free: burn the LT leg on `collect`, accrue the N leg to `buybackSink` for a separate guarded buyback). The one open call: **what consumes `buybackSink`?** (a) a permissionless, slippage-/TWAP-guarded on-chain `buyback()` that swaps N→LT and burns — max transparency, some added surface; (b) the sink IS a burn/treasury address and buybacks are executed by the Hydeout treasury operationally — simplest, less "trustless." Default recommendation: **(a) later, as a separate reviewed module;** ship v1 with the LT-leg burn live + N leg parked in the sink, so the split is honest and swap-free from day one. Option B (atomic in-`collect` swap) stays rejected (§7.12).
- ~~Launch-fee amount fixed vs owner-adjustable~~ → **RESOLVED (kami audit pt.1): fixed & `immutable` per deployment.** No owner toggle; a different amount/stablecoin/treasury = a separately deployed factory.
- ~~Milestone metric for `graduate`~~ → **RESOLVED (kami impl-audit 21164.3): a monotonic `graduationProgress[token]` accumulator on the collector, advanced by the numéraire leg of each `collect`** — chosen over the position's `tokensOwed` (resettable by permissionless `collect` → grief-able) and over instantaneous reserves (non-monotonic with price). `collect` can only advance it (INV-20). **Still blocked on the `graduationThreshold` *number*** (manifest policy value) before `graduate` is un-stubbed/deployed.
- Board during transition: dual-source (show existing Doppler launches) vs Hyde-only (PROTOCOL_PLAN §7).
