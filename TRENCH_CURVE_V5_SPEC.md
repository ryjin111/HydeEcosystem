# Hydeout V5 — Trench Curve

- Status: implementation specification
- Product version: Hydeout V5
- DEX rails: Uniswap V3 on Arc and Stable, Uniswap V4 on Robinhood Chain and Arbitrum
Legacy compatibility: existing Instant V3/V4 launches remain readable, tradeable, and claimable

## 1. Product contract

Trench Curve is one launch lifecycle with two chain-specific graduation adapters:

| Chain rail | Curve market | Graduation market | Permanent custody |
| --- | --- | --- | --- |
| Arc / Stable | Uniswap V3 single-sided curve position | Uniswap V3 locked positions | V5 V3 locker |
| Robinhood / Arbitrum | Uniswap V4 single-sided curve position with the Hyde hook | Uniswap V4 locked positions | V5 V4 collector |

The user-facing lifecycle is identical:

1. Launch creates the token and a real Uniswap pool.
2. Curve trading is live from block zero.
3. Progress moves as the curve allocation is bought or sold.
4. At 100%, a permissionless graduation delay begins.
5. Graduation atomically converts the temporary curve position into permanent locked liquidity.
6. Trading continues in the same pool.

There is no synthetic off-chain price, presale wallet, or admin-triggered migration.

## 2. Locked economic defaults

- Token supply: `1_000_000_000e18`, fixed forever.
- Curve allocation: 80% (`800_000_000e18`).
- Graduation reserve: 20% (`200_000_000e18`).
- No post-launch mint or burn authority.
- No creator allocation outside an explicitly configured, disclosed vesting module.
- Graduation delay: 300 seconds.
- Progress: curve inventory sold, not swap volume and not fees.
- 100% means curve-token principal is exhausted within the configured dust bound.
- The final graduation transaction rechecks spot, TWAP, inventory, custody, and minimum proceeds.
- Existing launch-fee policy remains chain-specific and immutable.

Fee policy remains compatible with the live rails:

- V3: 95% creator / 5% Hydeout on both collected assets.
- V4: 90% creator / 5% Hydeout / 5% retained in-kind for locked liquidity.
- V4 opening anti-snipe fees remain enforced by the pool hook.

## 3. State machine

Each token has exactly one lifecycle:

```text
NONE
  └─ launch ─► CURVE_ACTIVE
                  └─ signal (100% + checks) ─► GRADUATION_SIGNALED
                                                    └─ finalize ─► GRADUATED
```

Rules:

- `NONE -> CURVE_ACTIVE` is factory-only and all-or-revert.
- `signalGraduation` is permissionless.
- `signalGraduation` requires the curve position to be at its terminal side with no more than the configured token dust.
- `finalizeGraduation` is permissionless and only valid after `GRADUATION_DELAY`.
- Finalization requires a delay-window TWAP at the terminal boundary, not only a manipulable spot tick.
- Finalization is one-way and all-or-revert.
- A stale signal never bypasses the final spot, TWAP, inventory, proceeds, and custody checks.
- After graduation, no protocol path can decrease, transfer, approve, burn, or withdraw the permanent positions.

## 4. Supply and custody flow

### Launch

1. Clone and initialize the immutable V5 token.
2. Mint the full supply to the factory.
3. Transfer the 20% graduation reserve to the chain's graduator.
4. Seed the 80% curve allocation as single-sided token liquidity.
5. Mint the curve position NFT directly to the graduator.
6. Assert the NFT owner, exact token allocation, zero quote-asset contribution, and bounded seed dust.
7. Record creator, pool, curve position, ranges, reserve, and state.

The graduator has temporary custody of curve principal only because graduation must remove that position. It has no owner withdrawal, arbitrary-call, approval, or generic NFT-transfer path.

### Graduation

The finalization transaction:

