# Hydeout Slipstream Future Plan

- Status: research and architecture planning only
- Target: future Hydeout release after V5
- Decision state: not approved for production migration

## 1. Purpose

Evaluate Aerodrome/Velodrome Slipstream as a future concentrated-liquidity rail for Hydeout.
Slipstream may eventually replace the Uniswap V4 hook rail on officially supported chains, but it
does not replace the current V3/V4 deployments during research, implementation, or audit.

The intended user lifecycle remains:

```text
launch -> 80% live curve -> terminal inventory -> delay and safety checks
       -> combine curve proceeds with 20% reserve
       -> mint permanent concentrated liquidity -> lock the LP NFT forever
```

Existing launches and locked positions are immutable. Any future migration applies to new launches
only; Hydeout must not move, unwrap, or relabel existing V3 or V4 liquidity.

## 2. Chain policy

Slipstream is not assumed to exist on every EVM chain. Hydeout may enable the rail only when a
canonical Aerodrome/Velodrome deployment is present and all required contracts are independently
verified.

Initial evaluation targets:

- Base: Aerodrome Slipstream.
- Optimism and eligible OP Superchain networks: Velodrome Slipstream.
- Stable: retain the existing V3 rail unless a canonical, demonstrably superior venue is deployed.
- Arbitrum and Robinhood: retain the existing V4 rail during evaluation.
- Arc: remain Coming Soon until public mainnet and its canonical liquidity venues are live.

Self-deploying the open-source Slipstream contracts on an unsupported chain would create a
Hydeout-operated fork. It would not inherit official routing, gauges, emissions, governance, or
ecosystem support and must never be presented as canonical Aerodrome or Velodrome.

Every enabled chain requires a fail-closed manifest containing at least:

- pool factory and implementation;
- nonfungible position manager;
- router and quoter;
- swap-fee and unstaked-fee modules;
- optional gauge and voter contracts;
- deployment blocks, runtime code hashes, and immutable bindings;
- a funded read, swap, fee-collection, and full graduation rehearsal.

## 3. Required launch protections

Max-wallet and anti-snipe protections are mandatory release requirements, not optional UI settings.

### 3.1 Max wallet

Retain the current token-level, time-boxed max-wallet design:

- enforced by `HydeERC20`, independently of the DEX or router;
- applies to recipient accumulation and never blocks selling;
- bounded to the existing 0.01%-3% supply range;
- bounded to the existing 1-second to 1-hour launch window;
- configured once during token initialization with no owner setter;
- uses a frozen infrastructure exemption set with no post-launch whitelist authority.

The Slipstream pool, position manager, factory, graduator, permanent locker, router, and any approved
gauge must be included in the fixed exemption set before the token supply is minted. Fork tests must
prove that swaps, graduation, fee collection, and optional gauge operations cannot be blocked by the
wallet cap.

### 3.2 Anti-snipe

The current V4 opening-fee schedule is enforced by a hook. Slipstream has no equivalent per-launch V4
hook, so a migration cannot silently remove this protection.

One of these enforcement models must pass review before Slipstream launches:

1. Use an official, pool-enforced Slipstream dynamic-fee module that supports Hydeout's bounded,
   decaying opening fee and cannot be bypassed through another router.
2. Keep the launch curve in a Hydeout-controlled contract with bounded buy limits and opening fees,
   then use Slipstream only as the post-graduation liquidity destination.
3. Adopt a formally reviewed alternative that provides equivalent protection at the token or pool
   level.

UI-only throttles and a Hydeout-only router are insufficient because traders can call a permissionless
pool through another router or directly. Anti-snipe enforcement must occur in contracts on every swap
path.

The selected design must also retain:

- max-wallet enforcement as an independent defense;
- no blacklist, pause, confiscation, or owner-controlled exemption list;
- no indefinite launch tax;
- explicit maximum fee and maximum duration bounds;
- exemptions for graduation settlement transactions;
- adversarial testing with multiple wallets, direct pool calls, alternate routers, and same-block buys.

## 4. Fee model

The implementation must separate three different fees:

1. **Launch fee:** an immutable, chain-specific Hydeout factory charge.
2. **Pool swap fee:** configured through the canonical Slipstream pool or approved fee module.
3. **Collected-fee split:** applied by the Hydeout permanent locker after fees are collected.

The initial target is to preserve the V3-style creator split unless protocol economics require a
different disclosed policy:

- creator share credited by the locker;
- Hydeout share credited by the locker;
- any retained-liquidity share kept in permanent custody;
- upstream Aerodrome/Velodrome protocol fees accounted for before displaying creator estimates.

The launched token should remain a clean ERC-20. Do not add fee-on-transfer buy/sell taxes to emulate
a V4 hook; they create router, aggregator, liquidity, and accounting incompatibilities.

Custom pool fees are allowed only when the canonical deployment grants the required authority through
a documented fee module. Hydeout must not advertise creator-configurable fees when the venue's fee
manager or governance controls them.

## 5. Graduation architecture

