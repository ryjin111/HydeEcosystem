# Hydeout Own-Stack — rev7 Uniswap V4 Topology (PROPOSAL rev2 for Reviewer)

**Status:** PROPOSAL rev2 — read-only research/spec-design, **NO code, NO deploy** (kami 21290/21294). Researcher → Reviewer.
**Author:** gojo (senior protocol) · **Date:** 2026-07-14 · **Supersedes:** rev1 (`f14c490`) + `V4_DELTA_BRIEF.md`; retires V3
manifest `760d2cb`. **Decision locked (clint 21289 / kami 21290/21294): Uniswap V4.**
**Reviewer-locked topology decisions (kami 21294):** WETH numéraire (not native) · 90/5/5 stays in the vault (no
fund-bearing hook) · Hyde's seeded LP locked by **custody-only** (NOT a pool-wide hook revert).

> **rev2 fixes (kami audit 21294, 7 blockers):** (1) dropped the pool-wide `beforeRemoveLiquidity` revert (it bricks
> zero-liquidity fee `collect` AND traps external LPs) → custody-only lock; (2) corrected fee-collection to
> `PositionManager.modifyLiquidities(INCREASE_LIQUIDITY 0 + TAKE_PAIR)`; (3) authenticated system settlement swaps
> (`sender == vault`) → excluded from volume + charged `baseFee`, via a direct vault→PoolManager path (no
> UniversalRouter) — closes the donate→settle→count bypass; (4) replaced truncated-tick oracle with a real-tick,
> time-integrated **observation ring**; (5) added `beforeInitialize` factory-auth (permissionless init + predictable
> CREATE2 = front-run risk); (6) fixed the Quoter to the official `0x8dc178ef…`; (7) corrected the preservation
> claims — the vault's *accounting* survives, its V3 DEX-coupling does not.

---

## 1. Verified Robinhood 4663 V4 stack (extcodehash = keccak256(runtime), keccak self-checked)
| role | address | verified name | size | extcodehash |
|---|---|---|---|---|
| **PoolManager** (singleton) | `0x8366a39CC670B4001A1121B8F6A443A643e40951` | PoolManager | 24009 B | `0xbd3881180b547f5fe817545743cfb4343e96b1bc6640dcd70c106b0066e95626` |
| **PositionManager** (v4, ERC-721) | `0x58daec3116aae6D93017bAAea7749052E8a04fA7` | PositionManager | 23877 B | `0xc873e135dc9aaec88489cfbad146b4cb49d6a32e0d80326377784b7ba17670b2` |
| **UniversalRouter** (user swaps only) | `0x8876789976dEcBfCbBbe364623C63652db8C0904` | UniversalRouter | 24546 B | `0x2ce6aaaf9f4151f5e1cbf774668772f17f532ae11b15e9284fd0a072a8b0fbde` |
| **Permit2** | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | Permit2 | 9152 B | `0x5208783f52488f7d3493e5e38311ab707c1d75457fe472a19b0b4d57d66a7fca` |
| **StateView** | `0xF3334192D15450CdD385c8B70e03f9A6bD9E673b` | StateView | 3531 B | `0x7d9c591e0956fd89d98feb4ffcfe8bf1f7a62bd485edd979fa21d104b49878a6` |
| **V4Quoter (OFFICIAL, hook-aware)** | `0x8dc178efb8111bb0973dd9d722ebeff267c98f94` | V4Quoter | 6118 B | `0xd707b1da8cb165e5ea35a3b4450d971eb562ec171e23492aa117036b78a868f6` |
| ~~view-quoter-v4~~ (optional/custom) | `0x7232686FC954f12079cadFC5e9F755a9fEAeb3Ca` | Quoter | 6620 B | `0x6f47…8cb` — **does NOT execute our dynamic-fee hook callbacks; not for hook-aware quotes** |

