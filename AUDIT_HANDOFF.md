# Hydeout Own-Stack — External Audit Handoff Package

**Purpose:** everything an external security firm needs to audit the Hydeout own-stack Uniswap-V4 launchpad
contracts *before mainnet value*. Assembled by gojo (protocol) after a passing internal review; clint has chosen an
independent external audit before deploy (2026-07-15).

**Status:** contracts built, internally reviewed (46/46 Foundry tests vs real Uniswap V4, full security matrix), shipped
to `origin/main` (`aa1f896`). **NOT deployed on-chain.** No mainnet value at risk yet.

---

## 1. Scope (audit these)

| Contract | Role | LoC-ish | Notes |
|---|---|---|---|
| `src/HydeERC20.sol` | Cloned launch token (EIP-1167 target); EIP-2612; time-boxed max-wallet | small | no owner/mint/burn/pause; supply constant 1e9; **no `sync` hook (rev8)** |
| `src/HydeFeeVault.sol` | Per-token WETH fee settlement + creator/Hyde split; the ONE swap (LT→WETH) | large | holder/epoch machinery REMOVED (rev8); split via `NET_BPS=9500` |
| `src/HydeFeeCollector.sol` | Custodies the locked V4 position NFT; `collect` (5% in-kind carve) + `compound` (auto-LP) | large | the NEW rev8 surface — **audit `compound` hardest** |
| `src/HydeTokenFactory.sol` | Permissionless `launch`; CREATE2 deploy asserts (INV-C7b, HOOK_FLAGS) | large | seed single-sided; no pre-allocation |
| `src/HydeHook.sol` | Own V4 hook: anti-snipe dynamic fee · swap-volume graduation meter · real-tick TWAP oracle | large | non-fund-bearing; all 4 callbacks `onlyPoolManager` |
| `src/libraries/OracleLib.sol`, `TickMath.sol` | Oracle quote + tick math | small | |
| `src/interfaces/*` | Interfaces | — | |

**Out of scope:** the frontend (`hydeout-design-publish`), the interim Doppler-rail adapter, off-chain keeper/ops.

## 2. Authoritative spec
`CONTRACT_SPEC_L3.md` (rev8.3) is the full build spec + threat model + invariant matrix. **Read §4/§4b/§4c (collector/
vault/hook), §7 (threat model), §8 (invariants), §9 (deploy/CREATE2 cycle + asserts).** This handoff summarizes; the
spec governs.

## 3. Economic model (what the code must enforce)
- **Supply:** 1,000,000,000, constant — no mint, no burn. 100% seeded into the ONE locked position; **zero pre-mint,
  zero team allocation**.
- **Fee split (immutable, constructor-enforced):** 90% creator / 5% Hyde / **5% auto-compounded into permanently-locked
  liquidity**. Enforced by `hydeBps==500`, `liqBps==500`, and the deploy assert `NET_BPS + liqBps == 10000` (INV-C7b).
- **The 5% liquidity leg:** carved in-kind at `collect` (before the vault sees fees), accumulated in `pendingLiq{LT,WETH}`,
  and added into the collector's own custody-locked NFT via permissionless `compound()` — **add-only, TWAP-gated,
  residual-conserving**.
- **The ONE swap:** `settle` converts the LT fee leg → WETH (oracle-floored, partial-fill-rejected, one-shot callback).
- **Graduation:** label-only swap-volume milestone; **LP never migrates/unlocks** (currently stubbed).

