import type { WalletClient } from "viem";

/* Off-chain metadata (image + description) for own-stack launch tokens whose contract stores only
 * name/symbol. Written creator-signed (see api/launch-meta.js); read publicly. */

/** Chains whose own-stack tokens carry off-chain metadata (mainnet Doppler tokens store it on-chain). */
export const OWNSTACK_META_CHAINS = new Set<number>([46630]);
export function chainSupportsLaunchMeta(chainId: number): boolean {
  return OWNSTACK_META_CHAINS.has(chainId);
}

export type LaunchMeta = { image: string; description: string };

/** Canonical message the creator signs — MUST byte-match api/launch-meta.js canonicalMessage().
 *  The literal first line is the domain/purpose tag (blocks cross-flow signature replay). */
export function buildLaunchMetaMessage(p: {
  chainId: number;
  token: string;
  image: string;
  description: string;
  issuedAt: number;
}): string {
  return [
    "Hyde launch metadata v1",
    `chainId:${p.chainId}`,
    `token:${p.token.toLowerCase()}`,
    `image:${p.image || ""}`,
    `issuedAt:${p.issuedAt}`,
    `description:${p.description ?? ""}`,
  ].join("\n");
}

/** Public read — resolves the token's saved image/description, or null. Fail-neutral. */
export async function fetchLaunchMeta(chainId: number, token: string): Promise<LaunchMeta | null> {
  if (!chainSupportsLaunchMeta(chainId)) return null;
  try {
    const r = await fetch(`/api/launch-meta?chainId=${chainId}&token=${token}`);
    if (!r.ok) return null;
    const d = await r.json();
    const m = d?.meta;
    if (!m) return null;
    return { image: m.image || "", description: m.description || "" };
  } catch {
    return null;
  }
}

/**
 * Sign (EIP-191 personal_sign) + POST creator-authenticated metadata. THROWS on any failure so the
 * caller can surface an explicit retry — the launch itself is already confirmed on-chain and must
 * never be rolled back by a metadata hiccup.
 */
export async function saveLaunchMeta(
  walletClient: WalletClient,
  account: `0x${string}`,
  p: { chainId: number; token: string; image: string; description: string }
): Promise<void> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const message = buildLaunchMetaMessage({ ...p, issuedAt });
  const signature = await walletClient.signMessage({ account, message });
  const res = await fetch("/api/launch-meta", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chainId: p.chainId,
      token: p.token,
      image: p.image,
      description: p.description,
      issuedAt,
      signature,
    }),
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d?.error || `Save failed (${res.status})`);
  }
}