Official V4Quoter per https://developers.uniswap.org/docs/protocols/v4/deployments (blocker 6). WETH `0x0Bd7D308…` (18) /
USDG `0x5fc5360D…` (6) unchanged; launch fee = USDG 1e6 (pull via Permit2 or approve, exact-received guard).

## 2. `HydeHook` — permissions (mined into the address via CREATE2; blocker 1/5 change the flag set)
| callback | purpose |
|---|---|
| **`beforeInitialize`** (NEW, blocker 5) | **reject `sender != HydeTokenFactory`**; validate the pool is LT/WETH with the registered launch config → blocks permissionless front-run initialization of a predictable CREATE2 pool |
| `afterInitialize` | record `launchTime` (anti-snipe decay origin) + initialize the observation ring |
| `beforeSwap` | return the **dynamic anti-snipe LP fee** for **user** swaps; return **`baseFee` when `sender == vault`** (system settlement, blocker 3); bounded `[baseFee, MAX_LP_FEE_CAP]` |
| `afterSwap` | (a) advance the **observation ring** (§6); (b) add `abs(WETH BalanceDelta)` to the **swap-only gross WETH volume** counter — **skip entirely when `sender == vault`** (blocker 3) |
Flags mined = `BEFORE_INITIALIZE | AFTER_INITIALIZE | BEFORE_SWAP | AFTER_SWAP`. **No `beforeRemoveLiquidity`** (blocker 1).
The hook holds **no funds** and takes **no fee delta** — it only sets the LP fee + records counters/observations.

## 3. Permanent liquidity lock + exact fee-collection path (blocker 1/2)
- **Lock = CUSTODY-ONLY (no hook revert).** A pool-wide `beforeRemoveLiquidity` revert is rejected: canonical V4 routes
  `liquidityDelta <= 0` through that callback, and **fee collection uses a zero-liquidity `modifyLiquidity`** — so a
  blanket revert would **brick `collect`** and **permanently trap every third-party LP**. Instead: the collector holds
  Hyde's seeded v4 position **ERC-721 with no transfer / approve / decreaseLiquidity / burn / generic-call path
  exposed** — locked-by-absence on *our* NFT only. **External LPs stay fully removable** (INV: an external LP can add
  and later remove liquidity on a Hyde pool).
- **Fee collection (exact V4 sequence, blocker 2):** the collector, as NFT owner, calls
  **`PositionManager.modifyLiquidities([ INCREASE_LIQUIDITY(tokenId, liquidity=0, …), TAKE_PAIR(WETH, LT, collector) ])`**
  — the PositionManager owns the `unlock` lifecycle; a zero-liquidity change credits the position's owed fees, and
  `TAKE_PAIR` sweeps them to the collector. **Measure the collector's before/after {LT, WETH} balance deltas**, then
  `noteRaw` each to the vault (donation-proof pull-measure). Swap-free, split-free (INV-14/18). *(No manual
  `PoolManager.unlock → PositionManager` — PositionManager drives it.)*

## 4. Dynamic anti-snipe fee (do-more #1)
Dynamic-fee pool; `HydeHook.beforeSwap` returns `fee(t) = max(baseFee, startFee − slope·(t − launchTime))` for **user**
swaps, decaying from `startFee` to `baseFee` over an immutable `antiSnipeWindow`. Bounded `[baseFee, MAX_LP_FEE_CAP]`
(≤ ~25%), immutable schedule (preset) → can never brick trading or be tuned on a live pool. **System settlement swaps
(`sender == vault`) get `baseFee`, never the surcharge** (blocker 3). Early surcharge fees accrue to our locked
position → into the 90/5/5. Complements the token max-wallet cap. Manifest-calibrated: `startFee`/`baseFee`/
`antiSnipeWindow`/slope.

## 5. Graduation = swap-only gross WETH volume (do-more #2; blocker 3 term + exclusions)
- `HydeHook.afterSwap` adds **`abs(actual WETH BalanceDelta)` in BOTH directions** to a per-pool cumulative counter —
  termed **"swap-only gross WETH volume"** (NOT "organic"). Incremented **only** in `afterSwap`, and **only when
  `sender != vault`**. This excludes, by construction: `donate()` / flash `take`-`settle` (never hit `afterSwap`) **and**
  Hyde's own settlement swaps (authenticated `sender == vault`) — closing the **donate→collect→settle→count** bypass
  kami flagged.
