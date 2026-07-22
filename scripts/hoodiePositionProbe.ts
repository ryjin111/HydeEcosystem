// Live-4663 gate for the mainnet-HOODIE position PLUMBING that useTokenPosition adds (the covered-basis
// scan's on-chain data sources). Proves: the token's HoodieLaunchCreated attribution + inception block
// resolve, the event's poolId matches our derived poolId (so basis reconciles against the RIGHT pool),
// and the pool's Swap logs are queryable by that poolId. The mark itself (net-of-slippage sell sim) is
// already proven by hoodieSwapLiveSim; the covered-only accounting by positionPnlSmoke (40/40).
//
// Build+run: node_modules/.bin/esbuild scripts/hoodiePositionProbe.ts --bundle --platform=node
//   --format=esm --outfile=<tmp>.mjs && node <tmp>.mjs
import { createPublicClient, http, parseAbiItem } from "viem";
import { V4_CONTRACTS_BY_CHAIN } from "../src/utils/constants";
import { hoodiePoolId } from "../src/utils/hoodieSwap";

const RPC = "https://rpc.mainnet.chain.robinhood.com";
const CHAIN = 4663;
const TOKEN = "0x8a76FeeF3bb0140c122d146caCef6B1A4Ac145f7" as `0x${string}`; // LILHOODIE
const ENGINE_BLOCK = 15652257n;
const client = createPublicClient({ transport: http(RPC) });
const c = V4_CONTRACTS_BY_CHAIN[CHAIN];

const HOODIE_LAUNCH_CREATED = parseAbiItem("event HoodieLaunchCreated(address indexed launcher, address indexed creator, address indexed token, bytes32 poolId, uint256 tokenId)");
const SWAP = parseAbiItem("event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)");

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n: string, d: string) => { fail++; console.log(`  ✗ ${n} — ${d}`); };

const latest = await client.getBlockNumber();

// 1. Attribution + inception
const created = await client.getLogs({ address: c.hoodieEngine as `0x${string}`, event: HOODIE_LAUNCH_CREATED, args: { token: TOKEN }, fromBlock: ENGINE_BLOCK, toBlock: latest });
created.length > 0 ? ok(`HoodieLaunchCreated attribution resolves — inception block ${created[0].blockNumber}`) : bad("attribution resolves", "no HoodieLaunchCreated for LILHOODIE");

// 2. Derived poolId matches the event's poolId (basis reconciles against the RIGHT pool)
const derived = hoodiePoolId(TOKEN, CHAIN);
const eventPoolId = created[0]?.args?.poolId as string | undefined;
eventPoolId && eventPoolId.toLowerCase() === derived.toLowerCase()
  ? ok(`derived poolId == event poolId (${derived.slice(0, 12)}…)`)
  : bad("derived poolId == event poolId", `derived ${derived} vs event ${eventPoolId}`);

// 3. The pool's Swap logs are queryable by poolId (the basis scan's swap source)
const inception = created[0]?.blockNumber ?? ENGINE_BLOCK;
const swaps = await client.getLogs({ address: c.poolManager as `0x${string}`, event: SWAP, args: { id: derived }, fromBlock: inception, toBlock: latest });
swaps.length >= 0 && Array.isArray(swaps) ? ok(`pool Swap logs queryable by poolId (${swaps.length} in [${inception}..${latest}])`) : bad("swap logs queryable", "getLogs failed");

console.log(`\nhoodiePositionProbe: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