Add Slipstream as an explicit engine, never as the default fallback for an unknown chain:

```text
chain registry
  |- uniswap-v3
  |- uniswap-v4-hook
  `- slipstream-cl
```

Proposed contracts:

- `TrenchSlipstreamFactory`: clone and initialize the token, create/initialize the pool, mint the
  single-sided curve position, and transfer the 20% reserve to the graduator.
- `TrenchSlipstreamGraduator`: register custody, measure inventory progress, enforce the TWAP and
  delay, remove the temporary position, and seed permanent liquidity.
- `TrenchSlipstreamLocker`: permanently custody the final LP NFT and expose collect/read/claim
  operations only.
- `SlipstreamAdapter`: isolate venue-specific pool creation, quoting, mint, collect, and oracle calls.

The factory, graduator, and locker must preserve the existing V5 invariants:

- fixed one-billion token supply;
- 80% curve allocation and 20% graduation reserve;
- no creator presale allocation;
- progress derived from curve inventory rather than gross volume or donations;
- permissionless signal and finalize operations;
- minimum graduation delay;
- mature TWAP, terminal-price, custody, dust, and minimum-proceeds checks;
- principal and fees accounted separately;
- temporary position removable only inside verified graduation;
- permanent position cannot be transferred, approved, decreased, burned, or withdrawn;
- bounded dust remains in permanent custody;
- no owner rescue or arbitrary-call path.

## 6. Gauges and emissions

Gauge support is deferred from the first Slipstream release.

The first version should keep the permanent LP NFT unstaked so the locker can collect and split swap
fees using a simple, auditable path. Gauge staking may change fee entitlement, add emissions, require
token or pool listing, and move custody through additional contracts.

A later gauge adapter requires a separate threat model covering:

- whether a permanently locked NFT can be staked without creating an unstake or transfer escape;
- who may create, kill, revive, or configure the gauge;
- whether the position earns swap fees, emissions, or only one of them;
- how AERO/VELO emissions are split and claimed;
- what happens if a gauge or reward contract is replaced;
- whether external governance can impair collection without endangering principal.

## 7. Migration phases

### Phase 0 - dependency verification

- Freeze the exact canonical contract versions and licenses.
- Record deployment addresses, code hashes, permissions, fee modules, and audit reports.
- Confirm pool creation, oracle, position-manager, and collect semantics on a live fork.
- Recheck the Aerodrome/Velodrome-to-Aero roadmap before freezing dependencies.

### Phase 1 - adapter prototype

- Port the V5 V3 lifecycle behind `SlipstreamAdapter`.
- Implement max-wallet exemptions and one candidate anti-snipe model.
- Add local lifecycle, fuzz, invariant, and malicious-token tests.
- Do not deploy mainnet contracts or expose a live UI route.

### Phase 2 - live-fork qualification

- Run full curve-to-graduation tests on Base and Optimism.
- Test direct swaps and alternate routers for anti-snipe bypasses.
- Verify token sorting, tick spacing, fee-module behavior, TWAP maturity, rounding, and dust.
- Verify that only fee claims remain reachable after permanent custody.

### Phase 3 - security review

- Complete an internal selector and authority audit.
- Obtain an independent contract review focused on the new adapter and upstream assumptions.
- Rehearse small-value launch, buy, sell, signal, delay, graduation, collect, and claim flows.

### Phase 4 - limited launch

- Enable one canonical chain through a runtime-hash-gated manifest.
- Label the rail explicitly as Aerodrome or Velodrome Slipstream.
- Monitor quotes, graduation solvency, fee collection, and indexer consistency.
- Keep existing V3/V4 rails available and unchanged.

### Phase 5 - migration decision

Consider replacing new V4-hook launches only after the Slipstream rail demonstrates equivalent or
better safety, execution quality, fee reliability, liquidity discovery, and operational independence.
The decision must be chain-by-chain; there is no global automatic migration.

## 8. Release blockers

Slipstream remains a future plan while any of these are unresolved:

- no pool-enforced anti-snipe design with demonstrated bypass resistance;
- incomplete max-wallet exemption and alternate-router tests;
- unverified canonical contracts or fee-module authority;
- inability to reproduce the V5 inventory/TWAP graduation checks;
- a custody path that allows the permanent NFT or principal to leave;
- dependence on an unverified indexer or centralized API for correctness;
- unclear protocol-fee or gauge economics;
- missing independent review or small-value mainnet rehearsal;
- upstream Aero migration changes the frozen contracts or integration surface.

## 9. References

- Aerodrome documentation: <https://aerodrome.finance/docs>
- Aerodrome verified contracts: <https://aerodrome.finance/security#contracts>
- Velodrome developer guide: <https://github.com/velodrome-finance/docs/blob/main/content/sdk.mdx>
- Velodrome Superchain Slipstream deployments:
  <https://github.com/velodrome-finance/superchain-slipstream/tree/main/deployment-addresses>
- Slipstream contracts: <https://github.com/velodrome-finance/slipstream>
