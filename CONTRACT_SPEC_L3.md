# Hydeout Own-Stack — Level-3 Contract Spec & Threat Model (rev7 · Uniswap V4)

**Status:** BUILD SPEC — Reviewer spec-clearance granted (kami 21296); **not** Builder/code clearance. kuro builds only
after this rev7 passes Reviewer audit.
**Author:** gojo (senior protocol) · **Reviewer:** kami · **Builder:** kuro · **Date:** 2026-07-14 (rev7.3: V4 + kami audit-21307 seed-dust fix)

> **rev7.3 fix (kami audit 21307, final seed-arithmetic correction):** the `dust < 2 wei` claim was wrong — V4
> `LiquidityAmounts` exposes no `getAmount…ForLiquidity` inverse, and core charges principal with **round-UP**
> `SqrtPriceMath.getAmount{0,1}Delta(roundUp=true)`, whose round-trip residual depends on the concrete tick range and
> can exceed 1 wei. Fixed: compute `dep` with the same round-up core math (`require(dep ≤ SUPPLY)`), **measure the actual
> factory residual** after the mint, gate it with an **immutable `MAX_SEED_DUST`** + **constructor-validated preset
> tuples** (both sort branches), sweep exactly the measured residual to the exempt collector, assert factory/vault == 0.
> INV-15/52 restated; range-fuzz/reference-math test added. (Two-branch settle + oracle idle/rounding PASSED in
> `e1f63c8`.)

> **rev7.2 fixes (kami audit 21303, 3 build-blockers):** (1) restored the **two-branch `settle(token, asset, …)`** —
> WETH raw-leg reclassify-only (no swap/oracle/`unlock`, `accountedBalance[WETH]` unchanged) vs LT-leg swap path;
> branch-exact INV-27. (2) **oracle idle-pool** — when `target ≥ lastObsTs` extrapolate `cumTarget` at `lastTick`
> (synthetic bracket); **signed mean rounds toward −∞** (canonical `OracleLibrary`); `now ≥ window` guard. (3) **pinned
> the seed algorithm** — exact token-order tick/amount encoding for LT-as-currency0/1, the `getLiquidityForAmount0/1`
> calc, a **bounded-dust (< 2 wei) sweep to the exempt collector** (real disposition, not an assert), and
> `tokenId = nextTokenId()` capture + `ownerOf == COLLECTOR`. Added INV-51/52 + tests.
**Precedes:** `V4_REV7_PROPOSAL.md` rev2 (`6a3cab5`, PASSED) · `DEPLOY_MANIFEST_4663.md` (V4 refresh pending).

> **rev7.1 fixes (kami audit 21299, 5 impl-blockers):** (1) V4 seed = mint 1B to the **exempt factory/seeder** (no
> per-pool token address; `POOL_MANAGER` is the exempt holder), single-sided LT-only (WETH settle == 0), assert zero
> balances; direct-to-PoolManager preload forbidden (INV-49). (2) init state = **pending→staging→active** (the old
> one-shot deleted the data `afterInitialize` needed). (3) TWAP **interpolated at exactly `now−TWAP_WINDOW`** between
> bracketing obs; same-block updates only `lastTick`; cardinality floor pinned. (4) `settle` **rejects partial fills**
> (input delta must equal `−amountIn`) + credits the **measured** WETH balance increase (INV-50). (5) CEI pre-debit
> before `unlock` + **one-shot job-hash callback auth** + underflow-safe **branched** fee decay.
**Supersedes:** rev1–rev6 (Uniswap V3, `8cd47bc`) — retired. **DEX-agnostic base preserved:** kuro `04f3f66`
(HydeERC20 + HydeFeeVault accounting) survives as logic; its V3 DEX-coupling is rewritten here.

> **Reviewer-locked topology (kami 21294/21296):** own **non-fund-bearing V4 hook** · **WETH** numéraire (not native) ·
> **90/5/5 stays in `HydeFeeVault`** · Hyde's seeded LP **custody-locked** (external LPs free to exit). Drafting
> constraints 1–5 from kami 21296 are folded into §4b/§4c below.

---

## 0. Locked decisions
- **DEX = Uniswap V4 on Robinhood 4663** (singleton PoolManager + hooks + `unlock`/`take`/`settle` flash-accounting).
  Verified addresses in the manifest; official V4Quoter `0x8dc178ef…` is the only quoter in required deps.
- **Fee split: 90% creator / 5% Hyde / 5% holders, settled in WETH.** Split executes in `HydeFeeVault` (unchanged).
- **Launch fee: $1 USDG** (6-dec ⇒ 1e6), atomic, before pool creation. Not part of 90/5/5.
- **Pool: LT/WETH only, DYNAMIC-FEE**, `HydeHook` attached. WETH = `wrappedNative`; USDG = launch fee only.
- **Anti-snipe:** hook time-decay dynamic fee (economic) + token time-boxed max-wallet (accumulation cap).
- **Graduation:** hook **swap-only gross WETH volume** counter; label-only (no unlock); threshold clint-pinned; stubbed
  until pinned.
- **LP-lock:** custody-only on Hyde's seeded v4 position NFT; **no** hook removal-revert (would brick fee-collect + trap
  external LPs). **Supply constant 1e9** (no mint/burn).

---