## 4. Invariant matrix (prove/refute these)
**Compound / in-kind (rev8, the new surface):** INV-C1 sort-correct add (both token orders) · INV-C2 residual
conservation (measured decrement, never over-credit) · INV-C3 no over-add (`amountMax=pending` hard-cap) · INV-C4 TWAP
add-gate · INV-C5 min-add/dust + honest liveness · INV-C6 terminal custody of pending+added (no sweep/withdraw) · INV-C7
90/5/5 in-kind conservation · **INV-C7b cross-contract split-consistency deploy assert** · INV-C8 add-only/position-
monotonic.
**Carried (vault/token):** INV-1/2/3 (split/bps/immutable recipients) · INV-5 (supply constant) · INV-6 (max-wallet,
receive-only) · INV-13 (pull-measure donation-proof) · INV-27 (solvency, branch-exact settle) · INV-30 (register-before-
mint) · INV-32 (terminal conservation).
**V4:** INV-40 (**every hook entrypoint requires `msg.sender==POOL_MANAGER`** — Cork class) · INV-41 (zero-liq collect
not bricked) · INV-EXT (external LPs freely add/remove; **hook address mined to exactly 4 permission bits, no
remove/add/donate — FINDING-1**) · INV-42/43 (system-swap base-fee, oracle still updated) · INV-44 (donation no-grad) ·
INV-45/46 (oracle same-block coalesce, interpolate) · INV-48 (unlock delta-completeness + one-shot job-hash callback) ·
INV-49 (preloaded-PoolManager seed fails) · INV-50 (settle rejects partial fills) · INV-51 (oracle idle-pool + signed
rounding) · INV-52 (seed token-order + measured dust ≤ MAX_SEED_DUST).