1. Collects and accounts for outstanding curve swap fees.
2. Removes the entire curve position.
3. Collects the released quote principal.
4. Burns the now-empty temporary curve NFT where supported.
5. Combines quote principal with the 20% token reserve.
6. Seeds a primary full-range permanent position, then adds bounded one-sided residual
   positions when either asset remains above the dust limit. This preserves continuous
   two-way trading while consuming the released assets without an internal swap.
7. Mints the permanent position NFTs directly to the permanent locker/collector.
8. Transfers bounded rounding dust to the permanent locker/collector.
9. Asserts the graduator retains no unaccounted token or quote principal.
10. Marks the token `GRADUATED` and emits a complete custody manifest.

The curve principal can therefore move only from:

```text
temporary curve NFT -> graduation transaction -> permanent locked NFTs
```

There is no route from the curve NFT to an EOA, treasury, creator, factory owner, or arbitrary contract.

## 5. V3 adapter

### Contracts

- `TrenchV3Factory`
- `TrenchV3Graduator`
- `TrenchV3Locker`
- immutable `TrenchToken` implementation

### Curve

- A real V3 pool is created and initialized at the configured floor.
- The curve allocation is minted single-sided across `[floorTick, graduationTick]`, with sort-aware inversion.
- The curve NFT recipient is `TrenchV3Graduator`.
- V3 pool observations are expanded at launch so the graduation TWAP can mature.

### Graduation

- `TrenchV3Graduator` is the only contract containing the V3 `decreaseLiquidity` and temporary-position `burn` selectors.
- Those selectors are reachable only inside `finalizeGraduation` for a registered, signaled, ready curve position.
- Permanent NFTs are minted directly to `TrenchV3Locker`.
- `TrenchV3Locker` exposes collect/read operations only and has no decrease, burn, transfer, approval, or generic-call selector.
- Collected fees are split 95/5 in-kind to the immutable creator and Hyde treasury.

## 6. V4 adapter

### Contracts

- `TrenchV4Factory`
- a fresh, address-mined deployment of the audited `HydeHook` code, one-shot bound to the V5 factory
- `TrenchV4Graduator`
- `TrenchV4Locker`
- immutable `HydeERC20` implementation

### Curve

- A real V4 pool is initialized with a chain-local V5 instance of the audited Hyde dynamic-fee hook.
- An already-live hook address cannot be reused because `HydeHook.factory` is one-shot immutable;
  deployment must mine a new permission-bit-correct address and atomically bind it to the V5 factory.
- The curve allocation is minted single-sided into the configured curve range.
- The curve NFT recipient is `TrenchV4Graduator`.
- The hook enforces initialization authorization, opening anti-snipe fees, and oracle observations.

### Graduation

- `TrenchV4Graduator` contains one narrowly gated `BURN_POSITION` action for the temporary
  curve NFT; V4 atomically removes its liquidity and burns the receipt.
- Permanent NFTs are minted directly to `TrenchV4Locker`.
- The locker has no decrease, burn, transfer, approval, withdrawal, or generic-call path.
- It accounts each harvested asset directly as 90% creator claimable, 5% Hyde claimable,
  and 5% in-kind auto-LP (with rounding dust retained in the auto-LP bucket).
- Permissionless compounding can only add the in-kind bucket to the primary permanent NFT.

## 7. Progress API

Both adapters expose the same normalized read model:

```solidity
struct CurveProgress {
    uint256 sold;
    uint256 curveAllocation;
    uint256 progressWad;       // 0..1e18
    uint256 quotePrincipal;
    uint256 minimumProceeds;
    uint64 signaledAt;
    uint64 finalizableAt;
    uint8 state;               // NONE, CURVE_ACTIVE, GRADUATION_SIGNALED, GRADUATED
}
```

Requirements:

- `sold = curveAllocation - remainingCurveTokenPrincipal`.
- Fee growth and external donations do not increase `sold`.
- `progressWad` is clamped to `[0, 1e18]`.
- Buys can increase progress and sells can decrease it before graduation.
- The UI must never derive graduation solely from indexed swap volume.
- The on-chain read is authoritative.

