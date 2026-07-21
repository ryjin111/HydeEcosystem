# Safety & immutability

Hydeout is built so that once a token is live, **there is no exposed admin path to upgrade the contracts, mint or burn supply, withdraw a live pool's locked LP, or change a live token's fee recipient.**

## What's immutable

- **No upgradeability.** The contracts have no proxy admin, no upgrade path. What's deployed is what runs.
- **Fixed supply.** Every token is 1,000,000,000 tokens forever — no mint function, no burn function.
- **Locked liquidity.** Liquidity is single-sided seeded at launch, and the 5% fee LP add is **add-only**. There is no code path to withdraw a live pool's liquidity.
- **Immutable creator recipient.** Your 90% fee address is set at launch and cannot be changed.
- **Immutable anti-snipe.** The 1% / 300s max-wallet window has a fixed expiry; it can't be extended or re-armed. Selling is never restricted.
- **HOODIE pairing is enforced in code.** The engine hard-requires the base to be $HOODIE, so a launcher physically cannot pair against anything else.

## Authority boundary

The `owner` key's **only** power is `pause`/`unpause` of **new** launches, plus transfer/renounce of ownership. It does **not** configure fees or presets, and it has **no authority over already-live tokens or pools** — it cannot touch your token, your liquidity, or your fees.

## Deployment integrity

- Both stacks were deployed via one-shot coordinators (**`HydeStackCoordinator`** for WETH, **`HoodieStackCoordinator`** for HOODIE), each permanently **`finalized`** — they cannot deploy again.
- The deployment asserted, on-chain and fail-closed: correct chain id (4663), pinned code hashes for every Uniswap V4 core dependency + WETH + $HOODIE, correct roles/treasuries, that target addresses were empty, and that predicted addresses matched deployed ones.
- All of this is independently re-checkable — see [Verify on-chain](07-verify.md).

## Audit status

The contracts were reviewed internally (multiple audit rounds) and every launch flow was proven on a real 4663 fork before mainnet deployment. An external third-party audit is a separate track; check the repo for its current status before treating any deployment as externally audited.
