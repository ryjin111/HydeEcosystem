// Headless smoke: the Launches-board pipeline vs LIVE 4663 — mirrors
// src/hooks/useDopplerTokens.ts fetchHydePools exactly. Read-only.
import { createPublicClient, http, defineChain, parseAbiItem } from "viem";

const AIRLOCK = "0xeb7C034704eF8Dcd2D32324c1545f62fB4aD0862";
const POOL_MANAGER = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
const CREATE_EVENT  = parseAbiItem("event Create(address asset, address indexed numeraire, address initializer, address poolOrHook)");
const MIGRATE_EVENT = parseAbiItem("event Migrate(address indexed asset, address indexed pool)");
const TRANSFER_EVENT = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const ERC20_META_ABI = [
  { type: "function", name: "name",   stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
];

const chain = defineChain({
  id: 4663, name: "Robinhood Chain",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});
const client = createPublicClient({ chain, transport: http() });

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`); };

const [createLogs, migrateLogs] = await Promise.all([
  client.getLogs({ address: AIRLOCK, event: CREATE_EVENT, fromBlock: 0n, toBlock: "latest" }),
  client.getLogs({ address: AIRLOCK, event: MIGRATE_EVENT, fromBlock: 0n, toBlock: "latest" }),
]);
check("Create events found", createLogs.length > 0, `${createLogs.length} launches`);

const graduated = new Set(migrateLogs.map((l) => l.args.asset.toLowerCase()));
const logs = [...createLogs].reverse();
const assets = logs.map((l) => l.args.asset);
const createBlockOf = new Map(logs.map((l) => [l.args.asset.toLowerCase(), l.blockNumber]));

const seedTransfers = await client.getLogs({ address: assets, event: TRANSFER_EVENT, args: { to: POOL_MANAGER }, fromBlock: 0n, toBlock: "latest" });
const initialCurve = new Map();
for (const t of seedTransfers) {
  const a = t.address.toLowerCase();
  if (t.blockNumber !== createBlockOf.get(a)) continue;
  initialCurve.set(a, (initialCurve.get(a) ?? 0n) + t.args.value);
}
check("curve baselines derived", initialCurve.size > 0, `${initialCurve.size}/${assets.length} assets have a create-block seed`);

const meta = await client.multicall({
  contracts: assets.flatMap((asset) => [
    { address: asset, abi: ERC20_META_ABI, functionName: "name" },
    { address: asset, abi: ERC20_META_ABI, functionName: "symbol" },
    { address: asset, abi: ERC20_META_ABI, functionName: "balanceOf", args: [POOL_MANAGER] },
  ]),
});
check("multicall metadata", meta.length === assets.length * 3);

let withProgress = 0, sample = [];
for (let i = 0; i < assets.length; i++) {
  const key = assets[i].toLowerCase();
  const symbol = meta[i * 3 + 1].result;
  const pmBal = meta[i * 3 + 2].result;
  const initial = initialCurve.get(key);
  let progress = null;
  if (graduated.has(key)) progress = 100;
  else if (initial && initial > 0n && pmBal !== undefined) {
    const sold = initial > pmBal ? initial - pmBal : 0n;
    progress = Math.min(100, Number((sold * 10000n) / initial) / 100);
  }
  if (progress !== null) { withProgress++; if (sample.length < 5) sample.push(`${symbol}:${progress}%`); }
  if (progress !== null && (progress < 0 || progress > 100)) check(`progress bounds ${symbol}`, false, String(progress));
}
check("progress computed for majority", withProgress >= Math.floor(assets.length * 0.8), `${withProgress}/${assets.length} — sample: ${sample.join(" ")}`);

const uniqueBlocks = [...new Set(logs.map((l) => l.blockNumber))];
const blocks = await Promise.all(uniqueBlocks.slice(0, 5).map((bn) => client.getBlock({ blockNumber: bn })));
check("block timestamps resolve", blocks.every((b) => b.timestamp > 0n));

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exitCode = fail ? 1 : 0; // natural exit — process.exit() trips a libuv assert on Windows
