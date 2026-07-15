/** Shared pool type used by Hyde launch UI and trending components. */
export type DopplerPool = {
  address: string;
  chainId: number;
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
};