## 4b. Internal review — findings already caught + resolved (verify the fixes, don't just re-find)
Our internal pass surfaced and fixed the following before this handoff. Listed so the audit can **verify each fix
holds** and spend its budget going deeper, not re-deriving what we already patched:
- **FINDING-1 — hook must be mined to EXACTLY the 4 permission bits.** A hook deployed to an address with a stray
  remove/add/donate bit set would trap external LP removals (honeypot-for-LPs, INV-EXT). **Fixed:** factory ctor
  `require(uint160(hook) & Hooks.ALL_HOOK_MASK == the 4 flags)` + hook-ctor `validateHookPermissions` + a negative test
  (`HookExternalLP.t`: a remove-bit hook traps `decreaseLiquidity`; the correct hook doesn't). *Verify: the assert is
  fail-closed and the mined mainnet address decodes to exactly {beforeInitialize, afterInitialize, beforeSwap,
  afterSwap}.*
- **Cork-class callback auth.** Original hook callbacks validated only the `sender` param (attacker-controlled), not
  `msg.sender`. **Fixed:** every hook entrypoint `require(msg.sender == POOL_MANAGER)` FIRST (INV-40). *Verify: direct
  calls from a non-PoolManager revert.*
- **INV-C7b cross-contract split-consistency.** `vault.NET_BPS` and `collector.liqBps` are independent immutables in
  separately-deployed contracts → could silently drift and break 90/5/5. **Fixed:** deploy assert `NET_BPS + liqBps ==
  BPS_DENOM`, abort on mismatch. *Verify: a mismatched pair aborts deploy.*
- **Invariant enumeration precision.** Clarified that INV-27 (solvency) and INV-30 (register-before-mint) are RETAINED,
  only the holder set (23/24/25/26/28/29) retired.
- **MEV refinements:** `compound` takes a caller-supplied `deadline` (not `block.timestamp`); settle's `wethOut≥minOut`
  is checked post-op inside the unlock (non-bypassable); the settle 3% slippage floor is a permissionless backstop with
  a keeper passing tighter `callerMinOut` (documented as ops, not a liveness dependency).

## 5. Threat model — mapped to real 2025 incidents (please pressure-test each)
| Incident (sourced) | Class | Our defense — verify it holds |
|---|---|---|
| **Cork Protocol $11M** (May 2025) | unauth'd V4 hook callback | all 4 hook entrypoints `require(msg.sender==POOL_MANAGER)` FIRST + `validateHookPermissions` in ctor; every unlock nets deltas to zero |
| **Bunni $8.4M** (Sep 2025) | custom-liq rounding drain | `compound` is add-only (no withdraw path); rounds in protocol favor; measured residual, never over-credits |
| **LIBRA $107M** (Feb 2025) | LP-yank rug | position custody-locked — no decrease/transfer/burn/sweep selector in bytecode |
| **SafeMoon $200M+** (SEC 2023) | fake lock | no LP tokens held to redeem; lock is codehash-provable, not custodial |
| **honeypot generators** | sell-block | max-wallet is receive-side only (never blocks a sell); no blacklist/pause/owner-setter |
| **Rugproof / pre-allocation** | insider bag | factory asserts 100% supply → locked position, 0 to team; factory/vault LT==0 post-seed |

## 6. Deploy-time safety asserts (must fire fail-closed on live addresses)
1. **HOOK_FLAGS:** `uint160(hook) & Hooks.ALL_HOOK_MASK == BEFORE_INITIALIZE|AFTER_INITIALIZE|BEFORE_SWAP|AFTER_SWAP`
   (zero add/remove/donate/returns-delta bits) — else external LPs get trapped. Abort on mismatch.
2. **INV-C7b:** `vault.NET_BPS() + collector.liqBps() == BPS_DENOM` — else 90/5/5 silently breaks. Abort on mismatch.
3. **Seed:** post-seed `factory`/`vault` LT balances == 0; measured dust ≤ `MAX_SEED_DUST`; `ownerOf(tokenId)==COLLECTOR`.

## 7. Trust assumptions / known accepted risks (disclose to the auditor)
- **WETH on Robinhood Chain 4663 is an upgradeable proxy** — external trust assumption (clint to ack). (USDG is no longer a dependency — the launch fee is native ETH.)
- **V4 governance-settable protocol fee** — recorded/monitored per pool at deploy.
- **Settle-keeper is an OPS optimization, NOT a liveness dependency** — the contract is safe without it (3% permissionless
  slippage backstop); keeper just tightens `callerMinOut`.
- **Internal review only so far** — this external audit is the gate before mainnet value.

## 8. Test coverage (46/46 Foundry, fork of 4663 real V4)
`test/`: `Compound.t` (Bunni: conserve/monotonic/no-over-credit) · `HookExternalLP.t` (Cork/FINDING-1: direct-call
reverts + remove-bit trap demo) · `AntiRug.t` (immutable bps, forbidden selectors, no-burn) · `Factory.t` +
`Lifecycle.t` (launch→seed→collect→settle→compound) · `VaultInvariant.t` (256×8192 solvency) · `VaultAccounting.t` ·
`HydeERC20.t` (max-wallet never blocks sells).

## 9. Deploy parameters — ⚠️ TBD, pending clint (feed BOTH the audit scope and the deploy)
- `hydeoutTreasury` (receives 5%) · `launchFeeTreasury` (receives the **0.0004 ETH** native launch fee — MUST be an EOA, since the fee is forwarded with a raw `.call`) · factory-owner multisig
- anti-snipe schedule (`startFee`/`baseFee`/`antiSnipeWindow`) · `maxWalletBps`/`maxWalletWindowSecs`
- `graduationThreshold` (or keep stubbed) · `MAX_SLIPPAGE_BPS` (default 300) · `MAX_SEED_DUST` · `TWAP_WINDOW`/ring
  cardinality
- launch preset tuples (sort/initialTick/tickLower/tickUpper), constructor-validated

## 10. Post-audit → deploy sequence (clint-authorized, separate step)
mine hook address → CREATE2 cycle (factory→vault→collector→hook) with §6 asserts firing on live addresses → record
manifest (mined addr + flag bits + codehash) → repoint the site data layer (Doppler Airlock → Hyde factory reads;
adapter boundary already coded) → own-stack live.

**Deploy cost (measured — `forge test --gas-report` dry-run, no on-chain tx; per-step deployment gas):**
HydeERC20 impl 1,078,888 · StateView 654,433 · HydeFeeVault 2,164,855 · HydeFeeCollector 2,230,434 · HydeHook 1,470,311
(CREATE2 mining is off-chain = 0 gas) · HydeTokenFactory 2,498,760 · initFactory ×3 132,452 · tx bases ~189,000 →
**~10.42M gas full stack** (~8.5M if StateView/impl reused). At Robinhood-4663 live gas ~0.05 gwei ≈ **0.0005 ETH (~$1.5)**;
≤0.1 gwei ≈ 0.001 ETH. **First launch** (`factory.launch`) ≈ 1.19M gas ≈ 0.00006 ETH + the **0.0004 ETH** native launch fee (`msg.value`). **Fund the
deployer ~0.01 ETH** (native 4663) = 10–20× headroom over the stack deploy + several launches. (Numbers are bytecode-
dominated so representative; prod immutables don't move them.)

---
*gojo (protocol) · internal reviewer: casper · builder: kuro. Governing doc: `CONTRACT_SPEC_L3.md` rev8.3.*
