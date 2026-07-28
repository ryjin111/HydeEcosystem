# Hydeout V3 Line — Reconciled Build-Spec (multichain reach line · Uniswap V3 · single-sided · 95/5)

**Status:** BUILD SPEC — first draft for kuro (builder) + gojo/kami (protocol gate). Reconciles three sources into one build
truth: (1) `PROTOCOL_PLAN.md` locked decisions, (2) the DEX-agnostic base in `CONTRACT_SPEC_L3.md` §1 (`HydeERC20` +
`HydeFeeVault` accounting "survives as logic; its V3 DEX-coupling is rewritten"), (3) the `potatopad-ref` single-sided-mint +
perma-lock skeleton kuro cloned.
**Author:** shiro (research/design) · **Builder:** kuro · **Protocol gate:** gojo/kami · **Date:** 2026-07-24

> **Why this line exists (clint 2026-07-24):** the V4 hook stack (rev8.3, live on 4663) only runs where **canonical Uniswap
> V4** is deployed. Most new chains have **Uniswap V3** (or a V3-compatible fork), not V4 — Stable/988 is the first target
> (canonical V3, verified). The V3 line is the **reach play**: one config row per new chain, first-on-chain, lean audit
> surface. It is **NOT** a replacement for the V4 line — it is the second tier of a deliberate product ladder (§0).

---

## 0. Locked decisions (clint + team, 2026-07-24)

- **DEX = Uniswap V3** (canonical or V3-compatible fork) on the target chain — singleton-free classic V3:
  `factory` + `NonfungiblePositionManager` + `SwapRouter02` + `QuoterV2`. **No hooks, no PoolManager, no `unlock`/`take`/`settle`.**
- **Fee split = 95% creator / 5% Hyde treasury.** **NO holder-reward leg, NO in-kind auto-compound** — those stay the
  **V4/4663 premium** (their reward vault is oracle-coupled and does not port cleanly to a fresh V3 pool; clint chose the lean
  model 2026-07-24, msg 24155). This is the **product ladder**: V4 chains = premium (90/5/5 + rewards); V3 chains = reach (95/5).
- **Launch fee = the chain's flat launch fee** (per `PROTOCOL_PLAN` §2.5 — stablecoin-denominated `$1`-class, OR native, per
  chain config). See §3 fee block. Distinct revenue line from the 95/5 trading split.
- **Graduation = permanently-locked LP, label only** (`PROTOCOL_PLAN` §4 Option A — LOCKED). Liquidity is live + tradeable from
  block 0; "graduation" is a milestone label, never a trading unlock. Copy per §7.
- **Anti-snipe = token-side time-boxed max-wallet ONLY.** V3 has a **fixed fee tier** — the V4 hook's decaying-fee anti-snipe
  **does not exist here**. The only anti-snipe is the `HydeERC20` max-wallet cap for a short launch window, then it lifts
  (`PROTOCOL_PLAN` §2.3 option (b), already LOCKED). **Copy must not claim fee-decay anti-snipe on this line** (it would be false).
- **Supply = 1e9 (1B), 100% single-sided into the pool.** No team/pre-mint (fair-launch invariant, unchanged).
- **Numeraire = per-chain, config-driven** (§1 table). Stable/988 = **USDT0 (6-dec)**, verified. WETH-chains = wrapped-native
  (18-dec). Arc = USDC (6-dec, later, V3 unverified).
- **Custody-lock = no `decreaseLiquidity`/transfer/burn path on Hyde's position** (perma-lock by absence, PotatoFeeLocker
  skeleton). External LPs on the same pool remain freely removable (there is no hook to block them — V3 has none).

---

## 1. Numeraire / chain registry — the "change the chain, it always matches" seam

The whole per-chain surface is ONE config row. Add a chain = add a verified row; **zero contract or UI rewrite**. Both the
deploy script and the frontend read the SAME row (single source of truth, mirrors `V4_CONTRACTS_BY_CHAIN`).

