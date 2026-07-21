# Overview

**Hydeout** is a token launchpad on **Robinhood Chain (chain ID 4663)**, built on its own contract stack over **Uniswap V4**. Anyone can launch a token in a single transaction; the token gets a live V4 pool and is tradeable from the first block.

## What makes Hydeout different

- **Own stack, not a fork of someone else's launchpad.** Hydeout deploys its own factory, fee vault, fee collector, and V4 hook — so it is chain-portable and its economics are Hydeout's, not a third party's.
- **Two pairing options:**
  - **WETH pair** — the standard launch. Your token is paired against Robinhood-Chain WETH.
  - **HOODIE pair** — the *launcher-launcher*. You deploy your own personal launcher once, then every token you launch through it is immutably paired against **$HOODIE**.
- **Non-custodial.** Creator fees route to the creator's own address by protocol, never held by an agent wallet.
- **Honest, un-ruggable liquidity.** 5% of every trade's fees is permanently added to locked liquidity (add-only). There is no admin path to withdraw a live pool's liquidity.

## The numbers at a glance

| | |
|---|---|
| Chain | Robinhood Chain **4663** (`rpc.mainnet.chain.robinhood.com`) |
| DEX | Uniswap **V4** (canonical core live on 4663) |
| Launch fee | **0.0004 ETH** flat (native), paid once at launch |
| Trading fee | dynamic **3% → 1%** decay per token |
| Fee split | **90% creator · 5% Hyde · 5% permanently-locked LP** |
| Anti-snipe | **1% max wallet for 300s** after launch |
| Supply | **1,000,000,000** per token, 100% single-sided seeded to the pool |

## Status

Both stacks are **live on 4663 mainnet** (deployed 2026-07-21). See [Live contracts & addresses](06-contracts.md).
