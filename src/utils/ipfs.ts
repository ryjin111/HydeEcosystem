/**
 * IPFS read-gateway rewriting (kami 21155, clint 21153).
 *
 * "IPFS only" media: creators reference art as `ipfs://<CID>/<path>`. Browsers can't load the
 * `ipfs://` scheme directly, so we rewrite it to an HTTP read gateway for DISPLAY only. This does
 * NOT pin or upload anything — turning bytes into a CID still needs a pinning service (Pinata /
 * web3.storage), which is a separate, not-yet-built step. This module only makes existing CIDs
 * viewable.
 *
 * Gateway is configurable via `VITE_IPFS_GATEWAY`, defaulting to the public ipfs.io gateway.
 */

const DEFAULT_IPFS_GATEWAY = "https://inland-fuchsia-dove.myfilebase.com/ipfs/";

/** Resolved gateway base, always with a single trailing slash. */
export function ipfsGateway(): string {
  const configured = import.meta.env.VITE_IPFS_GATEWAY?.trim();
  const base = configured && configured.length > 0 ? configured : DEFAULT_IPFS_GATEWAY;
  return base.endsWith("/") ? base : `${base}/`;
}

/**
 * Convert an `ipfs://<CID>/<path>` URI to `${gateway}<CID>/<path>`.
 * Any other value (https://, data:, http://, already-gateway'd, or empty) passes through unchanged,
 * so it is safe to call on every image src.
 */
export function ipfsToGateway(uri: string | undefined | null): string {
  if (!uri) return "";
  const s = uri.trim();
  if (!s.toLowerCase().startsWith("ipfs://")) return s;

  // Strip the scheme, tolerate a redundant leading "ipfs/" and stray leading slashes.
  let rest = s.slice("ipfs://".length).replace(/^\/+/, "");
  if (/^ipfs\//i.test(rest)) rest = rest.slice(rest.indexOf("/") + 1);
  return `${ipfsGateway()}${rest}`;
}