```
V3_CHAIN_ROW = {
  chainId, rpc, explorer,
  v3Factory, positionManager, swapRouter02, quoterV2, universalRouter?, permit2,
  numeraire: {
    address,        // the paired asset (the "WETH slot" of the V3 pool)
    decimals,       // HARDCODED here — never read on-chain (§2 rule)
    symbol,         // display only, from config, never an on-chain symbol() call
    displayDecimals // UI price formatting (6-dec → $x.xx style, 18-dec → Ξ style)
  },
  feeTier,          // the V3 fee tier the pool is created at (e.g. 10000 = 1%)
  launchFee: { asset, amount, native: bool, supportsPermit: bool },
  poolProof: { getPool(exampleToken, numeraire, feeTier) resolves + token=18dec }  // gojo's gate anchor
}
```

**Verified Stable/988 row (gojo + kuro on-chain, msgs 24141/24140/24103) — GROUND TRUTH, not doc-sourced:**
```
chainId          988 (0x3dc)
v3Factory        0x88F0a512eF09175D456bc9547f914f48C013E4aA   // NPM.factory() binds to this ✓
positionManager  0x3BdC3437405f7D801b6036532713fc1F179136a6
swapRouter02     0x32eaf9B5d5F2CD7361c5012890C943D7de84C22a
universalRouter  0x5Be52b52f3d1dbC324d2959637471a4208626144
quoterV2         0xb070179E7032CdA868b53e6C1742F80c9e940d1A
permit2          0x000000000022D473030F116dDEE9F6B43aC78BA3   // canonical
numeraire USDT0  0x779Ded0c9e1022225f8E0630b35a9b54bE713736   // decimals()=6, symbol "USDT0", readable ✓
  decimals       6      // HARDCODED — do NOT read on-chain even though USDT0 is readable (§2)
  displayDecimals 6     // render $1.00-style
feeTier          10000  // Factory.feeAmountTickSpacing(10000)=200 → 1% tier LIVE ✓
launchFee        { asset: USDT0, amount: 1_000000 ($1 at 6-dec), native: false, supportsPermit: verify }
```
> ⚠️ Stable's `wrappedNative` shim (`0x5d44…9ab5`) and the web-search USDT0 (`0x9151…`) **REVERT on all ERC20 metadata** —
> do NOT use them. USDT0 `0x779Ded…3736` is the only readable, correct numeraire (kuro/gojo confirmed). Launch shape =
> **token(18-dec) ↔ USDT0(6-dec) @ 1% tier**, single-sided token-above-floor (matches the live Bankless/USDT0 pool at MIN_TICK).

**WETH-numeraire V3 row TEMPLATE (clint 24174 — "a WETH version for V3"):** ⚠️ **This is NOT a second contract build.** It is the
**same** `HydeV3Pad`/`HydeV3FeeLocker` with `numeraireDecimals = 18` and a WETH row — the numeraire-generic architecture (§2) makes
it fall out of the identical binary. The `numeraireDecimals` immutable kuro is building for audit-item-#1, and gojo's drift-proof
test that **already covers the 18-dec leg**, ARE the WETH version. Work to light up a WETH/V3 chain = **config + verify, not code**:
```
chainId          <pick a WETH-gas chain that has canonical/fork Uniswap V3 but NOT V4>
                 // candidates: Base / Arbitrum / Optimism / Polygon etc. — all have Uni V3.
                 // (Chains that ALSO have V4, like 4663, use the V4 premium line instead — the V3
                 //  WETH line is specifically for V3-only WETH chains. Chain pick = clint/gojo.)
v3Factory / positionManager / swapRouter02 / quoterV2 / permit2   // that chain's canonical Uni V3 (verify on-chain)
numeraire WETH   <chain's WETH>   decimals 18   displayDecimals 18   usdPegged false  // renders "Ξ", not "$"
feeTier          10000 (1%) or 3000 (0.3%) — pick per desired launch fee/liquidity profile
launchFee        { asset: <chain USD stablecoin>, amount: 1e6/1e18 ($1), native?: OR native ETH 0.0004 like the V4 line }
```
> **The one real decision for the WETH V3 line (clint):** the **launch fee**. `PROTOCOL_PLAN` §2.5 prefers a **stablecoin** $1
> fee (feed-free, exact) → needs that chain's canonical USD stablecoin configured. The V4/4663 line instead uses **native 0.0004
> ETH** (`msg.value`, no approval). Either works on V3 — pick per chain. Everything else is the verified-row + `chainverify` gate,
> identical to Stable. **No new contracts, no new audit surface** (the decimals test already proves 18-dec).

