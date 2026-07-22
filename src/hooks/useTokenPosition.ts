import { useEffect, useState } from "react";
import { useAccount, usePublicClient } from "wagmi";
import { parseAbiItem, formatUnits, encodeEventTopics, type Address } from "viem";
import type { TokenPosition } from "../components/YourPositionCard";
import { computePosition, buildMoves, type TokenPosition as CorePosition, type RawTransfer, type RawSwap } from "../utils/positionPnl";
import { quoteOwnStackExactIn, computePoolId, DYNAMIC_FEE_FLAG, OWN_STACK_TICK_SPACING } from "../utils/hydeQuote";
import { simulateHoodieSwap, hoodiePoolId } from "../utils/hoodieSwap";
import {
  ROBINHOOD_TESTNET, ROBINHOOD_TESTNET_STATE_VIEW, V4_CONTRACTS_BY_CHAIN, erc20Abi, hydeTokenFactoryAbi,
} from "../utils/constants";

/* Drift guard: the reducer's shape MUST stay identical to the card's frozen contract, or this
 * won't compile (kami's covered-only v4 semantics live in BOTH — never let them diverge silently). */
type _Same = CorePosition extends TokenPosition ? (TokenPosition extends CorePosition ? true : never) : never;
const _driftGuard: _Same = true;
void _driftGuard;

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const SWAP = parseAbiItem(
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
);
// PoolManager Swap topic0 — derived from the event (no hardcode drift). Used to receipt-parse EVERY
// PoolManager swap in a candidate tx (any pool), so covered vs other-pool/ambiguous is provable.
const SWAP_TOPIC0 = encodeEventTopics({ abi: [SWAP], eventName: "Swap" })[0] as string;
const LAUNCH_CREATED = parseAbiItem(
  "event LaunchCreated(address indexed token, address indexed creator, bytes32 indexed poolId, uint256 tokenId, uint256 presetId)",
);
// Mainnet 4663 HOODIE own-stack: launches emit HoodieLaunchCreated off the engine (numeraire = $HOODIE, not
// WETH). Attribution + inception block both come from this event, mirroring useDopplerTokens' mainnet reader.
const ROBINHOOD_MAINNET_ID = 4663;
const HOODIE_LAUNCH_CREATED = parseAbiItem(
  "event HoodieLaunchCreated(address indexed launcher, address indexed creator, address indexed token, bytes32 poolId, uint256 tokenId)",
);
const MAINNET_HOODIE_ENGINE_BLOCK = 15652257n; // HOODIE engine deploy block (bounds every scan; never fromBlock 0)
const RANGE = 100_000n; // public-RPC-safe getLogs window (mirrors useDopplerTokens)

/** Chains with a Hyde own-stack where per-wallet basis is derivable from LaunchCreated + the pool's Swap.
 *  Only 46630 today (mainnet 4663 still rides the Doppler rail — no own-stack pool to reconcile against). */
type OwnStack = { factory: Address; stateView: Address; weth: Address; deployBlock: bigint };
const OWN_STACK: Record<number, OwnStack> = {
  [ROBINHOOD_TESTNET.id]: {
    factory: ROBINHOOD_TESTNET.factory,
    stateView: ROBINHOOD_TESTNET_STATE_VIEW,
    weth: ROBINHOOD_TESTNET.weth as Address,
    deployBlock: 91418522n, // ROBINHOOD_TESTNET factory creation block
  },
};

const lc = (a: string): string => a.toLowerCase();

async function chunked<T>(fn: (from: bigint, to: bigint) => Promise<T[]>, from: bigint, to: bigint): Promise<T[]> {
  const out: T[] = [];
  for (let s = from; s <= to; s += RANGE) {
    const e = s + RANGE - 1n > to ? to : s + RANGE - 1n;
    out.push(...(await fn(s, e)));
  }
  return out;
}

// viem Transfer log → the reducer's minimal RawTransfer (buildMoves signs each delta by from/to==wallet).
type Xfer = { transactionHash: string | null; blockNumber: bigint | null; logIndex: number | null; args: { from?: string; to?: string; value?: bigint } };
const toRaw = (logs: unknown[]): RawTransfer[] =>
  (logs as Xfer[])
    .filter((l) => l.transactionHash && l.blockNumber != null)
    .map((l) => ({
      txHash: l.transactionHash as string,
      blockNumber: l.blockNumber as bigint,
      logIndex: BigInt(l.logIndex ?? 0),
      from: l.args.from ?? "",
      to: l.args.to ?? "",
      value: l.args.value ?? 0n,
    }));

