import type { Address, Hex, PublicClient } from "viem";
import { keccak256, encodeAbiParameters, parseAbiParameters } from "viem";

/* ── Off-chain V4 exact-in quote for own-stack (Hyde) pools ────────────────────
 * There is NO V4Quoter on Robinhood Testnet (46630), and the own-stack pool can't
 * be quoted from spot state: the single-sided seed is one constant-liquidity
 * position sitting ENTIRELY to one side of the launch tick, so getLiquidity() reads
 * 0 in-range at launch and a spot-price read returns nothing (gojo's gotcha). This
 * walks the swap across that one position with V4 SqrtPriceMath.
 *
 * IMPORTANT (casper's honesty gate): the number this returns is an ESTIMATE. The
 * hook applies a DYNAMIC fee per-swap (3%→1% anti-snipe decay, not slot0.lpFee), so
 * fold the caller's best-known fee in and ALWAYS enforce amountOutMinimum from user
 * slippage downstream — the estimate can be wrong, the min-received can't.
 *
 * Every own-stack pool uses ONE fixed preset (tickSpacing 60): LT=currency0 → range
 * [0, 60000] above the launch tick; LT=currency1 → range [-60000, 0] below it. So the
 * fillable region is a single constant-L range and the walk is a single computeSwapStep
 * (plus the free jump across the empty gap between the launch tick and the range edge).
 */

const Q96 = 1n << 96n;
export const DYNAMIC_FEE_FLAG = 0x800000;
export const OWN_STACK_TICK_SPACING = 60;

// Preset tick geometry (matches HydeTokenFactory constructor presets on 46630).
const PRESET = {
  // LT = currency0 (token < WETH): seed range ABOVE the launch tick
  c0: { tickLower: 0, tickUpper: 60000 },
  // LT = currency1 (token > WETH): seed range BELOW the launch tick
  c1: { tickLower: -60000, tickUpper: 0 },
};

/* ── V4 math (BigInt, matching @uniswap/v4-core TickMath / SqrtPriceMath) ─────── */

function mulDiv(a: bigint, b: bigint, denominator: bigint): bigint {
  return (a * b) / denominator;
}
function mulDivRoundingUp(a: bigint, b: bigint, denominator: bigint): bigint {
  const product = a * b;
  const result = product / denominator;
  return product % denominator === 0n ? result : result + 1n;
}

/** TickMath.getSqrtRatioAtTick — bit-exact sqrt(1.0001^tick) * 2^96. */
export function getSqrtRatioAtTick(tick: number): bigint {
  const absTick = BigInt(Math.abs(tick));
  let ratio =
    (absTick & 0x1n) !== 0n ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
  const M = (hex: bigint) => { ratio = (ratio * hex) >> 128n; };
  if ((absTick & 0x2n) !== 0n) M(0xfff97272373d413259a46990580e213an);
  if ((absTick & 0x4n) !== 0n) M(0xfff2e50f5f656932ef12357cf3c7fdccn);
  if ((absTick & 0x8n) !== 0n) M(0xffe5caca7e10e4e61c3624eaa0941cd0n);
  if ((absTick & 0x10n) !== 0n) M(0xffcb9843d60f6159c9db58835c926644n);
  if ((absTick & 0x20n) !== 0n) M(0xff973b41fa98c081472e6896dfb254c0n);
  if ((absTick & 0x40n) !== 0n) M(0xff2ea16466c96a3843ec78b326b52861n);
  if ((absTick & 0x80n) !== 0n) M(0xfe5dee046a99a2a811c461f1969c3053n);
  if ((absTick & 0x100n) !== 0n) M(0xfcbe86c7900a88aedcffc83b479aa3a4n);
  if ((absTick & 0x200n) !== 0n) M(0xf987a7253ac413176f2b074cf7815e54n);
  if ((absTick & 0x400n) !== 0n) M(0xf3392b0822b70005940c7a398e4b70f3n);
  if ((absTick & 0x800n) !== 0n) M(0xe7159475a2c29b7443b29c7fa6e889d9n);
  if ((absTick & 0x1000n) !== 0n) M(0xd097f3bdfd2022b8845ad8f792aa5825n);
  if ((absTick & 0x2000n) !== 0n) M(0xa9f746462d870fdf8a65dc1f90e061e5n);
  if ((absTick & 0x4000n) !== 0n) M(0x70d869a156d2a1b890bb3df62baf32f7n);
  if ((absTick & 0x8000n) !== 0n) M(0x31be135f97d08fd981231505542fcfa6n);
  if ((absTick & 0x10000n) !== 0n) M(0x9aa508b5b7a84e1c677de54f3e99bc9n);
  if ((absTick & 0x20000n) !== 0n) M(0x5d6af8dedb81196699c329225ee604n);
  if ((absTick & 0x40000n) !== 0n) M(0x2216e584f5fa1ea926041bedfe98n);
  if ((absTick & 0x80000n) !== 0n) M(0x48a170391f7dc42444e8fa2n);
  if (tick > 0) ratio = (1n << 256n) / ratio; // MaxUint256 / ratio, but exact for our range
  // round up to X96 (ratio is Q128.128 → shift to Q96)
  const rem = ratio % (1n << 32n);
  return (ratio >> 32n) + (rem === 0n ? 0n : 1n);
}

