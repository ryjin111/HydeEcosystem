import type { LaunchEngine } from "./chainRegistry";

/** Shared pool type used by Hyde launch UI and trending components. */
export type DopplerPool = {
  address: string;
  chainId: number;
  /** Canonical pool contract when the launch event exposes it directly (Stable V3). */
  poolAddress?: string | null;
  baseToken: {
    address: string;
    name: string;
    symbol: string;
    decimals: number;
  };
  quoteToken: {
    address: string;
    name: string;
    symbol: string;
    decimals: number;
  };
  /** Contract architecture that created this launch. This is deliberately separate from `type`,
   * which is legacy market-stage data (`v4` curve / `v2` migrated) and must never drive fee copy. */
  launchEngine: LaunchEngine;
  type: string;
  dollarLiquidity: string | null;
  volumeUsd: string | null;
  /** USD market cap — real, from the DEXScreener pair. Null until the token graduates
   *  to a Uniswap pool and is indexed (curve-stage tokens have no priced pair yet). */
  marketCapUsd: number | null;
  /** USD spot price from the DEXScreener pair. Null while on the auction curve. */
  priceUsd: number | null;
  createdAt: string;
  /** Curve progress toward graduation, 0–100 (100 = graduated). Null when unknown. */
  progress: number | null;
  /** Own-stack launch creator (from `LaunchCreated.creator`). Null for non-own-stack (Doppler) pools —
   *  used by "My Launches" to filter to the connected wallet (Phase 2). */
  creator?: string | null;
  /** Creator-claimable WETH in wei, as a decimal string (vault `creatorClaimable(token)`). Null when
   *  not own-stack or the read failed (fail-neutral, never fabricated). */
  creatorClaimable?: string | null;
};