**Verify-or-hidden gate (gojo, §6):** a chain row is **not selectable in the UI** until `chainverify.mjs` diffs it against a
**live-pool on-chain read** (factory bind + pool resolves + token decimals + fee tier). Half-configured chain → not in the
switcher. **A user can never switch to a chain that shows a garbage price.**

---

## 2. Hard rules (from tonight's on-chain findings — MUST hold or Stable silently bricks)

1. **NEVER call `decimals()`/`symbol()` on the numeraire at runtime — contract OR frontend.** Stable's non-USDT0 token
   contracts *revert* on metadata; any `IERC20Metadata(numeraire).decimals()` in a constructor or launch path **reverts the
   launch**. Decimals/symbol come from the **immutable config row**, baked at deploy. (Even though USDT0 itself is readable,
   hardcode `6` so a future chain's shim-token can never brick the path — gojo 24141.)
2. **Numeraire decimals = immutable constructor param** on the factory (and any contract that does numeraire math), sourced
   from the verified row. No setter, no on-chain read.
3. **🚨 THE `$1.9T`-class bug, PINNED TO A LINE (kuro code-read 24158) — AUDIT ITEM #1.** `PotatoPad._sqrtPriceX96FromFdv`
   (line 621) hardcodes the FDV→price math with the comment *"Both assets are 18-decimals."* USDT0 is **6-dec** → lifting it
   unchanged mis-prices every launch by **10^12** = the V3 twin of the WETH preset bug. **THE FIX: parameterize the entire
   FDV → `sqrtPriceX96` → tick chain by `numeraireDecimals`** (18 for WETH, 6 for USDT0), sourced from the immutable config row.
   Every preset/price computation is derived against the **verified** numeraire decimals, asserted per fixture. A 6-dec numeraire
   paired with an 18-dec token is the exact scale trap — cover both orderings in tests (§5).
4. **`tokenIs0` both orderings** — a launch token can sort either side of the numeraire. PotatoPad already handles this
   (`_rangeFor(tokenIs0)`/`_mintSingleSided`); keep it. Range is **entirely above spot** if token is the "upper" side, entirely
   below if the lower side — single-sided token, zero numeraire seeded.

---

## 3. Contract topology — strip-to-V3 + PotatoPad graft

**Naming (kuro 24158):** `PotatoPad → HydeV3Pad` · `PotatoToken → HydeERC20` · `PotatoFeeLocker → HydeV3FeeLocker`.

| contract | V3-line role | derivation |
|---|---|---|
| **`HydeERC20`** (V3 clone) | cloned launch token; EIP-2612; time-boxed max-wallet; **supply 1e9, no mint/burn/owner** | **REUSE `HydeERC20` almost as-is** (PotatoToken ≈ same shape). Drop the (already-removed in rev8) `sync` hook. Max-wallet stays in `_update` — PotatoPad's `MAX_WALLET` 2% + `antiSnipeBlocks` maps directly to our time-boxed cap. Exempt set: V3 has no PoolManager — `{positionManager, factory, locker, swapRouter, universalRouter, address(0)}`. |
| **`HydeV3Pad`** (factory) | permissionless `launch`: fee → clone → **create/seed single-sided V3 pool** → lock → register | **PotatoPad `_launch` skeleton, KEEP.** Replaces the V4 `initialize`+hook+`modifyLiquidities` seed with V3 `createPool`+`mint` single-sided. **KEEP its CREATE2 random-salt griefing guard** (`MAX_SALT_TRIES` — probes to dodge pool-pre-poisoning; genuinely good). |
| **`HydeV3FeeLocker`** | custodies the V3 position NFT; permissionless `collect()` fee-take; splits 95/5 | **PotatoFeeLocker skeleton, our policy.** Keep its perma-lock (no `decreaseLiquidity`) + `collect()` model; **swap its 50/50+burn for our 95/5 no-burn.** This is NOT `HydeFeeCollector` (that's V4/PoolManager/oracle-shaped — gojo 24143). |
| **`HydeFeeSplitLib`** | the 95/5 split math + `_safeTransfer` hardening | **REUSE the split *policy*** from `HydeFeeVault` (the DEX-agnostic accounting), NOT its V4 settle/oracle/`unlock` path. |

**Graft map (kuro's full PotatoPad.sol read, 24158):**
- **KEEP as-is:** `_launch` skeleton · CREATE2 random-salt griefing guard · single-sided mint→locker · pool create/init at exact
  tick boundary (zero-numeraire mint) · perma-lock · **`tokenIs0` both-orderings** · anti-snipe (`MAX_WALLET` 2% + `antiSnipeBlocks`)
  · 1% tier / tickSpacing 200.
- **CHANGE:** (1) **decimals math** — parameterize `_sqrtPriceX96FromFdv` by `numeraireDecimals` (§2 rule 3, audit item #1);
  (2) numeraire `weth`(IWETH9) → **USDT0 ERC20** (`0x779Ded…`, 6-dec) — pool pairs token/USDT0, dev-buy (if kept) uses USDT0 not
  wrapped-native (**dev-buy optional — can defer**); (3) fee split `PotatoFeeLocker` 50/50+burn → **our 95/5 creator/Hyde, no burn**,
  V3-native claim via `positionManager.collect()`.
- **DROP (95/5 = no rewards):** `createRewardToken` / `PotatoRewardToken` / `bindPosition` / `RewardTerms` — meaningfully simpler
  contract, and it's why the V3 line's audit surface is small.

**What is STRIPPED vs the V4 line (do not port):** `HydeHook`, `HydeFeeVault`'s settle-swap/`unlock`/oracle path, `OracleLib`,
the V4 `IPositionManager`, the entire in-kind `compound`/`pendingLiq*` machinery, `STATE_VIEW`, TWAP consult. The V3 line has
**no oracle, no hook, no auto-compound, no settle swap** — fees are claimed in-kind from the position and split 95/5 directly.

**Flow:** `launch` pays fee → clones `HydeERC20V3` → `v3Factory.createPool(token, numeraire, feeTier)` (or reuse if exists) →
`pool.initialize(sqrtPriceX96_preset)` → mint **single-sided** token-only liquidity via `positionManager.mint(...)` with
`recipient = HydeLockerV3` → assert numeraire-side minted == 0 → register. Users trade on the V3 pool immediately. Anyone calls
`HydeLockerV3.collect(token)` → `positionManager.collect()` pulls owed fees → split **95% creator / 5% Hyde**, `_safeTransfer`
each leg, revert-on-fail (no partial split). Position NFT is custody-locked forever (no decrease/transfer/burn selector).

---

## 3a. `HydeTokenFactoryV3.launch` — ordered, all-or-revert

`launch(LaunchParams{name, symbol, preset}) [payable if native fee] nonReentrant` — `creator := msg.sender`:
1. **Fee block FIRST (atomic, before any deploy):** native → `require(msg.value == launchFee.amount)` + forward to
   `launchFeeTreasury`; ERC-20 → `safeTransferFrom(creator, treasury, amount)` with **exact-balance-delta check** (fee-on-transfer
   guard, `PROTOCOL_PLAN` §2.5). Chain-gate: unconfigured fee ⇒ revert (never free). Permit path only where `supportsPermit`.
2. `token = Clones.cloneDeterministic(IMPL, salt=keccak256(msg.sender, symbol, nonce++))`.
3. `token.initialize(...)` — set exempt set + max-wallet window; **mint full 1e9 to the FACTORY** (the exempt seeder).
4. **Pool + single-sided seed (PotatoPad `_mintSingleSided`):** sort `(token, numeraire)`; `pool = v3Factory.getPool(...)` or
   `createPool`; if uninitialized `pool.initialize(sqrtPriceX96_preset)`. Compute the single-sided range from the **immutable
   preset** (`initialTick`, `tickLower`, `tickUpper`, all `tickSpacing`-aligned) so the position is **entirely token-side** at
   the preset price — `_rangeFor(tokenIs0)` picks above-vs-below spot. Approve token via **Permit2 → positionManager**;
   `positionManager.mint({token0, token1, fee: feeTier, tickLower, tickUpper, amount0Desired/amount1Desired = (SUPPLY on the
   token side, 0 on the numeraire side), amount0Min/1Min = same, recipient: HydeLockerV3, deadline})`.
5. **Assert single-sided:** the numeraire-side amount actually used == 0 (a mis-set range needing numeraire ⇒ revert). Capture the
   minted `tokenId`; `require(positionManager.ownerOf(tokenId) == HydeLockerV3)`. Sweep any measured token dust to the locker
   (exempt), assert factory token balance == 0.
6. `HydeLockerV3.register(token, creator, tokenId, numeraire, feeTier, graduationThreshold)`.
7. Emit `LaunchFeePaid` + `LaunchCreated(token, creator, pool, tokenId, preset)`. Any revert ⇒ whole tx rolls back.

---

## 4. `HydeLockerV3` — custody-lock + 95/5 collect

**Immutables:** `FACTORY`, `positionManager`, `hydeBps`(500), `hydeTreasury`(immutable), numeraire config (from row). Per-token
`Position{tokenId, creator, numeraire, feeTier, graduated}` set at `register` (factory-only).

**Custody-lock (INV, PotatoFeeLocker skeleton):** the locker owns the V3 position ERC-721 and exposes **no** transfer / approve /
setApprovalForAll / `decreaseLiquidity` / burn / generic-call path → locked-by-absence. Liquidity is **monotonic** (only the
initial single-sided mint; no compound on this line). Verified by codehash selector-enumeration (no-exit badge, §7).

**`collect(address token) external nonReentrant` — permissionless, swap-free:**
1. `pos = positionOf[token]; require(pos.registered)`.
2. `positionManager.collect({tokenId: pos.tokenId, recipient: address(this), amount0Max: MAX, amount1Max: MAX})` — pulls owed
   fees in **both** currencies to the locker.
3. **Measure** before/after balance deltas `dToken`, `dNumeraire` for each currency that moved.
4. **Split 95/5 per asset, atomically:** for each collected asset with `amt > 0`: `hydeCut = mulDiv(amt, hydeBps, 10000);
   creatorCut = amt − hydeCut;` `_safeTransfer(asset, pos.creator, creatorCut); _safeTransfer(asset, hydeTreasury, hydeCut);`
   Revert on any leg failure (`_safeTransfer` hardening) — **no partial split, no accrual buffer.** Emit `FeesCollected`.
   > Note: creators receive fees **in-kind** (both token + numeraire legs), NOT converted to a single asset — there is **no settle
   > swap on the V3 line** (that was V4/oracle-only). Simpler, no oracle surface. If clint wants creators paid in numeraire only,
   > that needs a V3 swap-on-collect path (router, slippage-guarded) — **flag as a v2 option, not in this build.**

**`graduate(token)` — permissionless, label-only:** `require(!graduated && <threshold met>)`. Threshold metric on V3 =
accumulated numeraire in the pool / net-buy volume (clint-pinned; **stubbed `GRADUATION_PENDING` until pinned**). No unlock, no
migration — liquidity was always live + locked (Option A copy, §7).

---

## 5. Security gates (before mainnet value — per `PROTOCOL_PLAN` §6)

- Foundry unit + fuzz on every contract; reuse the false-returning / no-return-token `_safeTransfer` hardening.
- **Decimals correctness fixtures:** `$1` fee resolves to `1e6` (6-dec) / `1e18` (18-dec); single-sided seed math correct for
  **token(18)↔numeraire(6)** AND token(18)↔numeraire(18) — the scale-trap coverage.
- **`tokenIs0` both orderings** — seed produces a single-sided token-only position in both sorts; numeraire-side == 0 asserted.
- **Custody-lock invariant:** selector-enumerate — no reachable decrease/transfer/burn on the position; creator/treasury/bps
  immutable; 95/5 sums to 100% exact; no admin path drains creator fees or unlocks the LP.
- **Launch-fee tests:** exact-amount-to-treasury, revert-no-token on bad allowance/balance/false-return/no-return, permit path,
  chain-gate revert when fee unset, reentrancy on the pre-deploy fee transfer.
- **Integration on a fork of the target chain** (Stable/988 fork has the real Uniswap V3): launch → trades accrue fees →
  `collect` 95/5 exact → graduate label. **Never call 988 a testnet** — name the real fork.
- **gojo `chainverify.mjs` row gate** green before the chain is selectable.
- External audit before real value. No pre-audit mainnet launch of value-bearing contracts.

---

## 6. gojo's per-chain verify gate (extends the V4 `chainverify` pattern)

A `V3_CHAIN_ROW` is **live only after** a mechanical live-pool on-chain diff passes:
- `NPM.factory() == row.v3Factory` (position manager cryptographically bound — anything we mint shows on the chain's DEX UI).
- `factory.feeAmountTickSpacing(row.feeTier) != 0` (tier live).
- `row.numeraire.decimals()` on-chain == `row.numeraire.decimals` **config** (sanity — but the *contract* still uses the config
  literal, never this read).
- `factory.getPool(exampleToken, numeraire, feeTier)` resolves to a real pool with `fee() == feeTier` and the paired token
  reports 18-dec (shape confirmation).
Stable/988 row **PASSES** this today (gojo 24141). Arc/USDC row is **unverified** (mainnet beta, V3 unconfirmed) → not live.

---

## 7. UI / design half (shiro) — one skin, N chains

The design does not change per chain — only a network chip + price formatting. This is the "retain our design, change the chain,
it always matches" that clint specified (24144).
- **Chain switcher + per-chain badge** — same board / coin-page / launch-form everywhere; user sees **Hyde**, never the engine
  ("PotatoPad"/V3/V4 is invisible).
- **Numeraire-aware price display** — keyed off `row.numeraire.displayDecimals`: USDT0/USDC render `$1.00`-style (6-dec), WETH
  renders `Ξ0.00…` (18-dec). One formatting switch; **no chain ever shows a garbage number.**
- **Engine-agnostic data hook** — on 4663 the hook talks to the V4 stack; on Stable/988 it talks to `HydeTokenFactoryV3` /
  `HydeLockerV3`. Same components, different data source.
- **Option-A graduation copy** (LOCKED): *"Trading is live from launch on this token's Uniswap pool."* + milestone: *"liquidity
  permanently locked."* **Never** imply "trading opens at graduation" or "graduates to a real pool." Board states = **Live / Locked**.
- **No-exit badge** = codehash proof the locker exposes no decrease/transfer/burn selector.
- **Anti-snipe copy** = "max-wallet cap for the first X minutes, then lifts." **NOT** fee-decay (false on V3).

---

## 8. Open items → decision owners

- [x] Fee model — **95/5 LOCKED** (clint 24155).
- [x] Stable numeraire + decimals — **USDT0 `0x779Ded…3736`, 6-dec, 1% tier — VERIFIED** (kuro/gojo).
- [ ] **gojo/kami:** protocol review of `HydeLockerV3` (PotatoFeeLocker `collect()` skeleton + our 95/5) — the one net-new
      contract surface. Confirm the perma-lock selector-enumeration + 95/5 conservation.
- [ ] **clint:** graduation threshold metric + value on V3 (accumulated-numeraire / net-buy) — stubbed until pinned.
- [ ] **clint:** creators paid in-kind (both legs) — DEFAULT — vs numeraire-only (needs a swap-on-collect path, v2 option). §4.
- [ ] **clint:** launch-fee on Stable — `$1` USDT0 (config'd) vs a different amount. Confirm.
- [ ] **kuro:** confirm `supportsPermit` on USDT0 (permit vs approve+transferFrom fee path).
- [ ] Arc/USDC row — deferred until Arc mainnet + V3 verified on-chain.

---

**Build order (kuro):** (1) `HydeERC20` V3-clone (trim rev8 `HydeERC20`, swap exempt set) → (2) `HydeV3FeeLocker` (PotatoFeeLocker
skeleton + 95/5, drop rewards) → (3) `HydeV3Pad` factory (V3 single-sided seed, **decimals-parameterized `_sqrtPriceX96FromFdv`**,
keep salt-guard) → (4) Foundry + decimals/ordering fixtures (audit item #1 = the 6-dec USDT0 preset) → (5) Stable-fork integration
→ (6) gojo `chainverify` row + kami/gojo audit of the 95/5 claim path → (7) UI config row + numeraire formatting. The design +
config table are the constant; each new chain is one verified row after.

> **§3a/§4 below still use the working names `HydeTokenFactoryV3`/`HydeLockerV3` — read them as `HydeV3Pad`/`HydeV3FeeLocker`
> per the §3 naming table (kuro 24158). Mechanics are identical; only the labels updated.**