/** SqrtPriceMath.getAmount0Delta — token0 between two prices for liquidity L. */
function getAmount0Delta(sqrtA: bigint, sqrtB: bigint, liquidity: bigint, roundUp: boolean): bigint {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  const numerator1 = liquidity << 96n;
  const numerator2 = sqrtB - sqrtA;
  return roundUp
    ? mulDivRoundingUp(mulDivRoundingUp(numerator1, numerator2, sqrtB), 1n, sqrtA)
    : mulDiv(mulDiv(numerator1, numerator2, sqrtB), 1n, sqrtA);
}

/** SqrtPriceMath.getAmount1Delta — token1 between two prices for liquidity L. */
function getAmount1Delta(sqrtA: bigint, sqrtB: bigint, liquidity: bigint, roundUp: boolean): bigint {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  return roundUp
    ? mulDivRoundingUp(liquidity, sqrtB - sqrtA, Q96)
    : mulDiv(liquidity, sqrtB - sqrtA, Q96);
}

/** getNextSqrtPriceFromAmount0RoundingUp — new price after adding amount of token0 (zeroForOne). */
function getNextSqrtPriceFromAmount0(sqrtP: bigint, liquidity: bigint, amount: bigint): bigint {
  if (amount === 0n) return sqrtP;
  const numerator1 = liquidity << 96n;
  const product = amount * sqrtP;
  const denominator = numerator1 + product;
  // zeroForOne exact-in: price decreases, rounding up
  return mulDivRoundingUp(numerator1, sqrtP, denominator);
}

/** getNextSqrtPriceFromAmount1RoundingDown — new price after adding amount of token1 (oneForZero). */
function getNextSqrtPriceFromAmount1(sqrtP: bigint, liquidity: bigint, amount: bigint): bigint {
  const quotient = mulDiv(amount, Q96, liquidity);
  return sqrtP + quotient;
}

/* ── PoolId + own-stack quote ─────────────────────────────────────────────────── */

/** V4 PoolId = keccak256(abi.encode(currency0, currency1, fee, tickSpacing, hooks)). */
export function computePoolId(currency0: Address, currency1: Address, fee: number, tickSpacing: number, hooks: Address): Hex {
  return keccak256(
    encodeAbiParameters(parseAbiParameters("address,address,uint24,int24,address"), [currency0, currency1, fee, tickSpacing, hooks])
  );
}

const stateViewAbi = [
  { type: "function", name: "getSlot0", stateMutability: "view", inputs: [{ name: "poolId", type: "bytes32" }], outputs: [{ type: "uint160" }, { type: "int24" }, { type: "uint24" }, { type: "uint24" }] },
  { type: "function", name: "getLiquidity", stateMutability: "view", inputs: [{ name: "poolId", type: "bytes32" }], outputs: [{ type: "uint128" }] },
  { type: "function", name: "getTickLiquidity", stateMutability: "view", inputs: [{ name: "poolId", type: "bytes32" }, { name: "tick", type: "int24" }], outputs: [{ name: "liquidityGross", type: "uint128" }, { name: "liquidityNet", type: "int128" }] },
] as const;

export type OwnStackQuote = {
  amountOut: bigint;
  /** True if the input consumed the whole seed range (quote is the max fillable, not a marginal price). */
  rangeExhausted: boolean;
  sqrtPriceStartX96: bigint;
};

/**
 * Exact-in quote for a buy/sell against a single-position own-stack pool. `feePips` is the caller's
 * best fee estimate (e.g. 10000 = 1% base after anti-snipe). Returns an ESTIMATE — enforce minOut downstream.
 */
