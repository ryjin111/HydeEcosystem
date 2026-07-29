// SINGLE Hyde launch-metadata verification config (kami B-blocker #2). Each chain pins its authoritative
// launch emitter and deployment block. On ANY redeploy, update the address + block together and in lockstep
// with the frontend registry. Every creator scan is deployment-bounded (never fromBlock:0).
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
    factory: "0x159A2fa37427299466B0723713eaa260e6124cbc", // current $5k WETH HydeTokenFactory
    deploymentBlock: 17418907n,
    // HOODIE launcher-launcher: tokens launched here emit `HoodieLaunchCreated` from the engine (carrying the
    // HUMAN creator). launch-meta.js checks this as a SECOND creator source, bounded from its deploy block.
    hoodieEngine: "0x8062951c99CfFA5365f979D5139Cf96b5c77CFCc",
    hoodieDeploymentBlock: 15652257n, // HOODIE engine creation block on 4663 (kami 23644)
  },
  988: {
    // Prefer the paid Stable endpoint server-side when configured; the public RPC is a safe fallback.
    rpc: process.env.STABLE_RPC_URL
      || process.env.VITE_STABLE_MAINNET_RPC_URL
      || "https://rpc.stable.xyz",
    v3Pad: "0xE79F17Fe61F9c76824D74C496f122f0AB483ec6A",
    // Canonical locker created by the pad. positionOf(token) is the direct immutable creator registry,
    // so metadata verification never needs an RPC-provider-specific historical log scan.
    v3Locker: "0xE43314319675eF26724a7d4381D95ac31c246d90",
    v3DeploymentBlock: 33271478n,
  },
  42161: {
    // Prefer the paid Arbitrum endpoint server-side; public RPC is the safe fallback.
    rpc: process.env.ARBITRUM_RPC_URL
      || process.env.VITE_ARBITRUM_MAINNET_RPC_URL
      || "https://arb1.arbitrum.io/rpc",
    factory: "0x710fEa288266518528A4230771E07ee310ce509f",
    deploymentBlock: 488965908n,
  },
};

export function ownstackChain(chainId) {
  return OWNSTACK[Number(chainId)] || null;
}
