/**
 * Doppler protocol configuration for Hyde Launchpad.
 * Addresses sourced from @whetstone-research/doppler-sdk via getAddresses(57073).
 */

// Doppler Indexer GraphQL endpoints
export const DOPPLER_INDEXER_URLS: Record<number, string> = {
  57073: "https://indexer.doppler.lol/graphql",
  84532: "https://testnet-indexer.doppler.lol/graphql",
};

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
};

export const DOPPLER_POOLS_QUERY = `
  query GetPools($chainId: Int!, $limit: Int!) {
    pools(
      orderBy: "createdAt"
      orderDirection: "desc"
      limit: $limit
      where: { chainId: $chainId }
    ) {
      items {
        address
        chainId
        baseToken { address name symbol decimals }
        quoteToken { address name symbol decimals }
        type
        dollarLiquidity
        volumeUsd
        createdAt
      }
    }
  }
`;