## 1. Topology
| contract | role | status vs `04f3f66` |
|---|---|---|
| **`HydeERC20`** | cloned launch token; EIP-2612; time-boxed max-wallet; `sync` → vault | **UNCHANGED** |
| **`HydeFeeVault`** | per-token WETH accounting: raw-fee custody, `settle`→WETH+90/5/5, creator/Hyde claim buckets, holder epoch vesting, `accountedBalance` solvency, `sync` | **ACCOUNTING PRESERVED; `settle` body + V4 immutables + oracle read REWRITTEN** |
| **`HydeFeeCollector`** | custodies Hyde's v4 position NFT (custody-lock); permissionless `collect` = zero-liq fee-take → vault | **MATERIALLY REWRITTEN (V4 collection)** |
| **`HydeTokenFactory`** | permissionless `launch`: $1 USDG, clone, hook pending-config, V4 `initialize`, single-sided seed, register | **REWRITTEN (V4)** |
| **`HydeHook` (NEW)** | per-pool V4 hook: `beforeInitialize` factory-auth · `afterInitialize` · `beforeSwap` dynamic fee · `afterSwap` oracle+volume | **NEW** |

Flow: `launch` seeds an LT/WETH dynamic-fee pool with `HydeHook` → users trade (hook meters volume + oracle, charges
decaying anti-snipe fee) → permissionless `collect` sweeps accrued fees to the vault → permissionless `settle` swaps
the LT leg→WETH (direct vault→PoolManager, hook-authenticated) and splits 90/5/5 → creator/Hyde `claim`, holders vest.

---

## 2. `HydeERC20` (UNCHANGED — carried from rev6)
Cloned (EIP-1167) minimal ERC-20 + EIP-2612; **no owner/mint/burn/blacklist/pause; supply constant 1e9**. Frozen
`exempt` infra set used for max-wallet exemption + reward-ineligibility (**blocker 1 — V4 has no per-pool token
address; the pooled LT lives at the singleton PoolManager, so the exempt holder is `POOL_MANAGER`, not a "pool"**):
`{POOL_MANAGER, POSITION_MANAGER, FACTORY, COLLECTOR, VAULT, UNIVERSAL_ROUTER, address(0)}`. `_update`: `to==0` revert;
call `VAULT.sync(from,to,balFrom,balTo,amount,exempt[from],exempt[to])` (onlyToken, pure, non-revert); time-boxed
max-wallet on recipients (`!exempt[to]`); `Transfer`. `isRewardExcluded(a)=exempt[a]`. **`initialize` (onlyFactory,
once): set exempt+VAULT, then mint the full 1B to the `FACTORY` (the exempt seeder)** — NOT to any "pool" address. The
factory then deposits it single-sided via the V4 seed flow (§3), so the LT ends up custodied inside `POOL_MANAGER` as
the position's reserves. **Invariants INV-5/6/21/23 unchanged.**

## 3. `HydeTokenFactory` (V4)
**Immutables:** `IMPL`, `COLLECTOR`, `VAULT`, `HOOK`, `POOL_MANAGER`, `POSITION_MANAGER`, `PERMIT2`, `stablecoin`(USDG),
`launchFeeAmount`(1e6), `launchFeeTreasury`, `WETH`, `feeTierBase`, `tickSpacing`, `preset(...)`, **`MAX_SEED_DUST`
(immutable seed-residual bound, §3 step 7)**, anti-snipe schedule (`startFee`,`baseFee`,`antiSnipeWindow`,`slope`),
`maxWalletBps`,`maxWalletWindowSecs`, oracle `TWAP_WINDOW`+ring cardinality, `graduationThreshold`. **Constructor
validates every allowed `preset` tuple `{sort, initialTick, tickLower, tickUpper}`** against the token-order/tick
alignment rules, the WETH-side-zero requirement, and residual `≤ MAX_SEED_DUST` (computed with the round-up core math,
both sort branches) — only validated tuples are launchable. Owner (multisig): `pause`/`unpause` NEW launches only.
**Chain-gate:** any zero immutable ⇒ not constructible.

**`launch(LaunchParams{name,symbol,preset}) nonReentrant` — `creator := msg.sender`; single tx, all-or-revert:**
1. `_chargeLaunchFee` — USDG `safeTransferFrom(msg.sender → launchFeeTreasury, 1e6)` + exact-received; (or Permit2
   signature path). Revert ⇒ nothing.
2. `token = Clones.cloneDeterministic(IMPL, salt=keccak256(msg.sender,symbol,nonce++))`.
3. `VAULT.register(token, creator)` — **before** `initialize` (mint-`sync` must be accepted); opens namespace.
4. **`HOOK.registerPendingPool(PoolKey, launchConfig)` — `onlyFactory` (constraint 4):** records the **exact** pending
   LT/WETH `PoolKey`(currency0/1=sort(token,WETH), fee=`DYNAMIC_FEE_FLAG`, tickSpacing, hooks=HOOK) + config
   (`launchTime` set at init, anti-snipe schedule, `token`), as a **one-shot** entry keyed by `poolId`.
5. `token.initialize(...)` — set exempt+VAULT, **mint the full 1B to the FACTORY** (the exempt seeder; blocker 1) —
   there is no per-pool address to mint to in V4.
6. **`POOL_MANAGER.initialize(PoolKey, sqrtPriceX96_preset)`** — triggers `HOOK.beforeInitialize` (validates
   `sender==factory` + the pending config, moves it to the one-shot `staging` record — §4c/blocker 2) then
   `HOOK.afterInitialize` (consumes `staging`→`active`, stamps `launchTime`, inits the observation ring). `sqrtPrice`
   preset is **token-order-dependent** (LT may be `currency0` or `currency1` after sort) — pin it + the
   `[tickLower,tickUpper]` range so the position is **single-sided in LT** at that price.
