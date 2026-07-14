# Hydeout Own-Stack — Level-3 Contract Spec & Threat Model

**Status:** BUILD SPEC — decisions locked, ready for kami audit → then kuro implements.
**Author:** gojo (senior protocol) · **Reviewer gate:** kami · **Builder:** kuro · **Date:** 2026-07-14 (rev5: WETH vault + kami audit-21263 fixes)
**Parent:** `PROTOCOL_PLAN.md` (Level-2). This doc pins the contract interfaces, invariants, and tests.
**Build path:** contract workspace under `D:\agentmanagerworks\` (kami 21085) — never in a shared app tree.

> "Checked for bugs" = layered testing + independent review, **never** a claim any contract is bug-free
> (kami). No public deploy / no push until review passes + a second independent review.

> **REV5 2026-07-14 — kami audit 21263 fixes (3).** (1) **Own-stack pools LOCKED to LT/WETH** (not "preferred") —
> USDG stays launch-fee-only; fee assets are exactly LT + WETH; the one pinned route is **LT→WETH direct at
> `feeTier`**; any other numéraire/route is **rejected at factory construction + register**. (2) **`settle` is an
> exact liability RECLASSIFICATION** (audit-21263 pt.2): the WETH leg only reclassifies existing accounted WETH into
> buckets (no total change); the LT leg decrements the LT ledger by `amountIn` and increments the WETH ledger by the
> **measured** `wethAmt`, then splits — so INV-27 can't break via double-credit or phantom LT liability. (3) **Non-
> extendable fixed epochs** replace the resettable Synthetix stream (audit-21263 pt.3): a `settle` during an active
> epoch **queues its holder cut for the *next* epoch and never moves the current `epochFinish`**; the next epoch
> rolls only **after** the current ends; **exact `mulDiv` vesting** from `epochAmount`+elapsed vests 100% at finish
> (no rate-division carry); `roll` requires no active epoch + nonzero queued — killing the tiny-top-up / empty-flush
> extension grief. Per-token Hyde buckets **approved**; donation-proof pull, ORACLE_NOT_READY, permissionless TWAP,
> Blockscout proxy **passed** (unchanged). Graduate/threshold + kuro's build stay held; amended → new SHA.

> **REV4 2026-07-14 — WETH fee settlement (clint 21255 → kami 21256).** Fees settle in **WETH**; `collect` is
> swap-free & split-free; a separate TWAP-guarded `settle` converts→WETH then splits **90/5/5**; **creator & Hyde =
> pull-based WETH claim buckets, only holders stream**; launch fee stays **USDG**. rev1–rev3 USDG design superseded.

---

## 0. Locked decisions (clint/kami 2026-07-13 → 2026-07-14)
> **Deployment-blocking manifest pins:** immutable `SETTLEMENT_TOKEN` (= WETH = wrappedNative), the LT/WETH
> `feeTier`, `hydeoutTreasury`, epoch `DURATION` / `MAX_SLIPPAGE_BPS` / `TWAP_WINDOW`, and the launch-fee `stablecoin`
> (USDG) **must be fixed in the reviewed manifest before any deploy.**

- **Fee split (own-stack): 90% creator / 5% Hyde / 5% holder rewards**, **settled in WETH** — immutable
  `hydeBps=500`, `holderBps=500`, `creatorBps` = remainder `9000`, `sum==1e4` (clint 21255; kami 21256). Split
  executes in **`settle`**.
- **Own-stack pools are LOCKED to LT/WETH (audit-21263 pt.1).** WETH (`wrappedNative`) is the sole numéraire; the
  fee assets are exactly **{LT, WETH}**; graduation progress is WETH-denominated; the settle route is the
  unambiguous **LT→WETH direct hop at `feeTier`**. **Any other numéraire/route is rejected at factory construction +
  `register`** — not merely discouraged. USDG is **launch-fee-only**, never a pool numéraire.
- **`collect` is swap-free & split-free (kami 21256).** It only collects the raw V3 fee assets and `noteRaw`s them
  into the vault — no creator transfer, no router, no split (INV-14/18).
- **`settle` — separate, permissionless, TWAP-floor + `ORACLE_NOT_READY` guarded.** WETH leg: no swap. LT leg:
  swap LT→WETH via the pinned route. Then splits the WETH **90/5/5** with **exact liability reclassification**
  (audit-21263 pt.2).
- **Creator & Hyde = pull-based WETH claim buckets; holders vest via NON-EXTENDABLE FIXED EPOCHS (audit-21263
  pt.3).** Each holder distribution funds the **next** epoch; the current epoch's `epochFinish` never moves; exact
  `mulDiv` vesting reaches 100% at finish. This closes JIT sniping *and* the permissionless stream-extension grief.
- **`HydeERC20` has NO burn.** Supply **constant 1e9 forever**. Creator paid in **WETH** (never the launch token) →
  the old `from==COLLECTOR` max-wallet bypass is gone (§2).
- **Launch fee: $1 flat in USDG**, atomic, before deploy — unchanged; USDG used only for the launch fee.
- Graduation: **Option A — permanently locked LP** (label only). Threshold still open (§9); deploy-blocked.
- Anti-snipe: **(b) time-boxed max-wallet**, expires; never permanent.
- Supply: **1B, 100% to the launch pool**.

---

## 1. System topology
- **`HydeERC20`** — verified impl, EIP-1167-cloned per launch. No owner/mint/burn/blacklist/pause. Transfer path
  calls the vault's `sync`.
- **`HydeTokenFactory`** — permissionless `launch`; charges $1 **USDG**, deploys+inits the clone, seeds the
  single-sided **LT/WETH** V3 LP (+ bumps oracle cardinality), registers with collector + vault. Owner = future-
  launch config only.
- **`HydeFeeCollector`** — custodies each V3 NFT **forever** (locked LP by absence of any withdraw path);
  permissionless `collect` **harvests raw fees → vault (swap-free, split-free)**; permissionless `graduate` = label.
- **`HydeFeeVault`** — shared singleton, per-token accounting: holds raw fees until `settle` converts→WETH and splits
  90/5/5 into the creator/Hyde claim buckets + the holder **epoch** vesting; global `accountedBalance[asset]`
  solvency; pull-based `claimCreator`/`claimHyde`/holder `claim`; the token-driven `sync`.

Deps: Uniswap V3 (with pool oracle), WETH, USDG (launch fee only), a swap router (settle only).

---

## 2. `HydeERC20` (implementation, cloned)

No owner/mint/burn/blacklist/pause; **supply constant 1e9** (INV-5). Immutable once-set storage: `name/symbol`,
`TOTAL_SUPPLY`, `maxWallet`, `maxWalletExpiry`, `VAULT`, and the **frozen infra `exempt` set** (pool/PM/factory/
collector/vault/router/`0`) used for BOTH max-wallet exemption AND reward-ineligibility. No `setExempt`.
`isRewardExcluded(a) → exempt[a]` (public view).

**`initialize`** — `initializer`+`onlyFactory`, same-tx from the factory. Sets the exempt set + `VAULT` **then**
mints 100% to the pool (mint-`sync` accepted because the factory registered the token in the vault at §3 step 3, and
`exempt[pool]` is already true). Bounds asserts: zero `poolRecipient`/`vault`, `maxWalletBps ∉ (0,300]`,
`maxWalletWindowSecs ∉ (0,3600]` → revert.

**Transfer `_update(from, to, amount)`:** (1) `to == 0` reverts (`ZERO_TO`; supply constant). (2) **before balances
change:** `VAULT.sync(from, to, balanceOf(from), balanceOf(to), amount, exempt[from], exempt[to])` — `onlyToken`,
pure arithmetic, no external calls, **non-revert on the normal path** (INV-23). (3) max-wallet: `if (block.timestamp
< maxWalletExpiry && !exempt[to]) require(balanceOf(to) + amount <= maxWallet);` — recipients only, expiry immutable.
**No `from==COLLECTOR` bypass** — creator is paid in WETH; the collector's only LT outflow is to the `to`-exempt
vault, which skips the cap without a bypass. (4) balance update + `Transfer`.

---

## 3. `HydeTokenFactory`

**Owner:** only `pause`/`unpause` NEW launches. All economic config immutable.

**Immutables:** `IMPL`, `COLLECTOR`, `VAULT`; `stablecoin` (= USDG, **launch fee only**), `launchFeeAmount`,
`supportsPermit`, `launchFeeTreasury`, `uniV3Factory`, `positionManager`, `swapRouter`, `wrappedNative` (= WETH =
vault `SETTLEMENT_TOKEN`), `feeTier` (the LT/WETH tier), `maxWalletBps`, `maxWalletWindowSecs`,
`graduationThreshold`, oracle-cardinality target. Split legs (`hydeoutTreasury`, `hydeBps`, `holderBps`) + epoch
params (`DURATION`, `MAX_SLIPPAGE_BPS`, `TWAP_WINDOW`) live on the **VAULT**. `creatorBps` = remainder.
**Chain-gate:** `stablecoin == 0 || launchFeeAmount == 0 || wrappedNative == 0` **cannot construct.**

**External:** `launch`/`launchWithPermit` (`nonReentrant`); `LaunchParams = { name, symbol, preset }`, **`creator :=
msg.sender`.** Owner: `pause`/`unpause`.

**`launch` ordering (single tx — all-or-revert):**
1. `_chargeLaunchFee(msg.sender)` — FIRST, **USDG** `SafeERC20` + `require(received == launchFeeAmount)`.
2. `_deployClone()` — deterministic salt `keccak256(msg.sender, symbol, nonce++)` → `token`.
3. **`VAULT.register(token, msg.sender /*creator*/)` — `onlyFactory`, BEFORE `initialize`.** Marks the token
   `sync`-authorized, records immutable `creator`, opens the namespace. **The settle route is fixed (LT→WETH direct
   at `feeTier`) — there is no route param to supply or validate** (audit-21263 pt.1): the pool is LT/WETH by
   construction, so the route is deterministic. (Live pool + TWAP maturity checked at `settle`.)
4. `token.initialize(...)` — guarded; sets exempt set + `VAULT`, **then** mints 1B to the pool (mint-`sync`
   accepted; pool excluded).
5. `_seedLiquidity()` — the pool is **LT paired with WETH** at `feeTier` (**reject/impossible for any other
   numéraire** — the factory only ever seeds LT/WETH); create+init if absent; **increase observation cardinality**
   (allocates slots — does NOT backfill; `settle` stays `ORACLE_NOT_READY` until a full `TWAP_WINDOW` accrues); mint
   the single-sided position `recipient = COLLECTOR` via the callback-payer flow. **After `mint`, factory/collector/
   vault hold 0 LT** (INV-15). Revert ⇒ whole `launch` reverts incl. step-3 register (INV-7/30).
6. `COLLECTOR.register(token, msg.sender, tokenId, WETH /*numeraire*/, graduationThreshold)` — `onlyFactory`;
   asserts `numeraire == WETH` (INV-31/34).
7. Emit `LaunchFeePaid` + `LaunchCreated`.

---

## 4. `HydeFeeCollector`

**Immutables:** `FACTORY`, `VAULT`, `POSITION_MANAGER`. (Split legs live on the vault.)

**Deployment cycle:** CREATE2 predict factory → deploy vault (predicted factory) → collector (predicted factory +
vault) → factory (collector + vault) at the predicted address; abort if mismatch. Fallback: one-shot `initFactory`
on both, deployer-only, then locked.

**Custody / LP-lock:** holds the V3 NFT forever; `positionOf[token] = {registered, graduated, creator, tokenId,
numeraire(==WETH), graduationThreshold}`; only mutable = one-way `graduated` + monotonic `graduationProgress`. **No
withdraw/decrease/transfer/approve/generic-call path; no owner** (INV-4/14).

**External:**
- `collect(address token) external nonReentrant` — **permissionless, SWAP-FREE, SPLIT-FREE.** `positionManager.collect
  (recipient=this)` → for each of {LT, WETH} with `amt>0`: `forceApprove(asset, VAULT, amt); VAULT.noteRaw(token,
  asset, amt); forceApprove(asset, VAULT, 0);` (vault pulls+measures). `graduationProgress[token] += <WETH amount
  collected>` (monotonic; INV-20). Atomic; revert on any `noteRaw` failure. **No router, no split, no creator
  payout.** Emits `FeesCollected(token, amtLT, amtWETH)`.
- `graduate(address token) external` — permissionless; `require(!graduated && graduationProgress ≥ threshold)`; no
  liquidity moves. **Stubbed to revert `GRADUATION_PENDING`** until the threshold is pinned (kami). Unchanged.

---

## 4b. `HydeFeeVault` (WETH settlement + claims + NON-EXTENDABLE-EPOCH holder vesting)

**Model.** Shared singleton, per-token. Holds raw fees until permissionless **`settle`** converts them to WETH
(LT→WETH swap for the LT leg; direct for the WETH leg) and splits WETH **90/5/5** into: the **creator claim bucket**,
the **Hyde claim bucket**, and the **holder epoch**. Creator & Hyde are pull-based; **holders vest over
non-extendable fixed epochs of length `DURATION`** (audit-21263 pt.3). O(1), no holder loops.

**Immutables:** `SETTLEMENT_TOKEN` (= WETH), `COLLECTOR`, `FACTORY`, `SWAP_ROUTER`, `feeTier` (LT/WETH), WETH pool
oracle inputs, `hydeoutTreasury`, `hydeBps(==500)`, `holderBps(==500)`, `DURATION` (**epoch length; default 7 days**),
`MAX_SLIPPAGE_BPS` (**default 300**), `TWAP_WINDOW` (**default 1800s**), `PRECISION = 1e30`. Constructor asserts all
non-zero, `hydeBps==500 && holderBps==500 && hydeBps+holderBps<1e4`, `MAX_SLIPPAGE_BPS<1e4`. **All math full-precision
`mulDiv`.**

**Per-token state:**
| field | meaning |
|---|---|
| `registered[token]`, `creator[token]` | set once by `onlyFactory register` |
| `rawFees[token][asset]` | un-settled raw V3 fees (asset ∈ {LT, WETH}) |
| `creatorClaimable[token]`, `hydeClaimable[token]` | **WETH** owed to creator / Hyde (claim any time) |
| `epochAmount[token]`, `epochStart[token]`, `epochFinish[token]` | the current holder epoch (`epochFinish = epochStart + DURATION`), vests by exact `mulDiv` |
| `nextEpochAmount[token]` | WETH queued for the **next** epoch (from settles during the active epoch + zero-supply re-queues) — **never extends the current epoch** |
| `lastUpdateTime[token]`, `rewardPerTokenStored[token]` | the holder claim-index checkpoint |
| `totalEligibleSupply[token]`, `userRewardPerTokenPaid[token][h]`, `rewards[token][h]` | eligible supply, per-holder anchor, crystallized WETH owed |

**Derived liability (NOT separately tracked — audit-21263 pt.2):** `accountedBalance[asset]` is the sole explicitly-
tracked ledger. Per-token liability is **derived** from the component maps:
`liability[token][LT] = rawFees[token][LT]`;
`liability[token][WETH] = rawFees[token][WETH] + creatorClaimable[token] + hydeClaimable[token] + holderReserve[token]`,
where `holderReserve[token] = nextEpochAmount + (epochAmount − vestedSoFar) + Σ_h rewards[h]`. **Cross-namespace
solvency (INV-27):** for every asset `balanceOf(this) >= accountedBalance[asset] == Σ_token liability[token][asset]`.

**Global custody — PULL-and-MEASURE (donation-proof).** `noteRaw` (`onlyCollector`) does `before = balanceOf(this);
safeTransferFrom(COLLECTOR, this, amount); received = balanceOf(this) - before; require(received == amount);
accountedBalance[asset] += received; rawFees[token][asset] += received;`. A donation can't brick it (delta-measured);
a fee-on-transfer shortfall reverts. `settle`'s swap output is measured the same way. `accountedBalance` is **never**
gated on ambient balance.

**Epoch vesting math (exact `mulDiv`, no rate-carry):**
- `_maybeRoll(token)` (internal): `if (now >= epochFinish[token] && nextEpochAmount[token] > 0) { epochAmount =
  nextEpochAmount; nextEpochAmount = 0; epochStart = now; epochFinish = now + DURATION; lastUpdateTime = now; }` —
  rolls a new epoch **only after the current one ends** (never resets an active epoch's clock).
- `_updateReward(token, acct, bal, excl)` (before every balance change + before claim/settle):
  `t1 = min(now, epochFinish[token]); newlyVested = (t1 > lastUpdateTime[token]) ? mulDiv(epochAmount[token], t1 -
  lastUpdateTime[token], DURATION) : 0;` **vests by exact elapsed fraction** →
  `if (totalEligibleSupply[token] > 0) rewardPerTokenStored += mulDiv(newlyVested, PRECISION, totalEligibleSupply);
  else nextEpochAmount[token] += newlyVested;` (**zero-supply vest is re-queued, never lost**); `lastUpdateTime = t1;`
  then `_maybeRoll(token);` then `if (acct != 0) { if (!excl) rewards[acct] = mulDiv(bal, rewardPerTokenStored -
  userRewardPerTokenPaid[acct], PRECISION) + rewards[acct]; userRewardPerTokenPaid[acct] = rewardPerTokenStored; }`.
  Because vesting is `epochAmount·elapsed/DURATION` computed directly, at `epochFinish` **exactly `epochAmount` has
  vested — no stranded rate-division carry** (audit-21263 pt.3).

**Functions:**
- `sync(from, to, balFrom, balTo, amount, fromExcl, toExcl)` — `require(registered[msg.sender])`. `_updateReward` for
  both accounts (settling against the pre-change supply), apply the eligible-supply delta. Pure arithmetic, no
  external calls, **non-revert on the normal path** (INV-23). *(No positive→zero special-case needed: the zero-supply
  vest re-queue in `_updateReward` already prevents loss; the epoch clock is wall-time and non-extendable, so nothing
  to pause.)*
- `noteRaw(token, asset, amt)` — `onlyCollector`, pull-and-measure into `rawFees` (above).
- `settle(token, asset, amountIn, callerMinOut, deadline) external nonReentrant` — **permissionless, TWAP-floor +
  oracle guarded — the ONLY swap.** `require(registered[token] && amountIn > 0 && amountIn <= rawFees[token][asset]
  && (asset == SETTLEMENT_TOKEN || asset == LT) && now <= deadline)`. `_updateReward(token, 0, 0, false)` first.
  - **WETH leg (`asset == WETH`) — pure reclassification (audit-21263 pt.2):** `rawFees[token][WETH] -= amountIn;`
    `wethAmt = amountIn;` **do NOT touch `accountedBalance[WETH]`** (the WETH is already accounted; we only move it
    from the `rawFees` component of the derived liability into the buckets below — total `liability[token][WETH]`
    unchanged).
  - **LT leg (`asset == LT`):** `rawFees[token][LT] -= amountIn; accountedBalance[LT] -= amountIn;` (LT leaves for the
    router). **Oracle-ready gate:** the LT/WETH pool's oldest observation must be ≥ `TWAP_WINDOW` old, else revert
    `ORACLE_NOT_READY`. `floor = mulDiv(TWAP(LT→WETH, amountIn, TWAP_WINDOW), 1e4 - MAX_SLIPPAGE_BPS, 1e4); minOut =
    max(floor, callerMinOut);` `forceApprove(LT, SWAP_ROUTER, amountIn); before = balanceOf(WETH); exactInput(LT→WETH
    @feeTier, recipient=this, minOut); wethAmt = balanceOf(WETH) - before; require(wethAmt >= minOut);` reset
    allowance; `accountedBalance[WETH] += wethAmt;` (new WETH enters, apportioned below).
  - **Split `wethAmt` 90/5/5 (both legs):** `hydeCut = mulDiv(wethAmt, hydeBps, 1e4); holderCut = mulDiv(wethAmt,
    holderBps, 1e4); creatorCut = wethAmt - hydeCut - holderCut;` `creatorClaimable[token] += creatorCut;
    hydeClaimable[token] += hydeCut; _queueReward(token, holderCut);`. (WETH leg: the `-= amountIn` on `rawFees` and
    the `+= (creatorCut+hydeCut+holderCut == amountIn)` on the buckets net to **zero** change in `liability[token]
    [WETH]` — a pure reclassification, INV-27 holds. LT leg: `accountedBalance[WETH] += wethAmt` matches the bucket
    increments, and `accountedBalance[LT] -= amountIn` matches `rawFees[LT]` — no phantom liability.) Emits
    `Settled(token, asset, amountIn, wethAmt, creatorCut, hydeCut, holderCut)`. **Permissionless-TWAP — no silent
    keeper.**
- `_queueReward(token, amt)` (internal, from settle): `nextEpochAmount[token] += amt; _maybeRoll(token);` — a settle
  during an **active** epoch just accumulates `nextEpochAmount` (does NOT touch `epochFinish`); the FIRST settle (no
  active epoch) rolls immediately and starts epoch 1.
- `roll(address token) external` — **permissionless.** `require(now >= epochFinish[token] && nextEpochAmount[token] >
  0); _updateReward(token, 0, 0, false);` (which `_maybeRoll`s). Lets anyone start the next epoch once the current
  ends. **Guarded so it CANNOT reset an active epoch (`now >= epochFinish`) nor spin an empty epoch (`nextEpochAmount
  > 0`)** — this is the fix for the flush/extension grief (audit-21263 pt.3).
- `claim(token[, holder]) external nonReentrant` — **holder vested WETH.** `_updateReward(token, holder,
  balanceOf(holder), isRewardExcluded(holder)); owed = rewards[token][holder]; require(owed>0); rewards=0;
  accountedBalance[WETH] -= owed; WETH.safeTransfer(holder, owed);` — CEI, O(1), rounds down. Third party may trigger;
  funds go to `holder`.
- `claimCreator(token)` / `claimHyde(token) external nonReentrant` — **WETH to the immutable `creator[token]` /
  `hydeoutTreasury`.** `owed = creatorClaimable/hydeClaimable; require(owed>0); zero it; accountedBalance[WETH] -=
  owed; WETH.safeTransfer(recipient, owed);`. (Anyone triggers; funds to the fixed recipient.) **For one-tx treasury
  collection, the vault inherits `Multicall` so a keeper can batch `claimHyde(tokenA..N)` — same accounting, no
  model change (kuro 21262).**

**Immutable invariants:** all vault immutables + per-token `registered`/`creator` have no setter. No admin/owner
function; no path moves an asset except the three claims (to fixed recipients) and the exact router allowance during
`settle` (reset to 0 same-call).

---

## 5. Authority & immutability boundary
| Actor | CAN | CANNOT |
|---|---|---|
| **Anyone** | `launch` ($1 USDG), `collect` (harvest→vault, swap-free), `settle` (oracle+TWAP-floored LT→WETH, 90/5/5), `roll` (start next epoch after the current ends), `claim`/`claimCreator`/`claimHyde` (WETH to fixed recipient), `graduate` | change any recipient/bps/route/epoch, move LP, mint/burn, loosen the settle floor, **extend an active epoch**, redirect a claim, drain fees |
| **Factory owner** | pause/unpause NEW launches — nothing else | change fee/stablecoin/treasury/bps/settlement/epoch params; touch a live token/LP/fees/accounting; unlock LP; extend max-wallet; add an exemption; seize; force/redirect settle/claim |
| **Creator** | receive **90% WETH** via `claimCreator`; immutable recipient; normal epoch-eligible holder for LT they buy | change recipient; touch LP; mint; preferential eligibility |
| **Holder** | receive **epoch-vested WETH**; `claim` any time | accrue while excluded; claim more than vested `earned` |
| **Hyde** | receive **5% WETH** via `claimHyde` → `hydeoutTreasury` | exceed 5%; touch other buckets/LP |
| **Token** | ERC-20 + permit; max-wallet during window; drive `sync` | mint/burn (**supply constant**); pause/blacklist |
| **Vault** | settle→WETH, hold buckets/epoch, pay fixed recipients, run the one TWAP swap | move an asset but to its rightful recipient; mutate bps/recipients/epoch; touch LP/NFT; hold < liabilities (INV-27) |

**Global immutability (fuzz):** no reachable function alters price/range/threshold/creator/treasury/`hydeBps`/
`holderBps`/`SETTLEMENT_TOKEN`/epoch params, moves/reduces LP, extends the max-wallet window, **or extends an active
epoch**. Supply constant.

---

## 6. Failure-mode / revert catalog
- USDG launch fee fails / stablecoin unset / `launchFeeAmount==0` / `wrappedNative==0` → **revert** (nothing created
  / not constructible).
- Non-2612 / expired / replayed permit → **revert.**
- `initialize` twice / non-factory → **revert.** `VAULT.register` **must precede** `initialize` (else mint-`sync`
  reverts; INV-30). `COLLECTOR.register` with `numeraire != WETH` → **revert** (audit-21263 pt.1; INV-34).
- `collect`/`noteRaw` fails, `noteRaw` from non-collector, or pull-measure `received != amount` → **revert.** A
  **donation** does NOT brick `noteRaw`/`collect`.
- `sync` from a non-registered token → **revert.** Normal-path `sync` **must not revert** (anti-invariant).
- `settle`: past `deadline`, `amountIn==0`, over `rawFees`, `asset ∉ {LT, WETH}`, **`ORACLE_NOT_READY`**, or `wethAmt
  < minOut` → **revert.**
- `roll`: **active epoch (`now < epochFinish`)** or **zero `nextEpochAmount`** → **revert** (no clock reset / no empty
  epoch; audit-21263 pt.3).
- `claim`/`claimCreator`/`claimHyde` with nothing owed → **revert**; never underflows `accountedBalance`.
- `graduate` before threshold / twice → **revert** (currently always `GRADUATION_PENDING`).
- Paused → `launch` reverts; live tokens unaffected (still `collect`/`settle`/`roll`/`claim`).

---

## 7. Threat model (attack → mitigation)
1. **Creator-share theft / fee redirect** → collector owns the NFT; `creator`/`hydeoutTreasury` immutable; claims go
   only to the fixed recipient regardless of caller. INV-3.
2. **LP rug** → no decrease/withdraw/transfer path; no admin. INV-4.
3. **Free-launch / fee bypass** → USDG fee first, revert-on-fail, chain-gate. INV-8.
4. **Reentrancy** → `collect` (CEI+`nonReentrant`, no swap, `noteRaw` pull-measure); `settle`/`claim*`
   (`nonReentrant`+CEI; settle's LT→pool swap re-enters only `sync`, a no-op on the excluded pair); `sync` (no
   external calls). INV-11, INV-23.
5. **Max-wallet trap** → time-boxed, expiry immutable, selling never restricted. INV-6.
6. **Init front-run / re-init** → `initializer` + `onlyFactory` + deterministic salt. INV-10.
7. **Rounding/dust / vest stranding** → creator = remainder (exact 5% legs); **epoch vests by exact `mulDiv`
   (`epochAmount·elapsed/DURATION`) → 100% at `epochFinish`, no rate-carry**; the zero-eligible-supply vest is
   **re-queued into `nextEpochAmount`** (never lost); claims round down. INV-1, INV-25, INV-32.
8. **bps escalation** → `hydeBps`/`holderBps` immutable, capped 500 (creator ≥ 9000). INV-2.
9. **Owner overreach onto live tokens** → owner = future-launch config only. INV-9, INV-12.
10. **Snipe on pool init** → single-sided seed at a fixed preset tick; max-wallet caps opening accumulation.
11. **Griefing `collect`/`settle`/`claim*`/`graduate`/`roll` spam** → idempotent-safe; harmless (see also 20).
12. **Fee-conversion MEV / sandwich (why swap-free `collect`)** → `collect` no swap. The only swap is `settle`,
    **oracle-gated** (`ORACLE_NOT_READY` until a full `TWAP_WINDOW` matures; cardinality allocated-not-backfilled) +
    **TWAP-floored** (immutable `MAX_SLIPPAGE_BPS`, caller may only tighten), pinned **LT→WETH** route. INV-18.
13. **Accounting corruption / cross-token bleed / donation-DoS** → state keyed by `token`; `sync` `onlyToken`;
    `noteRaw` `onlyCollector` + pull-and-measure (no ambient gate). INV-24, INV-13.
14. **JIT reward-sniping** → only the **holder 5% vests over an epoch `DURATION`**; a JIT buyer earns ≈ `t/DURATION`
    and eats V3 fees + slippage in/out. Creator/Hyde buckets have no JIT surface. INV-29.
15. **Transfer-hook DoS (brick via `sync`)** → `sync` = arithmetic, no external calls, non-reverting. INV-23.
16. **Precision/overflow** → `PRECISION=1e30` + full-precision `mulDiv`; `totalEligibleSupply==0` ⇒ vest re-queues
    (no div-by-zero/spike). INV-26.
17. **Vault insolvency / cross-namespace drain** → `accountedBalance[asset]` measured-delta ledger; **settle is an
    exact reclassification** (WETH leg net-zero; LT leg LT−amountIn / WETH+wethAmt); `balanceOf ≥ accountedBalance ==
    Σ derived liabilities` for every asset after ANY interleaving. INV-27.
18. **Launch atomicity incl. vault register** → `VAULT.register` at step 3; later revert unwinds it same-tx. INV-30.
19. **Creator paid in a held/illiquid asset** → creator receives **WETH only**; no max-wallet interaction, no launch-
    token dump pressure; the old collector→creator LT transfer + its bypass are eliminated. INV-17.
20. **Permissionless stream-EXTENSION grief (audit-21263 pt.3)** → **non-extendable fixed epochs.** A `settle` during
    an active epoch queues its holder cut for the **next** epoch and **never moves `epochFinish`**; `roll` requires
    `now >= epochFinish` (can't reset an active epoch) **and** `nextEpochAmount > 0` (can't spin an empty epoch). So
    an attacker spamming tiny `settle`/`roll` every block **cannot postpone the current epoch's vesting** — it always
    completes on schedule. INV-34.

---

## 8. Invariant / property test matrix (Foundry — fuzz ≥256 runs, invariant campaigns)
| # | Invariant | Kind |
|---|---|---|
| INV-1 | `settle` split: `creatorCut + hydeCut + holderCut == wethAmt`; `creatorCut == wethAmt - mulDiv(wethAmt,500,1e4)*2` (remainder); creator never underpaid | property + fuzz(amount, decimals) |
| INV-2 | `hydeBps==500 && holderBps==500`; `creatorBps==9000`; no path raises a 5% leg | invariant |
| INV-3 | `creator[token]`, `hydeoutTreasury`, bps, `SETTLEMENT_TOKEN`, epoch params unchanged by ANY call; claims always pay the fixed recipient regardless of caller | invariant (fuzz calldata + caller) |
| INV-4 | position liquidity never decreases; NFT never leaves collector | invariant |
| INV-5 | `totalSupply == 1e9*1e18` at launch AND forever; no mint AND no burn path | property + invariant |
| INV-6 | max-wallet blocks recipient over cap iff `now < expiry`; never after; never blocks `from`; expiry immutable | property + fuzz |
| INV-7 | any revert in `launch` ⇒ no token/pool/collector-registry/vault-namespace/state persisted | property (fail-injection) |
| INV-8 | exactly `launchFeeAmount` USDG moved creator→treasury once per launch; zero on revert | property |
| INV-9 | no owner selector alters a live token's params/LP/fees/accounting | invariant (owner-as-adversary) |
| INV-10 | `initialize` once; second call / non-factory reverts | unit |
| INV-11 | reentrant asset cannot double-spend/corrupt state in `launch`/`collect`/`settle`/`claim*` | property (reentrancy mock) |
| INV-12 | factory economic config immutable; owner's only state-change is pause/unpause | invariant |
| INV-13 | `noteRaw`/`settle` **pull-and-measure**: fee-on-transfer shortfall reverts; a **donation** doesn't revert/brick; no namespace over/short-credited | property (FoT + donation mocks) |
| INV-14 | selector enumeration: no collector selector reaches `positionManager.{transferFrom,decreaseLiquidity,burn,approve}` or a swap router; `collect` reaches no router | invariant / static |
| INV-15 | after `_seedLiquidity`, factory/collector/vault each hold 0 LT | property |
| INV-16 | `creator == msg.sender` every launch; no path charges another wallet | property |
| INV-17 | the collector's ONLY LT outflow is to the `to`-exempt vault; no fee path pays the creator in LT; max-wallet never blocks fee handling | property |
| INV-18 | **only `settle` swaps**; `nonReentrant`, pinned **LT→WETH** route, reverts `ORACLE_NOT_READY` until a full `TWAP_WINDOW`, `minOut = max(TWAP-floor, callerMinOut)` (tighten-only), resets allowance, touches no LP; `collect` reaches no router | invariant/static + property (price-manip vs floor; new-pool before/after window) |
| INV-19 | *(retired — buyback burn; no burn; folded into INV-5)* | — |
| INV-20 | `graduationProgress` (WETH) monotonic; `collect` only advances it; `graduate` one-way iff ≥ threshold | invariant |
| INV-21 | `_transfer` reverts on `to==0`; no transfer changes `totalSupply` | unit + property |
| INV-22 | `initialize` reverts on zero poolRecipient/vault or out-of-range maxWallet params | unit |
| INV-23 | **`sync` never reverts on the normal path** (no external calls; `mulDiv`/checked); reverts ONLY for a non-registered caller | property + anti-invariant |
| INV-24 | reward/fee state strictly partitioned by `token`; non-registered `sync` reverts; `noteRaw` `onlyCollector` | invariant (rogue-token-as-adversary) |
| INV-25 | **exact conservation:** `Σ_h rewards[h] + (epochAmount − vestedSoFar) + nextEpochAmount + creatorClaimable + hydeClaimable + Σ_asset rawFees(in-kind) == (Σ noteRaw'd in-kind) − (Σ LT settled) + (Σ settled WETH) − (Σ claimed)`, EXACTLY; **no rate-carry residue** (exact `mulDiv` vesting) | invariant (fuzz collect/settle/transfer/claim/roll/time-warp) |
| INV-26 | `rewardPerTokenStored` monotonic; `mulDiv` never overflows across fuzzed supplies/amounts/`Δt`; `totalEligibleSupply==0` ⇒ the vest is **re-queued into `nextEpochAmount`** (no div-by-zero, none lost) | invariant + fuzz(supply crossing 0) |
| INV-27 | **cross-namespace solvency + exact reclassification:** WETH-leg settle leaves total `accountedBalance[WETH]`/derived-`liability[WETH]` **unchanged** (reclassify only); LT-leg settle does `accountedBalance[LT]-=amountIn`, `accountedBalance[WETH]+=wethAmt`; `balanceOf(this) >= accountedBalance[asset] == Σ_token liability[token][asset]` after ANY interleaving | invariant (multi-namespace, **per-branch** settle + donation as adversary) |
| INV-28 | excluded/infra addresses never accrue; `totalEligibleSupply` excludes them, tracks pool↔holder flows exactly | property + invariant |
| INV-29 | **epoch JIT resistance:** a wallet holding `b` for `t ≤ DURATION` of an epoch `E` earns `≤ mulDiv(E, t, DURATION)·(b/eligibleSupply)`; buy-before-settle/sell-after not profitable vs V3 cost | property (fuzz JIT sequences) |
| INV-30 | `VAULT.register` executes before the init mint; mint-`sync` succeeds; a mid-launch revert unwinds it | property (ordering + fail-injection) |
| INV-31 | `settle` `asset ∈ {LT, WETH}` only; route is the fixed LT→WETH hop (no caller route); `amountIn==0`/over-rawFees/unregistered reverts | unit + property |
| INV-32 | **terminal conservation:** with no further fees, once the current epoch ends `roll` starts the queued one and, after a `DURATION` warp, every settled wei is claimed or held in an explicit bucket/`nextEpochAmount`; supply 0-crossings never strand vest | property (terminal + supply-drain-then-return) |
| INV-33 | **Blockscout clone state honest:** verified ONLY via a Blockscout minimal-proxy association to the verified `IMPL` (impl-source-against-proxy is invalid); app ✓ only on recognized-proxy+verified-impl, else neutral/pending | real-explorer acceptance + app-state unit |
| INV-34 | **LT/WETH lock + non-extendable epoch:** the factory constructs/seeds **only** LT/WETH pools and `COLLECTOR.register` rejects `numeraire != WETH`; a `settle` (or `roll`) spammed **every block** during an active epoch **never moves `epochFinish`** — the original epoch completes on schedule; `roll` reverts on an active epoch or zero queue | invariant (adversary spams settle/roll every block) + unit (numeraire reject) |

**Deploy-time:** factory/collector/vault fail to construct on any zero immutable, wrong bps, or `MAX_SLIPPAGE_BPS ≥
1e4`. **Per-chain manifest** pins `{chainId, WETH(=SETTLEMENT_TOKEN), USDG(launch fee)+decimals, launchFeeAmount,
hydeoutTreasury, swapRouter, uniswap addrs, LT/WETH feeTier, DURATION, MAX_SLIPPAGE_BPS, TWAP_WINDOW, oracle-
cardinality target}`; **LT/WETH pools mandatory** (any other numéraire rejected at construction/register). Deploy-
cycle: CREATE2 predict matches; `FACTORY` immutable equals it; `initFactory` fallback reverts on 2nd call / non-
deployer on both.

**Plus non-invariant coverage:** every §6 revert; permit paths; duplicate salt; mint-callback auth; **register-
before-init** regression; **numeraire-reject** (a non-WETH pool fails at construct/register, INV-34); seeding
atomicity incl. vault rollback; **settle per-branch accounting** (WETH-leg net-zero reclassification vs LT-leg
LT−amountIn/WETH+wethAmt — assert INV-27 on each branch); **epoch lifecycle** (first settle starts epoch 1; settle
during active epoch queues to `nextEpochAmount`, `epochFinish` unmoved; exact 100% vest at finish; `roll` after end
starts the queued epoch; `roll` reverts on active/empty; zero-supply vest re-queued); **extension-grief adversary**
(spam settle/roll every block, prove the original epoch finishes on schedule, INV-34); **JIT sim**; **`sync`-can't-
brick**; **donation-DoS**; **excluded-never-accrues**; **multi-namespace solvency** (interleave collect/settle/claim/
donate/roll across ≥3 tokens, INV-27). **Fork-integration on a Foundry fork of Robinhood mainnet 4663** (real V3 +
WETH + oracle): launch LT/WETH → trades accrue → `collect` (raw→vault) → `settle` (LT→WETH TWAP-floored + 90/5/5) →
`claimCreator`/`claimHyde`/holder `claim` over epochs → threshold → `graduate`. Slither clean/triaged; gas snapshot
incl. per-transfer `sync`.

---

## 9. Open sub-decisions (non-blocking for build start; flag at wiring)
- **Build defaults locked (kami 21254):** epoch `DURATION = 7 days`, `MAX_SLIPPAGE_BPS = 300`, `TWAP_WINDOW = 1800s`.
  Deployment still needs 4663-fork evidence + manifest sign-off (immutable per deployment). `settle` **permissionless-
  TWAP — no silent authorized keeper**.
- **Own-stack pools LOCKED to LT/WETH (kami 21263).** WETH = sole numéraire; USDG launch-fee-only; any other
  numéraire/route rejected at construction/register.
- **Hyde claim bucket = per-token (kami-APPROVED 21263; +1 kuro 21262).** `claimHyde(token)` → `hydeoutTreasury`;
  the vault inherits `Multicall` for one-tx batch treasury collection (kuro), zero accounting-model change.
- ~~USDG reward vault~~, ~~JIT / donation / stream-stranding / oracle-readiness / Blockscout fallback~~,
  ~~stream-extension grief~~ → **RESOLVED** (rev4/rev5; kami audits 21254/21263).
- ~~Settlement token~~ → **WETH CONFIRMED (clint 21255)**; launch fee stays USDG.
- ~~Milestone metric for `graduate`~~ → design = monotonic `graduationProgress` (WETH); **blocked on the threshold
  number** — graduate stays stubbed/deploy-blocked.
- Board during transition: dual-source vs Hyde-only (PROTOCOL_PLAN §7).

---

## 10. Automatic Blockscout verification pipeline (clint 21250 / kami 21251) — PASSED docs audit
Off-chain **verifier worker (indexer)**, decoupled from `launch` (contracts unchanged — `LaunchCreated` + fixed
`IMPL` suffice). **A. Pre-prod:** verify impl + factory + collector + vault (`forge verify-contract` / Sourcify);
release gate = all four `is_verified` on `robinhoodchain.blockscout.com`. **B. Per-launch:** durable-cursor index of
`LaunchCreated`; **associate each 1167 clone via a Blockscout-supported minimal-proxy path** — the clone runtime is
the proxy stub, so **submitting impl source against the clone bytecode-mismatches (invalid); do not** — link `token →
verified IMPL`; **validate the exact path on the real 4663 explorer during build**; honest state if no direct clone
verification = "recognized 1167 proxy + verified impl." Durable `pending→verified/failed(actionable)`, retry/backoff,
idempotent, **never blocks launch**. **C. App:** `useVerifiedStatus`/`getLaunchImplementation` — ✓ on direct-verified
OR eip1167+verified-impl; never false-✓. **D. Acceptance:** pre-prod gate + **mandatory real-explorer test** (launch
→ auto-verify with no manual step; also validates which proxy path the explorer supports) + resilience + idempotency
— "a release is not complete until a real launched token reaches Blockscout verified automatically." **E.** worker/
indexer goes in kuro's build handoff after the contract audit clears.

---

## 11. Bubblemaps deep-link (secondary, kami 21228) — research status
`v2.bubblemaps.io/robinhood` is a client-side SPA; a no-JS fetch returns the generic shell for any path, so the
token-route form can't be confirmed statically (no headless browser here). Ground truth = clint pastes the permalink
from that page for token `0x3bed9d3863e56e5e6afae8425012a80be7d80ba3`; then the `<address>` template goes to kuro for
the Path-A "View holders on Bubblemaps ↗" secondary link. Not blocking the contract work.

---

## 12. Changelog
- **2026-07-14 rev5 (kami audit 21263):** (1) own-stack pools **LOCKED to LT/WETH** (reject other numéraire at
  construct/register); (2) `settle` = **exact liability reclassification** (WETH-leg net-zero; LT-leg LT−amountIn /
  WETH+measured-wethAmt) — INV-27 per-branch; (3) **non-extendable fixed epochs** (settle queues the next epoch,
  never moves `epochFinish`; exact `mulDiv` vesting 100% at finish, no carry; `roll` requires ended-epoch + nonzero
  queue) — kills the stream-extension grief. Per-token Hyde buckets approved (+ `Multicall` for batch, kuro).
  Added INV-34; reframed INV-25/26/27/32; §7.20.
- **2026-07-14 rev4 (clint 21255 / kami 21256):** WETH fee settlement — swap-free/split-free `collect`; separate
  TWAP-guarded `settle`; creator/Hyde WETH claim buckets, only holders stream; launch fee USDG. rev1–rev3 USDG
  design superseded.
- **2026-07-14 rev2/rev3 (kami 21249/21254):** USDG reward-vault fixes (donation-proof, stream, oracle, Blockscout).
  *Superseded by rev4/rev5.*
- **2026-07-13:** L3 own-stack spec locked (90/5/5 buyback&burn); HydeERC20 + HydeFeeCollector built & held
  (`67bc16c`).