/** Off-own-stack (or unresolvable) token: honest balance-only, no fabricated basis/mark. */
function balanceOnly(balance: bigint, decimals: number, through: bigint, quoteSymbol = "WETH"): TokenPosition {
  return {
    balance,
    tokenDecimals: decimals,
    quoteDecimals: 18,
    quoteSymbol,
    markPrice: null,
    markStatus: "unavailable",
    asOfBlock: null,
    currentValue: null,
    basisStatus: "unknown",
    coveredUnits: 0n,
    uncoveredUnits: balance,
    coveredCostBasis: null,
    coveredAvgBasisPerToken: null,
    unrealizedPnl: null,
    realizedPnl: null,
    scannedFromBlock: through,
    scannedThroughBlock: through,
    historyComplete: false,
    loading: false,
  };
}

/** Mainnet 4663 HOODIE own-stack position — covered-only basis reconciled against the $HOODIE numeraire,
 *  mark-to-market via the same eth_simulateV1 SELL sim the swap card uses (net-of-slippage, correct even
 *  when in-range liquidity = 0 — the single-sided-seed case a spot read can't price). gojo 23876. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function buildHoodiePosition(publicClient: any, chainId: number, token: Address, wallet: Address, balance: bigint, decimals: number, latest: bigint): Promise<TokenPosition> {
  const c = V4_CONTRACTS_BY_CHAIN[chainId];
  const numeraire = c.hoodieNumeraire as Address;
  const engine = c.hoodieEngine as Address;
  const poolManager = c.poolManager as Address;
  const whole = 10n ** BigInt(decimals);

  // Authoritative attribution + inception: the token must have a HoodieLaunchCreated on the engine.
  const created = await chunked<{ blockNumber: bigint | null }>(
    (f, t) => publicClient.getLogs({ address: engine, event: HOODIE_LAUNCH_CREATED, args: { token }, fromBlock: f, toBlock: t }),
    MAINNET_HOODIE_ENGINE_BLOCK, latest,
  );
  if (created.length === 0) return balanceOnly(balance, decimals, latest, "HOODIE"); // not a HOODIE launch → no basis to prove
  const inception = created[0].blockNumber ?? MAINNET_HOODIE_ENGINE_BLOCK;
  const poolId = hoodiePoolId(token, chainId); // sorted (token,HOODIE)/dynamic-fee/tick60/HydeHook — self-checked live

  // Wallet-scoped token + HOODIE transfers over [inception, latest]. Truncation guard (gojo/kami): ANY
  // getLogs failure marks history INCOMPLETE (→ realizedPnl null, "history incomplete" state) — never
  // silently under-count basis, which would inflate PnL.
  let complete = true;
  const safeChunked = async (fn: (f: bigint, t: bigint) => Promise<unknown[]>): Promise<unknown[]> => {
    try { return await chunked(fn, inception, latest); } catch { complete = false; return []; }
  };
  const [tokIn, tokOut, humIn, humOut] = await Promise.all([
    safeChunked((f, t) => publicClient.getLogs({ address: token, event: TRANSFER, args: { to: wallet }, fromBlock: f, toBlock: t })),
    safeChunked((f, t) => publicClient.getLogs({ address: token, event: TRANSFER, args: { from: wallet }, fromBlock: f, toBlock: t })),
    safeChunked((f, t) => publicClient.getLogs({ address: numeraire, event: TRANSFER, args: { to: wallet }, fromBlock: f, toBlock: t })),
    safeChunked((f, t) => publicClient.getLogs({ address: numeraire, event: TRANSFER, args: { from: wallet }, fromBlock: f, toBlock: t })),
  ]);

  // Candidate txs = every tx that moved the user's TOKEN balance. RECEIPT-parse each for ALL PoolManager
  // Swap logs (any pool, not just this one), so covered vs other-pool/multihop-ambiguous is PROVABLE via
  // the reducer's poolSwapCount/hasOtherSwap (gojo 23882 / kami 23884) — not assumed. Bounded; over cap ⇒
  // history incomplete rather than a partial-scan under-count.
  const RECEIPT_CAP = 300;
  const candidateTxs = [...new Set(
    ([...tokIn, ...tokOut] as { transactionHash: string | null }[]).map((l) => l.transactionHash).filter(Boolean) as string[],
  )];
  if (candidateTxs.length > RECEIPT_CAP) complete = false;
  const receipts = await Promise.all(
    candidateTxs.slice(0, RECEIPT_CAP).map((hash) =>
      publicClient.getTransactionReceipt({ hash }).catch(() => { complete = false; return null; })),
  );
  const rawSwaps: RawSwap[] = [];
  for (const r of receipts as ({ transactionHash: string; logs: { address: string; topics: string[] }[] } | null)[]) {
    if (!r) continue;
    for (const log of r.logs) {
      if (lc(log.address) === lc(poolManager) && log.topics?.[0] === SWAP_TOPIC0 && log.topics?.[1]) {
        rawSwaps.push({ txHash: r.transactionHash, poolId: log.topics[1] }); // poolId = the Swap's indexed id
      }
    }
  }
  const moves = buildMoves([...toRaw(tokIn), ...toRaw(tokOut)], [...toRaw(humIn), ...toRaw(humOut)], rawSwaps, wallet, poolId as string);

  // Mark = net HOODIE from SELLING the full held balance (gojo's honesty gate: never balance×spot). One
  // sim → the effective per-token EXIT price; markStatus "exit" ("exit sim" badge), never "spot" — a large
  // position can't exit at a phantom spot value. Covered value is thus conservative (a smaller lot exits
  // slightly better). A failed sim → mark unavailable → card shows "Live exit value unavailable".
  let markPrice: bigint | null = null;
  let markStatus: TokenPosition["markStatus"] = "unavailable";
  if (balance > 0n) {
    const sim = await simulateHoodieSwap({
      client: publicClient, user: wallet, token, decimals, isBuy: false,
      amountIn: formatUnits(balance, decimals), amountOutQuoted: "0", slippagePercent: "0", chainId,
    }).catch(() => null);
    if (sim && sim.ok && sim.out > 0n) { markPrice = (sim.out * whole) / balance; markStatus = "exit"; }
  }

  return computePosition({
    balance, tokenDecimals: decimals, quoteDecimals: 18, quoteSymbol: "HOODIE",
    markPrice, markStatus, asOfBlock: latest, moves,
    scannedFromBlock: inception, scannedThroughBlock: latest,
    // Both true ONLY when the full scan succeeded — a truncated/capped scan flips these false so the reducer
    // reports historyComplete=false (realizedPnl null, basis "partial", "history incomplete" copy).
    reachedInception: complete,
    reachedThroughBlock: complete,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function buildPosition(publicClient: any, chainId: number, token: Address, wallet: Address): Promise<TokenPosition> {
  const decimals = Number(
    await publicClient.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
  );
  const balance = (await publicClient.readContract({
    address: token, abi: erc20Abi, functionName: "balanceOf", args: [wallet],
  })) as bigint;

  const latest = await publicClient.getBlockNumber();

  // Mainnet 4663 HOODIE own-stack → dedicated HOODIE-numeraire path (sim-based mark, works at tick-liq 0).
  // The testnet (46630) WETH own-stack path continues below.
  const mainnet = V4_CONTRACTS_BY_CHAIN[chainId];
  if (chainId === ROBINHOOD_MAINNET_ID && mainnet?.hoodieNumeraire && mainnet?.hoodieHook && mainnet?.hoodieEngine) {
    return buildHoodiePosition(publicClient, chainId, token, wallet, balance, decimals, latest);
  }

  const os = OWN_STACK[chainId];
  if (!os || lc(token) === lc(os.weth)) return balanceOnly(balance, decimals, latest);

  // Token inception = its LaunchCreated on the own-stack factory (also proves it's a Hyde launch).
  const created = await chunked<{ blockNumber: bigint | null }>(
    (f, t) => publicClient.getLogs({ address: os.factory, event: LAUNCH_CREATED, args: { token }, fromBlock: f, toBlock: t }),
    os.deployBlock, latest,
  );
  if (created.length === 0) return balanceOnly(balance, decimals, latest); // not an own-stack launch → no basis to prove
  const inception = created[0].blockNumber ?? os.deployBlock;

  // The pool: own-stack shares ONE hook; pair is (token, WETH), dynamic fee, tickSpacing 60.
  const hook = (await publicClient.readContract({
    address: os.factory, abi: hydeTokenFactoryAbi, functionName: "HOOK",
  })) as Address;
  const ltIsC0 = lc(token) < lc(os.weth);
  const c0 = (ltIsC0 ? token : os.weth) as Address;
  const c1 = (ltIsC0 ? os.weth : token) as Address;
  const poolId = computePoolId(c0, c1, DYNAMIC_FEE_FLAG, OWN_STACK_TICK_SPACING, hook);
  const poolManager = V4_CONTRACTS_BY_CHAIN[chainId]?.poolManager as Address;

  // Wallet-scoped token + WETH transfers, and this pool's swaps, over [inception, latest].
  const [tokIn, tokOut, wethIn, wethOut, swaps] = await Promise.all([
    chunked((f, t) => publicClient.getLogs({ address: token, event: TRANSFER, args: { to: wallet }, fromBlock: f, toBlock: t }), inception, latest),
    chunked((f, t) => publicClient.getLogs({ address: token, event: TRANSFER, args: { from: wallet }, fromBlock: f, toBlock: t }), inception, latest),
    chunked((f, t) => publicClient.getLogs({ address: os.weth, event: TRANSFER, args: { to: wallet }, fromBlock: f, toBlock: t }), inception, latest),
    chunked((f, t) => publicClient.getLogs({ address: os.weth, event: TRANSFER, args: { from: wallet }, fromBlock: f, toBlock: t }), inception, latest),
    poolManager
      ? chunked((f, t) => publicClient.getLogs({ address: poolManager, event: SWAP, args: { id: poolId }, fromBlock: f, toBlock: t }), inception, latest)
      : Promise.resolve([] as unknown[]),
  ]);

  // Map viem logs → the pure grouping's minimal shapes (module-scope `toRaw`); buildMoves signs each delta
  // by from/to==wallet and joins this pool's Swap count per tx. (A wallet-scoped transfer matches only one of
  // the {to}/{from} filters unless it's a self-transfer, which nets to zero either way — no double count.)
  // NOTE: this path fetches ONLY the selected pool's swaps, so every rawSwap.poolId == selected ⇒ hasOtherSwap
  // is always false here. Detecting other-pool/multihop hops needs the all-PoolManager-swap (receipt-based)
  // fetch that lands with the generic 4663 Doppler resolver (gojo). The reducer already ENFORCES hasOtherSwap;
  // the hook feeds it truthfully once that rework lands.
  const rawSwaps: RawSwap[] = (swaps as { transactionHash: string | null }[])
    .filter((s) => s.transactionHash)
    .map((s) => ({ txHash: s.transactionHash as string, poolId: poolId as string }));
  const moves = buildMoves([...toRaw(tokIn), ...toRaw(tokOut)], [...toRaw(wethIn), ...toRaw(wethOut)], rawSwaps, wallet, poolId as string);

  // Mark: a small marginal own-stack quote (token → WETH). Estimate — the hook fee is dynamic,
  // so this is provenance-tagged 'estimated', never a silent spot read (kami #5).
  let markPrice: bigint | null = null;
  let markStatus: TokenPosition["markStatus"] = "unavailable";
  const whole = 10n ** BigInt(decimals);
  const probe = balance > 0n && balance < whole ? balance : whole; // ≤ 1 token → marginal, won't exhaust the range
  const quote = await quoteOwnStackExactIn(publicClient, os.stateView, {
    tokenIn: token, tokenOut: os.weth as Address, weth: os.weth as Address, hook, amountIn: probe, feePips: 10_000,
  });
  if (quote && quote.amountOut > 0n) { markPrice = (quote.amountOut * whole) / probe; markStatus = "estimated"; }

  return computePosition({
    balance,
    tokenDecimals: decimals,
    quoteDecimals: 18,
    quoteSymbol: "WETH",
    markPrice,
    markStatus,
    asOfBlock: latest,
    moves,
    scannedFromBlock: inception,
    scannedThroughBlock: latest,
    reachedInception: true, // we scan from the token's own LaunchCreated block
    // Scan runs through `latest`; the rigorous single-block pin (kami #4) lands with the receipt-based rework.
    reachedThroughBlock: true,
  });
}

/**
 * useTokenPosition — per-wallet, covered-only PnL for the viewed token (kami's frozen v4 semantics).
 * Reads against the TOKEN PAGE'S network (`networkId`, e.g. 4663), not the wallet's connected chain, so a
 * position renders even if the wallet is momentarily on another chain. Returns `null` while loading or
 * disconnected (the card renders the skeleton / connect prompt); a fully honest `TokenPosition` otherwise.
 * The mark is computed on-chain with provenance (kami #5) — for HOODIE launches it's the net-of-slippage
 * sell sim.
 */
export function useTokenPosition(address: string, networkId: number, enabled = true): TokenPosition | null {
  const { address: wallet, isConnected } = useAccount();
  const publicClient = usePublicClient({ chainId: networkId });
  const [pos, setPos] = useState<TokenPosition | null>(null);

  useEffect(() => {
    // `enabled` lets a caller skip the log scan for tokens that have no reconcilable own-stack pool
    // (e.g. non-HOODIE pairs) — a hook is always called, but does no I/O when off.
    if (!enabled || !isConnected || !wallet || !publicClient || !address) {
      setPos(null);
      return;
    }
    let cancelled = false;
    setPos(null); // loading
    buildPosition(publicClient, networkId, address as Address, wallet as Address)
      .then((p) => { if (!cancelled) setPos(p); })
      .catch(() => { if (!cancelled) setPos(null); }); // fail-neutral: card falls back to skeleton, never a wrong number
    return () => { cancelled = true; };
  }, [address, wallet, isConnected, networkId, publicClient, enabled]);

  return pos;
}
