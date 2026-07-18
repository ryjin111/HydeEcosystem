# Security Policy

Hyde is an un-ruggable token launchpad built on Uniswap V4. Because it handles
value, we take security reports seriously.

## Current deployment status

- Contracts are **built and internally reviewed by an AI-agent team**, but are
  **NOT externally audited**.
- The own-stack launchpad is live only on **Robinhood Testnet (chain 46630)**.
- The contracts are **NOT deployed with real value on Robinhood Chain mainnet
  (4663)**. A professional external audit is the explicit gate before any
  mainnet-value deployment.

Treat nothing here as production-safe until that external-audit gate is cleared.

## Reporting a vulnerability

**Please do not open a public issue for a security vulnerability.** Public
disclosure of an unfixed flaw in a live-value contract can put funds at risk.

Instead, report it privately via GitHub:

1. Go to the repository's **Security → Advisories → "Report a vulnerability"**
   ([private security advisory](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability)), or
2. Contact the maintainer **[@ryjin111](https://github.com/ryjin111)** directly.

Please include:

- The affected contract/file and function.
- A description of the impact (fund-loss, DoS, griefing, etc.) and severity.
- Steps or a proof-of-concept (a failing Foundry test is ideal).
- Any suggested remediation.

## Scope

**In scope**

- The five core contracts in `contracts/src/` (`HydeTokenFactory`, `HydeERC20`,
  `HydeFeeCollector`, `HydeFeeVault`, `HydeHook`) and their libraries.
- The deploy script and its fail-closed invariants
  (`contracts/script/DeployHydeStack.s.sol`).
- The serverless API routes in `api/` (IPFS pinning + rate limiting), especially
  anything touching the paid Filebase credentials.

**Out of scope**

- The upgradeable WETH/USDG proxies on Robinhood Chain 4663 (a disclosed
  external trust assumption — see the README).
- Testnet-only funds and third-party infrastructure (RPC providers, Vercel,
  GitHub).
- Findings already documented as fixed (F1–F8) in `AUDIT_HANDOFF.md`.

## Response

We aim to acknowledge a valid report promptly, confirm the finding, and — where
the contracts are still at zero mainnet value — fix and re-review before any
deployment. Since the stack is deliberately immutable once deployed, a fix to a
deployed stack means a **new deployment**, not an upgrade.
