# Architecture

Hydeout is a small set of immutable contracts on top of the canonical Uniswap V4 core that is already live on Robinhood Chain 4663.

## Components

| Contract | Role |
|---|---|
| **HydeERC20** | The launched-token implementation. Each launch is a gas-cheap **EIP-1167 minimal-proxy clone** of this one implementation. Supply is fixed at 1e9 forever (no mint, no burn). |
| **HydeTokenFactory** | Deploys a token clone, initializes its V4 pool, single-sided seeds 100% of supply, and takes the launch fee. This is the **WETH-pair factory**. |
| **HydeFeeVault** | Holds and splits trading fees (90/5/5). Creator and Hyde shares are pull-based claim buckets; the LP share auto-compounds. |
| **HydeFeeCollector** | Harvests raw V4 position fees and forwards them to the vault; carves the 5% in-kind LP add. |
| **HydeHook** | The Uniswap V4 hook: dynamic fee (3%→1% decay), anti-snipe max-wallet window, and a TWAP oracle used for slippage-guarded fee settlement. |

## The HOODIE launcher-launcher

For the **$HOODIE** pair, Hydeout adds three contracts that **reuse/inherit the factory's `_launch` core**:

| Contract | Role |
|---|---|
| **HoodieLaunchEngine** | `extends HydeTokenFactory` with the base token fixed to **$HOODIE** (`require(WETH == HOODIE)` in the constructor — fail-closed). It is the shared backend; users never call it directly. |
| **HoodieMetaFactory** | Mints a per-creator **HoodieLauncher** clone via `cloneDeterministic(keccak256(creator, userSalt))` (a duplicate salt reverts — replay/collision safe). |
| **HoodieLauncher** | A thin EIP-1167 clone, creator-namespaced/deterministic (no owner-only gate). Its `launch` calls the engine's `launchFor(…, creator = the actual caller)`; the engine's `msg.sender` is the registered launcher, and the **human caller is recorded as the creator** (90% fee routing stays truthful — the clone is never credited). |

## Deployment (EIP-3860-safe)

Both stacks were deployed via a small, one-shot coordinator (**`HydeStackCoordinator`** for the WETH stack, **`HoodieStackCoordinator`** for the HOODIE stack; ~3 KB init code each). The coordinator receives each child contract's init code as **calldata** and performs the `CREATE`/`CREATE2` itself, so it stays well under the EIP-3860 init-code limit while remaining the single deployer that wires the vault/collector/hook together. It is `onlyOwner`, and permanently `finalized` after the deploy — it cannot be reused.

## What's on-chain vs. app

- **Trading** happens directly on Uniswap V4 pools — the token is tradeable from block 1 on its live pool.
- **Liquidity** is single-sided seeded at launch; the 5% fee LP add is **permanently locked (add-only)**. There is no code path to withdraw a live pool's liquidity.
- **Graduation** in the deployed configuration is a **label/milestone only** — it does not gate trading and does not migrate liquidity.
