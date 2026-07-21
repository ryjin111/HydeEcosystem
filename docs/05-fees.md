# Fees & splits

## Launch fee

A flat **0.0004 ETH** (native), paid once when you launch. It goes to the launch treasury. This is separate from trading fees.

## Trading fee

Each token's pool charges a **dynamic fee that decays from 3% down to 1%** over the anti-snipe window, then stays at the 1% base. The fee is enforced by the Hyde V4 hook.

## The split — 90 / 5 / 5

Trading fees are harvested, converted to the pool's **base token** (WETH for WETH-pair launches, $HOODIE for HOODIE-pair launches), and split:

| Share | Recipient | How it's paid |
|---|---|---|
| **90%** | **Creator** | Pull-based claim bucket (in the pool's base token) → your immutable creator address. Claim any time. |
| **5%** | **Hyde** | Pull-based claim bucket → the Hyde treasury. |
| **5%** | **Locked liquidity** | Auto-compounded (add-only) into the pool's locked position. Un-ruggable — there is no withdraw path. |

Mechanically: the collector carves the **5% LP add in-kind**, forwards the **95% remainder** to the vault, and the vault takes `hydeBps/NET_BPS = 500/9500` (exactly **5% of the original notional**) for Hyde, leaving the creator the **90% remainder**. The split is partition-invariant — chunking a settlement into many small calls yields the exact same totals.

> **Note:** an earlier design routed 5% to a *holder-reward stream*. That was **removed** in the deployed version — the 5% is permanently-locked auto-compound liquidity, not holder rewards.

## Anti-snipe

For the first **300 seconds** after launch, a **1% max-wallet cap** applies to buys — snipers can't hoover the supply at launch. **Selling is never restricted**, and the cap expires automatically (immutable expiry). It cannot be extended or re-armed by anyone.
