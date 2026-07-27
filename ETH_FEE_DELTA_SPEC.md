# HydeTokenFactory — Native-ETH Launch Fee Delta Spec

**Author:** gojo (Researcher) · **Status:** proposal for casper/kami re-audit before deploy
**Motivates:** clint items #2 (one wallet prompt) + #3 (0.0004 ETH fee) — these are the *same* change.
**Scope:** `contracts/src/HydeTokenFactory.sol` only. Everything else (hook, vault, collector,
HydeERC20) is UNTOUCHED. Keep this diff single-purpose so the re-audit is a surgical read.

---

## 0. Why this collapses 3 txs → 1

Today the own-stack launch is up to **3 wallet txs**: `faucet(mock USDG)` → `approve(USDG→factory)`
→ `launch()`. That exists purely because the fee is an **ERC-20** pulled via `safeTransferFrom`,
which requires prior allowance (and, on the sandbox, a faucet top-up).

A **native-ETH** fee rides in as `msg.value` on the launch call itself → **nothing to faucet,
nothing to approve** → exactly **one payable transaction**. It also makes the fee chain-portable
(ETH exists everywhere; USDG was a testnet mock only), which is clint's "compatible to everything."

## 1. Verified pre-conditions (why this is safe/clean)

- **`USDG` is fee-only.** Every reference (`:82` immutable, `:176` ctor guard, `:213` assign,
  `:293-295` in `launch`) is the fee path. It is **not** a pool asset — the pool pairs the launch
  token against **WETH** (`ltIsCurrency0 = token < WETH`), seeded **single-sided in the token**.
  ⇒ dropping USDG has zero effect on pool creation.
- **The seed consumes no ETH.** `_buildLeg` deposits `SUPPLY` of the *token* only; the factory
  passes no `value` to PoolManager/PositionManager. ⇒ after this change, **100% of `msg.value` is
  the fee** — fee ETH is never entangled with pool ETH. This is the key safety invariant.
- **`launch` is already `nonReentrant`.** The fee external-call inherits that guard.

## 2. Contract changes

### 2a. Constructor / immutables
- **`ConstructorParams`:** delete `address usdg;`. Keep `uint256 launchFeeAmount;` and
  `address launchFeeTreasury;`.
- Delete `IERC20 public immutable USDG;` (`:82`) and its ctor assignment (`:213`).
- Delete `require(p.usdg != address(0), "ZERO_USDG");` (`:176`).
- Keep `require(p.launchFeeAmount > 0, "ZERO_FEE");` and
  `require(p.launchFeeTreasury != address(0), "ZERO_FEE_TREASURY");`.
- **Remove the `IERC20`/`SafeERC20` import** if USDG was its only consumer (verify no other use).
- `launchFeeAmount` semantics change: **wei**, not 6-dec USDG. `0.0004 ETH = 4e14 wei`. Deploy
  config only — no code constant.

### 2b. `launch()` — make payable, swap the fee block
Signature: `function launch(LaunchParams calldata lp) external payable nonReentrant returns (...)`

Replace the current step-1 fee block (`:292-296`):
```solidity
// 1. flat native-ETH fee → launch-fee treasury. Exact amount (no refund path, no stuck excess).
require(msg.value == launchFeeAmount, "BAD_FEE");
(bool ok, ) = launchFeeTreasury.call{value: launchFeeAmount}("");
require(ok, "FEE_XFER_FAIL");
emit LaunchFeePaid(msg.sender, launchFeeTreasury, launchFeeAmount);
```
Notes / decisions:
- **Exact `==`, not `>=`.** Flat fee → no refund logic → no excess-ETH stuck in the factory and no
  second external call. Wallets set `value` from the on-chain `launchFeeAmount()` getter, so exact
  match is deterministic.
- **`LaunchFeePaid` event unchanged** (same 3 args) — indexers/board keep working.
- **Recommended design = direct-forward (above).** Preserves the current "factory never custodies
  fees" invariant with a single external call, already covered by `nonReentrant`. **Invariant:
  `launchFeeTreasury` MUST be an EOA (or a payable contract whose `receive` cannot revert)** — an
  EOA `.call` always succeeds, so with the intended Hyde fee EOA there is zero brick risk.
- **Alternative (only if treasury must be an untrusted contract):** accrue ETH in the factory and
  add `withdrawFees(address to) onlyOwner`. Zero external call in the launch hot path, but adds a
  privileged function + factory custody. Not recommended unless the EOA assumption breaks.

### 2c. Getters
- Delete the `USDG()` getter (ABI + frontend already updated below).
- `launchFeeAmount()` / `launchFeeTreasury()` unchanged.

## 3. Frontend ripple (kuro — informational; not this spec's deploy)
- **`src/utils/constants.ts`:** `hydeTokenFactoryAbi.launch` → add `"stateMutability": "payable"`;
  drop the `USDG` getter entry; drop `ROBINHOOD_TESTNET_USDG` + `mockUsdgAbi` once unused.
- **`src/utils/hydeLaunch.ts`:** delete the faucet + approve steps and the `HydeLaunchStep`
  `"faucet"|"approve"` variants. `executeHydeLaunch` becomes a single
  `writeContract({ ..., functionName:"launch", value: feeAmount })`. `simulateHydeLaunch` drops
  `needsFaucet`/`needsApproval` and instead checks `nativeBalance >= feeAmount + gasBuffer`.
- **Fee copy** (shiro's string list, msg 22851): `$1 USDG` → `0.0004 ETH`, remove the
  "faucet-funded + approved automatically" line.

## 4. Deploy + audit gates (NOT in this change — requires clint's order)
1. New 46630 testnet factory deploy with `launchFeeAmount = 4e14`, `launchFeeTreasury = <Hyde EOA>`,
   `usdg` param removed. (Hook mining unchanged — HOOK immutable is unaffected.)
2. Rewrite the fee unit tests: the USDG `approve`/`transferFrom`/`FEE_SHORTFALL` cases become
   `msg.value`-based (`BAD_FEE` on wrong value, `FEE_XFER_FAIL` on a reverting treasury, exact
   forward on success). Run **plain `forge test`** (see [[reference_forge_getcode_sparse]]).
3. casper/kami re-audit the surgical diff; then update `constants.ts` factory address + regen ABI.
4. Mainnet (4663) own-stack deploy is a separate, later gate (still pending clint's key).

## 5. Out of scope (explicitly)
- On-chain `tokenURI` / metadata — routed **off-chain** (gojo call, msg 22850). Do NOT add token
  metadata storage to this diff.
- Any hook/vault/collector/HydeERC20 change. Fee-path only.
