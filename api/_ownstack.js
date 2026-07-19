// SINGLE own-stack deploy-config source (kami B-blocker #2). chainId → { rpc, factory, deploymentBlock }.
// On ANY factory redeploy (e.g. the ETH-fee change / Commit C) this file's `factory` + `deploymentBlock`
// MUST be updated together — and in lockstep with the frontend's ROBINHOOD_TESTNET.factory +
// HYDE_TESTNET_FACTORY_DEPLOY_BLOCK and the ABI. Bounding scans from deploymentBlock avoids fromBlock:0.
// Underscore-prefixed so Vercel does not route it.
export const OWNSTACK = {
  46630: {
    rpc: "https://rpc.testnet.chain.robinhood.com",
    factory: "0x136914042064972913D54f024CccBA049C8cF03F",
    deploymentBlock: 90409075n, // factory CREATION block (Blockscout-verified, kami 22877) — safe lower bound
  },
};

export function ownstackChain(chainId) {
  return OWNSTACK[Number(chainId)] || null;
}