export async function quoteOwnStackExactIn(
  publicClient: PublicClient,
  stateView: Address,
  args: {
    tokenIn: Address; tokenOut: Address; weth: Address; hook: Address;
    amountIn: bigint; feePips: number;
  }
): Promise<OwnStackQuote | null> {
  const { tokenIn, tokenOut, weth, hook, amountIn, feePips } = args;
  if (amountIn <= 0n) return null;

  // token = the non-WETH side; sort currencies as V4 does.
  const token = tokenIn.toLowerCase() === weth.toLowerCase() ? tokenOut : tokenIn;
  const ltIsCurrency0 = token.toLowerCase() < weth.toLowerCase();
  const currency0 = (ltIsCurrency0 ? token : weth) as Address;
  const currency1 = (ltIsCurrency0 ? weth : token) as Address;
  const poolId = computePoolId(currency0, currency1, DYNAMIC_FEE_FLAG, OWN_STACK_TICK_SPACING, hook);

  const preset = ltIsCurrency0 ? PRESET.c0 : PRESET.c1;

  let slot0: readonly [bigint, number, number, number];
  let posLiquidity: bigint;
  try {
    slot0 = await publicClient.readContract({ address: stateView, abi: stateViewAbi, functionName: "getSlot0", args: [poolId] }) as readonly [bigint, number, number, number];
    // Position liquidity = |liquidityNet| at the range's lower tick (+L is added crossing up into the range).
    const lower = await publicClient.readContract({ address: stateView, abi: stateViewAbi, functionName: "getTickLiquidity", args: [poolId, preset.tickLower] }) as readonly [bigint, bigint];
    const net = lower[1];
    posLiquidity = net < 0n ? -net : net;
  } catch {
    return null;
  }
  const sqrtPriceCurrent = slot0[0];
  if (sqrtPriceCurrent === 0n || posLiquidity === 0n) return null;

  const sqrtLower = getSqrtRatioAtTick(preset.tickLower);
  const sqrtUpper = getSqrtRatioAtTick(preset.tickUpper);

  // zeroForOne = selling currency0 for currency1 (price decreases).
  const zeroForOne = tokenIn.toLowerCase() === currency0.toLowerCase();

  // Fee taken off the input before the swap step (V4 charges fee on the input).
  const amountInLessFee = amountIn - mulDivRoundingUp(amountIn, BigInt(feePips), 1_000_000n);
  if (amountInLessFee <= 0n) return null;

  // Effective start price: clamp to the range edge the swap will fill from (the empty gap between the
  // launch tick and the range crosses for free — no liquidity — so we start filling at the near edge).
  let sqrtStart = sqrtPriceCurrent;
  let amountOut = 0n;
  let rangeExhausted = false;

  if (zeroForOne) {
    // Price moves DOWN; fillable region is [sqrtLower, min(start, sqrtUpper)].
    if (sqrtStart > sqrtUpper) sqrtStart = sqrtUpper; // free jump across the empty gap above the range
    if (sqrtStart <= sqrtLower) return null; // already at/below the range — nothing to fill this side
    const maxIn = getAmount0Delta(sqrtLower, sqrtStart, posLiquidity, true); // token0 to walk to the lower edge
    if (amountInLessFee >= maxIn) {
      amountOut = getAmount1Delta(sqrtLower, sqrtStart, posLiquidity, false);
      rangeExhausted = true;
    } else {
      const sqrtNext = getNextSqrtPriceFromAmount0(sqrtStart, posLiquidity, amountInLessFee);
      amountOut = getAmount1Delta(sqrtNext, sqrtStart, posLiquidity, false);
    }
  } else {
    // oneForZero: price moves UP; fillable region is [max(start, sqrtLower), sqrtUpper].
    if (sqrtStart < sqrtLower) sqrtStart = sqrtLower; // free jump across the empty gap below the range
    if (sqrtStart >= sqrtUpper) return null;
    const maxIn = getAmount1Delta(sqrtStart, sqrtUpper, posLiquidity, true); // token1 to walk to the upper edge
    if (amountInLessFee >= maxIn) {
      amountOut = getAmount0Delta(sqrtStart, sqrtUpper, posLiquidity, false);
      rangeExhausted = true;
    } else {
      const sqrtNext = getNextSqrtPriceFromAmount1(sqrtStart, posLiquidity, amountInLessFee);
      amountOut = getAmount0Delta(sqrtStart, sqrtNext, posLiquidity, false);
    }
  }

  return { amountOut, rangeExhausted, sqrtPriceStartX96: sqrtStart };
}