7. **Seed single-sided (LT-only) liquidity — EXACT encoding (blocker 3):** all ticks aligned to `tickSpacing`;
   `sqrtPriceX96` consistent with `initialTick`. **Token-order rules (sort ⇒ LT is currency0 or currency1):**
   - **LT = `currency0`** (LT < WETH): range **entirely above** spot → `initialTick < tickLower < tickUpper`;
     `amount0Max = SUPPLY (1e27)`, `amount1Max = 0`; `liquidity = LiquidityAmounts.getLiquidityForAmount0(
     sqrtRatioAtTick(tickLower), sqrtRatioAtTick(tickUpper), SUPPLY)`.
   - **LT = `currency1`** (WETH < LT): range **entirely below** spot → `tickLower < tickUpper ≤ initialTick`;
     `amount0Max = 0`, `amount1Max = SUPPLY`; `liquidity = LiquidityAmounts.getLiquidityForAmount1(
     sqrtRatioAtTick(tickLower), sqrtRatioAtTick(tickUpper), SUPPLY)`.
   Factory approves LT via **Permit2 → PositionManager**, **captures `tokenId = POSITION_MANAGER.nextTokenId()` BEFORE
   the call** (PositionManager assigns the current `nextTokenId` then increments), then `POSITION_MANAGER.modifyLiquidities
   ([ MINT_POSITION(PoolKey, tickLower, tickUpper, liquidity, amount0Max, amount1Max, recipient=COLLECTOR, hookData=""),
   SETTLE_PAIR(currency0, currency1) ])`. **Assert the WETH-side settled == 0** (mis-set range needing WETH ⇒ revert),
   then **`require(POSITION_MANAGER.ownerOf(tokenId) == COLLECTOR)`** before registration.
   - **Dust disposition — MEASURED, not assumed (blocker 3 / audit-21307):** the mint's principal is charged by V4 core
     with **round-UP** math — `dep = SqrtPriceMath.getAmount0Delta(sqrtLower, sqrtUpper, liquidity, roundUp=true)`
     (LT=c0) / `getAmount1Delta(…, roundUp=true)` (LT=c1); **not** any `getAmount…ForLiquidity` inverse (V4
     `LiquidityAmounts` exposes no such function). `require(dep ≤ SUPPLY)`. After `modifyLiquidities`+`SETTLE_PAIR`,
     compute the **actual factory residual** `dust = IERC20(LT).balanceOf(FACTORY)` (measure it — the round-trip
     residual is **not** a universal `<2` wei; it depends on the concrete tick range). **Gate it:** `require(dust ≤
     MAX_SEED_DUST)` (an **immutable** bound); **sweep exactly the measured `dust` to the COLLECTOR** (exempt +
     custody-locked → reward-ineligible, never re-circulates, doesn't touch `totalEligibleSupply`); then **assert
     `factory` & `vault` LT balances == 0**. **The factory accepts only constructor-validated preset tuples** — each
     `{sort, initialTick, tickLower, tickUpper}` is checked at construction to satisfy the token-order/tick rules, the
     WETH-side-zero requirement, and a residual `≤ MAX_SEED_DUST` (validated with the same round-up core math, both sort
     branches). **INV-15 (restated):** after seed `factory` & `vault` hold 0 LT; the position holds `dep`; the collector
     holds only the measured `dust ≤ MAX_SEED_DUST` — inert. **Preloading/transferring LT to `POOL_MANAGER` directly is
     forbidden** (uncredited donation, can't satisfy PositionManager's negative delta; INV-49). Any revert ⇒ whole
     `launch` reverts (clone/register/staging rolled back same tx — no stale authorization).
8. `COLLECTOR.register(token, creator, tokenId, WETH, graduationThreshold)`.
9. Emit `LaunchFeePaid`, `LaunchCreated(token, creator, poolId, tokenId, preset)`.

## 4. `HydeFeeCollector` (V4)
**Immutables:** `FACTORY`, `VAULT`, `POSITION_MANAGER`, `POOL_MANAGER`. Custodies Hyde's seeded position NFT forever.
**Deployment cycle (CREATE2, §9)** resolves factory↔collector↔vault↔hook.

**Custody-lock (constraint/blocker 1):** the collector owns the v4 position ERC-721 and exposes **no** transfer /
approve / setApprovalForAll / decreaseLiquidity / burn / generic-call / `onERC721Received`-forward path → locked-by-
absence on **our** NFT only. **The hook has NO `beforeRemoveLiquidity`**, so external LPs on the same pool remain
freely removable (INV-EXT).

**`collect(address token) external nonReentrant` — permissionless, swap-free, split-free:**
- As NFT owner, call **`POSITION_MANAGER.modifyLiquidities( abi.encode([INCREASE_LIQUIDITY(tokenId, liquidityDelta=0,
  amount0Max=MAX, amount1Max=MAX, hookData=""), TAKE_PAIR(currency0, currency1, recipient=address(this))]), deadline)`**
  — the zero-liquidity change credits the position's owed fees; `TAKE_PAIR` sweeps both currencies to the collector.
  PositionManager owns the `unlock`.
- **Measure** the collector's before/after {LT, WETH} balance deltas; for each asset `>0`: `forceApprove(asset, VAULT,
  d); VAULT.noteRaw(token, asset, d); forceApprove(asset, VAULT, 0)` (vault pull-measures — donation-proof).
- `graduationProgress` is **not** touched here (it lives in the hook, meters swaps only). Emits `FeesCollected`.
- `graduate(token)` — permissionless; `require(!graduated && HOOK.swapVolume(poolId) ≥ graduationThreshold)`; label
  only. **Stubbed `GRADUATION_PENDING` until clint pins the threshold.**

## 4b. `HydeFeeVault` (accounting PRESERVED; settle REWRITTEN for V4)
**Immutables (V4):** `SETTLEMENT_TOKEN`(WETH), `COLLECTOR`, `FACTORY`, `POOL_MANAGER`, `HOOK`, `hydeBps`(500),
`holderBps`(500), `DURATION`(7d), `MAX_SLIPPAGE_BPS`(300), `TWAP_WINDOW`(1800s), `PRECISION`(1e30). **`PERMIT2` is NOT
a vault immutable/dependency (constraint 3)** — the direct settlement path settles ERC-20 via PoolManager
`sync`/`transfer`/`settle`. Per-token PoolKey/poolId recorded at `register`.

**PRESERVED verbatim (kuro `04f3f66` accounting):** `noteRaw` pull-measure; per-token `rawFees`, `creatorClaimable`,
`hydeClaimable`, `holderFunded`/`holderClaimed`, `accountedBalance[asset]`; the **non-extendable fixed epoch** model
(`epochAmount`/`epochStart`/`epochFinish`/`epochVested` cumulative-target vesting, `nextEpochAmount`, `_maybeRoll`,
`roll`, `_updateReward`); `claim`/`claimCreator`/`claimHyde`; `sync`; `Multicall`; the split math + solvency
(INV-1/2/3/13/23/24/25/26/27/28/29/30/31/32). **`sync`/epoch/claim are DEX-agnostic and do not change.**
> **`roll()` ordering refinement (kami 21300, applies to the preserved vault):** `roll()` must **checkpoint the
> terminal epoch (vest/requeue) BEFORE its queue guard** — required order: `_updateReward` (checkpoint vest → requeue a
> fully-elapsed zero-supply epoch's funds into `nextEpochAmount`) → `require(now ≥ epochFinish)` (current epoch ended)
> → `require(nextEpochAmount > 0)` → open the next fixed epoch. This makes a permissionless `roll()` **self-sufficient**
> (a fully-elapsed zero-supply epoch can be rolled without waiting for an unrelated transfer/settle to poke it), while
> preserving **no active-epoch reset** and **no empty-epoch spin**. (Fixes kuro's `3059d8b` edge; carries to V4
> unchanged — DEX-agnostic.)

**REWRITTEN — `settle(address token, address asset, uint256 amountIn, uint256 callerMinOut, uint256 deadline) external
nonReentrant` (blockers 1/4/5) — TWO BRANCHES, `asset ∈ {token(LT), WETH}`:**
- Common: `require(registered[token] && amountIn>0 && (asset==LT || asset==WETH) && amountIn ≤ rawFees[token][asset] &&
  now ≤ deadline)`; `_updateReward(token,0,…)`.
- **WETH raw-leg branch (`asset == WETH`) — reclassify-only (blocker 1; restored):** `rawFees[token][WETH] -= amountIn;
  wethAmt = amountIn;` **no oracle, no `unlock`, no swap, and do NOT change `accountedBalance[WETH]`** — the WETH is
  already accounted; this only moves `amountIn` from the `rawFees` component into the buckets (net-zero on total
  `liability[token][WETH]`, INV-27). Skip to the split with `wethAmt`.
- **LT branch (`asset == LT`) — swap path:**
  - **CEI pre-debit BEFORE the external call (blocker 5):** `rawFees[token][LT] -= amountIn; accountedBalance[LT] -=
    amountIn;` (a callback revert unwinds via tx revert).
  - **Oracle floor:** read the hook TWAP for `poolId` (interpolated, §4c); `require` window-ready else `ORACLE_NOT_READY`;
    `floor = mulDiv(twapQuote(amountIn), 1e4−MAX_SLIPPAGE_BPS, 1e4)`; `minOut = max(floor, callerMinOut)`.
  - **One-shot callback authorization (blocker 5):** store `activeJob = keccak256(poolId, amountIn, minOut, nonce++)`
    before `unlock`; the `unlockCallback` requires `msg.sender == POOL_MANAGER` **and** the decoded job hash `==
    activeJob`, then **clears `activeJob`** (consume once) — an unsolicited/replayed callback reverts (INV-48).
  - **Direct vault→PoolManager swap (blocker 3/4):** `POOL_MANAGER.unlock(abi.encode(job))`. In `unlockCallback`:
  1. `zeroForOne = (LT == currency0)`; `sqrtPriceLimit = zeroForOne ? MIN_SQRT+1 : MAX_SQRT−1` (direction-specific,
     permissive so a fully-liquid swap isn't clipped). `BalanceDelta d = POOL_MANAGER.swap(key, {zeroForOne,
     amountSpecified = −int256(amountIn) /*exact-in*/, sqrtPriceLimit}, "")` — vault is caller ⇒ hook sees
     `sender==vault` ⇒ base fee + volume-excluded, **oracle still updated** (constraint 1).
  2. **Reject partial fills (blocker 4):** `int128 inDelta = LT-leg of d; require(inDelta == −int128(amountIn))` — if
     the swap stopped early (hit the price limit / thin liquidity), the input consumed ≠ `amountIn` → **revert** (do NOT
     transfer/credit a mismatched amount). *(Uniswap warns low-liquidity swaps can return unexpected amounts — IPoolManager.)*
  3. **Settle input exactly:** `POOL_MANAGER.sync(LT); IERC20(LT).safeTransfer(POOL_MANAGER, amountIn);
     uint256 paid = POOL_MANAGER.settle(); require(paid == amountIn);`
  4. **Take output, MEASURE actual receipt (blocker 4):** `int128 outDelta = WETH-leg of d; require(outDelta > 0);`
     `uint256 before = WETH.balanceOf(this); POOL_MANAGER.take(WETH, address(this), uint256(uint128(outDelta)));
     wethOut = WETH.balanceOf(this) − before;` — credit the **measured** balance increase, not the raw delta. All
     currency deltas must be zero before the callback returns.
    - **LT branch only:** `require(wethOut ≥ minOut); accountedBalance[WETH] += wethOut;` (new WETH entered the vault).
- **Shared split on `wethAmt`/`wethOut` (both branches):** `w = (asset==WETH) ? wethAmt : wethOut;` `hydeCut=mulDiv(w,500,
  1e4); holderCut=mulDiv(w,500,1e4); creatorCut=w−hydeCut−holderCut;` `creatorClaimable+=creatorCut; hydeClaimable+=
  hydeCut; holderFunded+=holderCut; _queueReward(token, holderCut)`. **INV-27 per-branch:** WETH branch —
  `accountedBalance[WETH]` **unchanged**, `rawFees[WETH]` −`amountIn`, buckets +`amountIn` (net-zero); LT branch —
  `accountedBalance[LT]` −`amountIn`, `accountedBalance[WETH]` +`wethOut` (measured), buckets +`wethOut`. Emits `Settled`.

## 4c. `HydeHook` (NEW — non-fund-bearing; holds no user funds, takes no fee delta)
**Permissions (mined into the address via CREATE2, §9):** `BEFORE_INITIALIZE | AFTER_INITIALIZE | BEFORE_SWAP |
AFTER_SWAP` = `(1<<13)|(1<<12)|(1<<7)|(1<<6)`. **No** remove-liquidity / donate / returns-delta flags. Immutables:
`FACTORY`, `VAULT`, `POOL_MANAGER`.

**Per-poolId state (blocker 2 — 3-stage one-shot init):** `pending[poolId]{configured, token, schedule, expectedKey}`
(set by the factory) → `staging[poolId]{token, schedule}` (moved in `beforeInitialize`) → `active[poolId]{token,
launchTime, schedule}` (in `afterInitialize`). `swapVolume[poolId]` (WETH, monotonic); a **running** `lastTick[poolId]`
+ `lastObsTs[poolId]` + `lastCumulative[poolId]`; observation ring `obs[poolId][cardinality]{uint32 blockTimestamp,
int56 tickCumulative}` + `ringIndex[poolId]` (`cardinality` = a **manifest floor ≥ enough slots to cover
`TWAP_WINDOW` at the chain's block cadence** — 4663 ~1s blocks ⇒ ≥ ~2048 to safely span 1800s of one-slot-per-block).

- **`beforeInitialize(sender, key, sqrtPrice) → selector` (blocker 2/4):** `require(sender == FACTORY)`;
  `p = pending[poolId(key)]; require(p.configured && key == p.expectedKey && key.hooks == this && currencies == sort(LT,
  WETH) && key.fee == DYNAMIC_FEE_FLAG)`; **stage it:** `staging[poolId] = {p.token, p.schedule}; delete pending[poolId]`.
  (A second/stale/foreign init has no `pending` ⇒ reverts. Tx rollback restores neither ⇒ no stale auth, INV-40.)
- **`afterInitialize(sender, key, tick) → selector`:** `s = staging[poolId]; require(s exists);` activate
  `active[poolId] = {s.token, launchTime = now, s.schedule}; delete staging[poolId]` (consume the staged record — the
  data `afterInitialize` needs is read from `staging`, not from the deleted `pending`); seed the ring:
  `obs[poolId][0] = {now, 0}; lastCumulative = 0; lastTick = tick; lastObsTs = now; ringIndex = 0`.
- **`beforeSwap(sender, key, params, hookData) → (selector, BeforeSwapDelta ZERO, uint24 feeOverride)`:** if `sender ==
  VAULT` ⇒ `feeOverride = baseFee | OVERRIDE_FEE_FLAG`. Else compute the decaying anti-snipe fee with a **branch that
  cannot underflow (blocker 5):** `elapsed = now − launchTime; fee = elapsed >= antiSnipeWindow ? baseFee : baseFee +
  (startFee − baseFee) · (antiSnipeWindow − elapsed) / antiSnipeWindow;` `feeOverride = clamp(fee, baseFee,
  MAX_LP_FEE_CAP) | OVERRIDE_FEE_FLAG`. (Immutable-validated at deploy: `baseFee ≤ startFee ≤ MAX_LP_FEE_CAP`,
  `antiSnipeWindow > 0`; slope is *derived* from `(startFee−baseFee)/antiSnipeWindow`, so no separate slope rounding.)
  Returns ZERO swap-delta (non-fund-bearing).
- **`afterSwap(sender, key, params, BalanceDelta delta, hookData) → (selector, int128 ZERO)`:**
  1. **Oracle update — ALWAYS, incl. `sender == VAULT` (constraint 1):** `dt = now − lastObsTs[poolId];`
     - **if `dt == 0` (same-block, blocker 3/constraint 2): update `lastTick[poolId] = postSwapTick` ONLY** — the ring
       stores `{timestamp, cumulative}` (there is **no** per-slot "tick" field to update), and the cumulative for this
       block is not final until time advances, so **do NOT touch the ring / advance `ringIndex` / consume a slot.** A
       one-block swap-flood therefore can't overwrite history or force `ORACLE_NOT_READY`.
     - **else** (`dt > 0`): `lastCumulative += int56(lastTick) · dt`; `ringIndex = (ringIndex+1) % cardinality;
       obs[poolId][ringIndex] = {uint32(now), lastCumulative}; lastTick = postSwapTick; lastObsTs = now`.
  2. **Volume — SKIP entirely when `sender == VAULT`** (constraint 1/blocker 3). Else extract the WETH-leg from `delta`
     (`int128 w = wethIsC0 ? delta.amount0() : delta.amount1()`) and add its **int128-safe absolute value (constraint
     5):** `uint256 add = w == type(int128).min ? (uint256(uint128(type(int128).max)) + 1) : uint256(uint128(w < 0 ?
     -w : w)); swapVolume[poolId] += add;` — **one** increment per qualifying swap (exact-in & exact-out, both
     directions; a zero WETH leg adds 0). Return `(selector, 0)`. **`beforeSwap`/`afterSwap` are bounded + non-reverting
     on the normal path** (a revert freezes trading; only `beforeInitialize` auth reverts).
- **`consult(poolId, TWAP_WINDOW) view → int24 twapTick` (blockers 3 + 2 — interpolate at the exact target, handle idle
  pools + signed rounding):**
  1. `require(now ≥ TWAP_WINDOW)` (guard before the subtraction). `target = now − TWAP_WINDOW`.
  2. **Synthetic newest bracket (blocker 2 idle-pool):** define the running observation as `o_run = (lastObsTs,
     lastCumulative)` and the synthetic now-point `o_now = (now, cumNow)` where `cumNow = lastCumulative + int56(lastTick)
     ·(now − lastObsTs)`. **If `target ≥ lastObsTs`** (no swap for ≥ the time since `lastObsTs`, i.e. an idle pool), the
     target falls in the open interval after the newest stored obs → **extrapolate at `lastTick`:** `cumTarget =
     lastCumulative + int56(lastTick)·(target − lastObsTs)`.
  3. **Else** wrap-safe search the ring for the two stored observations `o_before.ts ≤ target ≤ o_after.ts`; require
     `o_before` exists and the **oldest retained obs is `≤ target`** (else `ORACLE_NOT_READY` — window not spanned);
     interpolate `cumTarget = o_before.cum + (o_after.cum − o_before.cum)·(target − o_before.ts)/(o_after.ts −
     o_before.ts)` (exact hit ⇒ use it directly).
  4. **Signed mean, round toward −∞ (blocker 2):** `int256 dcum = int256(cumNow) − int256(cumTarget); int24 twapTick =
     int24(dcum / int256(TWAP_WINDOW)); if (dcum < 0 && dcum % int256(TWAP_WINDOW) != 0) twapTick -= 1;` — canonical
     v3-periphery `OracleLibrary` rounding (Solidity's `/` truncates toward zero, which is wrong for negative means).
     Use wide signed intermediates throughout.
  Manipulation resistance = the **window length**; stored ticks are the **actual** post-swap ticks (no capping). The
  vault converts `twapTick`→price for the floor quote. INV-46.

---

## 5. Authority & immutability boundary
| Actor | CAN | CANNOT |
|---|---|---|
| **Anyone** | `launch`($1 USDG), `collect`(zero-liq fee-take→vault), `settle`(TWAP-floored LT→WETH via vault), `roll`, `claim*`, `graduate`, **be an external LP (add/remove freely)** | change recipients/bps/schedule/threshold; move Hyde's LP; mint/burn; extend an epoch; brick trading; count a system swap as volume; front-run pool init |
| **Factory owner** | pause/unpause NEW launches | anything on a live token/LP/fees/hook/vault |
| **Creator / Hyde / Holder** | claim 90% / 5% / vested-5% WETH (fixed recipients) | exceed share; touch others' buckets |
| **`HydeHook`** | set dynamic fee, meter volume, record oracle | hold funds, take a swap delta, block liquidity removal, authorize a non-factory init |
| **`HydeFeeVault`** | settle→WETH, split, pay fixed recipients, run the one system swap | move funds except to the rightful recipient; mutate bps/epoch; hold < liabilities (INV-27) |

## 6. Failure-mode / revert catalog
USDG fee fail / not-constructible; permit fail; `initialize` non-factory or twice or stale/foreign config
(`beforeInitialize`); `collect`/`noteRaw` non-collector or shortfall; `sync` non-registered (and **must not** revert on
the normal path); `settle` deadline/`amountIn==0`/over-rawFees/`ORACLE_NOT_READY`/`wethOut<minOut`/unsettled-delta;
`roll` active-epoch or empty; `claim*` nothing-owed; `graduate` <threshold/twice (currently always `GRADUATION_PENDING`);
paused ⇒ `launch` reverts, live pools unaffected. **A donation does NOT revert/brick `collect` or advance graduation.**

## 7. Threat model (V4)
1. **Unauthorized/stale pool init** → `beforeInitialize` requires `sender==factory` + validates & **consumes** the
   one-shot pending config; predictable CREATE2 pool can't be front-run or re-init'd. INV-40.
2. **Zero-liquidity fee-collect must not brick + external LPs not trapped** → no hook remove-revert; collection is
   `modifyLiquidities(INCREASE 0 + TAKE_PAIR)`. INV-EXT, INV-41.
3. **System-swap authentication** → `sender==vault` ⇒ baseFee + volume-skip **but oracle still updated**; users/router
   carry a different sender. INV-42/43.
4. **Donation/flash exclusion** → volume moves only in `afterSwap` on a non-vault swap; donate/flash never hit it;
   donate→collect→settle does not advance graduation. INV-44.
5. **Oracle** → real-tick time-integrated ring; **same-block coalesced (no slot consumption)** so history can't be
   flushed in one block; wraparound/interpolation/`TWAP_WINDOW` maturity; floor caller-tighten-only. INV-45/46.
6. **Signed-delta safety** → int128-boundary-safe abs of the WETH leg; one increment per qualifying swap, both
   directions, exact-in/out. INV-47.
7. **Unlock/delta completeness + reentrancy** → every `unlock` zeroes all currency deltas or reverts; `collect`/`settle`
   `nonReentrant`+CEI; `unlockCallback` `onlyPoolManager` + only during our own unlock. INV-48.
8. **Hook can't brick swaps** → `beforeSwap`/`afterSwap` bounded, non-reverting; dynamic fee `[baseFee,MAX_LP_FEE_CAP]`.
9. **Hook address/permission mining** → CREATE2 salt so low bits == the §4c flag set, else PoolManager rejects init.
10. **Protocol fee** → V4 governance-settable protocol fee; record + monitor per pool at deploy (manifest).
11. **Custody-lock** → no path moves Hyde's NFT or removes its liquidity; selector-enumerated. INV-4.
12. **90/5/5 solvency + creator paid in WETH** → unchanged vault invariants; creator never paid in LT. INV-17/27.

## 8. Invariant matrix (old→new mapping)
**Carried unchanged (vault/token accounting, DEX-agnostic):** INV-1 (split sums), INV-2 (bps), INV-3 (immutable
recipients), INV-5 (supply constant), INV-6 (max-wallet), INV-13 (pull-measure donation-proof), INV-23 (sync can't
brick), INV-24 (namespace partition), INV-25 (exact epoch conservation), INV-26 (vest math / supply-0 requeue),
INV-27 (cross-namespace solvency + branch-exact settle reclassification), INV-28 (excluded never accrue), INV-29
(epoch JIT resistance), INV-30 (register-before-mint), INV-32 (terminal conservation).
**Re-homed V3→V4:** INV-4 (LP-lock: was NFT-custody+no-path → **now custody-only, no hook-revert**), INV-14 (`collect`
reaches no swap router → **now `collect` = PositionManager fee-take only, no swap**), INV-18 (only the vault swaps →
**now the direct vault→PoolManager unlock swap, sender==vault**), INV-15 (**post-seed: factory & vault hold 0 LT; position holds `dep`; collector holds only the MEASURED residual `dust ≤ MAX_SEED_DUST`, inert**), INV-17 (creator WETH), **INV-27 (settle now branch-exact for BOTH the WETH reclassify leg and the LT swap leg)**.
**NEW (V4):** INV-40 init-auth **pending→staging→active one-shot, rollback leaves no stale auth**; INV-41
zero-liq-collect-not-bricked; INV-EXT external-LP add→remove; INV-42 system-swap baseFee; INV-43 system-swap
oracle-still-updated; INV-44 donation/settle no-graduation-advance; INV-45 same-block coalesce (**only `lastTick`
updated; no ring-slot consumption / history-flush**); INV-46 ring **interpolate-at-target** wraparound/maturity;
INV-47 int128-safe single-increment both directions; INV-48 unlock delta-completeness + **one-shot job-hash callback
auth** (unsolicited/replayed callback reverts); INV-49 **preloaded/donated PoolManager LT cannot seed** (seed must go
through PositionManager's delta; direct transfer to PoolManager is uncredited); INV-50 **settle rejects partial fills**
(input delta must equal `−amountIn`) + credits the **measured** WETH balance increase; INV-51 **oracle idle-pool**
(target past newest obs ⇒ extrapolate at `lastTick`) + **signed mean rounds toward −∞** (canonical OracleLibrary) +
`now ≥ window` guard; INV-52 **seed token-order/tick/amount encoding** (both sort branches) + **`ownerOf(tokenId) ==
COLLECTOR`** + WETH-side == 0 + **MEASURED residual `≤ MAX_SEED_DUST`** (round-up core math, constructor-validated
presets) swept to the exempt collector — the bound is enforced/measured, never asserted from a made-up inverse.

## 9. Deployment / CREATE2 cycle + manifest
- **Cycle:** predict factory address (CREATE2); deploy vault (predicted factory + collector), collector (predicted
  factory + vault), **mine the `HydeHook` salt** so its address bits == the §4c permission flags then deploy it
  (needs factory/vault/PoolManager — resolve via the same predicted-address pattern or a one-shot `initFactory` on
  hook+vault+collector, deployer-only, then locked); deploy factory to the predicted address (with collector/vault/hook).
  Abort on any address mismatch (no init-seizure).
- **Manifest (V4 refresh of `DEPLOY_MANIFEST_4663.md`):** PoolManager/PositionManager/UniversalRouter/Permit2/StateView
  + **official V4Quoter `0x8dc178ef…`** (+ hashes); the **mined HydeHook address + codehash + flag bits**; WETH/USDG +
  decimals; anti-snipe schedule; `graduationThreshold`; `TWAP_WINDOW`/ring cardinality/`MAX_SLIPPAGE_BPS`; per-pool
  `feeProtocol` recorded + monitored; treasuries + owner multisig (clint). gojo/kami co-sign.

## 10. Test / threat matrix (Foundry, fork of 4663 V4)
Carry all preserved vault/token tests (epochs/vest-exactness/solvency/sync/claims/JIT). **New V4 tests (incl. the six
kami 21299 named):**
- **Preloaded-PoolManager seed failure (INV-49):** transferring LT directly to `POOL_MANAGER` before `MINT_POSITION`
  does NOT credit the position (uncredited donation) and the seed still requires the real delta → the shortcut reverts;
  the correct mint-to-factory→Permit2→`MINT_POSITION` path succeeds single-sided (LT only, **WETH settle == 0**), and
  factory/collector/vault LT balances are 0 after (INV-15).
- **pending→staging→active rollback:** valid init consumes `pending`→`staging`→`active`; a **reverting** launch (fail
  after `beforeInitialize`) leaves **no** `pending`/`staging`/`active` (no stale auth); a second/foreign/replayed init
  reverts (INV-40).
- **Off-grid TWAP interpolation (INV-46):** with observations not aligned to `now−TWAP_WINDOW`, `consult` interpolates
  `cumTarget` at the exact target between the bracketing obs; result matches a reference TWAP within rounding; wraparound
  across the ring boundary; `ORACLE_NOT_READY` before the window is spanned.
- **Price-limit partial fill (INV-50):** a `settle` swap that would stop at `sqrtPriceLimit` / on thin liquidity
  (input delta ≠ `−amountIn`) **reverts**; a full-liquidity swap credits the **measured** WETH balance increase, then
  `minOut`.
- **Unsolicited / replayed `unlockCallback`:** a callback with `msg.sender != POOL_MANAGER`, or a job hash ≠ the stored
  one-shot `activeJob`, or a second call reusing a consumed job → reverts (INV-48).
- **Fee decay at/after the window (INV-42, blocker 5):** `elapsed == 0`→`startFee`; `0<elapsed<window`→interpolated,
  never underflows; `elapsed >= window`→exactly `baseFee`; `sender==vault`→`baseFee` at any time; all clamped
  `[baseFee, MAX_LP_FEE_CAP]`.
- **`settle` BOTH branches, branch-exact INV-27 (blocker 1):** WETH raw-leg = reclassify-only (no oracle/unlock,
  `accountedBalance[WETH]` unchanged, buckets +=`amountIn`); LT-leg = swap path; assert solvency after each.
- **Oracle idle-pool + signed rounding (INV-51, blocker 2):** no swap for > window (`target ≥ lastObsTs`) ⇒ extrapolate
  `cumTarget` at `lastTick` (synthetic bracket), TWAP still readable; a **negative-tick remainder** rounds toward −∞
  (assert vs a reference `OracleLibrary` computation); `now < window` ⇒ `ORACLE_NOT_READY`/guarded.
- **Seed both address-sort branches + nonzero-WETH rejection + dust bound (INV-52, blocker 3 / audit-21307):**
  LT-as-currency0 and LT-as-currency1 each seed single-sided with the correct tick/amount encoding; `tokenId ==
  nextTokenId()` and `ownerOf == COLLECTOR`; a range that would require WETH **reverts**. **Range-fuzz / reference-math:**
  compute the expected principal with `SqrtPriceMath.getAmount{0,1}Delta(roundUp=true)` and assert the **measured**
  factory residual matches it and is `≤ MAX_SEED_DUST`; a preset whose residual exceeds `MAX_SEED_DUST` is
  constructor-rejected; the measured residual (not a hard-coded `<2`) is swept to the collector, `factory`/`vault` == 0.
- Plus: zero-liq `collect` succeeds/doesn't brick (INV-41); external LP add→remove (INV-EXT); system swap baseFee +
  volume-unchanged + **oracle-tick-still-advanced** (INV-42/43); donation→collect→settle leaves `swapVolume` unchanged
  (INV-44); volume exact-in/out both directions, one increment, int128-boundary (INV-47); **same-block coalesce** (spam
  N swaps/block ⇒ ≤1 slot consumed, history intact, no forced `ORACLE_NOT_READY`; INV-45); dynamic-fee bounds;
  hook-can't-brick (fuzz swaps); custody-lock selector enumeration (INV-4); protocol-fee monitor.
**Fork lifecycle:** launch LT/WETH dynamic-fee+hook → user swaps (fee decays, volume+oracle meter) → `collect` →
`settle` (sender==vault base-fee, TWAP floor) → `claim*` over epochs → threshold → `graduate`. Slither triage; gas
snapshot incl. per-swap `afterSwap` + per-transfer `sync`; **hook address-mining rehearsed**.

## 11. Changelog
- **2026-07-14 rev7 (V4):** full re-architecture to Uniswap V4 per clint 21289 / kami 21290–21296. Own `HydeHook`
  (dynamic anti-snipe fee + swap-only WETH volume graduation + real-tick observation-ring oracle) feeding an unchanged
  `HydeFeeVault`; custody-only LP-lock; V4 `collect`/`settle`; factory pool init + one-shot hook auth. Folds kami 21296
  constraints 1–5 (oracle-updates-on-system-swap, same-block coalesce, no-Permit2-in-vault, atomic one-shot init-auth,
  int128-safe volume). Vault/token accounting preserved from `04f3f66`. rev1–rev6 (V3) retired.
