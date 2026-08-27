import { useEffect, useState } from "react";
import { isTrenchV5Configured, verifyTrenchV5Runtime } from "../utils/trenchV5";
import { chainV3Capability, isHydeLaunchLive } from "../utils/chainRegistry";

export type TrenchV5Readiness = {
  ready: boolean;
  checking: boolean;
  error: string | null;
  retry: () => void;
};

const verifiedChains = new Set<number>();
const verificationInFlight = new Map<number, Promise<void>>();

function standaloneV3Ready(chainId: number): boolean {
  return !isTrenchV5Configured(chainId)
    && chainV3Capability(chainId)?.status === "live"
    && isHydeLaunchLive(chainId, "v3-single-sided");
}

function unavailableError(chainId: number): string {
  return chainV3Capability(chainId)
    ? "Verified V3 launch deployment evidence is unavailable."
    : "V5 deployment manifest is unavailable.";
}

function verifyOnce(chainId: number): Promise<void> {
  if (verifiedChains.has(chainId)) return Promise.resolve();
  const existing = verificationInFlight.get(chainId);
  if (existing) return existing;
  const request = verifyTrenchV5Runtime(chainId)
    .then(() => { verifiedChains.add(chainId); })
    .finally(() => { verificationInFlight.delete(chainId); });
  verificationInFlight.set(chainId, request);
  return request;
}

/**
 * A parsed environment manifest is not proof of a deployment. V5 readiness becomes true only after
 * runtime hashes and protocol bindings pass. Standalone V3 rails use the registry's signed deployment,
 * runtime-hash, cross-binding and read-smoke evidence; their launch pre-flight repeats live checks.
 */
export function useTrenchV5Ready(chainId: number): TrenchV5Readiness {
  const configured = isTrenchV5Configured(chainId);
  const standaloneReady = standaloneV3Ready(chainId);
  const [attempt, setAttempt] = useState(0);
  const retry = () => setAttempt((value) => value + 1);
  const [snapshot, setSnapshot] = useState<{
    chainId: number;
    state: Omit<TrenchV5Readiness, "retry">;
  }>({
    chainId,
    state: standaloneReady || verifiedChains.has(chainId)
      ? { ready: true, checking: false, error: null }
      : configured
        ? { ready: false, checking: true, error: null }
        : { ready: false, checking: false, error: unavailableError(chainId) },
  });

  // Never expose the previous chain's successful state while the next chain waits for its effect.
  const state = snapshot.chainId === chainId
    ? snapshot.state
    : standaloneReady || verifiedChains.has(chainId)
      ? { ready: true, checking: false, error: null }
      : configured
        ? { ready: false, checking: true, error: null }
        : { ready: false, checking: false, error: unavailableError(chainId) };

  useEffect(() => {
    let cancelled = false;
    if (standaloneV3Ready(chainId)) {
      setSnapshot({ chainId, state: { ready: true, checking: false, error: null } });
      return () => { cancelled = true; };
    }
    if (!isTrenchV5Configured(chainId)) {
      setSnapshot({
        chainId,
        state: { ready: false, checking: false, error: unavailableError(chainId) },
      });
      return () => {
        cancelled = true;
      };
    }
    if (verifiedChains.has(chainId)) {
      setSnapshot({ chainId, state: { ready: true, checking: false, error: null } });
      return () => { cancelled = true; };
    }
    setSnapshot({ chainId, state: { ready: false, checking: true, error: null } });
    verifyOnce(chainId)
      .then(() => {
        if (!cancelled) setSnapshot({ chainId, state: { ready: true, checking: false, error: null } });
      })
      .catch((cause) => {
        if (!cancelled) {
          setSnapshot({
            chainId,
            state: {
              ready: false,
              checking: false,
              error: cause instanceof Error ? cause.message : "V5 runtime verification failed.",
            },
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [attempt, chainId]);

  return { ...state, retry };
}
