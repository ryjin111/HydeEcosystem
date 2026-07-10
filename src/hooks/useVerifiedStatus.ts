import { useEffect, useState } from "react";
import type { VerifyStatus } from "../components/ui/kit";

// Live per-token contract-verification status from Blockscout. HONEST BY
// CONSTRUCTION (gojo/kami gate): reads is_verified truth; ANY miss (404, not a
// contract, network error) → neutral/unverified — NEVER a false ✓. A failed
// lookup is a neutral state, never an app error and never blocks rendering.
// Isolated helper — touches no launch mechanics.
const BLOCKSCOUT = "https://robinhoodchain.blockscout.com/api/v2/smart-contracts";
const cache = new Map<string, VerifyStatus>();

export function useVerifiedStatus(address?: string): VerifyStatus {
  const key = address?.toLowerCase();
  const [status, setStatus] = useState<VerifyStatus>(key && cache.has(key) ? cache.get(key)! : "pending");

  useEffect(() => {
    if (!key) return;
    if (cache.has(key)) { setStatus(cache.get(key)!); return; }
    let cancelled = false;
    setStatus("pending");
    fetch(`${BLOCKSCOUT}/${key}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        // is_verified === true → verified; anything else (false, 404→null,
        // not-a-contract) → unverified. Never assert ✓ on ambiguity.
        const s: VerifyStatus = data && data.is_verified === true ? "verified" : "unverified";
        cache.set(key, s);
        if (!cancelled) setStatus(s);
      })
      .catch(() => {
        // network/error → neutral, do NOT cache (retryable), never false-✓
        if (!cancelled) setStatus("pending");
      });
    return () => { cancelled = true; };
  }, [key]);

  return status;
}
