/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** IPFS read gateway for rewriting `ipfs://<CID>/<path>` → `${gateway}<CID>/<path>`.
   *  Defaults to https://ipfs.io/ipfs/ when unset (kami 21155). Display-only. */
  readonly VITE_IPFS_GATEWAY?: string;
  /** Browser RPC key. This is bundled client-side; protect it with Alchemy origin allowlists. */
  readonly VITE_ALCHEMY_API_KEY?: string;
  /** Optional full-endpoint overrides. These take precedence over VITE_ALCHEMY_API_KEY. */
  readonly VITE_ROBINHOOD_MAINNET_RPC_URL?: string;
  readonly VITE_STABLE_MAINNET_RPC_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
