import { useEffect, useState } from "react";
import type { VerifyStatus } from "../components/ui/kit";

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
async function resolveVerified(addr: string): Promise<VerifyStatus> {
  const res = await fetch(`${BLOCKSCOUT}/${addr}`);
  if (!res.ok) return "unverified"; // 404 / not-a-contract → honest unverified
  const data = await res.json();
  if (data?.is_verified === true) return "verified";
  // proxy? resolve the implementation and check it
  const impl: string | undefined =
    data?.implementations?.[0]?.address_hash ||
    data?.implementations?.[0]?.address ||
    (data?.proxy_type ? data?.implementation_address : undefined);
  if (impl) {
    const ir = await fetch(`${BLOCKSCOUT}/${impl.toLowerCase()}`);
    if (ir.ok) {
      const idata = await ir.json();
      if (idata?.is_verified === true) return "verified";
    }
  }
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
