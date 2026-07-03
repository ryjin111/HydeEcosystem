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
  createdAt: string;
  /** Curve progress toward graduation, 0–100 (100 = graduated). Null when unknown. */
  progress: number | null;
};
