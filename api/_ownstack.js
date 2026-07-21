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
  4663: {
    // Prefer Clint's paid Alchemy endpoint server-side when configured. Never expose this value through
    // a VITE_ variable; the public Robinhood RPC remains the safe fallback for local/dev deployments.
    rpc: process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com",
    factory: "0x710fEa288266518528A4230771E07ee310ce509f", // mainnet WETH HydeTokenFactory (deployed 2026-07-21)
    deploymentBlock: 15643595n, // WETH factory creation block on 4663
    // HOODIE launcher-launcher: tokens launched here emit `HoodieLaunchCreated` from the engine (carrying the
    // HUMAN creator). launch-meta.js checks this as a SECOND creator source, bounded from its deploy block.
    hoodieEngine: "0x8062951c99CfFA5365f979D5139Cf96b5c77CFCc",
    hoodieDeploymentBlock: 15652257n, // HOODIE engine creation block on 4663 (kami 23644)
  },
};

export function ownstackChain(chainId) {
  return OWNSTACK[Number(chainId)] || null;
}