- `graduate` checks the counter ≥ `graduationThreshold` (WETH-denominated), monotonic, one-way, **label-only** (no LP
  unlock). **Honest residual:** still **wash-tradeable** (round-trip user swaps cost real fee + slippage each cycle —
  a real economic bar, far above free flash-donation, but not unspoofable). Label "traded-volume milestone"; clint pins
  the number. This makes the manifest §7 policy option (b) the default, cheaply.

## 6. LT→WETH settlement + oracle (blocker 3/4)
- **Settle path = DIRECT vault→PoolManager (blocker 3):** `HydeFeeVault.settle` implements the `unlockCallback` and swaps
  the parked LT reward leg → WETH via **`PoolManager.swap` inside its own `unlock`** — **not** UniversalRouter — so the
  hook sees `sender == vault` and applies the base-fee + volume-exclusion. Deltas fully settled (`take` WETH / `settle`
  LT) in the callback; `nonReentrant` + CEI. Floor: `minOut = max(hookTWAP·(1e4−MAX_SLIPPAGE_BPS)/1e4, callerMinOut)`,
  caller tighten-only; `ORACLE_NOT_READY` until the ring is window-full.
- **Oracle = real-tick observation RING (blocker 4):** the hook keeps a bounded fixed-cardinality ring of
  `{blockTimestamp, tickCumulative}`. On each swap's `afterSwap`: **integrate elapsed time at the *previously stored*
  tick** into `tickCumulative` (`tickCumulative += lastTick · (now − lastObsTime)`), then store the **actual post-swap
  tick** + `now`. `settle` reads a `TWAP_WINDOW` TWAP as `(tickCumulative_now − tickCumulative_{now−window}) / window`
  → price → floor. Handle: **same-block swaps** (dt = 0, no double-count), **no-swap intervals** (interpolate to `now`
  at the last stored tick when reading), **wraparound** (ring index mod cardinality), **full-window readiness** (oldest
  retained observation must be ≥ `TWAP_WINDOW` old, else `ORACLE_NOT_READY`). **Manipulation resistance comes from the
  time window, not from capping/falsifying ticks** (rev1's truncated-tick cap is dropped — it diverged from real price
  and could mis-price settlement). This is the V3 `observe()` mechanism re-homed in the hook.
- **90/5/5 solvency UNCHANGED** in the vault (WETH-leg reclassify net-zero; LT-leg `−amountIn`/`+measured wethAmt`;
  creator/Hyde buckets; holder epochs; `holderFunded−holderClaimed` + `accountedBalance`).

## 7. V4 threat model (unlock/delta/reentrancy/protocol-fee/hook + blocker-driven adds)
1. **Unauthorized initialization (blocker 5)** → `beforeInitialize` rejects `sender != factory` + validates LT/WETH +
   registered config; a predictable-CREATE2 pool can't be front-run-initialized by a third party.
2. **Zero-liquidity fee collection must not brick** → collection is a `modifyLiquidities(INCREASE 0 + TAKE_PAIR)`; the
   hook has **no** `beforeRemoveLiquidity`, so it neither blocks that nor traps LPs (test both).
3. **System-swap authentication** → `sender == vault` ⇒ `baseFee` + no volume; a spoofed sender can't (settlement is a
   direct vault `unlock`, `sender` is the vault; UniversalRouter/user paths carry the router/user as sender).
4. **Donation/flash exclusion** → counter moves **only** in `afterSwap` on a non-vault swap delta; `donate`/flash and
   settlement are excluded (test: donate LT → collect → settle → graduation counter unchanged).
5. **Oracle correctness/manipulation** → time-window ring (not tick-cap); interpolation/wraparound/`TWAP_WINDOW`
   maturity; resistance from window length; settle floor derived on-chain (caller tighten-only).
