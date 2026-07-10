import { useEffect, useState } from "react";
import type { VerifyStatus } from "../components/ui/kit";
import { getLaunchImplementation } from "./useDopplerTokens";

// Live per-token contract-verification status from Blockscout. HONEST BY
// CONSTRUCTION (gojo/kami gate): reads is_verified truth; ANY miss (404, not a
// contract, network error) → neutral/unverified — NEVER a false ✓. A failed
// lookup is a neutral state, never an app error and never blocks rendering.
// Isolated helper — touches no launch mechanics.
const BLOCKSCOUT = "https://robinhoodchain.blockscout.com/api/v2/smart-contracts";
const cache = new Map<string, VerifyStatus>();

// Resolve verification, PROXY-AWARE. Hyde launches are EIP-1167 minimal proxies:
// the token address is not itself "verified", but its implementation
// (DopplerERC20V1) is — and a 1167 clone's behavior is fully determined by that
// verified implementation. So ✓ when EITHER the address is directly verified OR
// it's a proxy whose implementation is verified. Still NEVER a false-✓: we only
// return "verified" after confirming genuine verification.
// Per-impl Blockscout verification, cached ONLY when true (a miss may be
// transient network noise — never cache a false negative).
const implVerifiedCache = new Map<string, true>();
async function isImplVerified(impl: string): Promise<boolean> {
  const key = impl.toLowerCase();
  if (implVerifiedCache.has(key)) return true;
  const r = await fetch(`${BLOCKSCOUT}/${key}`).catch(() => null);
  if (r?.ok && (await r.json())?.is_verified === true) { implVerifiedCache.set(key, true); return true; }
  return false;
}

async function resolveVerified(addr: string): Promise<VerifyStatus> {
  const res = await fetch(`${BLOCKSCOUT}/${addr}`);
  if (res.ok) {
    const data = await res.json();
    if (data?.is_verified === true) return "verified";
    // Blockscout-recognized proxy? resolve its implementation and check it
    // (kept as the general path for non-1167 proxy types).
    const impl: string | undefined =
      data?.implementations?.[0]?.address_hash ||
      data?.implementations?.[0]?.address ||
      (data?.proxy_type ? data?.implementation_address : undefined);
    if (impl && (await isImplVerified(impl))) return "verified";
  }
  // Blockscout has no verified entry — many Hyde clones 404 here (proxy→impl
  // link never indexed). SAME SOURCE OF TRUTH as the isHydeLaunch filter
  // (gojo root-cause / kami direction): resolve the EIP-1167 impl from ONCHAIN
  // BYTECODE via the shared getLaunchImplementation helper, then require THAT
  // impl's genuine Blockscout is_verified. A 1167 clone's behavior is fully
  // determined by its implementation → genuine ✓, not an inference. Bytecode
  // always wins over indexing. Anything else stays honest unverified.
  const chainImpl = await getLaunchImplementation(addr as `0x${string}`);
  if (chainImpl && (await isImplVerified(chainImpl))) return "verified";
  return "unverified";
}

export function useVerifiedStatus(address?: string): VerifyStatus {
  const key = address?.toLowerCase();
  const [status, setStatus] = useState<VerifyStatus>(key && cache.has(key) ? cache.get(key)! : "pending");

  useEffect(() => {
    if (!key) return;
    if (cache.has(key)) { setStatus(cache.get(key)!); return; }
    let cancelled = false;
    setStatus("pending");
    resolveVerified(key)
      .then((s) => { cache.set(key, s); if (!cancelled) setStatus(s); })
      .catch(() => { /* network/error → neutral, not cached (retryable), never false-✓ */ if (!cancelled) setStatus("pending"); });
    return () => { cancelled = true; };
  }, [key]);

  return status;
}
