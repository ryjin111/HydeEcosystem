import type { NetworkConfig } from "../utils/constants";

type Props = { network: NetworkConfig };

export function PoolsPage({ network: _network }: Props) {
  return (
    <div className="w-full max-w-6xl mx-auto px-4">
      <div className="mb-6">
        <h1 className="font-display text-2xl font-semibold text-pcs-text">Pools</h1>
        <p className="mt-1 text-xs text-pcs-textDim">Stake tokens to earn rewards</p>
      </div>

      <div
        className="rounded-2xl p-12 flex flex-col items-center gap-4 text-center"
        style={{ background: "#121419", border: "1px solid #22252D" }}
      >
        <div
          className="h-14 w-14 rounded-full flex items-center justify-center text-2xl"
          style={{ background: "rgba(46,159,230,0.10)" }}
        >
          💧
        </div>
        <div>
          <p className="text-base font-bold text-pcs-text">Pools Coming Soon</p>
          <p className="text-xs text-pcs-textDim mt-1 max-w-xs">
            HYDE staking pools deploy to Optimism alongside the HYDE token. Single-asset staking will be available here.
          </p>
        </div>
      </div>
    </div>
  );
}
