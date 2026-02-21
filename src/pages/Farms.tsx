import type { NetworkConfig } from "../utils/constants";

type Props = { network: NetworkConfig };

export function FarmsPage({ network: _network }: Props) {
  return (
    <div className="w-full max-w-6xl mx-auto px-4">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-pcs-text">Farms</h1>
        <p className="mt-1 text-xs text-pcs-textDim">Stake LP tokens to earn HYDE rewards</p>
      </div>

      <div
        className="rounded-2xl p-12 flex flex-col items-center gap-4 text-center"
        style={{ background: "#0d1220", border: "1px solid rgba(0,212,255,0.08)" }}
      >
        <div
          className="h-14 w-14 rounded-full flex items-center justify-center text-2xl"
          style={{ background: "rgba(0,212,255,0.08)" }}
        >
          🌱
        </div>
        <div>
          <p className="text-base font-bold text-pcs-text">Farms Coming Soon</p>
          <p className="text-xs text-pcs-textDim mt-1 max-w-xs">
            HYDE farming rewards launch when MasterChef deploys to Ink Mainnet. LP staking will be available here.
          </p>
        </div>
      </div>
    </div>
  );
}
