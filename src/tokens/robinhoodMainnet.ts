import type { TokenInfo } from "../utils/constants";

export const ROBINHOOD_MAINNET_TOKENS: TokenInfo[] = [
  {
    symbol: "ETH",
    name: "Ether",
    address: "0x0000000000000000000000000000000000000000",
    decimals: 18,
    logoURI: "/tokens/ETH.svg",
    isNative: true,
  },
  {
    symbol: "WETH",
    name: "Wrapped Ether",
    // Verified on-chain: UniswapV2MigratorSplit.weth() → this address; symbol()/name() both "WETH"
    address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    decimals: 18,
    logoURI: "/tokens/WETH.svg",
  },
];
