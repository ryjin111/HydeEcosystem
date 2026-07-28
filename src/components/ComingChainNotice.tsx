// Fail-closed notice for an engine-specific feature boundary. Never render a V4 action on a V3 route.
import { Card, Button } from "./ui/kit";

export function ComingChainNotice({
  chainName,
  feature,
  onSwitch,
}: {
  chainName: string;
  feature: string;
  onSwitch?: () => void;
}) {
  return (
    <Card variant="panel" className="mx-auto max-w-md text-center">
      <p className="text-sm font-medium text-pcs-text">{feature} isn’t part of {chainName}’s current V3 route.</p>
      <p className="mt-2 text-xs leading-relaxed text-pcs-textSub">
        {chainName} uses single-sided V3 launches with permanently locked principal. Hydeout exposes
        only execution paths verified for this engine; V4 controls are intentionally hidden.
      </p>
      {onSwitch && (
        <Button variant="secondary" className="mt-4" onClick={onSwitch}>
          Switch to a trading chain
        </Button>
      )}
    </Card>
  );
}
