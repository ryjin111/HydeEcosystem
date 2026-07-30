# Hydeout V5 Trench Curve — internal contract audit

Date: 2026-07-30

Scope: V5 V3/V4 factories, graduators, permanent lockers, math adapters, token/hook integration,
deployment scripts, lifecycle/fuzz/invariant tests, selector surfaces, and live dependency manifests.

This is an internal engineering review, not the independent security review required before release.
No deployment or mainnet transaction was performed during this audit. All four stacks were subsequently
deployed; their post-deploy evidence is recorded under `deployments/*-v5.json`.

## Result

One availability defect was confirmed and fixed. No principal-withdrawal, recipient-redirection,
post-launch mint/burn, permanent-NFT movement, or owner escalation path was found in the reviewed
V5 contracts.

### M-01 — long-idle V4 oracle interpolation overflow

Status: fixed

`HydeHook._interpolateAtTarget` previously multiplied the cumulative delta and elapsed offset as
`int56`. After a sufficiently long idle gap, the first new observation could make that intermediate
overflow even though the final interpolated cumulative remained bounded by two valid `int56`
endpoints. `consult()` would revert until the requested TWAP target moved past the newest
observation, temporarily blocking oracle-dependent operations such as auto-LP compounding.

The interpolation now widens both operands to `int256` before multiplication and narrows only the
bounded final result. `test_oracleConsult_survivesFirstSwapAfterLongIdleGap` covers a one-year idle
gap followed by a swap and a 300-second consultation.

### I-01 — missing fork RPCs reported as passing tests

Status: fixed

The V5 fork tests returned normally when their RPC environment variable was absent, which Foundry
reported as a passing test. They now call `vm.skip` with an explicit reason. With public RPCs
configured, the Arc, Stable, Robinhood, and Arbitrum dependency-manifest tests all pass against live
chain state.

### Coverage gaps closed

- V3 and V4 sells reduce curve progress before graduation.
- A stale graduation signal cannot bypass the final spot/inventory recheck.
- V4's 5% in-kind fee buckets compound into the primary permanently locked position.
- Full launch, live-pool trade, signal, TWAP wait, and finalization fork lifecycles pass for Arc,
  Stable, Robinhood, and Arbitrum using the production economic inputs and exact deployment topology. The
  tests use the live DEX dependencies but deploy the V5 stack ephemerally inside each fork.
- Arc's live native-USDC codehash, metadata, factory binding, and fee tier are checked directly. Its
  stateful lifecycle replaces only the USDC facade because Foundry does not implement Arc's custom
  native-transfer precompile; the Arc V3 factory, pool, and PositionManager remain live fork state.
- The shared hook test setup now always compiles the PositionManager artifacts required by
  string-based `vm.getCode` deployment helpers.

## Verification

- V3 pinned profile with Arc and Stable RPCs: 20 passed, 0 failed, 0 skipped.
- V4 pinned profile with Robinhood and Arbitrum RPCs: 35 passed, 0 failed, 0 skipped.
- Live dependency forks: eight checks passed across Arc, Stable, Robinhood, and Arbitrum: four runtime
  manifest checks and four full launch-to-permanent-lock lifecycle checks.
- Shared hook regressions: 19 passed across oracle churn, external-LP permissions, anti-rug, and
  compounding suites.
- High-severity Forge lint findings: 0.
- Locker selector enumeration found no NFT transfer/approval, liquidity-decrease, burn, withdrawal,
  multicall, delegatecall, or arbitrary-execution surface.
- V3 and V4 production contracts remain below runtime and initcode size limits.

## Remaining release blockers

1. Obtain the independent security review required by the V5 specification.
2. Perform the small-value mainnet rehearsal on each rail. The post-fix V4 salts, hashes, and manifests
   were regenerated and used for the mined deployments.
