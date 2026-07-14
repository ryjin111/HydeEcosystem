# Hydeout Own-Stack — Level-3 Contract Spec & Threat Model

**Status:** BUILD SPEC — decisions locked, ready for kami audit → then kuro implements.
**Author:** gojo (senior protocol) · **Reviewer gate:** kami · **Builder:** kuro · **Date:** 2026-07-14 (rev4: WETH fee-settlement vault)
**Parent:** `PROTOCOL_PLAN.md` (Level-2). This doc pins the contract interfaces, invariants, and tests.
**Build path:** contract workspace under `D:\agentmanagerworks\` (kami 21085) — never in a shared app tree.

> "Checked for bugs" = layered testing + independent review, **never** a claim any contract is bug-free
> (kami). No public deploy / no push until review passes + a second independent review.

> **REV4 2026-07-14 — WETH fee settlement (clint 21255 → kami 21256).** Trading fees now settle in **WETH**, and the
> **90% creator / 5% Hyde / 5% holders** split is denominated in WETH. `collect` **no longer splits or pays the
> creator** — it only harvests + accounts the raw V3 fee assets (swap-free). A **separate permissionless,
> TWAP-floor-guarded `settle`** converts non-WETH fees → WETH and performs the exact 90/5/5. **Creator and Hyde are
> pull-based WETH claim buckets; only the holder 5% streams (in WETH).** The $1 launch fee stays **USDG** (separate,
> unchanged). The rev1–rev3 USDG reward-vault design is **superseded** (kami 21256); kuro does NOT implement it. **All
> 21254 safety fixes carry over** (donation-proof pull-measure, explicit-carry streaming with requeue/restart,
> oracle-gated TWAP settle, global-solvency accounting, Blockscout minimal-proxy verification). Graduate/threshold +
> kuro's build stay held until this rev4 passes audit; then one clean SHA.

---

## 0. Locked decisions (clint/kami 2026-07-13 → 2026-07-14)
> **Deployment-blocking manifest pins:** the vault's immutable **`SETTLEMENT_TOKEN` (= WETH = wrappedNative)**, the
> split recipients (`hydeoutTreasury`), the immutable stream `DURATION` / `MAX_SLIPPAGE_BPS` / `TWAP_WINDOW`, the
> pinned per-launch settle route, and the launch-fee `stablecoin` (USDG) **must be fixed in the reviewed manifest
> before any deploy.**

- **Fee split (own-stack): 90% creator / 5% Hyde / 5% holder rewards**, **settled in WETH** — immutable
  `hydeBps=500`, `holderBps=500`, `creatorBps` = enforced remainder `1e4 - 500 - 500 == 9000`, `sum==1e4`
  (clint 21255; kami 21256). Split executes in **`settle`** (WETH-denominated), not in `collect`.
- **Settlement asset = WETH** (clint 21255). Creator claims WETH; Hyde claims WETH; holders earn the 5% as a
  **streamed WETH reward**. WETH is the chain's `wrappedNative`; **prefer LT/WETH launch pools** so the WETH fee leg
  needs no swap and only the LT leg is ever converted.
- **`collect` is swap-free & split-free (kami 21256).** It only collects the raw V3 fee assets and **accounts** them
  (`rawFees[token][asset]`) — **no creator transfer, no router, no split inside `collect`** (INV-14/18). The 90/5/5
  split + any conversion happen in the separate `settle` step.
- **`settle` — separate, permissionless, TWAP-floor-guarded (kami 21256).** Converts a non-WETH raw fee leg → WETH
  (oracle-gated), or takes the raw WETH leg directly (no swap), then splits the WETH **90/5/5** into the creator
  claim bucket, the Hyde claim bucket, and the holder WETH stream.
- **Creator & Hyde are pull-based WETH claim buckets; holders are streamed (audit-21254 stream fixes carry).** Only
  the holder 5% streams over an immutable `DURATION` (JIT-resistant); creator/Hyde accumulate and are claimable any
  time.
- **`HydeERC20` has NO burn path.** Supply is **constant 1e9 forever** — no mint, no burn (INV-5). Since the creator
  is now paid in **WETH** (never in the launch token), the collector never sends LT to a non-exempt wallet, so the
  old `from == COLLECTOR` max-wallet bypass is **no longer needed** (§2).
- **Launch fee: $1 flat in USDG** (the chain stablecoin), atomic, before deploy (PROTOCOL_PLAN §2.5) — **unchanged**;
  USDG is used ONLY for the launch fee, not for reward settlement.
- Graduation: **Option A — permanently locked LP** (milestone label only). Metric/threshold still open (§9); stays
  deploy-blocked (kami 21249).
- Anti-snipe: **(b) time-boxed max-wallet** in `HydeERC20`, expires; never permanent. (The holder **stream** closes
  JIT reward-sniping — §7.14.)
- Supply: **1B, 100% to the launch pool** (fair launch, no premint/team alloc).

---

## 1. System topology
Three shared authored contracts + a deterministic clone per launch:
- **`HydeERC20`** — one verified *implementation*, EIP-1167-cloned per launch. No owner, no mint, **no burn**, no
  blacklist, no pause. Its transfer path calls the vault's `sync` so the streamed holder accounting stays correct.
- **`HydeTokenFactory`** — permissionless `launch`; charges the $1 **USDG** fee, deploys+inits the clone, seeds
  single-sided V3 LP (and bumps the pool's oracle cardinality for the `settle` TWAP), registers the position with
  the collector and the vault. Owner sets templates/config for **future** launches only.
- **`HydeFeeCollector`** — custodies each launch's V3 position NFT **forever** (locked LP by absence of any
  withdraw/transfer path); permissionless `collect` **harvests raw V3 fees and hands them to the vault (swap-free,
  no split, no creator payout)**; permissionless `graduate` flips the milestone label.
- **`HydeFeeVault` (the WETH fee-settlement vault, NEW)** — shared singleton, per-token accounting. Holds raw fees
  until settled and the WETH claim/stream reserves under **global `accountedBalance[asset]`** solvency; runs the
  permissionless, TWAP-floor-guarded **`settle`** (the system's only swap) which converts non-WETH → WETH then
  splits 90/5/5; exposes pull-based `claimCreator` / `claimHyde` (WETH) and the streamed holder `claim` (WETH), plus
  the token-driven `sync`.

Per-chain surface = the adapter config (§5) + reviewed manifest (§8). No dependency beyond a compatible Uniswap V3
(with pool oracle), WETH (`wrappedNative`), USDG (launch fee only), and (for `settle` only) a swap router.

---

## 2. `HydeERC20` (implementation, cloned)

**Inherits:** minimal ERC-20 + EIP-2612 `permit`. **No owner. No mint-after-init. No burn. No blacklist. No pause.**
**Supply fixed at 1B forever** (INV-5).

**Immutable-after-init storage (set once in `initialize`, no setters):**
| field | meaning |
|---|---|
| `name`, `symbol` | metadata |
| `TOTAL_SUPPLY` | constant `1_000_000_000e18`, 100% minted to `pool` recipient at init |
| `maxWallet` | max holder balance during the anti-snipe window (from `maxWalletBps` of supply) |
| `maxWalletExpiry` | `uint64` timestamp; window active while `block.timestamp < maxWalletExpiry` |
| `VAULT` | the `HydeFeeVault` — notified on every transfer via `sync`; reward-excluded + max-wallet-exempt |
| `exempt[address]` | a **fixed infra set frozen at init**, used for BOTH max-wallet exemption AND reward-ineligibility: ONLY the V3 pool, position manager, factory, collector, **vault**, **swap router**, `address(0)`. No `setExempt`, no owner-addable whitelist. |

`isRewardExcluded(address a) → bool` public view returns `exempt[a]` (the vault reads it in `claim`; the transfer
path passes the two booleans into `sync`).

**`initialize` — clone init model:** once-set storage under `initializer` + `onlyFactory`. Same-tx call from the
factory → no front-run window. **Order inside `initialize`:** (a) set immutables incl. the exempt set + `VAULT`,
**then** (b) mint 100% to the pool — so the mint's `sync` sees `exempt[pool]=true` and the vault has **already been
registered by the factory before this call** (§3 step 3). Config-bounds asserts: revert on zero `poolRecipient` /
`vault`, `maxWalletBps ∉ (0,300]`, `maxWalletWindowSecs ∉ (0,3600]`.

**Transfer path — `_update(from, to, amount)`, in order:**
1. **`to == address(0)` reverts (`ZERO_TO`)** — no supply-reducing path exists (supply constant; INV-5/21).
2. **Reward crystallization (BEFORE balances change):** `VAULT.sync(from, to, balanceOf(from), balanceOf(to),
   amount, exempt[from], exempt[to])` — checkpoints both parties' streamed WETH index, re-anchors, adjusts
   `totalEligibleSupply`. **`onlyToken`, pure arithmetic, no external calls, cannot revert on the normal path** →
   never bricks a transfer (INV-23).
3. **Max-wallet:** `if (block.timestamp < maxWalletExpiry && !exempt[to]) require(balanceOf(to) + amount <=
   maxWallet);` — recipients only (never blocks selling); expiry immutable. **No `from == COLLECTOR` special-case is
   needed anymore** — the creator is paid in **WETH by the vault**, never in the launch token, so the collector's
   only LT outflow is to the **vault (a `to`-exempt recipient)** during fee handling; that transfer skips the cap
   without any bypass. (The vault's LT→router movements during `settle` are also to an exempt recipient.)
4. Standard balance update + `Transfer` event.

**Events:** standard `Transfer`/`Approval`. No admin/mint/burn events.

---

## 3. `HydeTokenFactory`

**Owner (multisig) — MINIMAL power:** only **`pause()`/`unpause()` of NEW launches**. Cannot change fee,
stablecoin, treasury, bps, uniswap addresses, the vault/settlement token/stream params, or anything on a live token
/ its LP / its fees / its reward accounting. **All economic config immutable.**

**Immutables (ALL constructor-set, NO setters):**
- `IMPL` (`HydeERC20`), `COLLECTOR`, `VAULT`.
- Economic config: `stablecoin` (= USDG, **launch fee only**), `launchFeeAmount`, `supportsPermit`,
  `launchFeeTreasury`, `uniV3Factory`, `positionManager`, `swapRouter`, `wrappedNative` (= WETH = the vault's
  `SETTLEMENT_TOKEN`), `feeTier`, `maxWalletBps`, `maxWalletWindowSecs`, `graduationThreshold`, and the
  **oracle-cardinality target** used at seed. The split legs (`hydeoutTreasury`, `hydeBps`, `holderBps`) + stream
  params (`DURATION`, `MAX_SLIPPAGE_BPS`, `TWAP_WINDOW`) live on the **VAULT** (where `settle` executes). `creatorBps`
  is the enforced remainder (never stored).
- **Presets** — hard-coded `pure` `preset(uint8 id)`; revert on unknown id.
- **Chain-gate:** `stablecoin == 0 || launchFeeAmount == 0 || wrappedNative == 0` **cannot be constructed for live
  use**.

**External functions:** `launch` / `launchWithPermit` (both `nonReentrant`); `LaunchParams = { name, symbol,
preset }`, **`creator := msg.sender`** (no caller-supplied creator). Owner: `pause`/`unpause` only.

**`launch` ordering (single tx — all-or-revert):**
1. **`_chargeLaunchFee(msg.sender)`** — FIRST state change, **USDG** `SafeERC20` + `require(received ==
   launchFeeAmount)`. Path 2 calls `permit` first. Revert ⇒ nothing created.
2. `_deployClone()` — `Clones.cloneDeterministic(IMPL, salt)`, `salt = keccak256(msg.sender, symbol, nonce++)`.
3. **`VAULT.register(token, msg.sender /*creator*/, settleRoute)` — `onlyFactory`, BEFORE `initialize`.** Marks
   `token` as a legit Hyde token authorized to call `sync`, records the immutable `creator`, opens the accounting
   namespace, and **pins + validates the per-launch settle route STRUCTURE** (input asset + hops + fee tiers,
   terminates in **WETH**): LT→WETH **direct** single-hop at `feeTier` for an LT/WETH pool, else an explicit path.
   *(Pool may not exist yet → register validates **structure only**; live pool + TWAP maturity are checked at
   `settle`, §4b.)* Registering here guarantees the next step's mint-`sync` is accepted.
4. `token.initialize(...)` — same-tx, guarded. Sets exempt set + `VAULT`, **then** mints 1B to the pool (mint-`sync`
   accepted; pool excluded ⇒ eligibility no-op).
5. `_seedLiquidity()` — deterministic pool addr; create+init at `feeTier`/preset tick if absent; **increase pool
   observation cardinality** to the target (**allocates slots — does NOT backfill history**, so `settle` stays
   `ORACLE_NOT_READY` until a full `TWAP_WINDOW` of observations accrues, §4b); mint the **single-sided** position
   via `positionManager.mint(recipient = COLLECTOR)`. Factory is the transient payer (funds in
   `uniswapV3MintCallback`, precomputed-pool-only, mid-launch-only). **After `mint`, factory, collector & vault each
   hold 0 launch-token** (INV-15). Any revert ⇒ whole `launch` reverts incl. the step-3 register (same-tx rollback;
   INV-7/30).
6. `COLLECTOR.register(token, msg.sender, tokenId, numeraire, graduationThreshold)` — `onlyFactory`.
7. Emit `LaunchFeePaid` + `LaunchCreated`.

**Events:** `LaunchFeePaid`, `LaunchCreated`, `Paused(bool)`.

---

## 4. `HydeFeeCollector`

**Immutables (constructor-set, NO setters):** `FACTORY` (deploy-cycle), `VAULT`, `POSITION_MANAGER`. *(The split
legs/recipients/bps have MOVED to the vault, where `settle` executes — kami 21158.1 principle applied to the new
flow; the collector no longer knows any bps or treasury.)*

**Deployment sequence (factory↔collector↔vault cycle):** CREATE2 address prediction — predict factory address,
deploy vault (predicted factory), deploy collector (predicted factory + vault), deploy factory (collector + vault)
**to the predicted address**; abort if it doesn't land there (no init-seizure). *Fallback:* one-shot `initFactory`
on **both** collector and vault, callable once by the deployer then locked.

**Custody / LP-lock:** holds every launch's V3 NFT. `positionOf[token] = {registered, graduated, creator, tokenId,
numeraire, graduationThreshold}`; only mutable bit is one-way `graduated` + monotonic `graduationProgress[token]`.
**LP locked by ABSENCE of a code path** — no decreaseLiquidity/withdraw/burn/transfer/approve/generic-call on the
position, no owner (INV-4/14).

**External functions:**
- `collect(address token) external nonReentrant` — **permissionless, SWAP-FREE, SPLIT-FREE (kami 21256).** V3
  `positionManager.collect(recipient = this)` → for each collected asset `amt`, **hand it to the vault** to be
  accounted as raw un-settled fees — **no split, no creator payout, no router:**
  ```
  // for each of token0, token1 with collected amt > 0:
  forceApprove(asset, VAULT, amt);          // exact allowance
  VAULT.noteRaw(token, asset, amt);         // vault PULLS + MEASURES (donation-proof); credits rawFees[token][asset]
  forceApprove(asset, VAULT, 0);            // reset
  ```
  **Graduation accumulator:** `graduationProgress[token] += <gross WETH (numéraire) amount collected this call>` —
  monotonic; `collect` only advances it (INV-20). Atomic; **revert on any `noteRaw` failure.** Emits
  `FeesCollected(token, amt0, amt1)`. **No swap, no split, no oracle, no creator transfer** — `collect` reaches no
  router (INV-14/18).
- `graduate(address token) external` — permissionless; `require(!graduated && graduationProgress ≥
  graduationThreshold)`; no liquidity moves (Option A). **Stays stubbed to revert `GRADUATION_PENDING` until the
  metric + threshold are pinned** (kami 21249). Unchanged.

**Events:** `FeesCollected(token, amt0, amt1)`, `Graduated`, `PositionRegistered`.

---

## 4b. `HydeFeeVault` (NEW — WETH settlement + claims + streamed holder rewards)

**Model.** Shared singleton, **per-token** accounting. Holds each launch's **raw un-settled V3 fees** until a
permissionless **`settle`** converts them to **WETH** (oracle-gated TWAP swap for non-WETH; direct for the WETH
leg) and splits the WETH **90/5/5** into: the **creator claim bucket**, the **Hyde claim bucket**, and the **holder
WETH stream**. **Creator & Hyde are pull-based** (accumulate, claim any time); **only the holder 5% streams** over an
immutable `DURATION` (JIT-resistant, O(1), no holder loops). All custody is under a **global `accountedBalance
[asset]`** credit ledger with a cross-namespace solvency invariant.

**Immutables (constructor-set, NO setters):** `SETTLEMENT_TOKEN` (= WETH = wrappedNative), `COLLECTOR` (sole
`noteRaw` funder), `FACTORY` (`onlyFactory register`), `SWAP_ROUTER`, `hydeoutTreasury` (5% recipient),
`hydeBps (==500)`, `holderBps (==500)`, `DURATION` (**default 7 days**), `MAX_SLIPPAGE_BPS` (**default 300**),
`TWAP_WINDOW` (**default 1800s**), `PRECISION = 1e30`. Constructor asserts all non-zero, `hydeBps == 500 &&
holderBps == 500 && hydeBps + holderBps < 1e4`, `MAX_SLIPPAGE_BPS < 1e4`. **All index/share/stream math uses
full-precision `mulDiv`.**

**Per-token state (keyed by `token`; a rogue caller only ever touches its OWN namespace):**
| field | meaning |
|---|---|
| `registered[token]`, `creator[token]`, `settleRoute[token]` | set once by `onlyFactory register` |
| `rawFees[token][asset]` | un-settled raw V3 fees awaiting `settle` (any asset, incl. WETH) |
| `creatorClaimable[token]` | **WETH** owed to the creator (90% bucket) — claim any time |
| `hydeClaimable[token]` | **WETH** owed to Hyde (5% bucket) — claimable to `hydeoutTreasury` |
| `rewardRate/periodFinish/lastUpdateTime/rewardPerTokenStored[token]` | the holder **WETH** stream (Synthetix-style) |
| `totalEligibleSupply[token]` | Σ balances of non-excluded holders (maintained in `sync`) |
| `userRewardPerTokenPaid[token][holder]`, `rewards[token][holder]` | per-holder index anchor + crystallized WETH owed |
| `queued[token]` | WETH held out of the stream (funded while eligibleSupply==0, or re-queued on supply→0); auto-folds |
| `carry[token]` | explicit streaming division-remainder (`< DURATION` wei); folded into every `_startStream` |
| `liability[token][asset]` | this namespace's owed asset (rawFees for raw assets; creator+hyde+stream-reserve for WETH) |

**Global custody accounting — PULL-and-MEASURE (audit-21254 pt.1).** `accountedBalance[asset]` is a **pure internal
credit ledger** (sum of amounts actually received), **never gated on ambient `balanceOf`** (that was a donation-DoS).
`noteRaw` **pulls and measures atomically:** `before = balanceOf(this); safeTransferFrom(COLLECTOR, this, amount);
received = balanceOf(this) - before; require(received == amount);` then `accountedBalance[asset] += received;
rawFees[token][asset] += received; liability[token][asset] += received;`. Delta-measuring ignores donated surplus
and still catches a fee-on-transfer shortfall. `settle`'s WETH swap output is measured the same way. **Cross-
namespace solvency invariant (INV-27):** for every asset, `balanceOf(this) >= accountedBalance[asset] == Σ_token
liability[token][asset]`; donations only add harmless surplus.

**Eligibility.** Eligible = **not** in the launch token's frozen infra set (pool/PM/factory/collector/vault/router/
`0`). `sync` passes `exempt[from]`/`exempt[to]`; `claim`/settle consult `token.isRewardExcluded`. **Excluded accounts
never accrue** — so the pool (~100% at launch) and the vault (holds un-settled LT) never capture the holder stream.

**Streaming index math (all `mulDiv`, WETH-denominated):** identical to the standard Synthetix accumulator —
`rewardPerToken = (totalEligibleSupply==0) ? stored : stored + mulDiv((min(now,periodFinish)-lastUpdateTime)*
rewardRate, PRECISION, totalEligibleSupply)`; `earned(a) = excluded ? 0 : mulDiv(bal, rewardPerToken -
userRewardPerTokenPaid[a], PRECISION) + rewards[a]`; `_updateReward(acct,bal,excl)` checkpoints before every balance
change and before claim/settle-fund.

**Functions:**
- `sync(from, to, balFrom, balTo, amount, fromExcl, toExcl) external` — `require(registered[msg.sender])`;
  `token=msg.sender`. Settle both accounts (`_updateReward`), apply the eligible-supply delta, and handle boundary
  transitions (audit-21254 pt.2): **positive→zero** re-queues the unvested stream (`queued += (periodFinish>now)?
  (periodFinish-now)*rewardRate:0; rewardRate=0; periodFinish=now; lastUpdateTime=now`) so no time is consumed
  against zero supply; **zero→positive** auto-restarts (`_startStream(token, 0)` folds `queued`+`carry`). Pure
  arithmetic, **no external calls, non-revert on the normal path** (INV-23).
- `noteRaw(address token, address asset, uint256 amt) external` — **`onlyCollector`.** Pull-and-measure `asset` from
  the collector into `rawFees[token][asset]` (donation-proof). No swap, no split (that's `settle`).
- `settle(address token, address asset, uint256 amountIn, uint256 callerMinOut, uint256 deadline) external
  nonReentrant` — **permissionless, TWAP-floor + oracle guarded — the ONLY swap in the system.**
  `require(registered[token] && amountIn > 0 && amountIn <= rawFees[token][asset])`, `require(now <= deadline)`.
  - **WETH leg** (`asset == SETTLEMENT_TOKEN`): `wethAmt = amountIn` — **no swap**. Decrement `rawFees`.
  - **non-WETH leg**: use the **pinned `settleRoute[token]`** (input asset fixed at register); **oracle-readiness
    gate:** for each route pool `require` the oldest observation ≥ `TWAP_WINDOW` old, else revert `ORACLE_NOT_READY`
    (cardinality is allocated, not backfilled — audit-21254 pt.4). Floor: `oracleOut = TWAP(route, amountIn,
    TWAP_WINDOW); floor = mulDiv(oracleOut, 1e4 - MAX_SLIPPAGE_BPS, 1e4); minOut = max(floor, callerMinOut)` (caller
    may only tighten). `forceApprove(asset, SWAP_ROUTER, amountIn); exactInput(route, recipient=this, minOut)`;
    **measure `wethAmt` via before/after `balanceOf(WETH)` delta**, `require(wethAmt >= minOut)`; decrement `rawFees`
    + reset allowance.
  - **Then split the settled `wethAmt` 90/5/5 (remainder-to-creator, exact):**
    `hydeCut = mulDiv(wethAmt,hydeBps,1e4); holderCut = mulDiv(wethAmt,holderBps,1e4); creatorCut = wethAmt - hydeCut
    - holderCut;` `creatorClaimable[token] += creatorCut; hydeClaimable[token] += hydeCut; _updateReward(token,0,0,
    false); _startStream(token, holderCut);` update `accountedBalance[WETH]`/`liability` and (for non-WETH legs)
    decrement `accountedBalance[asset]`. **The ONLY swap** — oracle-gated, TWAP-floored, deadline-bounded,
    `nonReentrant`, touches no LP; sandwiching below a matured floor isn't profitable within a block. **`settle`
    stays permissionless-TWAP — no silent authorized keeper** (kami 21254). Emits `Settled(token, asset, amountIn,
    wethAmt, creatorCut, hydeCut, holderCut)`.
- `_startStream(token, amt)` (internal; also `flushCarry`): `amt += queued[token] + carry[token]; queued=0; carry=0;`
  `if (totalEligibleSupply==0){ queued[token]=amt; return; }` else `leftover = now>=periodFinish ? 0 :
  (periodFinish-now)*rewardRate; total = amt + leftover; rewardRate = total/DURATION; carry[token] = total %
  DURATION;` (**remainder carried explicitly**, audit-21254 pt.2) `lastUpdateTime=now; periodFinish=now+DURATION;`.
- `flushCarry(address token) external` — **permissionless.** `require(totalEligibleSupply[token] > 0);
  _updateReward(token,0,0,false); _startStream(token,0);` — re-streams accumulated `carry`+`queued` with no new fee
  (terminal conservation, INV-25/32).
- `claim(address token[, address holder]) external nonReentrant` — **holder streamed WETH.** `_updateReward(token,
  holder, balanceOf(holder), isRewardExcluded(holder)); owed = rewards[token][holder]; require(owed>0);
  rewards=0; liability[token][WETH]-=owed; accountedBalance[WETH]-=owed; WETH.safeTransfer(holder, owed);` — CEI,
  O(1), rounds down. A third party may trigger; funds always go to `holder`.
- `claimCreator(address token) external nonReentrant` — **WETH to the immutable creator.** `owed =
  creatorClaimable[token]; require(owed>0); creatorClaimable=0; liability[token][WETH]-=owed; accountedBalance[WETH]
  -=owed; WETH.safeTransfer(creator[token], owed);` (anyone may trigger; funds always go to `creator[token]`). Emits
  `CreatorClaimed`.
- `claimHyde(address token) external nonReentrant` — **WETH to `hydeoutTreasury`.** Symmetric to `claimCreator` on
  `hydeClaimable[token]`. Emits `HydeClaimed`.

**Immutable invariants:** all vault immutables have no setter; per-token `registered`/`creator`/`settleRoute`
one-way (factory-set once). No admin/owner function; no path moves an asset except the three claims (to their fixed
recipients) and the exact router allowance during `settle` (reset to 0 same-call).

---

## 5. Authority & immutability boundary (the audit's spine)
| Actor | CAN | CANNOT |
|---|---|---|
| **Anyone** | `launch` (pay $1 USDG), `collect` (harvest raw fees to vault, swap-free), `settle` (oracle+TWAP-floored →WETH, 90/5/5), `claim`/`claimCreator`/`claimHyde` (WETH to the fixed recipient), `graduate` | change any recipient/bps/route, move LP, mint/burn, loosen the settle floor, redirect a claim, split inside `collect`, drain fees |
| **Factory owner (multisig)** | **pause / unpause NEW launches — nothing else** | change fee/stablecoin/treasury/bps/settlement token/stream params; touch a live token / LP / fees / accounting; unlock LP; extend max-wallet; add an exemption; seize; force/redirect a settle or claim |
| **Creator** | receive **90% in WETH** via `claimCreator`; immutable recipient; a normal holder-stream-eligible holder for LT they buy | change their recipient; touch LP; mint; get preferential stream eligibility |
| **Holder** | receive **streamed WETH** (5% pool); `claim` any time | accrue while excluded; claim more than streamed `earned` |
| **Hyde** | receive **5% in WETH** via `claimHyde` (to `hydeoutTreasury`) | exceed 5%; touch creator/holder buckets or LP |
| **Token contract** | ERC-20 + permit; max-wallet during window; drive `sync` | mint/burn (**supply constant**); be paused/blacklisted |
| **Fee vault** | settle→WETH, hold buckets/stream, pay the fixed recipients, run the one TWAP-guarded swap | move an asset anywhere but to its rightful recipient; mutate bps/recipients/stream; touch LP/NFT; hold < liabilities (INV-27) |

**Global immutability claims (under fuzz):** post-launch, no reachable function alters price/range/threshold/
creator/treasury/`hydeBps`/`holderBps`/`SETTLEMENT_TOKEN`/stream params, moves or reduces the LP, or extends the
max-wallet window. **Supply fully constant.**

---

## 6. Failure-mode / revert catalog
- Launch fee `safeTransferFrom` (USDG) fails / stablecoin unset / `launchFeeAmount==0` / `wrappedNative==0` →
  **revert** (nothing created / not constructible).
- `launchWithPermit` on non-2612 / expired / replayed permit → **revert.**
- `initialize` twice or non-factory → **revert.** **`VAULT.register` must precede `initialize`** (else the init
  mint's `sync` reverts — fixed + tested, INV-30).
- `collect` V3-collect or `noteRaw` fails, or `noteRaw` from a non-collector, or pull-measure `received != amount`
  (fee-on-transfer shortfall) → **revert.** A **donation** to the vault does NOT revert `noteRaw`/brick `collect`.
- `sync` from a non-registered token → **revert.** `sync` on the normal path **must not revert** (anti-invariant).
- `settle`: past `deadline`, `amountIn==0`, over `rawFees`, unregistered token, **`ORACLE_NOT_READY`** (window
  immature), `wethAmt < minOut` (`minOut = max(TWAP floor, callerMinOut)`) → **revert** (no partial / unguarded /
  below-floor / immature-oracle swap).
- `claim`/`claimCreator`/`claimHyde` with nothing owed → **revert**; can never underflow `accountedBalance`.
- `graduate` before threshold / twice → **revert** (currently always `GRADUATION_PENDING`).
- Paused (new launches) → `launch` reverts; live tokens unaffected (still `collect`/`settle`/`claim`).

---

## 7. Threat model (attack → mitigation)
1. **Creator-share theft / fee redirect** → collector owns the NFT; `creator`/`hydeoutTreasury` immutable; claims go
   only to the fixed recipient regardless of caller. INV-3.
2. **LP rug / liquidity pull** → no decreaseLiquidity/withdraw/transfer path; no admin. INV-4.
3. **Free-launch / fee bypass** → USDG fee first, revert-on-fail, chain-gate. INV-8.
4. **Reentrancy** — `collect` (CEI+`nonReentrant`, no swap, `noteRaw` trusted-caller pull-measure); `settle`/`claim*`
   (`nonReentrant`+CEI; `settle`'s LT→pool swap re-enters only `sync`, a no-op on the excluded pair); `sync` (no
   external calls). INV-11, INV-23.
5. **Max-wallet permanent trap** → time-boxed, expiry immutable, selling never restricted. INV-6.
6. **Init front-run / re-init** → `initializer` + `onlyFactory` + deterministic salt. INV-10.
7. **Rounding/dust / stream stranding** → creator = remainder (exact 5% legs); the holder stream's division
   remainder is **explicitly carried** (`carry`) and folded every `_startStream`; unvested stream **re-queued** on
   positive→zero eligible supply, **auto-restarted** on zero→positive; permissionless `flushCarry`. **Every settled
   wei is claimable or explicitly carried** (terminal test). Claims round down. INV-1, INV-25, INV-32.
8. **bps escalation** → `hydeBps`/`holderBps` immutable, each capped 500 (creator ≥ 9000). INV-2.
9. **Owner overreach onto live tokens** → owner = future-launch config only; property-tested no owner selector
   touches a launched token / LP / fees / accounting. INV-9, INV-12.
10. **Snipe on pool init** → single-sided seed at a fixed preset tick; max-wallet caps opening accumulation.
11. **Griefing `collect`/`settle`/`claim*`/`graduate` spam** → idempotent-safe; harmless.
12. **Fee-conversion MEV / sandwich (why swap-free `collect`)** → `collect` performs **no swap** (harvest + account
    only). The only swap is the separate `settle`, which (a) is **oracle-gated** (reverts `ORACLE_NOT_READY` until a
    full `TWAP_WINDOW` exists; cardinality allocated-not-backfilled) and (b) **TWAP-floored** with immutable
    `MAX_SLIPPAGE_BPS`, caller may only tighten, pinned route. In-`collect`/atomic swap rejected. INV-18.
13. **Accounting corruption / cross-token bleed / donation-DoS** → all state keyed by the calling `token`; `sync`
    `onlyToken`; `noteRaw` `onlyCollector` + **pull-and-measure** (no ambient gate) → a donation can't brick
    `collect`, a rogue can't credit itself, a fee-on-transfer shortfall still reverts. INV-24, INV-13.
14. **JIT reward-sniping** → only the **holder 5% streams over `DURATION`**, so a JIT buyer earns ≈ `t/DURATION` and
    eats V3 fees + slippage in/out; the stream is balance-and-time-weighted by construction. Creator/Hyde buckets are
    fixed recipients (no JIT surface). INV-29.
15. **Transfer-hook DoS (brick the token via `sync`)** → `sync` = arithmetic, no external calls, non-reverting. INV-23.
16. **Precision/overflow** → `PRECISION=1e30` + full-precision `mulDiv`; `totalEligibleSupply==0` ⇒ stream parks in
    `queued` (no div-by-zero/spike). INV-26.
17. **Vault insolvency / cross-namespace drain** → `accountedBalance[asset]` is a measured-delta credit ledger;
    `balanceOf(this) >= accountedBalance == Σ liabilities` for every asset after ANY interleaving; token A's claims/
    settles can't draw token B. INV-27.
18. **Launch atomicity incl. vault register** → `VAULT.register` at step 3 (before the mint); any later revert
    unwinds it same-tx. INV-30.
19. **Creator paid in the wrong/held asset** → creator receives **WETH only** (a liquid, non-launch asset), so no
    max-wallet interaction, no launch-token dumping pressure from fee payouts, and the old collector→creator LT
    transfer (and its max-wallet bypass) is eliminated. INV-17.

---

## 8. Invariant / property test matrix (Foundry — fuzz ≥256 runs, invariant campaigns)
| # | Invariant | Kind |
|---|---|---|
| INV-1 | `settle` split: `creatorCut + hydeCut + holderCut == wethAmt`; `creatorCut == wethAmt - mulDiv(wethAmt,500,1e4)*2` (remainder, no dust); creator never underpaid | property + fuzz(amount, decimals) |
| INV-2 | `hydeBps == 500 && holderBps == 500`; `creatorBps == 9000`; no path raises either 5% leg | invariant |
| INV-3 | `creator[token]`, `hydeoutTreasury`, `hydeBps`, `holderBps`, `SETTLEMENT_TOKEN`, stream params unchanged by ANY call sequence; claims always pay the fixed recipient regardless of caller | invariant (fuzz calldata + caller) |
| INV-4 | position liquidity never decreases; NFT never leaves collector | invariant |
| INV-5 | `totalSupply == 1e9*1e18` at launch AND forever — **constant**; no mint AND no burn path | property + invariant |
| INV-6 | max-wallet blocks recipient over cap iff `now < expiry`; never after; never blocks `from`; expiry immutable | property + fuzz |
| INV-7 | any revert in `launch` ⇒ no token/pool/collector-registry/**vault-namespace**/state persisted | property (fail-injection) |
| INV-8 | exactly `launchFeeAmount` USDG moved creator→treasury once per launch; zero on revert | property |
| INV-9 | no owner/admin selector alters a live token's params, LP, fees, or accounting | invariant (owner-as-adversary) |
| INV-10 | `initialize` once; second call / non-factory reverts | unit |
| INV-11 | reentrant asset/token cannot double-spend or corrupt state in `launch`/`collect`/`settle`/`claim*` | property (reentrancy mock) |
| INV-12 | factory economic config immutable; owner's only state-change is pause/unpause | invariant (owner-as-adversary) |
| INV-13 | `noteRaw`/`settle` **pull-and-measure**: fee-on-transfer shortfall reverts; a **donation** doesn't revert/brick; no namespace over- or short-credited | property (fee-on-transfer + donation mocks) |
| INV-14 | selector enumeration: no collector selector reaches `positionManager.{transferFrom,decreaseLiquidity,burn,approve}` or a swap router; `collect` reaches no router | invariant / static |
| INV-15 | after `_seedLiquidity`, factory, collector & vault each hold 0 launch-token | property |
| INV-16 | `creator == msg.sender` every launch; no path charges another wallet | property |
| INV-17 | the collector's ONLY launch-token outflow is to the **`to`-exempt vault**; no fee path pays the creator in the launch token; max-wallet never blocks fee handling | property |
| INV-18 | **only `HydeFeeVault.settle` swaps**; `nonReentrant`, pinned route, **reverts `ORACLE_NOT_READY` until a full `TWAP_WINDOW`**, `minOut = max(TWAP-floor, callerMinOut)` (caller can only tighten), resets router allowance to 0, touches no LP; `collect` reaches no router | invariant/static + property (price-manip vs floor; new-pool before/after window) |
| INV-19 | *(retired — buyback burn; no burn; folded into INV-5)* | — |
| INV-20 | `graduationProgress` monotonic; `collect` never reduces it; `graduate` one-way iff progress ≥ threshold | invariant |
| INV-21 | `_transfer` reverts on `to == 0`; no transfer changes `totalSupply` | unit + property |
| INV-22 | `initialize` reverts on zero poolRecipient/vault or out-of-range maxWallet params | unit |
| INV-23 | **`sync` never reverts on the normal path** (no external calls; `mulDiv`/checked arithmetic); reverts ONLY for a non-registered caller | property + anti-invariant |
| INV-24 | reward/fee state strictly partitioned by `token`; non-registered `sync` reverts; `noteRaw` `onlyCollector`; a rogue namespace can't touch a real token's buckets/stream | invariant (rogue-token-as-adversary) |
| INV-25 | **exact conservation:** `Σ_holders(earned) + not-yet-vested-stream + queued + carry + creatorClaimable + hydeClaimable + Σ_asset rawFees(valued in-kind) == Σ noteRaw'd in-kind − Σ settled + Σ settled-WETH − Σ claimed`, exactly; the only un-vested residue is explicit `carry (< DURATION)` | invariant (fuzz collect/settle/transfer/claim/time-warp) |
| INV-26 | `rewardPerTokenStored` monotonic; `mulDiv` never overflows across fuzzed supplies/amounts/`Δt`; `totalEligibleSupply==0` ⇒ stream parks in `queued`; positive→zero re-queues, zero→positive auto-restarts | invariant + fuzz(supply crossing 0 both ways) |
| INV-27 | **cross-namespace solvency:** for every asset, `balanceOf(this) >= accountedBalance[asset] == Σ_token liability[token][asset]` after ANY interleaving (donations only add surplus); one token can't draw another's reserve; claims round down | invariant (multi-namespace collect/settle/claim/**donation**-as-adversary) |
| INV-28 | excluded/infra addresses never accrue the holder stream; `totalEligibleSupply` excludes them, tracks pool↔holder flows exactly | property + invariant |
| INV-29 | **streamed JIT resistance:** a wallet holding `b` for `t ≤ DURATION` around a holder distribution `R` earns `≤ mulDiv(R,t,DURATION)·(b/eligibleSupply)`; buy-before-settle/sell-after not profitable vs V3 cost; creator/Hyde buckets have no JIT surface | property (fuzz JIT sequences) |
| INV-30 | `VAULT.register` executes before the init mint; mint-`sync` succeeds; a mid-launch revert unwinds the register | property (ordering + fail-injection) |
| INV-31 | `settle` uses only the pinned `settleRoute[token]`; caller-supplied route/asset impossible; `amountIn==0`/unregistered/over-rawFees reverts | unit + property |
| INV-32 | **terminal conservation:** with no further fees, `flushCarry` + `DURATION` warp makes every settled wei claimed or explicitly held in `carry`/`queued`/buckets; supply 0-crossings never strand elapsed rewards | property (terminal + supply-drain-then-return) |
| INV-33 | **Blockscout clone state honest:** a clone reaches verified ONLY via a Blockscout minimal-proxy association to the verified `IMPL` (NOT impl-source-against-proxy, which mismatches); app renders ✓ only on real recognized-proxy+verified-impl, else neutral/pending | real-explorer acceptance + app-state unit |

**Deploy-time tests:** factory/collector/vault fail to construct on any zero immutable, wrong bps, or
`MAX_SLIPPAGE_BPS ≥ 1e4`. **Per-chain manifest** pins `{chainId, WETH(=SETTLEMENT_TOKEN), USDG(launch fee)+decimals,
launchFeeAmount, hydeoutTreasury, swapRouter, uniswap addrs, DURATION, MAX_SLIPPAGE_BPS, TWAP_WINDOW,
oracle-cardinality target, per-preset settle route}`; gojo/kami sign off per chain; **prefer LT/WETH pools** (WETH
leg needs no swap). Deploy-cycle: CREATE2-predicted factory matches; collector & vault `FACTORY` equals it;
`initFactory` fallback reverts on 2nd call / non-deployer on both.

**Plus non-invariant coverage:** every §6 revert; permit happy/expired/replay; duplicate salt;
`uniswapV3MintCallback` auth; **register-before-init** regression; seeding atomicity incl. vault-namespace rollback;
**settle lifecycle** (WETH leg no-swap split; non-WETH leg `ORACLE_NOT_READY` on a new pool then converts after the
window, TWAP-floor under price-manipulation, caller-minOut tighten-only, deadline/over-raw/zero-in reverts, allowance
reset; exact 90/5/5); **claim** creator/Hyde/holder pay the fixed recipient regardless of caller; **streaming**
(fund→stream→partial earned→claim; leftover-fold; explicit carry; queued park; positive→zero re-queue, zero→positive
restart; `flushCarry`; **terminal every-wei-claimable-or-carried**, INV-25/32); **JIT sim**; **`sync`-can't-brick**;
**donation-DoS** (stray tokens don't brick `collect`/`noteRaw`); **excluded-never-accrues**; **multi-namespace
solvency** (interleave collect/settle/claim/donate across ≥3 tokens, INV-27). **Fork-integration on a Foundry fork of
Robinhood mainnet 4663** (real Uniswap V3 + WETH + oracle): launch → trades accrue fees → `collect` (raw→vault) →
`settle` (LT→WETH TWAP-floored + 90/5/5) → `claimCreator`/`claimHyde`/holder `claim` (streamed) → threshold →
`graduate` → post-state. Slither clean/triaged; gas snapshot incl. per-transfer `sync`.

---

## 9. Open sub-decisions (non-blocking for build start; flag at wiring)
- **Build defaults locked (kami 21254):** `DURATION = 7 days`, `MAX_SLIPPAGE_BPS = 300`, `TWAP_WINDOW = 1800s`.
  Build against these; **deployment still needs 4663-fork evidence + manifest sign-off** to confirm/adjust (immutable
  per deployment). `settle` **stays permissionless-TWAP — no silent authorized keeper**; an authorized converter is
  only considered with explicit kami/clint sign-off + fork evidence that a matured TWAP is structurally unavailable.
- **Settlement token = WETH — CONFIRMED (clint 21255).** Launch fee stays **USDG** unless clint separately changes
  it (kami 21256). Manifest prefers LT/WETH pools so the WETH fee leg needs no swap.
- **Hyde claim bucket granularity:** per-token `hydeClaimable[token]` (chosen — cleanest for the cross-namespace
  solvency invariant); `claimHyde(token)` sweeps to `hydeoutTreasury`. A global accumulator was considered and
  rejected (weakens per-namespace partition). Flag if clint wants a single sweep call across tokens (batch view is
  fine off-chain).
- ~~USDG reward vault~~ → **SUPERSEDED by WETH settlement** (kami 21256); not implemented.
- ~~JIT / donation / stream-stranding / oracle-readiness / Blockscout fallback~~ → **RESOLVED (audit-21254)**, carried
  into this rev4.
- ~~Milestone metric for `graduate`~~ → design = monotonic `graduationProgress`; **still blocked on the
  `graduationThreshold` number** (kami — graduate stays stubbed/deploy-blocked).
- Board during transition: dual-source vs Hyde-only (PROTOCOL_PLAN §7).

---

## 10. Automatic Blockscout verification pipeline (clint 21250 / kami 21251)

**Requirement:** every Hyde-launched token reaches Blockscout **verified automatically** — no manual step — and a
launch **never reverts** because Blockscout is slow/down. Off-chain **verifier worker (indexer)**, decoupled from the
on-chain `launch` path. **Contracts need no change** — `LaunchCreated(token, …)` + the fixed `IMPL` suffice
(optional: also emit `impl` for indexer convenience; flag to kuro, not required).

**A. Pre-production (at deploy).** Verify the shared contracts before any launch is enabled: `HydeERC20` impl,
`HydeTokenFactory`, `HydeFeeCollector`, `HydeFeeVault` — via `forge verify-contract` (Blockscout Etherscan-compatible
`/api?...verifysourcecode`, standard-JSON) and/or **Sourcify**. Pin `{compiler, optimizer runs, evm version,
standard-JSON}` in the manifest. **Release gate:** all four `is_verified: true` on `robinhoodchain.blockscout.com`.

**B. Per-launch worker.**
1. **Index `LaunchCreated`** with a **durable block cursor** (restart-safe: no missed / no double-processed).
2. **Associate each clone via a Blockscout-supported minimal-proxy path (audit-21254 pt.3):** the clone's runtime is
   the ~45-byte 1167 proxy stub, **NOT** the `HydeERC20` runtime — **submitting impl source against the clone
   bytecode-mismatches; do not.** Use Blockscout's **EIP-1167 recognition / proxy→implementation association** to
   link `token → verified IMPL`. **Validate the exact endpoint/flow on `robinhoodchain.blockscout.com` during
   build**; if a direct clone-verification path exists, use it; **if not, the honest verified state is "recognized
   EIP-1167 proxy + verified implementation"** (source readable via the linked impl).
3. **Durable status:** `unverified → submitted → pending → (verified | failed(actionable))`, persisted; `failed`
   records the explorer's reason.
4. **Poll + retry with capped backoff** for transient 5xx/429; `verified` terminal; a genuine mismatch **alerts**
   (not infinite retry). **Idempotent.**
5. **Never blocks launch** — an unavailable explorer only delays the badge (reinforces INV-7).

**C. App surface.** Reuse `useVerifiedStatus`/`getLaunchImplementation`: render ✓ when directly `is_verified` **OR**
an `eip1167` proxy whose implementation `is_verified`, combined with the worker's durable status. **Never a false ✓.**

**D. Acceptance tests.** Pre-prod gate (four contracts verified); **MANDATORY real-explorer test** on testnet/4663
fork against the real `robinhoodchain.blockscout.com` — launch → auto-associate → verified (direct or recognized-
proxy+verified-impl) with **no manual step** (this also validates which proxy path the explorer supports; not
assumed) — "a release is not complete until a real launched token reaches Blockscout verified automatically" (kami
21251); resilience (5xx/429/restart/mismatch/explorer-down); idempotency.

**E. Ownership/handoff.** Deployment/ops component (worker + indexer), a release requirement — **not** part of the
audited contract set. kuro includes the verifier-worker/indexer hook in the build handoff **after** the reward-
contract audit clears; the contract side is satisfied by `LaunchCreated` + fixed `IMPL`.

---

## 11. Bubblemaps deep-link (secondary, kami 21228) — research status
`v2.bubblemaps.io/robinhood` is a **client-side SPA**; a no-JS fetch returns the generic app shell for any path, so
the token-route form **cannot be confirmed statically**, and there's no headless browser on this box to render it
(confirmed against real 4663 token `0x3bed9d3863e56e5e6afae8425012a80be7d80ba3`). Ground truth = clint pastes the
permalink from that page; then the exact `<address>` template goes to kuro for the Path-A "View holders on Bubblemaps
↗" secondary link (kami 21220). Not blocking the fee-settlement contract work.

---

## 12. Changelog
- **2026-07-14 rev4 (clint 21255 / kami 21256) — WETH fee settlement.** Settlement asset → **WETH**; `collect` is now
  **swap-free & split-free** (harvest raw fees → `noteRaw` into the vault); a separate permissionless TWAP-guarded
  **`settle`** converts non-WETH → WETH then splits **90/5/5**; **creator & Hyde are pull-based WETH claim buckets,
  only holders stream (WETH)**. Launch fee stays **USDG**. Renamed the vault to `HydeFeeVault`; split legs moved from
  collector → vault; dropped the `from==COLLECTOR` max-wallet bypass (creator paid in WETH now). **All 21254 fixes
  carried** (donation-proof pull-measure, explicit-carry streaming + requeue/restart, oracle-gated TWAP settle,
  global-solvency accounting, Blockscout minimal-proxy verification). rev1–rev3 USDG design **superseded / not
  implemented** (kami 21256). Added INV-19/32/33 re-scoped for WETH; INV-1/3/17/25/27 re-denominated. Graduate +
  kuro's build stay held.
- **2026-07-14 rev3 (kami re-audit 21254):** donation-DoS pull-measure; explicit-carry stream requeue/restart;
  Blockscout minimal-proxy fix; `settle`/`convert` `ORACLE_NOT_READY`. *(Now folded into rev4.)*
- **2026-07-14 rev2 (kami audit 21249):** 5 fixes on the USDG reward-vault. **2026-07-14 rev1:** buyback&burn → USDG
  rewards. *(Both superseded by rev4's WETH settlement.)*
- **2026-07-13:** L3 own-stack spec locked (90/5/5 creator/buyback&burn/Hydeout); HydeERC20 + HydeFeeCollector built
  & held (`67bc16c`).
