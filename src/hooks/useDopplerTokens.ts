import { useEffect, useState } from "react";
import { createPublicClient, http, defineChain, parseAbiItem } from "viem";
import type { TokenInfo } from "../utils/constants";
import { ROBINHOOD_MAINNET, ROBINHOOD_TESTNET, DOPPLER_CONTRACTS_BY_CHAIN, ROBINHOOD_TESTNET_VAULT, hydeVaultAbi } from "../utils/constants";
import type { DopplerPool } from "../utils/dopplerConfig";

const ROBINHOOD_CHAIN_ID = 4663;

const AIRLOCK = DOPPLER_CONTRACTS_BY_CHAIN[ROBINHOOD_CHAIN_ID].airlock;

// Doppler Airlock events — every Hydeout launch emits Create; graduation emits Migrate.
const CREATE_EVENT  = parseAbiItem("event Create(address asset, address indexed numeraire, address initializer, address poolOrHook)");
const MIGRATE_EVENT = parseAbiItem("event Migrate(address indexed asset, address indexed pool)");

const ERC20_META_ABI = [
  { type: "function", name: "name",   stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

// Uniswap v4 PoolManager custodies every live curve's token inventory —
// curve progress is measured against it.
const POOL_MANAGER = "0x8366a39CC670B4001A1121B8F6A443A643e40951" as const;

const TRANSFER_EVENT = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

// ─── Mainnet own-stack sources (deployed 2026-07-21) ────────────────────────────────────────────
// The 4663 board now reads OUR factories' launch events ONLY — no Doppler Airlock (clint: "only our
// stack"). WETH factory emits `LaunchCreated`; the HOODIE launcher-launcher engine emits
// `HoodieLaunchCreated` (standard shape, human creator indexed). Deploy blocks bound every scan.
// WETH stack REDEPLOYED 2026-07-24 (numeraire-aware $5k preset, audited 08d99a7) — old broken
// factory 0x710fEa…509f + its $1.9T HYDE are delisted by pointing the board at the new factory.
const MAINNET_WETH_FACTORY = "0x159A2fa37427299466B0723713eaa260e6124cbc" as `0x${string}`;
const MAINNET_WETH_FACTORY_BLOCK = 17418907n;
const MAINNET_HOODIE_ENGINE = "0x8062951c99CfFA5365f979D5139Cf96b5c77CFCc" as `0x${string}`;
const MAINNET_HOODIE_ENGINE_BLOCK = 15652257n;
const MAINNET_WETH_VAULT = "0x02Ce83859BEa69d248973Aa4beE09D7e12Ed0227" as `0x${string}`;
const MAINNET_HOODIE_VAULT = "0x1ee72dCb5a18ddcC069e4E604Ba59ac5a0930DB4" as `0x${string}`;
const MAINNET_HOODIE = "0xC72c01AAB5f5678dc1d6f5C6d2B417d91D402Ba3" as `0x${string}`;
const HOODIE_LAUNCH_CREATED = parseAbiItem(
  "event HoodieLaunchCreated(address indexed launcher, address indexed creator, address indexed token, bytes32 poolId, uint256 tokenId)"
);

// Dedicated client: launches must load even before a wallet connects.
const robinhoodChain = defineChain({
  id: ROBINHOOD_CHAIN_ID,
  name: ROBINHOOD_MAINNET.name,
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [ROBINHOOD_MAINNET.rpcUrl] } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});
const client = createPublicClient({ chain: robinhoodChain, transport: http() });

// Bounded scan: with thousands of launches, block-0 / all-asset getLogs times
// out in the browser. Scan the NEWEST launches backwards in fixed block chunks,
// then enrich only that page — all queries bounded. `MAX_SHOWN` caps the board
// page (newest first); older launches load via pagination later (not silently
// dropped — the count reflects the page, and there's a documented cap here).
const RANGE = 100_000n;   // blocks per getLogs (public-RPC-safe)
const MAX_SHOWN = 60;     // newest launches enriched per board load

// chunked getLogs over bounded ranges; the call factory keeps viem's typed logs
async function getLogsChunked<E>(call: (from: bigint, to: bigint) => Promise<E[]>, fromBlock: bigint, toBlock: bigint): Promise<E[]> {
  const out: E[] = [];
  for (let s = fromBlock; s <= toBlock; s += RANGE) {
    const e = s + RANGE - 1n > toBlock ? toBlock : s + RANGE - 1n;
    out.push(...(await call(s, e)));
  }
  return out;
}

// Real market-cap / price / liquidity / 24h-volume from the DEXScreener pair — the
// same indexer the Token page already uses for the chart. Only graduated tokens that
// have a live Uniswap pool are indexed; curve-stage tokens simply aren't returned, so
// their MCAP stays null (honest — no fabricated number, the card shows curve % instead).
// Batched (up to 30 addrs/call) + fail-neutral: any error leaves everything null.
type DexData = { marketCapUsd: number | null; priceUsd: number | null; liquidityUsd: number | null; volumeUsd: number | null };
async function fetchDexData(addresses: string[]): Promise<Map<string, DexData>> {
  const out = new Map<string, DexData>();
  const CHUNK = 30; // DEXScreener /tokens accepts up to 30 comma-separated addresses
  for (let i = 0; i < addresses.length; i += CHUNK) {
    const batch = addresses.slice(i, i + CHUNK);
    try {
      const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${batch.join(",")}`);
      if (!r.ok) continue;
      const d = await r.json();
      type Pair = { chainId?: string; dexId?: string; baseToken?: { address?: string };
        marketCap?: number; fdv?: number; priceUsd?: string; liquidity?: { usd?: number }; volume?: { h24?: number } };
      for (const p of (d?.pairs ?? []) as Pair[]) {
        // only robinhood/uniswap pairs — never a wrong-chain price
        if (p.chainId !== "robinhood" || p.dexId !== "uniswap") continue;
        const key = (p.baseToken?.address ?? "").toLowerCase();
        if (!key) continue;
        const liq = p.liquidity?.usd ?? null;
        const prev = out.get(key);
        // keep the deepest-liquidity pair per token (the canonical/graduated one)
        if (prev && (prev.liquidityUsd ?? 0) >= (liq ?? 0)) continue;
        out.set(key, {
          marketCapUsd: p.marketCap ?? p.fdv ?? null,
          priceUsd: p.priceUsd != null ? Number(p.priceUsd) : null,
          liquidityUsd: liq,
          volumeUsd: p.volume?.h24 ?? null,
        });
      }
    } catch { /* fail neutral — leave this batch null */ }
  }
  return out;
}


/** Tokens launched via the Hydeout launchpad on Robinhood Chain, as TokenInfo[].
 *  No swap-routing metadata attached here; the Token page gates executable swaps
 *  on isGatewayLive() until router metadata (hook address per pool) is wired. */
export function useHydeTokens(chainId: number): {
  tokens: TokenInfo[];
  loading: boolean;
} {
  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // Clear stale mainnet tokens the moment we leave 4663 so a testnet view never carries mainnet
    // launches (kami A-blocker #3). This swap-routing list is mainnet-only by design.
    if (chainId !== ROBINHOOD_CHAIN_ID) { setTokens([]); setLoading(false); return; }

    let cancelled = false;
    setLoading(true);

    fetchMainnetOwnStackPools()
      .then((pools) => {
        if (cancelled) return;
        setTokens(
          pools.map((p): TokenInfo => ({
            address: p.baseToken.address as `0x${string}`,
            name: p.baseToken.name,
            symbol: p.baseToken.symbol,
            decimals: p.baseToken.decimals,
          }))
        );
      })
      .catch(() => {
        // RPC unavailable — leave tokens empty
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [chainId]);

  return { tokens, loading };
}

// Canonical launch-token implementation (EIP-1167/Solady clone target). ADAPTER
// CONSTANT: on the Hyde own-stack this becomes HydeTokenFactory's implementation.
export const LAUNCH_IMPL = "3be8b97fd0e713b5abe0649fa830223b6b4bc599";

/** SINGLE SOURCE OF TRUTH for EIP-1167 impl resolution (kami's direction): read
 *  the minimal-proxy implementation from ONCHAIN BYTECODE. getCode only — no
 *  scans, no Blockscout dependency. Returns undefined for EOAs / non-clones.
 *  Used by fetchLaunchToken, isHydeLaunch AND useVerifiedStatus — one regex. */
export async function getLaunchImplementation(address: `0x${string}`): Promise<`0x${string}` | undefined> {
  const code = await client.getCode({ address }).catch(() => undefined);
  const m = code?.match(/363d73([0-9a-fA-F]{40})5af4/);
  return m ? (`0x${m[1].toLowerCase()}` as `0x${string}`) : undefined;
}

/** Read ONE launch by address — ADAPTER BOUNDARY. All Doppler-specific reads live
 *  here; on own-stack this swaps to Hyde-contract reads. Returns null when the
 *  address is NOT a launch (honest not-found). No block-0 scans — just getCode +
 *  a metadata multicall; graduation is inferred from the DEXScreener pair client-side. */
export async function fetchLaunchToken(address: `0x${string}`): Promise<DopplerPool | null> {
  // confirm it's a launch: minimal-proxy clone of the known token implementation
  if ((await getLaunchImplementation(address)) !== `0x${LAUNCH_IMPL}`) return null;

  const meta = await client.multicall({
    contracts: [
      { address, abi: ERC20_META_ABI, functionName: "name" } as const,
      { address, abi: ERC20_META_ABI, functionName: "symbol" } as const,
    ],
  });
  const name = meta[0].result as string | undefined;
  const symbol = meta[1].result as string | undefined;
  if (!name || !symbol) return null;

  return {
    address, chainId: ROBINHOOD_CHAIN_ID,
    baseToken: { address, name, symbol, decimals: 18 },
    quoteToken: { address: ROBINHOOD_MAINNET.weth, name: "Wrapped Ether", symbol: "WETH", decimals: 18 },
    // type refined by the Token page from the DEXScreener pair (has pool = graduated)
    type: "v4", dollarLiquidity: null, volumeUsd: null, marketCapUsd: null, priceUsd: null,
    createdAt: new Date(0).toISOString(), // exact create time is unindexed; omitted honestly
    progress: null, // precise % only for board (newest-page) tokens; honest null here
  };
}

/** Cheap check: is this address a Hyde launch token (minimal-proxy clone of the
 *  canonical implementation)? getCode only — no scans. Used to filter holdings. */
export async function isHydeLaunch(address: `0x${string}`): Promise<boolean> {
  return (await getLaunchImplementation(address)) === `0x${LAUNCH_IMPL}`;
}

/** AUTHORITATIVE 4663 own-stack membership (kami 23886): the token was minted through OUR WETH factory
 *  (`LaunchCreated`) or the HOODIE engine (`HoodieLaunchCreated`) — event attribution, NOT a clone-bytecode
 *  guess. The old `isHydeLaunch` clone check both admitted the $HOODIE base asset and MISSED HOODIE-engine
 *  launches (e.g. LILHOODIE), showing wrong Profile holdings. This admits engine launches and explicitly
 *  excludes the $HOODIE / WETH base numeraires. Bounded from each contract's deploy block. */
export async function isMainnetOwnStackLaunch(address: `0x${string}`): Promise<boolean> {
  const a = address.toLowerCase();
  // Base numeraire assets are never a "launch you hold" — exclude fast, before any log query.
  if (a === MAINNET_HOODIE.toLowerCase() || a === ROBINHOOD_MAINNET.weth.toLowerCase()) return false;
  const [weth, hoodie] = await Promise.all([
    client.getLogs({ address: MAINNET_WETH_FACTORY, event: LAUNCH_CREATED, args: { token: address }, fromBlock: MAINNET_WETH_FACTORY_BLOCK, toBlock: "latest" }).catch(() => []),
    client.getLogs({ address: MAINNET_HOODIE_ENGINE, event: HOODIE_LAUNCH_CREATED, args: { token: address }, fromBlock: MAINNET_HOODIE_ENGINE_BLOCK, toBlock: "latest" }).catch(() => []),
  ]);
  return weth.length > 0 || hoodie.length > 0;
}

/** Single-token read for launches outside the board page. Network-aware: mainnet reads the two live
 *  own-stack launch sources; testnet reads its own factory. Fails to null (honest not-found). */
export function useHydeToken(address?: string, chainId: number = ROBINHOOD_CHAIN_ID): { pool: DopplerPool | null; loading: boolean } {
  const [pool, setPool] = useState<DopplerPool | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) { setPool(null); setLoading(false); return; }
    let cancelled = false;
    setPool(null); // drop the prior token immediately on address/chain change (kami A-blocker #3)
    setLoading(true);
    const fetcher = chainId === RH_TESTNET_ID ? fetchTestnetLaunchToken : fetchMainnetLaunchToken;
    fetcher(address as `0x${string}`)
      .then((p) => { if (!cancelled) setPool(p); })
      .catch(() => { if (!cancelled) setPool(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [address, chainId]);
  return { pool, loading };
}

/* ─── Testnet OWN-STACK (46630) — reads OUR HydeTokenFactory, not Doppler ───────────────
 * The launchpad is network-aware: on Robinhood Testnet the board enumerates launches from our
 * live-deployed factory's `LaunchCreated` events (our own contracts) instead of the Doppler Airlock.
 * DEXScreener/GeckoTerminal don't index 46630 testnet → MCAP/liquidity stay null (honest "not
 * indexed"); the real on-chain curve % still reads. Config-enforced boundary: only a network whose
 * `factory` is set reads own-stack data (mainnet's is unset → own-stack tiles stay "coming"). */
export const RH_TESTNET_ID = 46630;
const HYDE_TESTNET_FACTORY = ROBINHOOD_TESTNET.factory as `0x${string}`;
// Factory CREATION block on 46630 for the 0.0004-ETH factory (deploy tx 0x0e58fc6f…, block 91418522).
// Safe lower bound that bounds every LaunchCreated scan (never getLogs from block 0). Updated in
// lockstep with ROBINHOOD_TESTNET.factory + api/_ownstack.js at the ETH-fee redeploy.
const HYDE_TESTNET_FACTORY_DEPLOY_BLOCK = 91418522n;
const LAUNCH_CREATED = parseAbiItem(
  "event LaunchCreated(address indexed token, address indexed creator, bytes32 indexed poolId, uint256 tokenId, uint256 presetId)"
);
const rhTestnetChain = defineChain({
  id: RH_TESTNET_ID,
  name: "Robinhood Testnet",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [ROBINHOOD_TESTNET.rpcUrl] } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});
const testnetClient = createPublicClient({ chain: rhTestnetChain, transport: http() });

type LaunchLog = { args: { token: `0x${string}`; creator: `0x${string}` }; blockNumber: bigint | null };

/** Own-stack launches on 46630 — from `LaunchCreated` off our factory. Same enrichment shape as the
 *  Doppler board (name/symbol/curve %), minus third-party price data (testnet isn't indexed → null). */
async function fetchHydeFactoryPools(): Promise<DopplerPool[]> {
  const latest = await testnetClient.getBlockNumber();
  const collected: LaunchLog[] = [];
  let toB = latest;
  // The own-stack factory is recently deployed → all launches are in recent blocks. Bounded scan
  // (not the mainnet 80-chunk walk): stop once we've found launches and then hit an older empty chunk,
  // hard-capped at 20 chunks so a near-empty testnet resolves fast (no 80-chunk timeout).
  for (let guard = 0; guard < 20 && collected.length < MAX_SHOWN && toB > 0n; guard++) {
    const fromB = toB > RANGE ? toB - RANGE + 1n : 0n;
    const chunk = await testnetClient.getLogs({ address: HYDE_TESTNET_FACTORY, event: LAUNCH_CREATED, fromBlock: fromB, toBlock: toB });
    collected.unshift(...(chunk as unknown as LaunchLog[]));
    if (fromB === 0n) break;
    if (chunk.length === 0 && collected.length > 0) break; // passed the factory's active range
    toB = fromB - 1n;
  }
  const logs = collected.slice(-MAX_SHOWN).reverse();
  if (logs.length === 0) return [];
  const tokens = logs.map((l) => l.args.token);
  const createBlockOf = new Map(logs.map((l) => [l.args.token.toLowerCase(), l.blockNumber ?? 0n]));
  const fromB = logs.map((l) => l.blockNumber ?? latest).reduce((a, b) => (a < b ? a : b), latest);

  // curve baseline: tokens transferred INTO the PoolManager in each token's create block
  const seedTransfers = await getLogsChunked(
    (f, t) => testnetClient.getLogs({ address: tokens, event: TRANSFER_EVENT, args: { to: POOL_MANAGER }, fromBlock: f, toBlock: t }),
    fromB, latest
  );
  const initialCurve = new Map<string, bigint>();
  for (const t of seedTransfers) {
    const asset = t.address.toLowerCase();
    if ((t.blockNumber ?? 0n) !== createBlockOf.get(asset)) continue;
    initialCurve.set(asset, (initialCurve.get(asset) ?? 0n) + (t.args.value as bigint));
  }

  const meta = await testnetClient.multicall({
    contracts: tokens.flatMap((token) => [
      { address: token, abi: ERC20_META_ABI, functionName: "name" } as const,
      { address: token, abi: ERC20_META_ABI, functionName: "symbol" } as const,
      { address: token, abi: ERC20_META_ABI, functionName: "balanceOf", args: [POOL_MANAGER] } as const,
    ]),
  });
  // Creator-claimable WETH per token from the fresh vault — ONE batched multicall (no per-render RPC
  // waterfall), fail-neutral: any read failure leaves that token's claimable null, never fabricated.
  const claimRes = await testnetClient.multicall({
    contracts: tokens.map((token) => ({
      address: ROBINHOOD_TESTNET_VAULT, abi: hydeVaultAbi, functionName: "creatorClaimable", args: [token],
    } as const)),
  }).catch(() => null);
  const uniqueBlocks = [...new Set(logs.map((l) => l.blockNumber ?? 0n))];
  const blockTimes = new Map(
    (await Promise.all(uniqueBlocks.map((bn) => testnetClient.getBlock({ blockNumber: bn })))).map((b) => [b.number, Number(b.timestamp)])
  );

  const pools = logs.map((log, i): DopplerPool | null => {
    const token = log.args.token;
    const key = token.toLowerCase();
    const name = meta[i * 3].result as string | undefined;
    const symbol = meta[i * 3 + 1].result as string | undefined;
    const pmBalance = meta[i * 3 + 2].result as bigint | undefined;
    if (!name || !symbol) return null;
    const initial = initialCurve.get(key);
    let progress: number | null = null;
    if (initial && initial > 0n && pmBalance !== undefined) {
      const sold = initial > pmBalance ? initial - pmBalance : 0n;
      progress = Math.min(100, Number((sold * 10000n) / initial) / 100);
    }
    const ts = blockTimes.get(log.blockNumber ?? 0n);
    const claim = claimRes?.[i];
    return {
      address: token,
      chainId: RH_TESTNET_ID,
      baseToken: { address: token, name, symbol, decimals: 18 },
      quoteToken: { address: ROBINHOOD_TESTNET.weth, name: "Wrapped Ether", symbol: "WETH", decimals: 18 },
      type: "v4",
      dollarLiquidity: null,
      volumeUsd: null,
      marketCapUsd: null,
      priceUsd: null,
      createdAt: new Date((ts ?? 0) * 1000).toISOString(),
      progress,
      creator: log.args.creator as string,
      creatorClaimable: claim && claim.status === "success" ? (claim.result as bigint).toString() : null,
    };
  });
  const nonNull = pools.filter((p): p is DopplerPool => p !== null);
  const seen = new Set<string>();
  return nonNull.filter((p) => {
    const k = p.address.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Single own-stack (46630) launch read for /token/:address — reads name/symbol via the TESTNET
 *  client so a testnet token page never falls back to mainnet data (clint #4 cross-chain bleed).
 *  Testnet isn't third-party indexed → price/graduation stay null (honest). Fails to null. */
export async function fetchTestnetLaunchToken(address: `0x${string}`): Promise<DopplerPool | null> {
  // Authoritative attribution (kami A-blocker #1): must be a token minted by OUR factory — proven by an
  // indexed LaunchCreated(token=address) event — NOT merely any 46630 ERC-20 that exposes name()/symbol().
  // Bounded from the factory deploy block (never fromBlock 0).
  const created = await testnetClient.getLogs({
    address: HYDE_TESTNET_FACTORY,
    event: LAUNCH_CREATED,
    args: { token: address },
    fromBlock: HYDE_TESTNET_FACTORY_DEPLOY_BLOCK,
    toBlock: "latest",
  }).catch(() => null);
  if (!created || created.length === 0) return null; // not a Hyde own-stack launch → honest not-found

  const meta = await testnetClient.multicall({
    contracts: [
      { address, abi: ERC20_META_ABI, functionName: "name" } as const,
      { address, abi: ERC20_META_ABI, functionName: "symbol" } as const,
    ],
  }).catch(() => null);
  const name = meta?.[0]?.result as string | undefined;
  const symbol = meta?.[1]?.result as string | undefined;
  if (!name || !symbol) return null;
  return {
    address, chainId: RH_TESTNET_ID,
    baseToken: { address, name, symbol, decimals: 18 },
    quoteToken: { address: ROBINHOOD_TESTNET.weth, name: "Wrapped Ether", symbol: "WETH", decimals: 18 },
    type: "v4", dollarLiquidity: null, volumeUsd: null, marketCapUsd: null, priceUsd: null,
    createdAt: new Date(0).toISOString(), // exact create time unindexed on the single-read path
    progress: null,
  };
}

type OwnStackLog = { args: { token: `0x${string}`; creator?: `0x${string}` }; blockNumber: bigint | null };

/** Single-token read for /swap?out= on 4663 — authoritative attribution: the address must have a
 *  `LaunchCreated` (WETH factory) OR `HoodieLaunchCreated` (HOODIE engine) event, bounded from each
 *  deploy block. Mirrors the testnet reader so a mainnet token page resolves OUR launches (not the
 *  old Doppler clone-impl check). Fails to null (honest not-found); the page refines graduation/price. */
async function fetchMainnetLaunchToken(address: `0x${string}`): Promise<DopplerPool | null> {
  const [wethCreated, hoodieCreated] = await Promise.all([
    client.getLogs({ address: MAINNET_WETH_FACTORY, event: LAUNCH_CREATED, args: { token: address }, fromBlock: MAINNET_WETH_FACTORY_BLOCK, toBlock: "latest" }).catch(() => []),
    client.getLogs({ address: MAINNET_HOODIE_ENGINE, event: HOODIE_LAUNCH_CREATED, args: { token: address }, fromBlock: MAINNET_HOODIE_ENGINE_BLOCK, toBlock: "latest" }).catch(() => []),
  ]);
  if (wethCreated.length === 0 && hoodieCreated.length === 0) return null; // not one of our launches
  const isHoodiePair = hoodieCreated.length > 0;

  const meta = await client
    .multicall({
      contracts: [
        { address, abi: ERC20_META_ABI, functionName: "name" } as const,
        { address, abi: ERC20_META_ABI, functionName: "symbol" } as const,
      ],
    })
    .catch(() => null);
  const name = meta?.[0]?.result as string | undefined;
  const symbol = meta?.[1]?.result as string | undefined;
  if (!name || !symbol) return null;

  return {
    address,
    chainId: ROBINHOOD_CHAIN_ID,
    baseToken: { address, name, symbol, decimals: 18 },
    // HOODIE-paired launches quote in $HOODIE; WETH launches quote in WETH.
    quoteToken: isHoodiePair
      ? { address: MAINNET_HOODIE, name: "Hoodie", symbol: "HOODIE", decimals: 18 }
      : { address: ROBINHOOD_MAINNET.weth, name: "Wrapped Ether", symbol: "WETH", decimals: 18 },
    type: "v4",
    dollarLiquidity: null,
    volumeUsd: null,
    marketCapUsd: null,
    priceUsd: null,
    createdAt: new Date(0).toISOString(),
    progress: null,
  };
}

/** 4663 mainnet own-stack board — unions our WETH factory `LaunchCreated` + the HOODIE engine's
 *  `HoodieLaunchCreated`; NO Doppler Airlock (clint: "only our stack"). Bounded from each contract's
 *  deploy block. Same enrichment as the Doppler board (curve % + DEXScreener MCAP/price on graduated
 *  tokens), so only tokens minted through OUR factories ever surface. */
async function fetchMainnetOwnStackPools(): Promise<DopplerPool[]> {
  const latest = await client.getBlockNumber();
  const [wethLogs, hoodieLogs] = await Promise.all([
    getLogsChunked((f, t) => client.getLogs({ address: MAINNET_WETH_FACTORY, event: LAUNCH_CREATED, fromBlock: f, toBlock: t }), MAINNET_WETH_FACTORY_BLOCK, latest),
    getLogsChunked((f, t) => client.getLogs({ address: MAINNET_HOODIE_ENGINE, event: HOODIE_LAUNCH_CREATED, fromBlock: f, toBlock: t }), MAINNET_HOODIE_ENGINE_BLOCK, latest),
  ]);
  const rows = [
    ...(wethLogs as unknown as OwnStackLog[]).map((l) => ({ ...l, isHoodiePair: false })),
    ...(hoodieLogs as unknown as OwnStackLog[]).map((l) => ({ ...l, isHoodiePair: true })),
  ]
    .map((l) => ({ token: l.args.token, creator: l.args.creator, block: l.blockNumber ?? 0n, isHoodiePair: l.isHoodiePair }))
    .sort((a, b) => (a.block < b.block ? 1 : a.block > b.block ? -1 : 0)) // newest first
    .slice(0, MAX_SHOWN);
  if (rows.length === 0) return [];

  const tokens = rows.map((r) => r.token);
  const createBlockOf = new Map(rows.map((r) => [r.token.toLowerCase(), r.block]));
  const fromB = rows.map((r) => r.block).reduce((a, b) => (a < b ? a : b), latest);

  const seedTransfers = await getLogsChunked((f, t) => client.getLogs({ address: tokens, event: TRANSFER_EVENT, args: { to: POOL_MANAGER }, fromBlock: f, toBlock: t }), fromB, latest);
  const initialCurve = new Map<string, bigint>();
  for (const t of seedTransfers) {
    const a = t.address.toLowerCase();
    if ((t.blockNumber ?? 0n) !== createBlockOf.get(a)) continue;
    initialCurve.set(a, (initialCurve.get(a) ?? 0n) + (t.args.value as bigint));
  }

  const meta = await client.multicall({
    contracts: tokens.flatMap((token) => [
      { address: token, abi: ERC20_META_ABI, functionName: "name" } as const,
      { address: token, abi: ERC20_META_ABI, functionName: "symbol" } as const,
      { address: token, abi: ERC20_META_ABI, functionName: "balanceOf", args: [POOL_MANAGER] } as const,
    ]),
  });
  const claimRes = await client.multicall({
    contracts: rows.map((r) => ({
      address: r.isHoodiePair ? MAINNET_HOODIE_VAULT : MAINNET_WETH_VAULT,
      abi: hydeVaultAbi,
      functionName: "creatorClaimable",
      args: [r.token],
    } as const)),
  }).catch(() => null);
  const uniqueBlocks = [...new Set(rows.map((r) => r.block))];
  const blockTimes = new Map((await Promise.all(uniqueBlocks.map((bn) => client.getBlock({ blockNumber: bn })))).map((b) => [b.number, Number(b.timestamp)]));

  const pools = rows.map((r, i): DopplerPool | null => {
    const key = r.token.toLowerCase();
    const name = meta[i * 3].result as string | undefined;
    const symbol = meta[i * 3 + 1].result as string | undefined;
    const pmBalance = meta[i * 3 + 2].result as bigint | undefined;
    if (!name || !symbol) return null;
    const initial = initialCurve.get(key);
    let progress: number | null = null;
    if (initial && initial > 0n && pmBalance !== undefined) {
      const sold = initial > pmBalance ? initial - pmBalance : 0n;
      progress = Math.min(100, Number((sold * 10000n) / initial) / 100);
    }
    const ts = blockTimes.get(r.block);
    const claim = claimRes?.[i];
    return {
      address: r.token, chainId: ROBINHOOD_CHAIN_ID,
      baseToken: { address: r.token, name, symbol, decimals: 18 },
      quoteToken: r.isHoodiePair
        ? { address: MAINNET_HOODIE, name: "Hoodie", symbol: "HOODIE", decimals: 18 }
        : { address: ROBINHOOD_MAINNET.weth, name: "Wrapped Ether", symbol: "WETH", decimals: 18 },
      type: "v4", dollarLiquidity: null, volumeUsd: null, marketCapUsd: null, priceUsd: null,
      createdAt: new Date((ts ?? 0) * 1000).toISOString(), progress,
      creator: r.creator as string | undefined,
      creatorClaimable: claim && claim.status === "success" ? (claim.result as bigint).toString() : null,
    };
  });
  const nonNull = pools.filter((p): p is DopplerPool => p !== null);
  const seen = new Set<string>();
  const deduped = nonNull.filter((p) => { const k = p.address.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  const dex = await fetchDexData(deduped.map((p) => p.address));
  return deduped.map((p) => {
    const d = dex.get(p.address.toLowerCase());
    if (!d) return p;
    return { ...p, marketCapUsd: d.marketCapUsd, priceUsd: d.priceUsd, dollarLiquidity: d.liquidityUsd != null ? String(d.liquidityUsd) : p.dollarLiquidity, volumeUsd: d.volumeUsd != null ? String(d.volumeUsd) : p.volumeUsd };
  });
}

/** Full pool objects for the Launchpad explore tab and trending carousel. Network-aware: Robinhood
 *  Testnet + mainnet both read our own-stack factories (mainnet = WETH factory + HOODIE engine). */
export function useHydeLaunches(chainId: number = ROBINHOOD_CHAIN_ID): {
  pools: DopplerPool[];
  loading: boolean;
  refetch: () => void;
} {
  const [pools, setPools] = useState<DopplerPool[]>([]);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const refetch = () => setTick((t) => t + 1);

  useEffect(() => {
    let cancelled = false;
    setPools([]); // drop prior-chain launches immediately on a chain switch (kami A-blocker #3)
    setLoading(true);

    const fetcher = chainId === RH_TESTNET_ID ? fetchHydeFactoryPools : fetchMainnetOwnStackPools;
    fetcher()
      .then((items) => {
        if (!cancelled) setPools(items);
      })
      .catch(() => {
        if (!cancelled) setPools([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [tick, chainId]);

  return { pools, loading, refetch };
}

/* ─── Platform stats (transparency page) ──────────────────────────────────────
 * Total UNIQUE tokens launched (dedup by asset — the Airlock emits several Create
 * logs per launch) + graduated count. Blockscout has no one-call filtered event
 * count, so this is a REAL on-chain scan; it's cached (localStorage, 10-min TTL)
 * and run in the background behind an honest "indexing" state — never a placeholder.
 * The clean long-term source is a stats indexer/cron; this is the honest client fallback. */
const STATS_CACHE_KEY = "hyde_stats_v1";
const STATS_TTL_MS = 10 * 60 * 1000;
type HydeStatsCache = { totalLaunched: number; graduated: number; at: number };

function readStatsCache(): HydeStatsCache | null {
  try {
    const raw = localStorage.getItem(STATS_CACHE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as HydeStatsCache;
    return typeof v?.totalLaunched === "number" && typeof v?.at === "number" ? v : null;
  } catch {
    return null;
  }
}

async function scanHydeStats(): Promise<{ totalLaunched: number; graduated: number }> {
  const latest = await client.getBlockNumber();
  const uniq = new Set<string>(); // unique launch tokens (dedup by asset address)
  let graduated = 0;
  for (let to = latest; to > 0n; to -= RANGE) {
    const from = to > RANGE ? to - RANGE + 1n : 0n;
    const [cLogs, mLogs] = await Promise.all([
      client.getLogs({ address: AIRLOCK, event: CREATE_EVENT, fromBlock: from, toBlock: to }),
      client.getLogs({ address: AIRLOCK, event: MIGRATE_EVENT, fromBlock: from, toBlock: to }),
    ]);
    for (const l of cLogs) {
      const a = (l.args as { asset?: string }).asset;
      if (a) uniq.add(a.toLowerCase());
    }
    graduated += mLogs.length;
    if (from === 0n) break;
  }
  return { totalLaunched: uniq.size, graduated };
}

/** Real platform-wide launch totals for the Stats page. Serves a cached value instantly and
 *  refreshes in the background; `loading` stays true (→ honest "indexing" state) until the first
 *  real scan resolves. Fail-neutral: an RPC error leaves the numbers null, never fabricated. */
export function useHydeStats(): {
  totalLaunched: number | null;
  graduated: number | null;
  updatedAt: number | null;
  loading: boolean;
} {
  const [s, setS] = useState(() => {
    const c = readStatsCache();
    return c
      ? { totalLaunched: c.totalLaunched, graduated: c.graduated, updatedAt: c.at, loading: Date.now() - c.at >= STATS_TTL_MS }
      : { totalLaunched: null as number | null, graduated: null as number | null, updatedAt: null as number | null, loading: true };
  });

  useEffect(() => {
    const c = readStatsCache();
    if (c && Date.now() - c.at < STATS_TTL_MS) return; // fresh cache — no rescan
    let cancelled = false;
    setS((p) => ({ ...p, loading: true }));
    scanHydeStats()
      .then((r) => {
        if (cancelled) return;
        const at = Date.now();
        try {
          localStorage.setItem(STATS_CACHE_KEY, JSON.stringify({ ...r, at }));
        } catch {
          /* ignore storage quota */
        }
        setS({ totalLaunched: r.totalLaunched, graduated: r.graduated, updatedAt: at, loading: false });
      })
      .catch(() => {
        if (!cancelled) setS((p) => ({ ...p, loading: false })); // honest: stays null → "indexing"
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return s;
}
