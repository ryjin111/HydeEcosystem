# Launch a token — WETH pair

A WETH-pair launch is a **single transaction**. Your token is paired against Robinhood-Chain WETH and is tradeable immediately.

## In the app

1. Open the Hydeout launchpad and choose the **WETH PAIR** tab.
2. Fill in name, symbol, and image/description.
3. Confirm the creator/fee-recipient address (this is **immutable** — it's who receives your 90% of trading fees, forever).
4. Submit — one wallet transaction, **0.0004 ETH** launch fee attached.

That's it. The transaction:
- deploys your token (an EIP-1167 clone),
- initializes a **WETH-paired Uniswap V4 pool**,
- single-sided seeds **100% of the 1,000,000,000 supply** into the pool,
- forwards the 0.0004 ETH fee to the launch treasury.

## Directly on-chain

The WETH factory is:

```
HydeTokenFactory  0x710fEa288266518528A4230771E07ee310ce509f   (chain 4663)
```

Call the factory's `launch` entrypoint, sending `0.0004 ETH` as the launch fee:

```solidity
function launch(LaunchParams lp) external payable returns (address token, uint256 tokenId);
// LaunchParams = (string name, string symbol, uint256 presetId)
```

The app uses a `simulate` → `executeHydeLaunch` pattern to preview the deployed token address before sending.

## After launch

- Your token trades on its WETH V4 pool from block 1.
- Trading fees accrue and split **90% you / 5% Hyde / 5% locked LP** — see [Fees & splits](05-fees.md).
- A **1% max-wallet cap holds for the first 300 seconds** (anti-snipe); selling is never restricted.
- Claim your accrued creator fees any time (pull-based, to your immutable recipient address).
