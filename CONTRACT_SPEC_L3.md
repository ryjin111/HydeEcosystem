# Hydeout Own-Stack — Level-3 Contract Spec & Threat Model

**Status:** BUILD SPEC — decisions locked, ready for kami audit → then kuro implements.
**Author:** gojo (senior protocol) · **Reviewer gate:** kami · **Builder:** kuro · **Date:** 2026-07-14 (rev2: reward-vault + kami audit-21249 fixes)
**Parent:** `PROTOCOL_PLAN.md` (Level-2). This doc pins the contract interfaces, invariants, and tests.
**Build path:** contract workspace under `D:\agentmanagerworks\` (kami 21085) — never in a shared app tree.

> "Checked for bugs" = layered testing + independent review, **never** a claim any contract is bug-free
> (kami). No public deploy / no push until review passes + a second independent review.

> **REV2 2026-07-14 — kami audit 21249 fixes (5).** (1) vault-register moved before the init mint so `sync`
> doesn't revert launch; (2) `convert` now a **contract-level TWAP floor + immutable max-slippage** (caller may
> only tighten), not caller-`minOut` alone; (3) **JIT closed at the mechanism level** — instant-lump indexing
> replaced by an **O(1) fixed-duration reward stream** (Synthetix `rewardRate`/`periodFinish`), so short holding
> earns only a short slice — this is now treated as deployment-blocking, not a v1.1 observation; (4) **global
> `accountedBalance[asset]` reconciliation + cross-namespace solvency invariant** replaces the per-token
> exact-received handwave; (5) **full-precision `mulDiv`** for all index math + a **pinned, validated per-launch
> convert route**, `amountIn>0` + registered-pair required. USDG reward token **confirmed** (clint). Graduate +
> threshold stay deployment-blocked. **Also added §10 — automatic Blockscout verification pipeline** (clint 21250 /
> kami 21251): off-chain verifier worker + acceptance tests, contracts unchanged. **kuro hold remains until this
> rev2 passes audit;** after audit I commit the docs-only revision and hand kami one clean SHA.

> **REV 2026-07-14 — fee split changed (clint 21245 → kami 21247).** The 5% **buyback&burn** leg is
> **replaced** (not added to) by **5% USDG holder rewards** via a **pull-based reward vault**. Buyback&burn design
> retired (see §11 changelog).

---

## 0. Locked decisions (clint/kami 2026-07-13 → 2026-07-14)
> **Deployment-blocking manifest pins:** the reward vault's immutable `REWARD_TOKEN` (= USDG on 4663, **confirmed**
> — clint 21249), the immutable **stream `DURATION`**, `MAX_SLIPPAGE_BPS`, `TWAP_WINDOW`, the pinned per-launch
> convert route, and the three split recipients/legs **must be fixed in the reviewed manifest before any deploy.**

- **Fee split (own-stack): 90% creator / 5% Hydeout / 5% USDG holder rewards** of LP trading fees — immutable
  `hydeoutBps=500`, `rewardBps=500`, `creatorBps` = enforced remainder `1e4 - 500 - 500 == 9000`, `sum==1e4`
  (clint 2026-07-14, msg 21245; kami 21247). Supersedes the earlier 90/5/5 *buyback&burn* leg — buyback **removed**.
- **Holder-reward mechanism — O(1) STREAMED claim-index (audit-21249 pt.3).** The 5% reward leg pays **USDG to
  launch-token holders, pull-based, no holder loops**, via a **Synthetix-style streaming reward index**:
  distributions do **not** land as an instantly-claimable lump — they set a per-token `rewardRate` that streams the
  reward **linearly over an immutable `DURATION`** (leftover + new folded on each distribution). A JIT buyer who
  holds for `t` of `DURATION` earns only ≈ `t/DURATION` of a distribution, so buy-before-`collect` / sell-after is
  no longer profitable. Still **O(1)** (no per-holder iteration). Distribution is **swap-free in the permissionless
  hot path:**
  - the **USDG portion** of the reward leg (the N leg when the pool pairs LT/USDG) is deposited to the vault and
    **feeds the stream inside `collect`** — no swap, no MEV;
  - the **non-USDG portion** (the LT leg always; the N leg too if a launch pairs against wrappedNative) **accrues
    in the vault un-streamed** and is converted to USDG by a **separate, TWAP-floor-guarded `convert()`** whose
    output then feeds the stream — **never** an in-`collect` swap.
  Rationale for swap-free `collect`: an atomic swap inside permissionless `collect` is **sandwichable** and would
  force an oracle + reentrancy + router surface into the hot path (rejected, §7.12).
- **`HydeERC20` has NO burn path** (the only prior supply mutation was the buyback burn). Supply is **constant 1e9
  forever** — no mint, no burn (INV-5).
- Launch fee: **$1 flat in USDG** (= `REWARD_TOKEN`), atomic, before deploy (PROTOCOL_PLAN §2.5).
- Graduation: **Option A — permanently locked LP** (milestone label only). Metric/threshold still open (§9); stays
  deploy-blocked (kami 21249).
- Anti-snipe: **(b) time-boxed max-wallet** in `HydeERC20`, expires; never permanent. (Blunts opening-window
  accumulation; the reward **stream**, not max-wallet, is what closes JIT reward-sniping — §7.14.)
- Supply: **1B, 100% to the launch pool** (fair launch, no premint/team alloc).

---

## 1. System topology
Three shared authored contracts + a deterministic clone per launch:
- **`HydeERC20`** — one verified *implementation*, EIP-1167-cloned per launch. No owner, no mint, **no burn**, no
  blacklist, no pause. Its transfer path calls the reward vault's `sync` so streamed holder accounting stays
  correct across transfers.
- **`HydeTokenFactory`** — permissionless `launch`; charges $1, deploys+inits the clone, seeds single-sided V3 LP
  (and bumps the pool's oracle cardinality for the `convert` TWAP), registers the position with the collector and
  the reward vault. Owner sets templates/config for **future** launches only.
- **`HydeFeeCollector`** — custodies each launch's V3 position NFT **forever** (locked LP by absence of any
  withdraw/transfer path); permissionless `collect` splits **90/5/5** (creator / Hydeout / reward): the USDG reward
  portion feeds the vault stream in-path (swap-free); the non-USDG reward portion is forwarded to the vault
  un-streamed for a separate guarded conversion; permissionless `graduate` flips the milestone label.
- **`HydeRewardVault` (NEW)** — shared singleton, per-token streamed reward accounting. Custodies the USDG reward
  reserve + any un-converted LT/N balance under **global `accountedBalance[asset]`** reconciliation; maintains a
  per-token **streaming claim-index**; exposes permissionless pull-based `claim`, the TWAP-guarded `convert` (the
  system's only swap), and the token-driven `sync`.

Per-chain surface = the adapter config (§5) + reviewed manifest (§8). No dependency beyond a compatible Uniswap V3
(with pool oracle), USDG, and (for `convert` only) a swap router.

---

## 2. `HydeERC20` (implementation, cloned)

**Inherits:** minimal ERC-20 + EIP-2612 `permit`. **No owner. No mint-after-init. No burn. No blacklist. No pause.**
**Supply fixed at 1B forever** — no post-init supply-mutating path at all (the prior `onlyCollector burn` is
**deleted**). INV-5 is "supply constant."

**Immutable-after-init storage (set once in `initialize`, no setters):**
| field | meaning |
|---|---|
| `name`, `symbol` | metadata |
| `TOTAL_SUPPLY` | constant `1_000_000_000e18`, 100% minted to `pool` recipient at init |
| `maxWallet` | max holder balance during the anti-snipe window (from `maxWalletBps` of supply) |
| `maxWalletExpiry` | `uint64` timestamp; window active while `block.timestamp < maxWalletExpiry` |
| `COLLECTOR` | the `HydeFeeCollector` (max-wallet sender-exempt for the creator LT-fee leg) |
| `REWARD_VAULT` | the `HydeRewardVault` — notified on every transfer via `sync`; reward-excluded + max-wallet-exempt |
| `exempt[address]` | a **fixed infra set frozen at init**, used for BOTH max-wallet exemption AND reward-ineligibility: ONLY the V3 pool, position manager, factory, collector, **reward vault**, **swap router**, `address(0)`. No `setExempt`, no owner-addable whitelist. |

`isRewardExcluded(address a) → bool` public view returns `exempt[a]` (the vault reads it in `claim`; the transfer
path passes the two booleans into `sync` to avoid a re-entrant read).

**`initialize(InitParams) external` — clone init model:** once-set storage under an `initializer` guard +
`onlyFactory`. The factory clones then call `initialize` in the **same transaction** — no front-run window.
**Ordering inside `initialize` matters (audit-21249 pt.1):** (a) set immutables incl. the exempt set + `COLLECTOR`
+ `REWARD_VAULT`, **then** (b) mint 100% supply to the pool. So when the mint's `_update` fires `sync`, `exempt
[pool]` is already `true` (the token passes `toExcl=true`) and the vault has **already been registered by the
factory before this call** (§3 step 3), so `sync` neither reverts nor mis-accrues.

**`initialize` config-bounds asserts — revert on any of:** `poolRecipient == 0` · `collector == 0` · `rewardVault
== 0` · `maxWalletBps ∉ (0, MAX_WALLET_BPS_CAP]` · `maxWalletWindowSecs ∉ (0, MAX_WINDOW_CAP]`. Pinned:
`MAX_WALLET_BPS_CAP = 300`, `MAX_WINDOW_CAP = 3600`.

**Transfer path — `_update(from, to, amount)`, in order:**
1. **`to == address(0)` reverts (`ZERO_TO`)** — no transfer can strand/burn tokens; with burn removed there is **no**
   supply-reducing path (supply invariant, INV-5/21).
2. **Reward crystallization (BEFORE balances change):**
   `REWARD_VAULT.sync(from, to, balanceOf(from), balanceOf(to), amount, exempt[from], exempt[to])`. Checkpoints
   both parties' streamed index at their pre-transfer balances, re-anchors their per-holder index, and adjusts the
   vault's `totalEligibleSupply` for any excluded-boundary crossing. **`sync` is `onlyToken`, uses only
   full-precision arithmetic, performs no external calls, and cannot revert on the normal path** (§4b) → it can
   **never brick a transfer** (INV-23).
3. **Max-wallet enforcement:**
   ```
   if (block.timestamp < maxWalletExpiry && !exempt[to] && from != COLLECTOR)
       require(balanceOf(to) + amount <= maxWallet);
   ```
   - Recipients only → caps sniper accumulation; never blocks selling (`from` unrestricted).
   - **`from == COLLECTOR` bypass:** `collect` pays the creator's 90% LT leg to the non-exempt creator; without the
     bypass a window-time payout could exceed `maxWallet` and revert `collect`. Creator's own buys come `from ==
     pool` (still capped).
   - The **reward vault is `to`-exempt**, so `collect` can forward the LT reward leg to the vault during the window,
     and the vault's LT movements during `convert` (to router/pool, both exempt) never trip the cap.
   - After `maxWalletExpiry`: zero restriction, permanently. Expiry immutable.
4. Standard balance update + `Transfer` event.

**Events:** standard `Transfer`/`Approval`. No admin/mint/burn events (none exist).

---

## 3. `HydeTokenFactory`

**Owner (multisig) — MINIMAL power:** only **`pause()`/`unpause()` of NEW launches**. Cannot change fee,
stablecoin, treasury, bps, uniswap addresses, the reward vault/token/stream params, or anything on a live token /
its LP / its fees / its reward accounting. **All economic config immutable (constructor-set); a different chain,
version, fee, stablecoin, treasury, or reward param = a separately deployed immutable factory.**

**Immutables (ALL constructor-set, NO setters):**
- `IMPL` (`HydeERC20`), `COLLECTOR`, `REWARD_VAULT`.
- Economic config: `stablecoin` (= USDG = `REWARD_TOKEN`), `launchFeeAmount`, `supportsPermit`, `launchFeeTreasury`,
  `uniV3Factory`, `positionManager`, `swapRouter`, `quoter`, `wrappedNative`, `feeTier`, `maxWalletBps`,
  `maxWalletWindowSecs`, `graduationThreshold`, and the **oracle-cardinality target** used at seed. Split legs live
  on their executing contracts: `hydeoutTreasury`/`hydeoutBps`/`rewardBps` on the **COLLECTOR**; `REWARD_TOKEN` +
  stream params (`DURATION`, `MAX_SLIPPAGE_BPS`, `TWAP_WINDOW`) on the **VAULT**. `creatorBps` is the enforced
  remainder (never stored).
- **Presets** — hard-coded `pure` function `preset(uint8 id) → (initialTick, tickLower, tickUpper,
  graduationThreshold)`, revert on unknown id. Compile-time constants.
- **Chain-gate:** `stablecoin == 0 || launchFeeAmount == 0` **cannot be constructed for live use**.

**External functions:** `launch` / `launchWithPermit` (both `nonReentrant`, code-level); `LaunchParams = { name,
symbol, preset }`, **`creator := msg.sender`** (no caller-supplied creator; closes allowance-drain/spoof). Owner:
`pause`/`unpause` only.

**`launch` ordering (single tx — all-or-revert; audit-21249 pt.1 reorders 3–4):**
1. **`_chargeLaunchFee(msg.sender)`** — FIRST state change, `SafeERC20` + `require(received == launchFeeAmount)`.
   Path 2 calls `permit` first. Revert ⇒ nothing created.
2. `_deployClone()` — `Clones.cloneDeterministic(IMPL, salt)`, `salt = keccak256(msg.sender, symbol, nonce++)`.
   Yields `token` (deterministic address).
3. **`REWARD_VAULT.register(token, convertRoute)` — `onlyFactory`, BEFORE `initialize` (the fix).** Marks `token`
   as a legit Hyde token authorized to call `sync`, opens its accounting namespace, and **pins + validates the
   per-launch convert route** (audit-21249 pt.5): LT→USDG **direct** single-hop at `feeTier` for a USDG-paired
   pool; else an explicit validated path (hops + fee tiers, must terminate in USDG). Registering here guarantees
   the very next step's mint-`sync` is accepted.
4. `token.initialize(...)` — same-tx, `onlyFactory`+`initializer`-guarded. Sets exempt set + `COLLECTOR` +
   `REWARD_VAULT`, **then** mints 1B to the pool (the mint's `sync(0, pool, …)` is now accepted; pool excluded ⇒
   no-op on eligibility).
5. `_seedLiquidity()` — deterministic pool addr; create+init at `feeTier`/preset tick if absent; **increase pool
   observation cardinality** to the target (so `convert`'s TWAP has history); mint the **single-sided** position
   via `positionManager.mint(recipient = COLLECTOR)`. Factory is the transient payer (funds inside
   `uniswapV3MintCallback`, authorized to the precomputed pool only, mid-launch only). **After `mint`, factory,
   collector & vault each hold 0 launch-token** (INV-15). Any revert ⇒ whole `launch` reverts (incl. the
   vault-register from step 3 — same-tx rollback; tested, INV-7/30).
6. `COLLECTOR.register(token, msg.sender, tokenId, numeraire, graduationThreshold)` — `onlyFactory`.
7. Emit `LaunchFeePaid` + `LaunchCreated`.

**Events:** `LaunchFeePaid`, `LaunchCreated`, `Paused(bool)`. No `ConfigUpdated`.

---

## 4. `HydeFeeCollector`

**Collector immutables (constructor-set, NO setters):** `FACTORY` (deploy-cycle), `REWARD_VAULT`, `REWARD_TOKEN`
(= USDG; to tell a USDG reward leg from a convertible one), `hydeoutTreasury`, `hydeoutBps (==500)`,
`rewardBps (==500)`. Authoritative source for the `collect` split (runs here). Constructor asserts `hydeoutBps ==
500 && rewardBps == 500 && hydeoutBps + rewardBps < 1e4`, `hydeoutTreasury != 0`, `REWARD_VAULT != 0`,
`REWARD_TOKEN != 0`. *(The prior `buybackSink` immutable is removed.)*

**Deployment sequence (factory↔collector↔vault cycle):** CREATE2 address prediction — predict the factory address,
deploy the vault (predicted factory + collector), deploy the collector (predicted factory + vault), deploy the
factory (collector + vault) **to the predicted address**; abort if it doesn't land there (no init-seizure).
*Fallback:* one-shot `initFactory(addr)` on **both** collector and vault, callable once by the immutable deployer
then locked (2nd call / non-deployer reverts on each — the current collector already ships this fallback).

**Custody / LP-lock:** holds every launch's V3 NFT. `positionOf[token] = {registered, graduated, creator, tokenId,
numeraire, graduationThreshold}` written once by the factory; only mutable bit is one-way `graduated` + the
monotonic `graduationProgress[token]`. **LP locked by ABSENCE of a code path** — no decreaseLiquidity/withdraw/
burn/transfer/approve/generic-call/multicall on the position, no owner. Provable by selector enumeration
(INV-4/14).

**External functions:**
- `collect(address token) external nonReentrant` — **permissionless.** V3 `positionManager.collect(recipient=this)`
  → for each collected asset `amt`, split **90/5/5** (remainder-to-creator, exact 5% legs):
  ```
  hydeoutCut = mulDiv(amt, hydeoutBps, 1e4);        // 5% → Hydeout
  rewardCut  = mulDiv(amt, rewardBps,  1e4);        // 5% → USDG holder rewards
  creatorCut = amt - hydeoutCut - rewardCut;        // remainder ⇒ no dust
  safeTransfer(hydeoutTreasury, hydeoutCut);
  if (asset == REWARD_TOKEN) {                       // USDG leg → feed the stream now (swap-free)
      safeTransfer(REWARD_VAULT, rewardCut);
      REWARD_VAULT.notifyReward(token, rewardCut);   // global-accounted; starts/extends the DURATION stream
  } else {                                           // LT / non-USDG N leg → park for guarded convert
      safeTransfer(REWARD_VAULT, rewardCut);
      REWARD_VAULT.notePending(token, asset, rewardCut);
  }
  safeTransfer(creator, creatorCut);
  ```
  **No swap, no burn, no oracle in `collect`.** `notifyReward`/`notePending` are `onlyCollector`, arithmetic-only,
  and reconcile the vault's **global `accountedBalance[asset]`** (§4b) — so `collect` stays a bounded, non-swapping,
  CEI + `nonReentrant` path (INV-14/18). **Graduation accumulator:** `graduationProgress[token] += <gross, pre-split
  numéraire amount this call>` — monotonic; `collect` only advances it (INV-20). Atomic; **revert on any transfer/
  notify failure.** Emits `FeesCollected` + `RewardFunded` (USDG leg) / `RewardPending` (convertible leg).
- `graduate(address token) external` — permissionless; `require(!graduated && graduationProgress ≥
  graduationThreshold)`; no liquidity moves (Option A). **Stays stubbed to revert `GRADUATION_PENDING` until the
  metric + threshold value are pinned** (kami 21249). Unchanged by this rev.

**Events:** `FeesCollected(...)`, `RewardFunded(token, asset, amount)`, `RewardPending(token, asset, amount)`,
`Graduated`, `PositionRegistered`.

---

## 4b. `HydeRewardVault` (NEW — pull-based, O(1) STREAMED claim-index, no loops)

**Model.** Shared singleton, **per-token** accounting. Rewards paid in `REWARD_TOKEN` (USDG) to launch-token
holders **proportional to balance**, using a **Synthetix-`StakingRewards`-style streaming claim-index** — O(1) per
operation, **no holder iteration ever** (kami's "no holder loops"). A distribution does **not** become instantly
claimable; it sets a per-token `rewardRate` that streams **linearly over an immutable `DURATION`**, which is what
closes JIT reward-sniping (audit-21249 pt.3): holding for `t` seconds of a `DURATION` stream earns ≈ `t/DURATION`.
The per-holder index anchor `userRewardPerTokenPaid` IS the "snapshot" — no Merkle, no loops.

**Immutables (constructor-set, NO setters):** `REWARD_TOKEN` (= USDG), `COLLECTOR` (sole `notify*` funder),
`SWAP_ROUTER`, `wrappedNative`, `FACTORY` (`onlyFactory register`), `DURATION` (stream length; **manifest policy —
proposed default 7 days**), `MAX_SLIPPAGE_BPS` (convert floor; proposed ≤ 300), `TWAP_WINDOW` (oracle window;
proposed 1800s), `PRECISION = 1e30`. Constructor asserts all non-zero and `MAX_SLIPPAGE_BPS < 1e4`. **All index and
share math uses full-precision `mulDiv`** (OZ `Math.mulDiv` / Uniswap `FullMath`) so `amt·PRECISION` and
`balance·Δindex` never overflow before the divide (audit-21249 pt.5).

**Per-token streaming state (keyed by `token`; a rogue caller only ever touches its OWN namespace):**
| field | meaning |
|---|---|
| `registered[token]`, `convertRoute[token]` | set once by `onlyFactory register`; `sync` requires `msg.sender == token && registered`; `convertRoute` is the pinned/validated LT→USDG path |
| `rewardRate[token]` | USDG/sec currently streaming |
| `periodFinish[token]` | timestamp the current stream ends |
| `lastUpdateTime[token]` | last index checkpoint time (≤ `periodFinish`) |
| `rewardPerTokenStored[token]` | streamed cumulative USDG-per-eligible-token index (× `PRECISION`), monotdc non-decreasing |
| `totalEligibleSupply[token]` | Σ balances of **non-excluded** holders; maintained incrementally in `sync` |
| `userRewardPerTokenPaid[token][holder]` | per-holder index anchor at last settle |
| `rewards[token][holder]` | crystallized, unclaimed USDG owed |
| `queued[token]` | USDG deposited while `totalEligibleSupply == 0`; folded into the next `notifyReward` (never lost) |
| `pendingConversion[token][asset]` | un-streamed reward balance awaiting `convert()`→USDG |
| `liability[token][asset]` | this namespace's owed asset (Σ `rewards` for USDG + reserve for the stream + `pendingConversion`) — the per-namespace claim on `accountedBalance` |

**Global custody accounting (audit-21249 pt.4).** `accountedBalance[asset]` = the vault's intended total holding of
`asset` across ALL token namespaces. Every inflow path (`notifyReward`, `notePending`, `convert` output) does
`require(IERC20(asset).balanceOf(this) == accountedBalance[asset] + amount)` (exact-received, immune to
cross-namespace interleaving because it reconciles the **global** figure, not a per-token subtotal) then
`accountedBalance[asset] += amount`. Every outflow (`claim`, `convert` input to router) decrements it. **Cross-
namespace solvency invariant (INV-27):** for every asset, `IERC20(asset).balanceOf(this) >= accountedBalance[asset]
== Σ_token liability[token][asset]` — actual balance always ≥ the sum of all namespaces' liabilities.

**Eligibility (holder eligibility / snapshots).** Eligible = **not** in the launch token's frozen infra set
(pool/PM/factory/collector/vault/router/`0`). `sync` receives `exempt[from]`/`exempt[to]`; `claim`/settle consult
`token.isRewardExcluded`. **Excluded accounts never accrue** (settle short-circuits them) — so the pool (~100% at
launch) and the vault (holds un-converted LT) never capture+strand rewards. `totalEligibleSupply` starts at 0 and
grows as tokens reach real holders.

**Streaming index math (all `mulDiv`):**
- `rewardPerToken(token)` view: `if totalEligibleSupply == 0: return rewardPerTokenStored;` else
  `return rewardPerTokenStored + mulDiv((min(now, periodFinish) - lastUpdateTime) * rewardRate, PRECISION,
  totalEligibleSupply);`
- `earned(token, a)` view: `excluded ? 0 : mulDiv(balanceOf(a), rewardPerToken(token) - userRewardPerTokenPaid[a],
  PRECISION) + rewards[a];`
- `_updateReward(token, acct, bal, excl)` (the checkpoint, called before every balance change and before claim/
  notify): `rewardPerTokenStored = rewardPerToken(token); lastUpdateTime = min(now, periodFinish);
  if (acct != 0) { if (!excl) rewards[acct] = <earned at bal>; userRewardPerTokenPaid[acct] =
  rewardPerTokenStored; }`

**Functions:**
- `sync(from, to, balFrom, balTo, amount, bool fromExcl, bool toExcl) external` — `require(registered[msg.sender])`;
  `token = msg.sender`. `_updateReward(token, from, balFrom, fromExcl)`, `_updateReward(token, to, balTo, toExcl)`,
  then `totalEligibleSupply += toExcl ? 0 : amount; totalEligibleSupply -= fromExcl ? 0 : amount;`. Pure
  `mulDiv`/checked arithmetic, **no external calls, non-revert on the normal path** (INV-23).
- `notifyReward(address token, uint256 usdgAmt) external` — **`onlyCollector`.** Global exact-received guard on
  USDG; `accountedBalance[USDG] += usdgAmt; liability[token][USDG] += usdgAmt;` `_updateReward(token, 0, 0, false);`
  then `_startStream(token, usdgAmt)`.
- `_startStream(token, amt)` (internal, also called by `convert` output): `amt += queued[token]; queued[token] = 0;`
  `if (totalEligibleSupply[token] == 0) { queued[token] = amt; return; }` (park — begins streaming when the next
  distribution arrives after holders exist; never lost, tracked in `liability`); else
  `if (now >= periodFinish) rewardRate = amt / DURATION; else rewardRate = (amt + (periodFinish - now) * rewardRate)
  / DURATION;` `lastUpdateTime = now; periodFinish = now + DURATION;`. (Flooring dust `< DURATION` wei stays in the
  reserve, recaptured on the next `_startStream` fold — bounded, never stranded; INV-25.)
- `notePending(address token, address asset, uint256 amt) external` — **`onlyCollector`.** Global exact-received
  guard on `asset`; `accountedBalance[asset] += amt; liability[token][asset] += amt; pendingConversion[token][asset]
  += amt;` (no stream change — un-streamed until converted).
- `convert(address token, uint256 amountIn, uint256 callerMinOut, uint256 deadline) external nonReentrant` —
  **permissionless but CONTRACT-LEVEL guarded (audit-21249 pt.2).** `require(registered[token] && amountIn > 0 &&
  amountIn <= pendingConversion[token][asset])`, `require(now <= deadline)`. Uses the **pinned `convertRoute
  [token]`** (audit-21249 pt.5) — the input asset + hops + fee tiers are fixed at register, so a caller can't
  inject a malicious route. Compute a **manipulation-resistant floor on-chain**: `oracleOut =
  TWAP(convertRoute, amountIn, TWAP_WINDOW)` (each hop's V3 pool `observe()` over the immutable window; the seed
  bumped cardinality so history exists); `floor = mulDiv(oracleOut, 1e4 - MAX_SLIPPAGE_BPS, 1e4);`
  **`minOut = max(floor, callerMinOut)`** — the caller may only *tighten*, never loosen below the TWAP floor.
  Approve exactly `amountIn` to `SWAP_ROUTER`, `exactInput(route, recipient=this, amountOutMinimum=minOut)`, measure
  USDG received via `accountedBalance` delta, `require(received >= minOut)`; decrement `pendingConversion` +
  `accountedBalance[asset]` + `liability[token][asset]`, reset router allowance to 0; then USDG in:
  `accountedBalance[USDG] += received; liability[token][USDG] += received; _updateReward(token,0,0,false);
  _startStream(token, received)`. **The ONLY swap in the system** — isolated, TWAP-floored, deadline-bounded,
  `nonReentrant`, touches no LP. Worst case = bounded slippage on this one call; sandwiching below a `TWAP_WINDOW`
  floor isn't profitable within a block (INV-18). Emits `RewardConverted(token, asset, amountIn, received)`.
  *Deploy fallback:* if a chain's Uniswap lacks usable oracle history, `convert` is made `onlyAuthorizedConverter`
  (an immutable keeper) instead of permissionless — a manifest/deploy decision (§9), never caller-`minOut` alone.
- `claim(address token) external nonReentrant` → `_claim(token, msg.sender)`;
  `claim(address token, address holder) external nonReentrant` → `_claim(token, holder)` (a third party may only
  *trigger* a claim; funds always go to `holder`).
  - `_claim(token, holder)`: `_updateReward(token, holder, balanceOf(holder), token.isRewardExcluded(holder));`
    `owed = rewards[token][holder]; require(owed > 0, "NOTHING"); rewards[token][holder] = 0; liability[token][USDG]
    -= owed; accountedBalance[USDG] -= owed; REWARD_TOKEN.safeTransfer(holder, owed);` — strict CEI, `nonReentrant`,
    O(1), rounds down (never underflows `accountedBalance`). Emit `RewardClaimed`.

**Immutable invariants:** all vault immutables (`REWARD_TOKEN`, `COLLECTOR`, `FACTORY`, `SWAP_ROUTER`, `DURATION`,
`MAX_SLIPPAGE_BPS`, `TWAP_WINDOW`, `PRECISION`) have no setter; per-token `registered`/`convertRoute` one-way
(factory-set once). No admin/owner function; no path moves an asset except `claim` (to the holder) and the exact
router allowance during `convert` (reset to 0 same-call).

---

## 5. Authority & immutability boundary (the audit's spine)
| Actor | CAN | CANNOT |
|---|---|---|
| **Anyone** | `launch` (pay $1), `collect` (90/5/5), `convert` (TWAP-floored LT/N→USDG), `claim` (pull own/another holder's USDG to that holder), `graduate` | change any recipient, move LP, mint/burn, mutate bps/params/stream, loosen the convert floor, redirect a claim, drain `collect` |
| **Factory owner (multisig)** | **pause / unpause NEW launches — nothing else** | change fee/stablecoin/treasuries/bps/reward token/stream params; touch any live token / its LP / its fees / its reward accounting; raise reward/hydeout bps; unlock LP; extend max-wallet; add an exemption; seize/freeze; force/redirect a conversion or claim |
| **Creator** | receive **90%**; immutable recipient; a normal reward-eligible holder for LT they buy | change their recipient; touch LP; mint; get preferential eligibility |
| **Holder** | receive **streamed pro-rata USDG**; `claim` any time | accrue while excluded; claim more than the streamed `earned`; block others' claims |
| **Token contract** | ERC-20 + permit; max-wallet during window; drive reward `sync` | mint/burn (**supply constant**); be paused/blacklisted |
| **Reward vault** | accrue/pay USDG per the stream; run the one TWAP-guarded swap | move an asset anywhere but to the rightful holder on `claim`; mutate bps/recipients/stream; touch LP or the NFT; hold < its liabilities (solvency INV-27) |

**Global immutability claims (under fuzz):** post-launch, no reachable function alters price/range/threshold/
creator/treasuries/`rewardBps`/`hydeoutBps`/`REWARD_TOKEN`/stream params, moves or reduces the LP, or extends the
max-wallet window. **Supply fully constant.**

---

## 6. Failure-mode / revert catalog
- Launch fee `safeTransferFrom` fails → **revert, nothing created.**
- Stablecoin unset / `launchFeeAmount==0` → **revert** (feature disabled).
- `launchWithPermit` on non-2612 / expired / replayed permit → **revert.**
- `initialize` twice or non-factory → **revert.** **`REWARD_VAULT.register` must precede `initialize`** (else the
  init mint's `sync` reverts on an unregistered token — the audit-21249 pt.1 bug, now fixed + tested).
- `collect` transfer / `notifyReward` / `notePending` leg fails, or `notify*` from a non-collector, or global
  exact-received mismatch → **revert** (no partial split).
- `sync` from a non-registered token → **revert.** `sync` on the normal path **must not revert** (anti-invariant —
  it runs inside transfers).
- `convert`: past `deadline`, `amountIn == 0`, over `pendingConversion`, unregistered token/asset, `received <
  minOut` (where `minOut = max(TWAP floor, callerMinOut)`), or an attempt to convert `REWARD_TOKEN` → **revert**
  (no partial / no unguarded / no below-floor swap).
- `claim` with nothing owed → **revert** (`NOTHING`); can never underflow `accountedBalance`.
- `graduate` before threshold / twice → **revert** (currently always `GRADUATION_PENDING`).
- Paused (new launches) → `launch` reverts; live tokens unaffected (still `collect`/`convert`/`claim`).

---

## 7. Threat model (attack → mitigation)
1. **Creator-share theft / fee redirect** → collector owns the NFT; recipients immutable; no redirect selector. INV-3.
2. **LP rug / liquidity pull** → no decreaseLiquidity/withdraw/transfer path; no admin path. INV-4.
3. **Free-launch / fee bypass** → fee first, revert-on-fail, chain-gate. INV-8.
4. **Reentrancy** — `_chargeLaunchFee` (nothing deployed yet); `collect` (CEI+`nonReentrant`, no swap, `notify*`
   trusted-caller arithmetic); `claim`/`convert` (`nonReentrant`+CEI; `convert`'s LT→pool swap re-enters only
   `sync`, a no-op on the excluded pair); `sync` (no external calls). INV-11, INV-23.
5. **Max-wallet permanent trap** → time-boxed, expiry immutable, selling never restricted. INV-6.
6. **Init front-run / re-init** → `initializer` + `onlyFactory` + deterministic salt. INV-10.
7. **Rounding/dust** → creator = remainder (exact 5% legs); stream flooring dust `< DURATION` wei stays in reserve,
   recaptured on the next fold; claim rounds down (no `accountedBalance` underflow). INV-1, INV-25.
8. **bps escalation** → `rewardBps`/`hydeoutBps` immutable, each capped 500 (creator ≥ 9000). INV-2.
9. **Owner overreach onto live tokens** → owner = future-launch config only; property-tested no owner selector
   touches a launched token / LP / fees / reward accounting. INV-9, INV-12.
10. **Snipe on pool init** → single-sided seed at a fixed preset tick; max-wallet caps opening accumulation.
11. **Griefing `collect`/`graduate`/`convert`/`claim` spam** → all idempotent-safe; harmless.
12. **Reward-distribution MEV / sandwich (why swap-free `collect`)** → `collect` performs **no swap**; the USDG leg
    only feeds the stream, the LT/N leg only accrues. The only swap is the **separate `convert()`**, floored by an
    on-chain **`TWAP_WINDOW` oracle + immutable `MAX_SLIPPAGE_BPS`** with the caller allowed only to tighten
    (audit-21249 pt.2) — sandwiching below the TWAP floor isn't profitable within a block. Pinned route blocks
    malicious-path injection. In-`collect` swap variant rejected. INV-18.
13. **Reward-accounting corruption / cross-token bleed** → all per-token state keyed by the calling `token`; `sync`
    is `onlyToken` (rogue only touches its own worthless namespace); `notify*` are `onlyCollector` + global
    exact-received, so a rogue can't credit itself USDG it didn't deposit. INV-24.
14. **JIT reward-sniping (buy-before-distribution, sell-after)** — **closed at the mechanism level (audit-21249
    pt.3):** distributions **stream over an immutable `DURATION`** (not an instant lump), so a buyer holding for
    `t` earns only ≈ `t/DURATION` and eats V3 fees + slippage in *and* out. A single `holderSince` timestamp would
    be insufficient (an aged wallet could add fresh balance) — the *stream* is balance-and-time-weighted by
    construction (`rewardPerToken` accrues per second against live eligible supply), so fresh balance earns only
    from the moment it's held. INV-29.
15. **Transfer-hook DoS (brick the token via `sync`)** → `sync` = `mulDiv`/checked arithmetic, no external calls,
    provably non-reverting on the normal path. INV-23.
16. **Precision/overflow** → `PRECISION=1e30` + **full-precision `mulDiv`** everywhere (audit-21249 pt.5), so
    `amt·PRECISION` / `balance·Δindex` / `Δt·rewardRate·PRECISION` never overflow before the divide;
    `totalEligibleSupply==0` ⇒ `rewardPerToken` returns stored and distributions **park in `queued`** (no
    div-by-zero, no 1-wei-supply index spike). INV-26.
17. **Vault insolvency / cross-namespace drain (audit-21249 pt.4)** → **global `accountedBalance[asset]`**
    reconciled on every fund/convert/claim; per-namespace `liability[token][asset]` tracked; the **cross-namespace
    solvency invariant** `balanceOf(this) >= accountedBalance == Σ liabilities` holds after ANY interleaving of
    calls across token namespaces. Claims/converts on token A can never draw down token B's reserve. INV-27.
18. **Launch atomicity incl. vault register (audit-21249 pt.1)** → `REWARD_VAULT.register` at step 3 (before the
    mint) makes the init-mint `sync` succeed; any later revert unwinds the register in the same tx (no orphan
    namespace). INV-30.

---

## 8. Invariant / property test matrix (Foundry — fuzz ≥256 runs, invariant campaigns)
| # | Invariant | Kind |
|---|---|---|
| INV-1 | `creatorCut + hydeoutCut + rewardCut == collected`; `creatorCut == collected - mulDiv(collected,500,1e4)*2` (remainder, no dust); creator never underpaid | property + fuzz(amount, decimals) |
| INV-2 | `hydeoutBps == 500 && rewardBps == 500` always; `creatorBps == 9000`; no path raises either leg | invariant |
| INV-3 | `creator`, `hydeoutTreasury`, `hydeoutBps`, `rewardBps`, `REWARD_TOKEN`, `REWARD_VAULT`, stream params unchanged by ANY call sequence | invariant (fuzz calldata) |
| INV-4 | position liquidity never decreases; NFT never leaves collector | invariant |
| INV-5 | `totalSupply == 1e9*1e18` at launch AND forever — **constant**; no mint AND no burn path reachable | property + invariant |
| INV-6 | max-wallet blocks recipient over cap **iff** `now < expiry`; never after; never blocks `from`; expiry immutable | property + fuzz(buy/sell, time warps) |
| INV-7 | any revert in `launch` ⇒ no token/pool/collector-registry/**vault-namespace**/state persisted (atomicity) | property (fail-injection) |
| INV-8 | exactly `launchFeeAmount` moved creator→treasury once per launch; zero on revert | property |
| INV-9 | no owner/admin selector alters a live token's params, LP, fees, or reward accounting | invariant (owner-as-adversary) |
| INV-10 | `initialize` once; second call / non-factory reverts | unit |
| INV-11 | reentrant stablecoin/token cannot double-spend or corrupt state in `launch`/`collect`/`convert`/`claim` | property (reentrancy mock) |
| INV-12 | factory economic config immutable; owner's only state-change is pause/unpause | invariant (owner-as-adversary) |
| INV-13 | fee-on-transfer/rebasing asset ⇒ global exact-received mismatch ⇒ **revert**; no namespace short-credited | property (fee-on-transfer mock) |
| INV-14 | selector enumeration: no collector selector reaches `positionManager.{transferFrom,decreaseLiquidity,burn,approve}` or grants approval | invariant / static |
| INV-15 | after `_seedLiquidity`, factory, collector & vault each hold 0 launch-token | property |
| INV-16 | `creator == msg.sender` every launch; no path charges another wallet | property |
| INV-17 | during the window, `collect` paying the creator LT leg (`from==COLLECTOR` bypass) and the LT reward leg (vault `to`-exempt) never revert | property |
| INV-18 | **only `HydeRewardVault.convert` swaps**; it is `nonReentrant`, uses the **pinned route**, enforces `minOut = max(TWAP-floor(TWAP_WINDOW, MAX_SLIPPAGE_BPS), callerMinOut)` (caller can only tighten), resets router allowance to 0, touches no LP; `collect` reaches no router | invariant/static + property (fuzz price manip vs floor) |
| INV-19 | *(retired — buyback burn; no burn exists; folded into INV-5)* | — |
| INV-20 | `graduationProgress` monotonic; `collect` never reduces it; `graduate` one-way iff progress ≥ threshold | invariant |
| INV-21 | `_transfer` reverts on `to == 0`; no transfer changes `totalSupply` | unit + property |
| INV-22 | `initialize` reverts on zero poolRecipient/collector/rewardVault or out-of-range maxWallet params | unit |
| INV-23 | **`sync` never reverts on the normal transfer path** (no external calls; `mulDiv`/checked arithmetic) → can't brick a token; reverts ONLY for a non-registered caller | property (fuzz balances/amounts/flags) + anti-invariant |
| INV-24 | reward state strictly partitioned by `token`; non-registered `sync` reverts; `notify*` `onlyCollector`; a rogue namespace can't touch a real token's stream/eligible-supply | invariant (rogue-token-as-adversary) |
| INV-25 | **reward conservation & dust (streamed):** Σ over holders of `earned` + not-yet-streamed reserve + `queued` equals total USDG funded to `token`, within stream flooring dust `< DURATION` wei; dust always recaptured, never stranded | invariant (fuzz distribute/transfer/claim/time-warp orderings) |
| INV-26 | `rewardPerTokenStored` monotonic; all `mulDiv` products never overflow across fuzzed supplies (1..1e27), amounts, and `Δt`; `totalEligibleSupply==0` ⇒ distribution **parks in `queued`** (no div-by-zero/spike) | invariant + fuzz |
| INV-27 | **cross-namespace solvency:** for every asset, `balanceOf(this) >= accountedBalance[asset] == Σ_token liability[token][asset]` after ANY interleaving; `claim`/`convert` on one token can't draw another's reserve; claims round down | invariant (multi-namespace deposit/transfer/claim/convert-as-adversary) |
| INV-28 | excluded/infra addresses never accrue; `totalEligibleSupply` excludes them and tracks pool↔holder flows exactly | property + invariant |
| INV-29 | **streamed JIT resistance:** a wallet holding balance `b` for `t ≤ DURATION` around a distribution `R` earns `≤ mulDiv(R, t, DURATION)·(b/eligibleSupply)` (bounded, no lump capture); buy-before-`collect`/sell-after is not profitable vs V3 in/out cost | property (fuzz JIT buy/collect/sell/time sequences) |
| INV-30 | `REWARD_VAULT.register` executes before the init mint in `launch`; the init-mint `sync` succeeds; a mid-launch revert unwinds the register (no orphan namespace) | property (ordering + fail-injection) |
| INV-31 | `convert` uses only the pinned `convertRoute[token]` (input asset + hops + fee tiers fixed at register); a caller-supplied route/asset is impossible; `amountIn==0`/unregistered pair reverts | unit + property |

**Deploy-time tests:**
- Factory `stablecoin==0`/`launchFeeAmount==0` → **fails to construct**. Collector/vault with any zero immutable,
  wrong bps, or `MAX_SLIPPAGE_BPS ≥ 1e4` → **fails to construct**.
- **Per-chain manifest (required):** pins `{chainId, USDG address + decimals, launchFeeAmount, hydeoutTreasury,
  REWARD_TOKEN(==USDG), swapRouter, uniswap addrs, DURATION, MAX_SLIPPAGE_BPS, TWAP_WINDOW, oracle-cardinality
  target, per-preset convert route}`; gojo/kami sign off per chain. `launchFeeAmount` asserted to USDG decimals.
  **Manifest SHOULD prefer USDG-paired pools** (numéraire reward leg swap-free; only the LT leg needs `convert`);
  wrappedNative-paired is legal but routes both legs through `convert`.
- Deploy-cycle: CREATE2-predicted factory matches; collector & vault `FACTORY` immutable equals it; `initFactory`
  fallback (if used) reverts on 2nd call / non-deployer on **both** collector and vault.

**Plus non-invariant coverage:** every §6 revert; permit happy/expired/replay; duplicate salt; `uniswapV3MintCallback`
auth; **register-before-init ordering** (mint `sync` succeeds; a register-after-init variant reverts — regression on
audit-21249 pt.1); failed pool-init/seeding atomicity incl. vault-namespace rollback; reward-rounding/dust across
time-warps; **streaming lifecycle** (fund→stream over `DURATION`→partial `earned` at `t<DURATION`→claim exact;
leftover-fold on a second distribution mid-stream; `queued` park when eligibleSupply 0→>0); **JIT sim** (buy pre-
collect, sell post, verify bounded earn, INV-29); **`sync`-can't-brick** (fuzz every arg incl. huge balances);
**excluded-never-accrues**; **convert** TWAP-floor holds under simulated price manipulation, caller-minOut can only
tighten, deadline/over-pending/zero-in/unregistered-route revert, allowance reset; **multi-namespace solvency**
(interleave collect/convert/claim across ≥3 tokens, assert INV-27). Fork-integration on a **Foundry fork of
Robinhood mainnet 4663** (real Uniswap V3 + USDG + oracle): launch → trades accrue fees → `collect` **90/5/5 exact**
(creator paid, Hydeout paid, USDG reward streamed / LT leg parked) → `convert` TWAP-floored LT→USDG → holders
`claim` streamed amounts over time → threshold → `graduate` → post-state. Slither clean/triaged; gas snapshot (incl.
the per-transfer `sync` cost).

---

## 9. Open sub-decisions (non-blocking for build start; flag at wiring)
- **Reward-conversion guard — pinned to a contract-level TWAP floor (§4b, audit-21249 pt.2).** Deploy-blocking
  bits: `MAX_SLIPPAGE_BPS`, `TWAP_WINDOW`, the oracle-cardinality target, and the per-preset convert route (manifest).
  **Fallback decision:** if 4663 Uniswap pools can't reliably supply `TWAP_WINDOW` history, `convert` ships
  `onlyAuthorizedConverter` (immutable keeper) instead of permissionless — kami/clint call at wiring.
- **Stream `DURATION` — policy value (kami/clint).** Proposed **7 days** (balances JIT-resistance vs holders
  waiting for rewards to vest). Shorter = weaker JIT protection; longer = slower payout. Immutable per deployment
  (manifest).
- ~~JIT reward-sniping~~ → **RESOLVED via the streamed index (audit-21249 pt.3)** — no longer a v1.1 deferral.
- ~~Reward token = USDG confirm~~ → **CONFIRMED (clint 21249).**
- ~~Buyback&burn realisation~~ → **RETIRED** (replaced by the reward vault; §11).
- ~~Launch-fee amount fixed vs adjustable~~ → **RESOLVED: fixed & immutable per deployment.**
- ~~Milestone metric for `graduate`~~ → design = monotonic `graduationProgress`; **still blocked on the
  `graduationThreshold` number** (kami 21249 — graduate stays stubbed/deploy-blocked).
- Board during transition: dual-source vs Hyde-only (PROTOCOL_PLAN §7).

---

## 10. Automatic Blockscout verification pipeline (clint 21250 / kami 21251)

**Requirement (kami 21251):** every Hyde-launched token reaches Blockscout **verified automatically** — no manual
per-token step — and a launch **never reverts** because Blockscout is slow/down. Solidity cannot call an explorer
HTTP API, so this is an **off-chain verifier worker (indexer)** in the deployment/ops layer, fully decoupled from
the on-chain `launch` path. **The contracts need no change** for it: `LaunchCreated(token, creator, pool, tokenId,
preset)` already carries `token`, and the clone's `IMPL` is a known factory immutable (identical bytecode across all
clones) — enough to reconstruct verification. *(Optional non-breaking nicety: also emit `impl` in `LaunchCreated`
so the indexer needn't read the factory immutable — flag to kuro; not required.)*

**A. One-time, pre-production (at deploy).** Verify the shared contracts via source verification **before any launch
is enabled:** `HydeERC20` implementation, `HydeTokenFactory`, `HydeFeeCollector`, `HydeRewardVault`. Method:
`forge verify-contract` against the Blockscout Etherscan-compatible API (`/api?module=contract&
action=verifysourcecode`, standard-JSON input) and/or **Sourcify** (Blockscout on 4663 supports both). Pin the exact
`{compiler version, optimizer runs, evm version, standard-JSON}` in the deployment manifest so verification is
reproducible. **Release gate:** all four report `is_verified: true` on `robinhoodchain.blockscout.com` before
mainnet launches are turned on.

**B. Per-launch, async & continuous (the worker).**
1. **Index `LaunchCreated`** from the factory with a **durable block cursor** (last-processed block persisted) so a
   restart resumes with **no missed launches** and **no double-processing**.
2. For each new `token` (an EIP-1167 minimal proxy of the verified `IMPL`), **submit verification to Blockscout:**
   - *Primary — EIP-1167 recognition:* Blockscout auto-detects 1167 minimal proxies and links the implementation;
     the worker calls the proxy/bytecode-match endpoint to associate `token → IMPL`. Because every clone shares
     identical creation+runtime bytecode (modulo the embedded impl address), one verified `IMPL` makes all clones
     matchable.
   - *Fallback — explicit source:* if the explorer hasn't auto-matched within a bound, submit the `HydeERC20`
     standard-JSON (same source/compiler as the verified impl) for the clone address so the clone itself carries
     verified source.
3. **Durable per-token status machine:** `unverified → submitted → pending → (verified | failed)`, persisted in the
   indexer DB. `failed` is **actionable** — record the explorer's reason (bytecode mismatch / 429 rate-limit /
   transient 5xx) rather than a silent drop.
4. **Poll + retry with backoff:** poll verification status; retry *transient* failures (5xx/429/network) with
   capped exponential backoff; `verified` is terminal; a genuine mismatch (should be impossible for a correct clone)
   raises an **alert**, not an infinite retry. **Idempotent** — reprocessing a `verified` token is a no-op.
5. **Never blocks launch:** the worker is off the on-chain path — an unavailable explorer only delays the badge,
   never the token (reinforces INV-7: launch atomicity has zero explorer dependency).

**C. App surface.** Show the verification state + explorer link. Reuse the existing `useVerifiedStatus` /
`getLaunchImplementation` logic: render ✓ when the token is directly `is_verified` **OR** it is an `eip1167` proxy
whose implementation `is_verified` — combined with the worker's durable status (pending spinner / ✓ + link /
actionable-failure). **Never a false ✓** — a miss shows neutral/pending, not a scary "unverified."

**D. Acceptance tests (kami: "its acceptance tests"):**
- **Pre-prod gate:** all four shared contracts `is_verified: true` on the target Blockscout before launches enabled.
- **Release-complete criterion (kami's bar):** on testnet/the 4663 fork, launch a token → the worker consumes
  `LaunchCreated` → submits → the token reaches **`verified` on the real Blockscout automatically**, and the app
  badge flips to ✓ with the correct link — *with no manual step.* "A release is not complete until a real launched
  token reaches Blockscout verified automatically" (kami 21251).
- **Resilience:** (i) explorer 5xx/429 → worker backs off + retries, launch unaffected, eventually verifies;
  (ii) worker restart mid-stream → cursor + status resume, no double-submit, no missed token; (iii) simulated
  permanent mismatch → status lands `failed(actionable)` with reason + alert, launch still fine; (iv) launch while
  the explorer is down → token created + tradeable, badge `pending`, auto-verifies on recovery.
- **Idempotency:** re-running the worker over already-verified tokens changes nothing.

**E. Ownership/handoff.** This is a **deployment/ops component** (verifier worker + indexer), **not** part of the
audited contract set — but it is a **release requirement**. kuro includes the verifier-worker/indexer hook in the
build handoff **once the reward-contract audit clears** (kami 21251); the contract side is already satisfied by the
existing `LaunchCreated` event + fixed `IMPL`.

---

## 11. Bubblemaps deep-link (secondary, kami 21228) — research status
`v2.bubblemaps.io/robinhood` is a **client-side SPA**; a no-JS fetch returns the generic app shell for any path, so
the token-route form (`/robinhood/token/<addr>` vs `/map?chain=robinhood&address=<addr>`) **cannot be confirmed
statically**, and there's no headless browser on this box to render it (confirmed against real 4663 token
`0x3bed9d3863e56e5e6afae8425012a80be7d80ba3`). Ground truth = clint pastes the permalink from that page (or a
browser render); then the exact `<address>` template is handed to kuro for the Path-A "View holders on Bubblemaps ↗"
secondary link (kami 21220). Not blocking the fee-split contract work.

---

## 12. Changelog
- **2026-07-14 rev2 (kami audit 21249) + verification pipeline (clint 21250 / kami 21251):** added §10 —
  **automatic Blockscout verification** off-chain worker (index `LaunchCreated`, EIP-1167 impl-match + source
  fallback, durable pending→verified/failed status, retry/backoff, app badge, never blocks launch) + its acceptance
  tests + the pre-prod shared-contract verification gate. Plus the five audit-21249 contract fixes: (1) `REWARD_VAULT.register` moved before the init mint (launch no longer
  reverts on the mint's `sync`); (2) `convert` guarded by an on-chain **TWAP floor + immutable `MAX_SLIPPAGE_BPS`**,
  caller may only tighten, **pinned per-launch route**, `amountIn>0`/registered-pair required; (3) JIT closed via an
  **O(1) fixed-`DURATION` reward stream** (Synthetix `rewardRate`/`periodFinish`) replacing instant-lump indexing —
  now deployment-blocking-resolved, not a v1.1 defer; (4) **global `accountedBalance[asset]` + cross-namespace
  solvency invariant** (INV-27) replacing per-token exact-received; (5) full-precision **`mulDiv`** throughout. USDG
  confirmed. Added INV-29/30/31, reframed INV-25/26/27; §7.12–18. Graduate + threshold stay deploy-blocked.
- **2026-07-14 rev1:** fee split's 5% leg changed **buyback&burn → USDG holder rewards** (clint 21245, kami 21247).
  Added `HydeRewardVault` (pull-based claim-index, no loops); removed `HydeERC20.burn` (supply constant); retired
  buyback immutables/threats/INV-19.
- **2026-07-13:** L3 own-stack build spec locked (90/5/5 creator/buyback&burn/Hydeout); HydeERC20 + HydeFeeCollector
  built & tested, held (`67bc16c`).
