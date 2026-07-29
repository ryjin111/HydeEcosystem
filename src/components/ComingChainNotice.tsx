// Fail-closed notice for an engine-specific feature boundary.
import { Card, Button } from "./ui/kit";
import type { LaunchEngine } from "../utils/chainRegistry";

export function ComingChainNotice({
  chainName,
  feature,
  engine = "v3-single-sided",
  detail,
  onSwitch,
}: {
  chainName: string;
  feature: string;
  engine?: LaunchEngine;
  detail?: string;
  onSwitch?: () => void;
}) {
  const isV4 = engine === "v4-hook";
  return (
    <Card variant="panel" className="mx-auto max-w-md text-center">
      <p className="text-sm font-medium text-pcs-text">
        {isV4 ? `${feature} isn’t live on ${chainName} yet.` : `${feature} isn’t part of ${chainName}’s current V3 route.`}
      </p>
      <p className="mt-2 text-xs leading-relaxed text-pcs-textSub">
        {detail ?? (isV4
          ? `Canonical Uniswap V4 is available on ${chainName}. Hydeout's factory, hook, vault, and execution path remain disabled until their chain-specific deployment is verified.`
          : `${chainName} uses single-sided V3 launches with permanently locked principal. Hydeout exposes only execution paths verified for this engine; V4 controls are intentionally hidden.`)}
      </p>
      {onSwitch && (
        <Button variant="secondary" className="mt-4" onClick={onSwitch}>
          Switch to a trading chain
        </Button>
      )}
    </Card>
  );
}