## 8. Safety invariants

### Token

- V5-1: total supply is exactly 1 billion and can never change.
- V5-2: no owner mint, burn, blacklist, tax, or post-launch metadata authority exists in the token.
- V5-3: all token allocations sum exactly to total supply.

### Curve

- V5-4: launch seed consumes zero quote asset.
- V5-5: curve seed is exactly the configured curve allocation minus bounded rounding dust.
- V5-6: the curve NFT is always owned by the registered graduator before graduation.
- V5-7: progress excludes fees, donations, and external LP balances.
- V5-8: signaling and finalization are permissionless and recipient-independent.
- V5-9: finalization requires terminal inventory, minimum proceeds, spot, and TWAP checks.

### Terminal custody

- V5-10: the temporary curve position can only be decreased during successful finalization.
- V5-11: all released curve principal is consumed by permanent seeding or transferred as bounded dust to permanent custody.
- V5-12: no creator, treasury, owner, or caller receives curve principal during graduation.
- V5-13: permanent position liquidity is monotonically non-decreasing.
- V5-14: permanent NFTs have no transfer, approve, decrease, burn, withdraw, or arbitrary-call path.
- V5-15: external LPs in the same pool remain freely removable.

### Fees

- V5-16: V3 fee distribution conserves 100% as creator 95% + Hyde 5%.
- V5-17: V4 fee distribution conserves 100% as creator 90% + Hyde 5% + locked-liquidity 5%.
- V5-18: principal and fees are measured separately during graduation.
- V5-19: donations cannot create fee credit or graduation progress.
- V5-20: claim liabilities never exceed accounted assets.

### Hook and oracle

- V5-21: every V4 hook callback authenticates the canonical PoolManager first.
- V5-22: only a factory-registered pending pool can initialize.
- V5-23: same-block swaps cannot flush the oracle history.
- V5-24: graduation uses an interpolated, mature TWAP covering the full delay window.
- V5-25: system settlement swaps do not advance progress.

### Authority

- V5-26: owner authority can pause only new launches.
- V5-27: owner authority cannot alter live pools, recipients, allocations, fees, ranges, or graduation rules.
- V5-28: ownership is renounceable after the deployment manifest is verified.
- V5-29: no proxy, delegatecall admin, selfdestruct, or arbitrary executor exists.

## 9. UI contract

### Launch card

- `V5 · TRENCH CURVE`
- DEX destination: `V3 LOCKED` or `V4 LOCKED`
- curve allocation and graduation reserve
- floor market cap and graduation market cap
- fee split
- anti-snipe policy
- permanent-lock explanation

### Token page

- progress bar based on the on-chain `CurveProgress`
- current price and market cap
- token sold / curve allocation
- quote principal / minimum proceeds
- `Curve active`, `Graduation delay`, or `Bonded · LP locked`
- permanent locker and position links after graduation

### Legacy

- Existing launches remain visible with `LEGACY · INSTANT V3` or `LEGACY · INSTANT V4`.
- Legacy fee claims and swaps remain functional.
- Legacy launches never receive fabricated curve progress.

## 10. Deployment gate

No V5 factory becomes the UI default until all of the following pass:

1. Unit tests for both token-order branches and all state transitions.
2. Fuzz tests over tick ranges, rounding, supply allocation, and partial progress.
3. Invariant tests for custody, principal conservation, fee solvency, and monotonic permanent liquidity.
4. Fork tests against the exact V3/V4 deployments for each supported chain.
5. Selector enumeration proving permanent lockers cannot move principal.
6. Bytecode/codehash manifest checks for every immutable dependency.
7. A small-value mainnet smoke launch and full curve-to-graduation rehearsal.
8. Independent security review.

Only after the gate passes:

- publish verified V5 addresses;
- switch the launch UI to V5;
- pause legacy factories where supported;
- retain legacy discovery, trading, and claims indefinitely.
