# Launch a token — HOODIE launcher-launcher

The **HOODIE pair** works differently from the WETH pair: instead of launching straight through a shared factory, you first deploy **your own personal launcher**, then launch through it. Every token you launch this way is **immutably paired against $HOODIE**.

This is the "launch a launcher" mechanic: *anyone can deploy a launcher, and every token from it is HOODIE-paired.*

## The two-step flow

**Step 1 — deploy your launcher (once):**

```
HoodieMetaFactory  0x101Fe0c0328De00F6F6f928B79d512E899fE2fC0

createLauncher(bytes32 userSalt)  →  your own HoodieLauncher clone
```

- Your launcher address is deterministic: `predictLauncher(creator, userSalt)` returns it before you deploy.
- Re-using the same `userSalt` reverts — no collisions, no replay.

**Step 2 — launch tokens through your launcher (as many as you want):**

```
launch{value: 0.0004 ETH}(string name, string symbol, uint256 presetId)
```

Each call:
- deploys a token (EIP-1167 clone),
- initializes a **$HOODIE-paired Uniswap V4 pool**,
- single-sided seeds 100% of supply,
- records **you (the actual caller)** as the creator — the launcher passes `creator = you` into the engine's `launchFor` (the engine's own `msg.sender` is just the registered launcher), so your 90% fee routing is truthful; the launcher clone is never credited.

## Why a launcher-launcher?

- **Every token is guaranteed HOODIE-paired** — the engine hard-requires the base to be $HOODIE (`require(WETH == HOODIE)`), so a launcher can't pair against anything else.
- **Your launcher is creator-namespaced** — a deterministic address bound to your `(creator, userSalt)`. Its `launch` has no owner-only gate: whoever calls it is credited as that token's creator.
- **It reuses/inherits the engine's `_launch` core** — the same launch/seed/fee path as the WETH factory, only the base token differs.

## Emitted event (for indexers / UIs)

```
HoodieLaunchCreated(address launcher, address creator, address token, bytes32 poolId, uint256 tokenId)
```

`poolId` resolves the chart/stats/quote; `creator` is the human who gets the 90% claim.

## $HOODIE

```
HOODIE  0xC72c01AAB5f5678dc1d6f5C6d2B417d91D402Ba3   (18-dec, graduated Doppler token on 4663)
```
