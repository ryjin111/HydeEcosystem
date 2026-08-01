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
  readonly VITE_ARBITRUM_MAINNET_RPC_URL?: string;
  readonly VITE_ARC_MAINNET_RPC_URL?: string;
  /** Optional Ponder API. Discovery prefers it and safely falls back to direct factory-log scans. */
  readonly VITE_V5_INDEXER_URL?: string;
  /** V5 is fail-closed: every runtime address/hash field is required before the UI reads or writes it. */
  readonly VITE_TRENCH_V5_ARC_FACTORY?: string;
  readonly VITE_TRENCH_V5_ARC_FACTORY_CODE_HASH?: string;
  readonly VITE_TRENCH_V5_ARC_GRADUATOR_CODE_HASH?: string;
  readonly VITE_TRENCH_V5_ARC_LOCKER_CODE_HASH?: string;
  readonly VITE_TRENCH_V5_ARC_DEPLOYMENT_BLOCK?: string;
  readonly VITE_TRENCH_V5_STABLE_FACTORY?: string;
  readonly VITE_TRENCH_V5_STABLE_FACTORY_CODE_HASH?: string;
  readonly VITE_TRENCH_V5_STABLE_GRADUATOR_CODE_HASH?: string;
  readonly VITE_TRENCH_V5_STABLE_LOCKER_CODE_HASH?: string;
  readonly VITE_TRENCH_V5_STABLE_DEPLOYMENT_BLOCK?: string;
  readonly VITE_TRENCH_V5_ROBINHOOD_FACTORY?: string;
  readonly VITE_TRENCH_V5_ROBINHOOD_FACTORY_CODE_HASH?: string;
  readonly VITE_TRENCH_V5_ROBINHOOD_GRADUATOR_CODE_HASH?: string;
  readonly VITE_TRENCH_V5_ROBINHOOD_LOCKER_CODE_HASH?: string;
  readonly VITE_TRENCH_V5_ROBINHOOD_HOOK?: string;
  readonly VITE_TRENCH_V5_ROBINHOOD_HOOK_CODE_HASH?: string;
  readonly VITE_TRENCH_V5_ROBINHOOD_DEPLOYMENT_BLOCK?: string;
  readonly VITE_TRENCH_V5_ARBITRUM_FACTORY?: string;
  readonly VITE_TRENCH_V5_ARBITRUM_FACTORY_CODE_HASH?: string;
  readonly VITE_TRENCH_V5_ARBITRUM_GRADUATOR_CODE_HASH?: string;
  readonly VITE_TRENCH_V5_ARBITRUM_LOCKER_CODE_HASH?: string;
  readonly VITE_TRENCH_V5_ARBITRUM_HOOK?: string;
  readonly VITE_TRENCH_V5_ARBITRUM_HOOK_CODE_HASH?: string;
  readonly VITE_TRENCH_V5_ARBITRUM_DEPLOYMENT_BLOCK?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
