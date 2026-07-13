# Hydeout Own-Stack — Level-3 Contract Spec & Threat Model

**Status:** BUILD SPEC — decisions locked, ready for kami audit → then kuro implements.
**Author:** gojo (senior protocol) · **Reviewer gate:** kami · **Builder:** kuro · **Date:** 2026-07-13
**Parent:** `PROTOCOL_PLAN.md` (Level-2). This doc pins the contract interfaces, invariants, and tests.
**Build path:** contract workspace under `D:\agentmanagerworks\` (kami 21085) — never in a shared app tree.

> "Checked for bugs" = layered testing + independent review, **never** a claim any contract is bug-free
> (kami). No public deploy / no push until review passes + a second independent review.

---

## 0. Locked decisions (all resolved — clint/kami 2026-07-13)
- Fee split: **95% creator / 5% Hyde treasury** of LP trading fees (immutable, treasuryBps ≤ 500).
- Launch fee: **$1 flat in the chain's canonical USD stablecoin**, atomic, before deploy (PROTOCOL_PLAN §2.5).
- Graduation: **Option A — permanently locked LP** (milestone label only, liquidity never migrates).
- Anti-snipe: **(b) time-boxed max-wallet** in `HydeERC20`, expires; never permanent.
- Supply: **1B, 100% to the launch pool** (fair launch, no premint/team alloc).

---

## 1. System topology
Three authored contracts + a deterministic clone per launch:
- **`HydeERC20`** — one verified *implementation*, EIP-1167-cloned per launch (cheap deploy, inherited verification).
- **`HydeTokenFactory`** — permissionless `launch`; charges the $1 fee, deploys+inits the clone, seeds single-sided V3 LP, registers the position with the collector. Owner sets templates/config for **future** launches only.
- **`HydeFeeCollector`** — custodies each launch's V3 position NFT **forever** (locked LP by absence of any withdraw/transfer path); permissionless `collect` splits 95/5; permissionless `graduate` flips the milestone label.

Per-chain surface = the adapter config (§5). No dependency beyond a compatible Uniswap V3 + a configured stablecoin.

---

## 2. `HydeERC20` (implementation, cloned)

**Inherits:** minimal ERC-20 + EIP-2612 `permit` (holder UX). **No owner. No mint-after-init. No blacklist. No pause.** (Non-seizable by design — the honesty/trust claim.)

**Immutable-after-init storage (set once in `initialize`, no setters):**
| field | meaning |
|---|---|
| `name`, `symbol` | metadata |
| `TOTAL_SUPPLY` | constant `1_000_000_000e18`, 100% minted to `pool` recipient at init |
| `maxWallet` | max holder balance during the anti-snipe window (from `maxWalletBps` of supply) |
| `maxWalletExpiry` | `uint64` timestamp; window active while `block.timestamp < maxWalletExpiry` |
| `exempt[address]` | max-wallet exemptions — a **fixed set frozen at init**: ONLY the V3 pool, position manager, factory, collector, `address(0)`. **No `setExempt`, no owner-addable whitelist** → no privileged wallet can be granted a cap-dodge (kami audit pt.4). |

**`initialize(InitParams) external`** — `initializer` guard (callable **once**), **only callable by the factory** (`msg.sender == factory`, factory address baked at clone creation or checked via immutable). Mints 100% supply to the seeding recipient (factory/collector) for the single-sided position.

**Transfer hook (max-wallet):** on any transfer, `if (block.timestamp < maxWalletExpiry && !exempt[to]) require(balanceOf(to) + amount <= maxWallet)`.
- Applies to **recipients only** → caps how much a sniper can *accumulate*; **never blocks selling** (a `from` is never restricted) → users can always exit, even during the window.
- After `maxWalletExpiry`: zero restriction, permanently. Expiry is immutable — cannot be extended or re-armed.

**Events:** standard `Transfer`/`Approval`. (No custom admin events — there is no admin.)

---

## 3. `HydeTokenFactory`

**Owner (multisig) — MINIMAL power (kami audit pt.1):** the owner's **only** capability is **`pause()`/`unpause()` of NEW launches**. It **cannot** change the fee, stablecoin, treasury, bps, uniswap addresses, or any economic parameter on the live factory, and cannot call into / mutate / seize / pause any already-launched token, its LP, or its fees. **All economic config is immutable (constructor-set); a different chain, version, fee, stablecoin, or treasury = a separately deployed immutable factory, never an owner toggle.** That is the load-bearing security claim.

**Immutables (ALL set in the constructor, NO setters):**
- `IMPL` — the `HydeERC20` implementation.
- `COLLECTOR` — the `HydeFeeCollector`.
- Economic config, **all `immutable`**: `stablecoin`, `launchFeeAmount`, `supportsPermit`, `launchFeeTreasury`, `tradingTreasury`, `treasuryBps (==500)`, `uniV3Factory`, `positionManager`, `swapRouter`, `quoter`, `wrappedNative`, `feeTier`, `maxWalletBps`, `maxWalletWindowSecs`, `graduationThreshold`.
- `tickPreset[]` — fixed at construction (immutable price/range templates; owner cannot add/alter presets → no path to change launch economics).
- **Chain-gate is a deploy-time constant:** a factory whose `stablecoin == address(0) || launchFeeAmount == 0` **cannot be constructed for live use** (constructor requires a configured stablecoin+amount), so a live factory always charges exactly its immutable $1. There is no "disabled/native/free" runtime branch to exploit.

**External functions:**
- `launch(LaunchParams p) external returns (address token, uint256 tokenId)` — path 1 (creator pre-approved the stablecoin).
- `launchWithPermit(LaunchParams p, Permit sig) external returns (address token, uint256 tokenId)` — path 2 (EIP-2612; only if `supportsPermit`).
- `LaunchParams = { string name, string symbol, address creator, uint8 preset }` (price/range/threshold come from the immutable `preset`, not caller-chosen → no arbitrary-tick grief).
- **Owner-only: `pause()` / `unpause()` (new launches only). Nothing else.** No `setConfig`/`setTreasury`/`setTemplate` exists (economic config is immutable, above).

**`launch` ordering (single tx — all-or-revert):**
1. **`_chargeLaunchFee(creator)`** — FIRST state change, using **`SafeERC20`** and an **exact-received assertion** so a fee-on-transfer / rebasing token cannot short-pay (kami audit pt.2): measure `launchFeeTreasury` balance (or pull to `this`) before/after `safeTransferFrom(creator, launchFeeTreasury, launchFeeAmount)` and **`require(received == launchFeeAmount)`** — revert on any shortfall. Path 2 calls `permit` first. `approve`+`transferFrom` is the universal route; `permit` is offered only when the immutable `supportsPermit` is true. Revert ⇒ nothing created.
2. `_deployClone()` — `Clones.cloneDeterministic(IMPL, salt)` (`salt = keccak(creator, symbol, nonce)`).
3. `token.initialize(...)` — sets immutables, mints 1B to the seeding flow, computes `maxWallet = supply * maxWalletBps / 1e4`, `maxWalletExpiry = block.timestamp + maxWalletWindowSecs`.
4. `_seedLiquidity()` — create/init V3 pool at `feeTier` + preset initial tick; mint the **single-sided** position (1B tokens, from `tickPreset`) with **`COLLECTOR` as the position recipient/owner**.
5. `COLLECTOR.register(token, creator, tokenId)` — only-factory; stores immutable `{creator, treasury, tokenId}`.
6. Emit `LaunchFeePaid` + `LaunchCreated`.

**Events:**
- `LaunchFeePaid(address indexed creator, address indexed token, address stablecoin, uint256 amount)`
- `LaunchCreated(address indexed token, address indexed creator, address pool, uint256 tokenId, uint8 preset)`
- `ConfigUpdated(...)`, `Paused(bool)` (owner actions on future launches only).

---

## 4. `HydeFeeCollector`

**Custody:** holds every launch's V3 position NFT. Registry `positionOf[token] = {creator, treasury, tokenId, graduated}` written **once** by the factory (`onlyFactory` `register`), never mutated after.

**LP is locked by ABSENCE of a code path (kami audit pt.3):** there is **no** `decreaseLiquidity`, `withdraw`, `burn`, `transferPosition`, `collect`-to-arbitrary-recipient, generic `execute`/`call`/`delegatecall`/`multicall`, or `approve`/`setApprovalForAll` on the position — and **no owner/admin function that can move or touch the NFT.** The collector grants **no ERC-721 or ERC-20 approvals** on the position to anyone. `onERC721Received` returns the selector but **never forwards or acts**. There is **no inheritance that introduces a transfer/approve/withdraw path** (collector inherits only minimal, audited bases — no `Ownable`-over-position, no proxy). The only external actions are `collect(token)` (recipient hard-wired to `this` then split) and `graduate(token)` (label). This is the "liquidity locked forever" guarantee — **provable by enumerating every selector** and showing none reach `positionManager.{transferFrom,decreaseLiquidity,burn,approve}` directly or transitively (INV-4 + selector test).

**External functions:**
- `collect(address token) external` — **permissionless**. Calls V3 `positionManager.collect(tokenId, recipient=this, max, max)` → receives accrued fees in token0/token1 → for each: `treasuryCut = amt * 500 / 1e4; creatorCut = amt - treasuryCut; safeTransfer(treasury, treasuryCut); safeTransfer(creator, creatorCut)`. Atomic; **revert on any transfer failure** (no partial split, no accrual buffer). Emits `FeesCollected`.
  - Split sends the **remainder to creator** (`amt - treasuryCut`) → no dust stranded, creator ≥ 95%.
- `graduate(address token) external` — **permissionless**. `require(!graduated)`, read the milestone metric (accumulated numéraire/`wrappedNative` reserve in the position vs `graduationThreshold`), `require(metric >= threshold)`, set `graduated = true`, emit `Graduated`. **No liquidity moves** (Option A) — label only.

**Immutable invariants per token:** `creator`, `treasury`, `treasuryBps(=500)`, `tokenId` — no setter reaches them post-`register`.

**Events:** `FeesCollected(token, creator, creatorAmt0, treasuryAmt0, creatorAmt1, treasuryAmt1)`, `Graduated(token, atMetric)`, `PositionRegistered(token, creator, tokenId)`.

---

## 5. Authority & immutability boundary (the audit's spine)
| Actor | CAN | CANNOT |
|---|---|---|
| **Anyone** | `launch` (pay $1), `collect`, `graduate` | change any recipient, move LP, mint, mutate params |
| **Factory owner (multisig)** | **pause / unpause NEW launches — and nothing else** | change fee/stablecoin/treasury/bps (all immutable); touch any live token / its LP / its fees; raise treasuryBps; unlock LP; extend max-wallet; add a max-wallet exemption; seize/freeze |
| **Creator** | receive 95%; is the immutable recipient | change their recipient after launch; touch LP; mint |
| **Token contract** | ERC-20 + permit; enforce max-wallet during window | mint after init; be paused/blacklisted (no such code) |

**Global immutability claims (must hold under fuzz):** post-launch, *no* reachable function alters price/range/supply/threshold/creator/treasury/treasuryBps, moves or reduces the LP position, or extends the max-wallet window.

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
7. **Rounding/dust in 95/5** → creator gets `amt - treasuryCut` (remainder) → no stranded dust, split sums exactly. INV-1.
8. **treasuryBps escalation** → `bps` immutable, hard-capped at 500, no setter. INV-2.
9. **Owner overreach onto live tokens** → owner functions gated to future-launch config only; property-tested that no owner selector alters a launched token. INV-9.
10. **Snipe on pool init** → protocol seeds the only liquidity single-sided at a fixed preset tick (no open first-deposit), and max-wallet caps sniper accumulation in the opening window.
11. **Griefing `collect`/`graduate` spam** → both idempotent-safe (exact split / one-way flag); harmless, no state corruption.

---

## 8. Invariant / property test matrix (Foundry — fuzz ≥256 runs, invariant campaigns)
| # | Invariant | Kind |
|---|---|---|
| INV-1 | `creatorCut + treasuryCut == collected`; `creatorCut == collected - collected*500/1e4` (no dust) | property + fuzz(amount, decimals) |
| INV-2 | `treasuryBps == 500` always; no path raises it | invariant |
| INV-3 | `creator` & `treasury` recipients unchanged by ANY call sequence | invariant (fuzz calldata) |
| INV-4 | position liquidity never decreases; NFT never leaves collector | invariant |
| INV-5 | `totalSupply == 1e9*1e18`; minted 100% at init; no mint path reachable after | property |
| INV-6 | max-wallet blocks recipient over cap **iff** `now < expiry`; never after; never blocks `from`(sell); expiry immutable | property + fuzz(buy/sell sequences, time warps) |
| INV-7 | any revert in `launch` ⇒ no token/pool/registry/state persisted (atomicity) | property (fail-injection stablecoin) |
| INV-8 | exactly `launchFeeAmount` moved creator→treasury once per successful launch; zero on revert | property |
| INV-9 | no owner/admin selector alters a live token's params, LP, or fees | invariant (owner-as-adversary) |
| INV-10 | `initialize` succeeds once; second call / non-factory caller reverts | unit |
| INV-11 | reentrant stablecoin/token cannot double-spend or corrupt state in `launch`/`collect` | property (malicious ERC-20/reentrancy mock) |
| INV-12 | factory economic config (fee/stablecoin/treasury/bps) is `immutable` — **no selector mutates it**; owner's only reachable state-change is pause/unpause | invariant (owner-as-adversary, full calldata fuzz) |
| INV-13 | fee-on-transfer/rebasing stablecoin ⇒ `received != amount` ⇒ **revert** (exact-amount guard); treasury never short-paid | property (fee-on-transfer mock) |
| INV-14 | **selector enumeration:** no collector selector reaches `positionManager.{transferFrom,decreaseLiquidity,burn,approve}` or grants any approval — directly or transitively | invariant / static |

**Plus, non-invariant coverage (incl. kami audit pt.5):** unit tests for each revert in §6; permit happy/expired/replay; decimals ($1 = 1e6 / 1e18) via config fixtures; **duplicate salt / same-name+symbol collision** (CREATE2 salt = `keccak(creator, symbol, nonce)` → two identical-name launches both succeed at distinct addresses, never revert-collide or overwrite a registry entry); **V3 mint/callback reentrancy boundary** (the `uniswapV3MintCallback` during seeding cannot be abused to reenter `launch`/`collect`); **failed pool-init/seeding atomicity** (if pool create/init or the single-sided mint reverts, the whole `launch` reverts — fee refunded-by-rollback, no orphan token/clone); **fee-rounding/dust** (creator = `amt - treasuryCut`, sum-exact across fuzzed amounts/decimals); **pause-only-new-launches** (paused ⇒ `launch` reverts; a token launched pre-pause still trades, `collect`s, and `graduate`s normally); **narrow-exemption** (no non-infra address is max-wallet-exempt and no function can add one). Fork-integration lifecycle on a **Foundry fork of Robinhood mainnet 4663** (real Uniswap V3): launch → trades accrue fees → `collect` 95/5 exact → threshold → `graduate` → post-state. Static analysis (slither) clean or triaged; gas snapshot.

---

## 9. Open sub-decisions (non-blocking for build start; flag at wiring)
- ~~Launch-fee amount fixed vs owner-adjustable~~ → **RESOLVED (kami audit pt.1): fixed & `immutable` per deployment.** No owner toggle; a different amount/stablecoin/treasury = a separately deployed factory.
- Milestone metric for `graduate`: exact source (accumulated numéraire in position vs a net-buy counter) — pin the precise read at build with kuro against the V3 position/pool getters.
- Board during transition: dual-source (show existing Doppler launches) vs Hyde-only (PROTOCOL_PLAN §7).
