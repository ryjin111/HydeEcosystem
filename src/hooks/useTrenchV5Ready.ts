import { useEffect, useState } from "react";
import { isTrenchV5Configured, verifyTrenchV5Runtime } from "../utils/trenchV5";

export type TrenchV5Readiness = {
  ready: boolean;
  checking: boolean;
  error: string | null;
};

/**
 * A parsed environment manifest is not proof of a deployment. Readiness becomes true only after
 * runtime code hashes and every factory/graduator/locker/(V4 hook) binding pass on the selected chain.
 */
export function useTrenchV5Ready(chainId: number): TrenchV5Readiness {
  const configured = isTrenchV5Configured(chainId);
  const [state, setState] = useState<TrenchV5Readiness>({
    ready: false,
    checking: configured,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    if (!isTrenchV5Configured(chainId)) {
      setState({ ready: false, checking: false, error: null });
      return () => {
        cancelled = true;
      };
    }
    setState({ ready: false, checking: true, error: null });
    verifyTrenchV5Runtime(chainId)
      .then(() => {
        if (!cancelled) setState({ ready: true, checking: false, error: null });
      })
      .catch((cause) => {
        if (!cancelled) {
          setState({
            ready: false,
            checking: false,
            error: cause instanceof Error ? cause.message : "V5 runtime verification failed.",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [chainId]);

  return state;
}
