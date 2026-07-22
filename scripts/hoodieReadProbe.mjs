// Live-4663 read-layer probe for the HOODIE swap card. Validates, against mainnet, every read the
// card depends on BEFORE it's written: poolId derivation, StateView slot0/liquidity, whether the
// deployed V4 Quoter works on the dynamic-fee hook pool, and the protection getters (hook.active +
// token max-wallet). Pure reads — no keys, no state change.
//   node scripts/hoodieReadProbe.mjs
import { createPublicClient, http, keccak256, encodeAbiParameters, parseAbiParameters, formatUnits } from "viem";

const RPC = "https://rpc.mainnet.chain.robinhood.com";
const STATE_VIEW = "0xF3334192D15450CdD385c8B70e03f9A6bD9E673b";
const QUOTER     = "0x7232686FC954f12079cadFC5e9F755a9fEAeb3Ca";
const HOOK       = "0x41078B0012751e7E646DF9B6607e6C4fF8B570C0";
const HOODIE     = "0xC72c01AAB5f5678dc1d6f5C6d2B417d91D402Ba3"; // numeraire (currency1)
const TOKEN      = "0x8a76FeeF3bb0140c122d146caCef6B1A4Ac145f7"; // LILHOODIE (currency0, TOKEN < HOODIE)
const HOLDER     = "0xcbacfD51fB04bB996565F4B03c53BD0932fA740c"; // real HOODIE holder
const FEE = 0x800000, TICK = 60;

const client = createPublicClient({ transport: http(RPC) });

// poolId = keccak256(abi.encode(PoolKey)) — all-static struct, so tuple-encode the 5 fields.
const poolId = keccak256(encodeAbiParameters(
  parseAbiParameters("address,address,uint24,int24,address"),
  [TOKEN, HOODIE, FEE, TICK, HOOK],
));
console.log("computed poolId:", poolId);

const stateViewAbi = [
  { type: "function", name: "getSlot0", stateMutability: "view", inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [{ name: "sqrtPriceX96", type: "uint160" }, { name: "tick", type: "int24" }, { name: "protocolFee", type: "uint24" }, { name: "lpFee", type: "uint24" }] },
  { type: "function", name: "getLiquidity", stateMutability: "view", inputs: [{ name: "poolId", type: "bytes32" }], outputs: [{ name: "liquidity", type: "uint128" }] },
];
const hookAbi = [
  { type: "function", name: "active", stateMutability: "view", inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [{ name: "exists", type: "bool" }, { name: "token", type: "address" }, { name: "launchTime", type: "uint64" }] },
  { type: "function", name: "antiSnipeWindow", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "startFee", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "baseFee", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
];
const tokenAbi = [
  { type: "function", name: "maxWallet", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "maxWalletExpiry", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
];
const quoterAbi = [
  { type: "function", name: "quoteExactInputSingle", stateMutability: "nonpayable",
    inputs: [{ name: "params", type: "tuple", components: [
      { name: "poolKey", type: "tuple", components: [
        { name: "currency0", type: "address" }, { name: "currency1", type: "address" },
        { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" }] },
      { name: "zeroForOne", type: "bool" }, { name: "exactAmount", type: "uint128" }, { name: "hookData", type: "bytes" }] }],
    outputs: [{ name: "amountOut", type: "uint256" }, { name: "gasEstimate", type: "uint256" }] },
];

const try_ = async (label, fn) => { try { const v = await fn(); console.log(`PASS  ${label}:`, v); return v; } catch (e) { console.log(`FAIL  ${label}: ${String(e).split("\n")[0].slice(0, 120)}`); return null; } };

const latest = await client.getBlock();
console.log("chain now:", Number(latest.timestamp));

await try_("StateView.getSlot0", () => client.readContract({ address: STATE_VIEW, abi: stateViewAbi, functionName: "getSlot0", args: [poolId] }).then((r) => ({ sqrtPriceX96: r[0].toString(), tick: r[1], lpFee: r[3] })));
await try_("StateView.getLiquidity", () => client.readContract({ address: STATE_VIEW, abi: stateViewAbi, functionName: "getLiquidity", args: [poolId] }).then(String));
await try_("hook.active(poolId)", () => client.readContract({ address: HOOK, abi: hookAbi, functionName: "active", args: [poolId] }).then((r) => ({ exists: r[0], token: r[1], launchTime: Number(r[2]) })));
await try_("hook.antiSnipeWindow", () => client.readContract({ address: HOOK, abi: hookAbi, functionName: "antiSnipeWindow" }).then(String));
await try_("hook.startFee", () => client.readContract({ address: HOOK, abi: hookAbi, functionName: "startFee" }).then(String));
await try_("hook.baseFee", () => client.readContract({ address: HOOK, abi: hookAbi, functionName: "baseFee" }).then(String));
await try_("token.maxWallet", () => client.readContract({ address: TOKEN, abi: tokenAbi, functionName: "maxWallet" }).then((v) => `${v} (${formatUnits(v, 18)})`));
await try_("token.maxWalletExpiry", () => client.readContract({ address: TOKEN, abi: tokenAbi, functionName: "maxWalletExpiry" }).then(String));
await try_("token.totalSupply", () => client.readContract({ address: TOKEN, abi: tokenAbi, functionName: "totalSupply" }).then((v) => `${v} (${formatUnits(v, 18)})`));
await try_("token.balanceOf(HOLDER)", () => client.readContract({ address: TOKEN, abi: tokenAbi, functionName: "balanceOf", args: [HOLDER] }).then((v) => formatUnits(v, 18)));

// The big question: does the deployed V4 Quoter return a real amountOut for the dynamic-fee hook pool?
await try_("Quoter BUY 1 HOODIE->TOKEN (zeroForOne=false)", () => client.simulateContract({ address: QUOTER, abi: quoterAbi, functionName: "quoteExactInputSingle",
  args: [{ poolKey: { currency0: TOKEN, currency1: HOODIE, fee: FEE, tickSpacing: TICK, hooks: HOOK }, zeroForOne: false, exactAmount: 1000000000000000000n, hookData: "0x" }] }).then((r) => `amountOut=${formatUnits(r.result[0], 18)} TOKEN, gas=${r.result[1]}`));
await try_("Quoter SELL 1e6 TOKEN->HOODIE (zeroForOne=true)", () => client.simulateContract({ address: QUOTER, abi: quoterAbi, functionName: "quoteExactInputSingle",
  args: [{ poolKey: { currency0: TOKEN, currency1: HOODIE, fee: FEE, tickSpacing: TICK, hooks: HOOK }, zeroForOne: true, exactAmount: 1000000000000000000000000n, hookData: "0x" }] }).then((r) => `amountOut=${formatUnits(r.result[0], 18)} HOODIE, gas=${r.result[1]}`));

console.log("\nprobe done.");
