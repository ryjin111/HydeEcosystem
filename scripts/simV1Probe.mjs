// Does the 4663 RPC support eth_simulateV1 with asset-change tracing? If yes, we can produce an
// ACCURATE swap quote (bundle: HOODIE.approve → Permit2.approve → UR.execute, read TOKEN received)
// without a working V4 Quoter. If not, the card falls back to a StateView spot estimate + a
// simulate-before-submit gate.
import { createPublicClient, http, encodeFunctionData, encodeAbiParameters, parseAbiParameters } from "viem";

const RPC = "https://rpc.mainnet.chain.robinhood.com";
const UR       = "0x8876789976dEcBfCbBbe364623C63652db8C0904";
const PERMIT2  = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const HOODIE   = "0xC72c01AAB5f5678dc1d6f5C6d2B417d91D402Ba3";
const TOKEN    = "0x8a76FeeF3bb0140c122d146caCef6B1A4Ac145f7";
const HOOK     = "0x41078B0012751e7E646DF9B6607e6C4fF8B570C0";
const HOLDER   = "0xcbacfD51fB04bB996565F4B03c53BD0932fA740c";
const FEE = 0x800000, TICK = 60, ONE = 1000000000000000000n;

const client = createPublicClient({ transport: http(RPC) });

// balance check first
const bal = await client.readContract({ address: HOODIE, abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }], functionName: "balanceOf", args: [HOLDER] });
console.log("HOLDER HOODIE balance:", bal.toString());

// Build the BUY execute calldata (2-arg execute(bytes,bytes[]))
const actions = "0x060c0f";
const swapParam = encodeAbiParameters(
  parseAbiParameters("((address,address,uint24,int24,address),bool,uint128,uint128,uint256,bytes)"),
  [[[TOKEN, HOODIE, FEE, TICK, HOOK], false, ONE, 0n, 0n, "0x"]]);
const settleParam = encodeAbiParameters(parseAbiParameters("address,uint256"), [HOODIE, ONE]);
const takeParam = encodeAbiParameters(parseAbiParameters("address,uint256"), [TOKEN, 0n]);
const v4SwapInput = encodeAbiParameters(parseAbiParameters("bytes,bytes[]"), [actions, [swapParam, settleParam, takeParam]]);
const executeData = encodeFunctionData({
  abi: [{ type: "function", name: "execute", stateMutability: "payable", inputs: [{ type: "bytes" }, { type: "bytes[]" }], outputs: [] }],
  functionName: "execute", args: ["0x10", [v4SwapInput]] });

const erc20approve = (spender, amt) => encodeFunctionData({ abi: [{ type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] }], functionName: "approve", args: [spender, amt] });
const p2approve = encodeFunctionData({ abi: [{ type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "address" }, { type: "uint160" }, { type: "uint48" }], outputs: [] }], functionName: "approve", args: [HOODIE, UR, (1n << 160n) - 1n, 2000000000] });

try {
  const res = await client.request({
    method: "eth_simulateV1",
    params: [{
      blockStateCalls: [{
        calls: [
          { from: HOLDER, to: HOODIE, data: erc20approve(PERMIT2, (1n << 256n) - 1n) },
          { from: HOLDER, to: PERMIT2, data: p2approve },
          { from: HOLDER, to: UR, data: executeData, value: "0x0" },
        ],
        traceTransfers: true,
      }],
      validation: false,
      traceTransfers: true,
    }, "latest"],
  });
  const call3 = res[0].calls[2];
  console.log("execute status:", call3.status, "gasUsed:", parseInt(call3.gasUsed, 16));
  // Output amount = TOKEN (currency0) Transfer whose `to` == HOLDER (the TAKE_ALL recipient).
  const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const holderTopic = "0x000000000000000000000000" + HOLDER.slice(2).toLowerCase();
  let out = null;
  for (const l of call3.logs) {
    if (l.address.toLowerCase() === TOKEN.toLowerCase() && l.topics[0] === TRANSFER && l.topics[2]?.toLowerCase() === holderTopic) {
      out = BigInt(l.data);
    }
  }
  console.log(`ACCURATE QUOTE: 1 HOODIE -> ${out === null ? "?" : (Number(out) / 1e18).toFixed(6)} TOKEN  (raw ${out})`);
  console.log("all call statuses:", res[0].calls.map((c) => c.status).join(","));
} catch (e) {
  console.log("eth_simulateV1 FAIL:", String(e).split("\n").slice(0, 3).join(" | ").slice(0, 300));
}
