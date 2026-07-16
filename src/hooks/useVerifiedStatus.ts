import { useEffect, useState } from "react";
import type { VerifyStatus } from "../components/ui/kit";
import { getLaunchImplementation } from "./useDopplerTokens";
import { NETWORKS, ROBINHOOD_MAINNET } from "../utils/constants";

// Live per-token contract-verification status from Blockscout. HONEST BY
// CONSTRUCTION (gojo/kami gate): reads is_verified truth; ANY miss (404, not a
// contract, network error) → neutral/unverified — NEVER a false ✓. A failed
// lookup is a neutral state, never an app error and never blocks rendering.
// Isolated helper — touches no launch mechanics.
//
// NETWORK-AWARE (gojo GAP-2): the Blockscout host differs per chain — mainnet 4663
// = robinhoodchain.blockscout.com, testnet 46630 = explorer.testnet.chain.robinhood.com.
// A hardcoded host made the badge read "unverified" forever on the other network even
// after the contracts were verified. We derive the API base from the active network's
// explorerUrl, same as the rest of the action-layer fix.
function blockscoutBase(chainId: number): string {
  const net = NETWORKS.find((n) => n.id === chainId) ?? ROBINHOOD_MAINNET;
  return `${net.explorerUrl.replace(/\/$/, "")}/api/v2/smart-contracts`;
}

const cache = new Map<string, VerifyStatus>();
const ck = (chainId: number, addr: string) => `${chainId}:${addr.toLowerCase()}`;

// Resolve verification, PROXY-AWARE. Hyde launches are EIP-1167 minimal proxies:
// the token address is not itself "verified", but its implementation (HydeERC20 /
// DopplerERC20V1) is — and a 1167 clone's behavior is fully determined by that
// verified implementation. So ✓ when EITHER the address is directly verified OR
// it's a proxy whose implementation is verified. Still NEVER a false-✓: we only
// return "verified" after confirming genuine verification.
// Per-impl Blockscout verification, cached ONLY when true (a miss may be
// transient network noise — never cache a false negative).
const implVerifiedCache = new Map<string, true>();
async function isImplVerified(impl: string, base: string): Promise<boolean> {
  const key = `${base}|${impl.toLowerCase()}`;
  if (implVerifiedCache.has(key)) return true;
  const r = await fetch(`${base}/${impl.toLowerCase()}`).catch(() => null);
  if (r?.ok && (await r.json())?.is_verified === true) { implVerifiedCache.set(key, true); return true; }
  return false;
}

async function resolveVerified(addr: string, chainId: number): Promise<VerifyStatus> {
  const base = blockscoutBase(chainId);
  const res = await fetch(`${base}/${addr}`);
  if (res.ok) {
    const data = await res.json();
    if (data?.is_verified === true) return "verified";
    // Blockscout-recognized proxy? resolve its implementation and check it. This is
    // the path own-stack clones take on testnet — Blockscout resolves the EIP-1167
    // implementations[] link, and the HydeERC20 impl is verified (full match).
    const impl: string | undefined =
      data?.implementations?.[0]?.address_hash ||
      data?.implementations?.[0]?.address ||
      (data?.proxy_type ? data?.implementation_address : undefined);
    if (impl && (await isImplVerified(impl, base))) return "verified";
  }
  // Blockscout has no verified entry — some Hyde clones 404 here (proxy→impl link
  // never indexed). Fall back to resolving the EIP-1167 impl from ONCHAIN BYTECODE.
  // The shared getLaunchImplementation helper is bound to the MAINNET client, so we
  // only use it for mainnet; on testnet the Blockscout impl-link path above already
  // resolves it, and anything else stays honest unverified (never a false ✓).
  if (chainId === ROBINHOOD_MAINNET.id) {
    const chainImpl = await getLaunchImplementation(addr as `0x${string}`);
    if (chainImpl && (await isImplVerified(chainImpl, base))) return "verified";
  }
  return "unverified";
}

export function useVerifiedStatus(address?: string, chainId: number = ROBINHOOD_MAINNET.id): VerifyStatus {
  const key = address ? ck(chainId, address) : undefined;
  const [status, setStatus] = useState<VerifyStatus>(key && cache.has(key) ? cache.get(key)! : "pending");

  useEffect(() => {
    if (!address || !key) return;
    if (cache.has(key)) { setStatus(cache.get(key)!); return; }
    let cancelled = false;
    setStatus("pending");
    resolveVerified(address.toLowerCase(), chainId)
      .then((s) => { cache.set(key, s); if (!cancelled) setStatus(s); })
      .catch(() => { /* network/error → neutral, not cached (retryable), never false-✓ */ if (!cancelled) setStatus("pending"); });
    return () => { cancelled = true; };
  }, [key, address, chainId]);

  return status;
}
