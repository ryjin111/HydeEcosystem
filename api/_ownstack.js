// SINGLE own-stack deploy-config source (kami B-blocker #2). chainId → { rpc, factory, deploymentBlock }.
// On ANY factory redeploy (e.g. the ETH-fee change / Commit C) this file's `factory` + `deploymentBlock`
// MUST be updated together — and in lockstep with the frontend's ROBINHOOD_TESTNET.factory +
// HYDE_TESTNET_FACTORY_DEPLOY_BLOCK and the ABI. Bounding scans from deploymentBlock avoids fromBlock:0.
// Underscore-prefixed so Vercel does not route it.
export const OWNSTACK = {
  46630: {
    rpc: "https://rpc.testnet.chain.robinhood.com",
    factory: "0x6607BE76A0F8C44AadB5DF3bb13AcD29fb3Ade2C",
    deploymentBlock: 91418522n, // NEW 0.0004-ETH factory creation block (deploy tx 0x0e58fc6f…)
  },
};

export function ownstackChain(chainId) {
  return OWNSTACK[Number(chainId)] || null;
}
