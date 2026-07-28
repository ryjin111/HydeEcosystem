# Hyde Ecosystem

**A token launchpad built on Uniswap V4.**

Hyde lets anyone launch an ERC-20 whose entire supply is seeded into a single, permanently custody-locked V4 liquidity position. There is no team allocation, no pre-mint, no mint/burn/pause, and no path for anyone — including the creator or the protocol — to pull the liquidity. Trading fees are split **90% creator / 5% Hyde / 5% permanently auto-compounded back into the locked position**, so the liquidity floor only ever grows.

The protocol contracts, the launchpad frontend, and the security audit in this repository were designed, built, and adversarially reviewed by an autonomous team of AI agents (see [AI-Agent Audit](#ai-agent-audit)).

- **Frontend:** live on Vercel (Vite + React + wagmi/viem).
- **Own-stack launchpad:** live on **Robinhood Testnet (chain 46630)** — the factory/hook/vault/collector are deployed there and the board reads real `LaunchCreated` events.
- **Mainnet (Robinhood Chain 4663):** contracts built + internally audited (~55 Foundry tests against real Uniswap V4). **Not yet deployed with mainnet value** — deploy is gated behind an external audit.

---

## Table of Contents
- [What We Built](#what-we-built)
- [How It Works](#how-it-works)
- [Fees & Parameters](#fees--parameters)
- [Anti-Rug Guarantees](#anti-rug-guarantees)
- [Security / Exploit Threat Model](#security--exploit-threat-model)
- [AI-Agent Audit](#ai-agent-audit)
- [Tech Stack](#tech-stack)
- [Install & Run](#install--run)
- [Repository Layout](#repository-layout)
- [Deep-Dive Docs](#deep-dive-docs)
- [Status & Disclaimers](#status--disclaimers)

---

## What We Built

### Smart contracts (`contracts/`) — own Uniswap V4 stack
Five core contracts with **56 Foundry test/invariant functions** (55 pass · 1 skipped). They run against **real Uniswap V4 core + periphery deployed in a local Foundry harness** (via v4-core's `Deployers`) — **not a chain fork**. A single *optional* smoke test (`TestnetForkSmoke`) forks a live testnet when `TESTNET_RPC` is set, and skips cleanly otherwise.

| Contract | Role |
|---|---|
| `HydeTokenFactory.sol` | Permissionless `launch()`. CREATE2-deploys the token, seeds 100% of supply single-sided into one V4 position, and fires fail-closed deploy asserts (hook-flag bits, split consistency, zero residual). No pre-allocation. |
| `HydeERC20.sol` | The launched token — EIP-1167 clone target, EIP-2612 permit, time-boxed receive-only max-wallet. **No owner, mint, burn, or pause.** Supply is a constant 1e9. |
| `HydeFeeCollector.sol` | Custodies the locked V4 position NFT. `collect()` carves the 5% liquidity leg in-kind; `compound()` permissionlessly adds it back into the locked position — **add-only, TWAP-gated, residual-conserving**. |
| `HydeFeeVault.sol` | Per-token WETH fee settlement. `settle()` performs the ONE swap (launch-token fee leg → WETH), oracle-floored and partial-fill-rejected, then splits 90/5. |
| `HydeHook.sol` | Own V4 hook: anti-snipe dynamic fee, swap-volume graduation meter, and a real-tick TWAP oracle. Non-fund-bearing; all four callbacks are `onlyPoolManager`. |
| `libraries/OracleLib.sol`, `TickMath.sol` | TWAP quote + tick math (binary-searched oracle ring). |

### Launchpad frontend (`src/`) — Vite + React
- **Launchpad** — permissionless launch form; network-aware, writes to the live own-stack factory on 46630.
- **Discover / Launches / Stats** — on-chain aggregates and trending, read straight from factory events.
- **Swap** — V4 own-stack routing plus Stable V3 SwapRouter02/QuoterV2 Buy/Sell with live preflight and slippage protection.
- **Add / Remove Liquidity** — V4 Position Manager multicall flows.
- **Token page** — per-token detail, embedded GeckoTerminal chart.
- **Trust / Security page** — the four failure classes this design defends against, with live on-chain receipts.
- **Pools / Farms / Profile** and a shared UI kit.
- Hardened `Content-Security-Policy` and an upload-only IPFS image gate (`api/pin-image.js` + rate limiter).

---

## How It Works

1. **Launch.** A creator calls `factory.launch()` and pays a flat **0.0004 ETH** fee — native ETH sent as `msg.value` in the single payable launch transaction (no ERC-20 approval, no faucet). The factory CREATE2-clones a `HydeERC20`, mints the fixed 1e9 supply, and seeds **100%** of it single-sided into one Uniswap V4 position. **Zero** goes to the team or the creator's wallet.
2. **Lock.** That position NFT is transferred to `HydeFeeCollector`, which has **no** decrease/transfer/burn/sweep selector in its bytecode. The liquidity is locked by code, provable by codehash — not by a custodian who could change their mind.
3. **Trade.** Swaps accrue fees inside the V4 pool. The hook applies an anti-snipe dynamic fee at launch and feeds a real-tick TWAP oracle every swap.
4. **Settle & split.** `settle()` performs a single oracle-floored swap of the launch-token fee leg into WETH, then splits **90% creator / 5% Hyde**.
5. **Auto-compound.** The remaining **5%** is carved in-kind at `collect()` and added back into the locked position via `compound()` — permissionless, add-only, TWAP-gated. The liquidity floor is monotonically non-decreasing.

Full economic model and invariant matrix: [`CONTRACT_SPEC_L3.md`](CONTRACT_SPEC_L3.md).

---

## Fees & Parameters

> **Read this first.** Every fee and protection parameter is **chosen once, at deploy time, and is then immutable for the entire life of that deployment.** There are **no live/admin fee setters** — nobody (not the creator, not Hyde, not an owner) can change a fee, tax, or split after launch. **Changing any value below requires deploying a brand-new stack.** That immutability *is* the anti-rug guarantee.

All of these are `internal constant`s in **`contracts/script/DeployHydeStack.s.sol`** that feed the contract constructors and become on-chain `immutable`s. Fee values use Uniswap V4 **pips** (`1_000_000` = 100%, so `10_000` = 1%). Wallet/split values use **bps** (`10_000` = 100%, so `100` = 1%).

| Parameter | Current value | Unit | Allowed bound (enforced) | Where to change | Mutability | Security impact |
|---|---|---|---|---|---|---|
| **Launch fee** | `400_000_000_000_000` (**0.0004 ETH**) | native ETH — wei, via `msg.value` | `> 0` | `LAUNCH_FEE` | Deploy-time → immutable | Anti-spam/sybil on `launch()`; paid in one payable tx (no approval), exact-value (`BAD_FEE` on mismatch), forwarded to the launch-fee treasury (must be an EOA). Can't be raised on you post-deploy. |
| **Anti-snipe start fee** | `30_000` (**3%**) | pips | `baseFee ≤ startFee ≤ maxLpFeeCap` | `START_FEE` | Deploy-time → immutable | The opening swap tax that prices out snipers/MEV; the highest fee anyone pays at t=0. |
| **Base (steady-state) fee** | `10_000` (**1%**) | pips | `≤ startFee` | `BASE_FEE` | Deploy-time → immutable | The normal swap fee the anti-snipe tax decays down to. |
| **Fee hard cap** | `50_000` (**5%**) | pips | `≤ MAX_LP_FEE` (100%) | `MAX_LP_FEE_CAP` | Deploy-time → immutable | Absolute ceiling — the swap fee can **never** exceed this, ever. Blocks a "fee to 100%" honeypot. |
| **Anti-snipe window** | `300` (**5 min**) | seconds | `> 0` | `ANTI_SNIPE_WINDOW` | Deploy-time → immutable | How long the 3%→1% decay runs. So: **trading fee = 3% at launch → 1% over 5 minutes.** |
| **Max wallet** | `100` (**1%**) | bps | `0 < bps ≤ 300` (≤3%) | `MAX_WALLET_BPS` | Deploy-time → immutable | Caps the balance a wallet may **receive** early — applies to **any receipt (a buy *or* an incoming transfer)** and bounds the recipient's resulting balance. **Recipient-side only — never blocks a sell or any outgoing transfer.** |
| **Max-wallet window** | `300` (**5 min**) | seconds | `0 < w ≤ 3600` (≤1h) | `MAX_WALLET_WINDOW` | Deploy-time → immutable | How long the 1% cap applies, then it lifts forever. |
| **Fee split (economic)** | **90 / 5 / 5** = `9000 / 500 / 500` bps of the fee notional | bps | `hydeBps == 500` **and** `liqBps == 500` (ctor `require`, hard-coded) · `NET_BPS + liqBps == 10_000` (deploy assert) | `HYDE_BPS` / `LIQ_BPS` (both fixed at `500` in Solidity) · `NET_BPS` (= the `9500` remainder) | **Solidity-hard-coded** — changing it needs a **code change + re-audit**, *not* just a new deploy constant | 90% creator · 5% Hyde · 5% auto-compounded into the permanently-locked position. `NET_BPS=9500` is the *post-liq-carve remainder* / vault split **denominator**, **not** the creator's share. |
| **Settle slippage floor** | `300` (**3%**) | bps | permissionless backstop | `MAX_SLIPPAGE` | Deploy-time → immutable | Floor on the one fee→WETH swap; a keeper can pass a tighter bound. |
| **TWAP window** | `1800` (**30 min**) | seconds | `CARDINALITY (2048) > window` | `TWAP_WINDOW` | Deploy-time → immutable | Oracle averaging window backing the fee/settle price floors. |

**In plain terms:**
- **Yes, there is an anti-snipe tax:** the swap fee starts at **3%** and decays to **1%** over the first **5 minutes** — snipers pay the most, normal traders pay 1%.
- **Yes, there is a max wallet:** for the first **5 minutes**, no wallet may **receive** more than **1% of supply** — this bounds the *recipient's* balance on **any receipt (a buy *or* an incoming transfer)**. It can **never** stop you selling or sending tokens out. No blacklist, no transfer-pause, no owner setter.
- **On the split numbers:** the *economic* split is **90% creator / 5% Hyde / 5% liquidity** (`9000 / 500 / 500` bps of the original fee). `HYDE_BPS` and `LIQ_BPS` are **hard-coded to `500` in the contract constructors** (`require(_hydeBps == 500)` / `require(_liqBps == 500)`); `NET_BPS = 9500` is the *post-liquidity-carve remainder* the vault uses as its split **denominator** (`hydeBps / NET_BPS = 500 / 9500` = exactly 5% of the original notional), **not** the creator's share. Because those shares are `require`-locked in Solidity, **changing the split is a code change + re-audit — not merely a new deploy constant.**
- The **90/5/5 split is immutable** and cross-checked at deploy (`NET_BPS + liqBps == 10_000`), so it can't silently drift.
- The factory's *only* owner power is `pause`/`unpause` of **new launches**, and it's **renounceable** — set `owner = 0` and even that disappears, making the whole stack permanently immutable and publicly verifiable.
- Making any of the above **changeable at runtime would remove an immutability guarantee**, so it is *intentionally not implemented*. It would require a separate threat-model/spec decision before being added.

---

## Anti-Rug Guarantees

These are enforced by immutable code and fail-closed deploy asserts, not by promises:

- **No team bag / no pre-mint.** The factory asserts 100% of supply lands in the locked position; post-seed factory and vault balances must be 0.
- **Liquidity can never be pulled.** No decrease/transfer/burn/sweep path exists on the collector. The lock is codehash-provable, not custodial (unlike a SafeMoon-style redeemable "lock").
- **Fees can't be re-pointed.** The 90/5/5 split is constructor-immutable, and a cross-contract deploy assert (`NET_BPS + liqBps == 10000`) aborts deploy if the two independently-deployed contracts ever drift.
- **No sell-blocking.** The max-wallet limit is receive-side only and time-boxed — it can never block a sell. There is no blacklist, pause, or owner-setter.
- **Compounding only adds.** `compound()` rounds in the protocol's favor, measures residuals, and never over-credits — so it can't be milked.

---

## Security / Exploit Threat Model

The design was pressure-tested against real 2025/2023 DeFi exploits. Each attack class maps to a specific defense that is unit-tested:

| Real incident | Exploit class | Hyde's defense (tested) |
|---|---|---|
| **Cork Protocol — $11M** (May 2025) | Unauthorized V4 hook callback | All 4 hook entrypoints `require(msg.sender == POOL_MANAGER)` **first**; `validateHookPermissions` in the constructor; every unlock nets its deltas to zero. |
| **Bunni — $8.4M** (Sep 2025) | Custom-liquidity rounding drain | `compound()` is add-only (no withdraw path), rounds in protocol favor, measures residual, never over-credits. |
| **LIBRA — $107M** (Feb 2025) | LP-yank rug | Position is custody-locked — no decrease/transfer/burn/sweep selector in the bytecode. |
| **SafeMoon — $200M+** (SEC 2023) | Fake / redeemable lock | No LP tokens are held to redeem; the lock is codehash-provable, not custodial. |
| **Honeypot generators** | Sell-block trap | Max-wallet is receive-side only (never blocks a sell); no blacklist/pause/owner-setter. |
| **Pre-allocation rugs** | Insider bag | Factory asserts 100% supply → locked position, 0 to team. |

### Findings caught & fixed during internal review

The AI-agent review surfaced and patched these **before** any deploy. Findings F2–F8 are fixed in the contracts on `main`; the full matrix lives in [`AUDIT_HANDOFF.md`](AUDIT_HANDOFF.md) and [`CONTRACT_SPEC_L3.md`](CONTRACT_SPEC_L3.md).

- **F1 — Hook flag-bit trap (honeypot-for-LPs).** A hook deployed to an address with a stray remove/add/donate permission bit would trap external LP removals. **Fix:** the hook address is mined to *exactly* the 4 required permission bits, and both the factory ctor and hook ctor assert it fail-closed. Negative test proves a remove-bit hook traps `decreaseLiquidity` while the correct one doesn't.
- **F2 — Oracle liveness DoS (griefable `settle`/`compound`).** With a TWAP window measured in seconds on a 2s-block chain, a too-small oracle ring couldn't span the window → `consult` reverted `ORACLE_NOT_READY` → DoS on any active pool. Naively raising ring cardinality just traded a ring-DoS for an O(cardinality) on-chain gas-DoS. **Fix:** binary-search the oracle ring (Uniswap V3 `OracleLibrary` pattern) **and** size the ring against the window in seconds (same-second swaps coalesce → block-time-independent).
- **F3 — `settle` sandwich.** `settle`'s swap was protected only by a TWAP floor, with no spot-vs-TWAP deviation gate (`compound` already had one). **Fix:** mirror `compound`'s spot-deviation gate onto `settle`.
- **F4 — Dead V3 oracle code.** Latent V3-pool oracle helpers unused in a V4 system. **Fix:** removed (footgun elimination).
- **F5 — Ring cardinality** raised to a config-bound invariant (ring must span the TWAP window in seconds).
- **F6/F7 — Fee-split rounding.** `mulmod` carry makes the 90/5/5 partition exact (no rounding-bias leak).
- **F8 — Per-launcher nonce** to remove CREATE2 `predictNext` drift.

**No fund-drain path** was found in the full re-audit: no token-reentrancy (the token has no transfer hooks), one-shot callback job-hash, sequential multicall, factory-only pool init, and underflow-safe claim solvency.

---

## AI-Agent Audit

This project was built and audited end-to-end by an autonomous multi-agent team, each with a fixed role and a hard gate the work had to pass:

- **Builder** — implemented contracts + frontend.
- **Protocol/Research** — authored the spec, threat model, and invariant matrix; pinned the V4 integration.
- **Reviewer** — independent adversarial audit; owned the pass/fail gate and the push.
- **Designer** — UX, honesty of claims, and visual/trust surface.

The review was adversarial by design (each finding had to be *refuted or confirmed* by an independent pass, not just re-found), and it ran the contracts against **real Uniswap V4 core + periphery deployed in a local Foundry harness** — not mocks, and not a chain fork. The output is the finding set above plus an external-audit handoff package.

> **Honesty note:** this is an *internal* AI-agent review, not a substitute for a professional external audit. An independent external audit is the explicit gate before any mainnet value is deployed.

---

## Tech Stack

**Contracts**
- Solidity + [Foundry](https://book.getfoundry.sh/) (`forge test`)
- Uniswap **V4** (PoolManager, hooks, Position Manager, Universal Router, Permit2)
- EIP-1167 minimal-proxy clones · EIP-2612 permit · CREATE2 deterministic deploy

**Frontend**
- [Vite](https://vitejs.dev/) + React 18 + TypeScript
- [wagmi](https://wagmi.sh/) + [viem](https://viem.sh/) for chain I/O
- Tailwind CSS · React Router · React Query · react-hot-toast
- Deployed on **Vercel** (Node 24 runtime); serverless `api/` routes for IPFS pinning + rate limiting

**Chains**
- Robinhood Chain mainnet (`4663`) · Robinhood Testnet (`46630`, live own-stack) · Tempo Moderato · Pharos Atlantic testnets

---

## Install & Run

New to this? Follow the numbered steps — you only need the **Frontend** part to run the launchpad UI locally. The **Contracts** part is only if you want to run the Solidity test suite.

### Prerequisites

- **[Node.js](https://nodejs.org/) 20 or newer** (production uses Node 24) and **npm** (npm ships with Node). Check with `node -v`.
- **[git](https://git-scm.com/downloads)** to clone the repo.
- *(contracts only)* **[Foundry](https://book.getfoundry.sh/getting-started/installation)** — the Solidity toolchain (`forge`). Check with `forge --version`.

### 1. Get the code

```bash
git clone https://github.com/ryjin111/HydeEcosystem.git
cd HydeEcosystem
```

### 2. Run the frontend (the launchpad UI)

```bash
npm ci          # installs the exact locked dependencies from package-lock.json (one time; ~a minute)
npm run dev     # starts the local dev server
```

Then open the URL it prints (usually **http://localhost:5173**) in your browser. You should see the Hyde launchpad. It's already wired to the **live own-stack factory on Robinhood Testnet (chain 46630)** — connect a wallet on that network and you can launch/trade against real testnet contracts, no config needed.

To make a production build instead:

```bash
npm run build    # type-checks, then builds to dist/
npm run preview  # serves that production build locally to verify it
```

**Where the config lives:** chains, RPC URLs, and contract addresses are all in `src/utils/constants.ts` (`SUPPORTED_CHAINS`, `V4_CONTRACTS_BY_CHAIN`). Change nothing to use the defaults.

### 3. (Optional) Run the smart-contract tests

```bash
cd contracts
forge install    # fetches contract dependencies (one time)
forge test       # runs the full suite (56 test/invariant fns) against real V4 deployed locally
```

> ⚠️ **Run plain `forge test`** (no `--match` filter). A `--match*` filter sparse-prunes `ForceCompile.sol` and breaks `vm.getCode` at setUp. Fork tests are gated behind an RPC env var and skip cleanly if it's unset — a clean run is ~55 pass / 1 skip.

### 4. Environment variables

**None are required to run the app locally** — every one has a safe default. They only matter for production or the optional fork/pinning flows. Copy `.env.example` → `.env.local` if you want to override.

| Variable | Used by | Required? | Purpose |
|---|---|---|---|
| `VITE_IPFS_GATEWAY` | frontend | Optional | IPFS read gateway for token art. Defaults to `https://ipfs.io/ipfs/`. |
| `TESTNET_RPC` | contract fork tests | Optional | RPC URL for the on-chain fork tests. Unset → those tests skip cleanly. |
| `FILEBASE_KEY` / `FILEBASE_SECRET` / `FILEBASE_BUCKET` | Vercel serverless (`api/pin-image`) | Prod only | Server-side IPFS pinning secrets. **Never** prefix with `VITE_` (that would leak them into public client JS). Set in Vercel, not in the repo. |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Vercel serverless (`api/_ratelimit`) | Prod only | Vercel KV / Upstash-compatible REST credentials that back the per-IP pin **rate limiter**. If unset, the credentialed pin endpoint **fails closed** (refuses to pin) — this is deliberate so the paid Filebase key can't be abused. Set in Vercel. |
| `PIN_RATE_LIMIT` / `PIN_RATE_WINDOW_SEC` | Vercel serverless (`api/_ratelimit`) | Optional | Pin requests allowed per window / window length in seconds. Have safe defaults (**20** requests per **3600s**); bounds are validated so a bad value can't defeat the limiter. |

> This table covers the vars the code actually reads. For local development you need **none** of them (the frontend runs on public defaults); the server-only vars matter solely for the deployed Vercel pin/rate-limit flow.

### 5. Expected output (so you know it worked)

- `npm run dev` → prints something like `VITE vX.Y.Z ready` and `➜ Local: http://localhost:5173/`. Open that URL and the launchpad loads.
- `npm run build` → ends with `✓ built in …` and a `dist/` folder appears. No red TypeScript errors.
- `forge test` → ends with a summary like `Suite result: ok. ~55 passed; 0 failed; 1 skipped`.

### 6. Common errors & fixes

- **`vm.getCode: no matching artifact`** on `forge test` → you used a `--match` filter. Run **plain `forge test`**.
- **`Port 5173 is in use`** → another dev server is running; stop it, or Vite will offer the next free port.
- **Wallet shows nothing / can't launch** → make sure your wallet is on **Robinhood Testnet (chain 46630)**; the live own-stack factory lives there.
- **`command not found: forge`** → Foundry isn't installed. See [Foundry install](https://book.getfoundry.sh/getting-started/installation).
- **`npm ci` fails** → check `node -v` is ≥ 20, then remove `node_modules/` and re-run `npm ci`. **Don't delete `package-lock.json`** — `npm ci` needs it for a reproducible install. (Only if the lockfile is genuinely out of sync should you run `npm install` to regenerate it.)

> ⚠️ **Mainnet safety warning.** These contracts are **internally reviewed but NOT externally audited**, and are **not deployed with real value on Robinhood Chain mainnet (4663)**. Do **not** deploy or point this at mainnet with real funds until the external-audit gate is cleared. Testnet (46630) only.

**Deploying to mainnet** (Robinhood Chain 4663) is a separate, owner-authorized step — see the deploy sequence in [`AUDIT_HANDOFF.md`](AUDIT_HANDOFF.md) §9–§10 and `contracts/script/DeployHydeStack.s.sol`.

---

## Repository Layout

```
contracts/            # Foundry project — the own-stack V4 contracts
  src/                #   HydeTokenFactory, HydeERC20, HydeFeeCollector,
                      #   HydeFeeVault, HydeHook + interfaces/ + libraries/
  test/               #   56 test/invariant fns vs real V4 deployed locally (Compound, HookExternalLP,
                      #   AntiRug, Factory, Lifecycle, VaultInvariant, ...)
  script/             #   DeployHydeStack.s.sol, LaunchSmoke.s.sol
src/                  # Vite + React frontend
  pages/              #   Launchpad, Swap, Discover, Stats, Trust, Token, ...
  components/         #   LaunchTokenForm, V4SwapCard, V4LiquidityCard, ...
  utils/constants.ts  #   chains + V4 contract addresses per network
api/                  # Vercel serverless routes (IPFS pin, rate limit)
```

## Deep-Dive Docs

- [`CONTRACT_SPEC_L3.md`](CONTRACT_SPEC_L3.md) — authoritative build spec, threat model, invariant matrix (rev8.3).
- [`AUDIT_HANDOFF.md`](AUDIT_HANDOFF.md) — external-audit handoff package (scope, findings, deploy sequence, gas).
- [`PROTOCOL_PLAN.md`](PROTOCOL_PLAN.md) — protocol design plan.
- [`HYDEOUT_DESIGN_SPEC.md`](HYDEOUT_DESIGN_SPEC.md) — product/UX spec.

---

## Status & Disclaimers

- Contracts are **built and internally audited**, not externally audited and **not deployed with mainnet value**. Do not treat this as production-safe until the external audit gate is cleared.
- WETH on Robinhood Chain 4663 is an upgradeable proxy — an external trust assumption, disclosed. (USDG is no longer a dependency — the launch fee is native ETH.)
- Nothing here is financial advice. Launching or trading tokens carries risk.
