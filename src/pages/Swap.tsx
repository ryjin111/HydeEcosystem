import type { NetworkConfig, TokenInfo } from "../utils/constants";
import { V4SwapCard } from "../components/V4SwapCard";

type Props = {
  network: NetworkConfig;
  tokens: TokenInfo[];
  onAddCustomToken: (token: { address: `0x${string}`; symbol: string; name: string; decimals: number }) => void;
};

export function SwapPage({ network, tokens, onAddCustomToken }: Props) {
  return <V4SwapCard network={network} tokens={tokens} onAddCustomToken={onAddCustomToken} />;
}
