/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** IPFS read gateway for rewriting `ipfs://<CID>/<path>` → `${gateway}<CID>/<path>`.
   *  Defaults to https://ipfs.io/ipfs/ when unset (kami 21155). Display-only. */
  readonly VITE_IPFS_GATEWAY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