6. **Unlock-callback reentrancy / delta completeness** → all pool ops inside an `unlock` callback must zero every
   currency delta or revert; `collect`/`settle` `nonReentrant` + CEI; the singleton lock prevents nested unlocks.
7. **Hook callbacks must not brick swaps** → `beforeInitialize`/`beforeSwap`/`afterSwap` are bounded, non-reverting on
   the normal path (a reverting hook freezes trading); dynamic fee bounded `[baseFee, MAX_LP_FEE_CAP]`.
8. **Protocol fee** → V4 `PoolManager` has a governance-settable protocol fee (like V3 `feeProtocol`); record + monitor
   per launch pool at deploy.
9. **Hook address/permission mining** → deploy the hook via CREATE2 salt to an address whose low bits equal the flag
   set (§2), else `PoolManager` rejects init; verify at deploy (per-chain mined address in the manifest).
10. **External-LP safety** → external LPs can add/remove freely; only Hyde's own seeded NFT is custody-locked (test an
    external LP full add→remove cycle succeeds).

## 8. Preservation — precise (blocker 7)
**`HydeERC20`:** preserved entirely (token, EIP-2612, max-wallet, `sync`) — DEX-agnostic.
**`HydeFeeVault` — accounting PRESERVED, DEX-coupling REWRITTEN.** Preserved *logic/state*: epoch fields +
cumulative-`epochVested` vesting, exact 90/5/5 reclassification, `holderFunded`/`holderClaimed` + `accountedBalance`
solvency, `claim`/`claimCreator`/`claimHyde`, `sync`, `Multicall`, `noteRaw` pull-measure. **Rewritten:** its
immutables (drop V3 `swapRouter`/`positionManager`/oracle refs → V4 `PoolManager`/`Permit2`), the **`settle()` swap
body** (SwapRouter02 → direct `PoolManager.unlock` swap + `unlockCallback`), and the **oracle read** (V3 `observe` →
hook ring). Any V3 `TickMath`/oracle-lib imports retire (kuro 21293). **So `04f3f66` does NOT survive verbatim** — the
hard accounting math does; the DEX-coupling is respec'd.
**`HydeFeeCollector`:** changes materially (V3 `collect` → V4 `modifyLiquidities` fee-take; custody model on the v4 NFT).
**`HydeTokenFactory`:** full respec (V4 `initialize` + `PoolKey`+hook + v4 PM seed + hook address-mining).
**NEW `HydeHook`.**

## 9. Required tests / invariants (kami 21294) — for the rev7 spec
Unauthorized initialization reverts (non-factory `beforeInitialize`); fee collection with a **zero-liquidity change
succeeds** (doesn't brick); **external LP add→exit succeeds** (not trapped); **system-swap exclusion + base-fee**
(`sender==vault` ⇒ no volume, `baseFee`); **donation→collect→settle does NOT advance graduation**; **exact-in/out
both directions** counted as `abs(WETH BalanceDelta)`; **oracle ring** same-block/no-swap/wraparound/`TWAP_WINDOW`
maturity + `ORACLE_NOT_READY` before warm; unlock delta-completeness; dynamic-fee bounds; hook can't-brick-swaps;
protocol-fee monitoring; hook-address-permission mining. Plus the preserved vault/token invariants (epochs/split/
solvency/sync) carry unchanged.

## 10. Recommendation to Reviewer
Adopt this rev2 topology. On your clearance I write the full **rev7 spec** (§3 factory / §4 collector / §4b `settle` +
`HydeHook`, with the §9 invariant + threat matrix fully derived) and return it for audit before kuro implements.
Open manifest/calibration values (fork-tested): anti-snipe `startFee`/`window`/slope, `baseFee`(=1% tier),
`graduationThreshold`, `TWAP_WINDOW`/`MAX_SLIPPAGE_BPS`, oracle ring cardinality, and the mined hook address per chain.
