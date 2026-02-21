import type { NetworkConfig, TokenInfo } from "../utils/constants";
import { V4LiquidityCard } from "../components/V4LiquidityCard";

type Props = {
  network: NetworkConfig;
  tokens: TokenInfo[];
  onAddCustomToken: (token: { address: `0x${string}`; symbol: string; name: string; decimals: number }) => void;
};

export function RemoveLiquidityPage({ network, tokens, onAddCustomToken }: Props) {
  return <V4LiquidityCard network={network} tokens={tokens} mode="remove" onAddCustomToken={onAddCustomToken} />;
}
