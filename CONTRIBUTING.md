# Contributing to Hyde Ecosystem

Thanks for your interest. Hyde is a token launchpad on Uniswap V4 (contracts +
a Vite/React frontend). This guide covers how to build, test, and propose
changes.

Please also read the [Code of Conduct](CODE_OF_CONDUCT.md). Security issues have
their own private path — see [SECURITY.md](SECURITY.md), **do not** file them as
public issues.

## Getting set up

Prerequisites and full run steps are in the [README](README.md#install--run).
In short:

```bash
git clone https://github.com/ryjin111/HydeEcosystem.git
cd HydeEcosystem
npm ci          # exact, reproducible install from package-lock.json
npm run dev     # launchpad UI on http://localhost:5173
```

Contracts (optional, needs [Foundry](https://book.getfoundry.sh/)):

```bash
cd contracts
forge install
forge test       # run PLAIN forge test — see the gotcha below
```

## Before you open a PR

Run the same checks the Reviewer runs, and paste the results in the PR:

- **Frontend:** `npm run build` — must type-check and build with no errors.
- **Contracts:** `forge test` — must be green (a clean run is **55 pass / 1
  skipped**; the 1 skip is the optional testnet-fork smoke).
- ⚠️ **Always run plain `forge test`.** A `--match*` filter sparse-prunes
  `ForceCompile.sol` and breaks `vm.getCode` at `setUp` on every suite. If you
  see `vm.getCode: no matching artifact`, you used a filter — drop it.

## Change guidelines

- **Keep the anti-rug and immutability guarantees intact.** Do not add runtime
  fee setters, mint/burn/pause on the token, an LP-withdraw path, a blacklist,
  or any owner power beyond the existing renounceable pause of *new launches*.
  Any change to those properties needs a separate threat-model/spec decision
  first — flag it in the issue, don't just build it.
- **Fee split and protection parameters are Solidity-hard-coded** (`hydeBps`,
  `liqBps` are `require`-locked to `500`; the 90/5/5 split is constructor-
  immutable). Changing them is a code change **and a re-audit**, not a config
  tweak.
- **Match the surrounding code** — the contracts carry invariant annotations
  (`INV-*`, `FINDING-*`); if you touch guarded logic, update/add the
  corresponding test and annotation.
- **Never commit secrets.** `.env*` is gitignored; keep it that way. Server
  secrets (Filebase, KV) live in Vercel, not the repo.
- Keep commits scoped and messages descriptive.

## Review & merge

This repo is reviewed before merge. Open a PR against `main` with a clear
description of *what* changed and *why*, and the test/build output above. A
maintainer/Reviewer audits correctness and the security claims before the change
lands on `main`.

## Docs

The authoritative specs live at the repo root:
[`CONTRACT_SPEC_L3.md`](CONTRACT_SPEC_L3.md) (build spec, threat model, invariant
matrix), [`AUDIT_HANDOFF.md`](AUDIT_HANDOFF.md) (external-audit handoff),
[`PROTOCOL_PLAN.md`](PROTOCOL_PLAN.md), and
[`HYDEOUT_DESIGN_SPEC.md`](HYDEOUT_DESIGN_SPEC.md). Keep them in sync when you
change behavior they describe.
