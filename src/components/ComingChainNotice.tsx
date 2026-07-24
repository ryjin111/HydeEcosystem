// Fail-closed notice for a "coming" chain (Stable V3, pre-deploy) on trade/liquidity/portfolio routes.
// The chain is browsable + launch-visible, but V4 trade features aren't available — never render a V4
// card or Robinhood data on it (kami 24317). Honest, chain-aware, no fabricated values.
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
      <p className="text-sm font-medium text-pcs-text">{feature} isn’t available on {chainName} yet.</p>
      <p className="mt-2 text-xs leading-relaxed text-pcs-textSub">
        {chainName} is a single-sided V3 launch chain. Once launches go live here, liquidity will be
        permanently locked and tokens will trade on their canonical Uniswap pool. In-app{" "}
        {feature.toLowerCase()} opens after the chain is verified.
      </p>
      {onSwitch && (
        <Button variant="secondary" className="mt-4" onClick={onSwitch}>
          Switch to a trading chain
        </Button>
      )}
    </Card>
  );
}
