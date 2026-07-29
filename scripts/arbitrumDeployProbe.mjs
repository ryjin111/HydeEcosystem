// Read-only mainnet deployment probe for the Arbitrum Hydeout stack.
// Optional: ARBITRUM_RPC_URL=https://arb-mainnet.g.alchemy.com/v2/<key>
import { formatEther, keccak256 } from "viem";

const rpcUrl = process.env.ARBITRUM_RPC_URL || "https://arb1.arbitrum.io/rpc";
const deployer = "0x800557e7882b42ee49594fa2790300A9697a0e4D";
const addresses = {
  POOL_MANAGER: "0x360e68faccca8ca495c1b759fd9eee466db9fb32",
  POSITION_MANAGER: "0xd88f38f930b7952f2db2432cb002e7abbf3dd869",
  PERMIT2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  STATE_VIEW: "0x76fd297e2d437cd7f76d50f01afe6160f86e9990",
  UNIVERSAL_ROUTER: "0xa51afafe0263b40edaef0df8781ea9aa03e381a3",
  WETH: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
};

let requestId = 0;
async function rpc(method, params) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
  });
  const payload = await response.json();
  if (payload.error) throw new Error(`${method}: ${payload.error.message}`);
  return payload.result;
}

const chainId = Number(await rpc("eth_chainId", []));
if (chainId !== 42161) throw new Error(`Wrong chain: expected 42161, received ${chainId}`);

console.log(`Arbitrum One deployment probe · block ${Number(await rpc("eth_blockNumber", []))}`);
for (const [name, address] of Object.entries(addresses)) {
  const code = await rpc("eth_getCode", [address, "latest"]);
  if (!code || code === "0x") throw new Error(`${name} has no code at ${address}`);
  console.log(`${name}=${address} bytes=${(code.length - 2) / 2} codehash=${keccak256(code)}`);
}

const balance = BigInt(await rpc("eth_getBalance", [deployer, "latest"]));
const nonce = Number(await rpc("eth_getTransactionCount", [deployer, "latest"]));
const gasPrice = BigInt(await rpc("eth_gasPrice", []));
console.log(`DEPLOYER=${deployer} nonce=${nonce} balance=${formatEther(balance)} ETH gasPriceWei=${gasPrice}`);
