import { encodeAbiParameters, keccak256, parseAbiParameters, parseUnits, toHex, type Address, type Hex } from "viem";
import { V4_ACTIONS, V4_ENCODING_TEMPLATES, SWEEP_ETH_ADDRESS } from "./constants";
import { CHAIN_EVIDENCE, type MarketEvidence } from "./chainEvidence";

const DEFAULT_HOOKS = SWEEP_ETH_ADDRESS;

/** V4's native-currency sentinel — pools pair against address(0), never WETH.
 *  (WETH substitution is a V2-path concern only; kami A-blocker 23091.) */
export const NATIVE_CURRENCY = "0x0000000000000000000000000000000000000000" as Address;

export function feeToTickSpacing(fee: number): number {
  if (fee <= 100) return 1;
  if (fee <= 500) return 10;
  if (fee <= 3000) return 60;
  return 200;
}

type SwapTemplateParams = {
  tokenIn: Address;
  tokenOut: Address;
  fee: number;
  recipient: Address;
  amountIn: string;
  amountOutQuoted: string;
  slippagePercent: string;
  decimalsIn: number;
  decimalsOut: number;
  tickSpacing?: number;
  hooks?: Address;
  /** When set, the encoded PoolKey is asserted against the chain's market
   *  evidence (chainEvidence.ts) — encoding a different pool than the one
   *  proven (e.g. WETH-paired where evidence is native-paired) THROWS instead
   *  of silently building a payload for an unproven pool. */
  chainId?: number;
  /** NATIVE INTENT (kami A-blocker 23093): the caller's UI-level truth that a
   *  side IS the chain's native currency. An intended-native side that arrives
   *  encoded as anything but NATIVE_CURRENCY (e.g. a reintroduced WETH
   *  rewrite) THROWS — this is the layer that catches the rewrite itself,
   *  which the pair-assert alone cannot (a rewritten pair has no 0x0 side
   *  left to trigger on). */
  nativeIn?: boolean;
  nativeOut?: boolean;
};

type AddLiquidityTemplateParams = {
  token0: Address;
  token1: Address;
  fee: number;
  tickLower: number;
  tickUpper: number;
  amount0Desired: string;
  amount1Desired: string;
  amount0Min: string;
  amount1Min: string;
  decimals0: number;
  decimals1: number;
  recipient: Address;
  tickSpacing?: number;
  hooks?: Address;
};

type RemoveLiquidityTemplateParams = {
  tokenId: string;
  liquidity: string;
  amount0Min: string;
  amount1Min: string;
  recipient: Address;
  decimals0: number;
  decimals1: number;
};

function sortTokens(a: Address, b: Address): [Address, Address, boolean] {
  const aLower = a.toLowerCase();
  const bLower = b.toLowerCase();
  if (aLower < bLower) return [a, b, true];
  return [b, a, false];
}

function clampSlippageBps(value: string): bigint {
  const pct = Number(value || "0");
  if (!Number.isFinite(pct) || pct < 0) return 0n;
  // Cap at 50% (5000 bps) to prevent accidental 100%+ slippage wiping minOut
  const bps = Math.floor(pct * 100);
  return BigInt(Math.min(bps, 5000));
}

function encodePoolKey(
  currency0: Address,
  currency1: Address,
  fee: number,
  tickSpacing: number,
  hooks: Address
): Hex {
  return encodeAbiParameters(
    parseAbiParameters("address,address,uint24,int24,address"),
    [currency0, currency1, fee, tickSpacing, hooks]
  );
}

function packActions(actions: number[]): Hex {
  const bytes = new Uint8Array(actions.length);
  actions.forEach((a, i) => { bytes[i] = a; });
  return toHex(bytes);
}

/** Re-derive an evidence market's poolId through THIS module's own sort+encode
 *  path. If the app encoder can't reproduce the proven poolId, the market is
 *  not tradable by this app — the registry excludes it (fail-closed). This is
 *  the regression seam kami required (23091): evidence PoolKey ↔ encoded
 *  PoolKey proven by the same code that builds real swap payloads. */
export function reencodeEvidencePoolId(mk: MarketEvidence): Hex {
  const [c0, c1] = sortTokens(mk.poolKey.currency0, mk.poolKey.currency1);
  return keccak256(encodePoolKey(c0, c1, mk.poolKey.fee, mk.poolKey.tickSpacing, mk.poolKey.hooks));
}
export function evidencePoolIdMatches(mk: MarketEvidence): boolean {
  return reencodeEvidencePoolId(mk).toLowerCase() === mk.poolId.toLowerCase();
}

/** Per-swap guard: when one side of the encoded pair is NATIVE and the chain
 *  has evidence for the other token, the encoded pairing must agree with the
 *  proven market, and on a full fee/tickSpacing/hooks match the poolId must
 *  match. NOTE (kami 23093): this pair-assert CANNOT catch a native→WETH
 *  rewrite by itself — a rewritten pair has no 0x0 side left to trigger on;
 *  that class is caught by the nativeIn/nativeOut intent assertion in
 *  buildSwapTemplatePayload. Token↔token pairs and fee tiers outside evidence
 *  are legitimate distinct pools — not asserted, not blocked. */
function assertPoolKeyAgainstEvidence(
  chainId: number, currency0: Address, currency1: Address, fee: number, tickSpacing: number, hooks: Address
): void {
  const markets = CHAIN_EVIDENCE[chainId]?.markets;
  if (!markets || markets.length === 0) return;
  const c0 = currency0.toLowerCase(), c1 = currency1.toLowerCase();
  if (c0 !== NATIVE_CURRENCY && c1 !== NATIVE_CURRENCY) return; // not a native-paired intent
  const token = c0 === NATIVE_CURRENCY ? c1 : c0;
  const mk = markets.find((m) => m.token.toLowerCase() === token);
  if (!mk) return; // no evidence claim for this token
  const mkPair = [mk.poolKey.currency0.toLowerCase(), mk.poolKey.currency1.toLowerCase()];
  if (!(mkPair.includes(c0) && mkPair.includes(c1))) {
    throw new Error(
      `PoolKey drift for ${mk.symbol} on chain ${chainId}: encoding pair (${currency0}, ${currency1}) ` +
      `but evidence proves (${mk.poolKey.currency0}, ${mk.poolKey.currency1})`
    );
  }
  if (fee === mk.poolKey.fee && tickSpacing === mk.poolKey.tickSpacing && hooks.toLowerCase() === mk.poolKey.hooks.toLowerCase()) {
    const derived = keccak256(encodePoolKey(currency0, currency1, fee, tickSpacing, hooks));
    if (derived.toLowerCase() !== mk.poolId.toLowerCase()) {
      throw new Error(`PoolKey drift for ${mk.symbol} on chain ${chainId}: encoded poolId ${derived} ≠ evidence ${mk.poolId}`);
    }
  }
}

export function buildSwapTemplatePayload(params: SwapTemplateParams): { commands: Hex; inputs: Hex[] } {
  if (!params.tokenIn || !params.tokenOut) throw new Error("tokenIn and tokenOut are required");
  if (params.tokenIn.toLowerCase() === params.tokenOut.toLowerCase()) throw new Error("tokenIn and tokenOut must differ");
  if (!params.recipient || params.recipient === "0x0000000000000000000000000000000000000000") throw new Error("recipient is required");
  if (params.decimalsIn < 0 || params.decimalsIn > 18) throw new Error("invalid decimalsIn");
  if (params.decimalsOut < 0 || params.decimalsOut > 18) throw new Error("invalid decimalsOut");

  const amountInParsed = parseUnits(params.amountIn || "0", params.decimalsIn);
  if (amountInParsed === 0n) throw new Error("amountIn must be greater than 0");

  // Native-intent assertion FIRST (kami 23093): a side the caller declares
  // native must be encoded as address(0). This fires on the exact
  // native→WETH rewrite class regardless of what the addresses look like.
  if (params.nativeIn && params.tokenIn.toLowerCase() !== NATIVE_CURRENCY) {
    throw new Error(`native-intent drift: tokenIn declared native but encoded as ${params.tokenIn} — V4 native must encode as address(0); WETH substitution is V2-only`);
  }
  if (params.nativeOut && params.tokenOut.toLowerCase() !== NATIVE_CURRENCY) {
    throw new Error(`native-intent drift: tokenOut declared native but encoded as ${params.tokenOut} — V4 native must encode as address(0); WETH substitution is V2-only`);
  }

  const [currency0, currency1, zeroForOne] = sortTokens(params.tokenIn, params.tokenOut);
  const tickSpacing = params.tickSpacing ?? feeToTickSpacing(params.fee);
  const hooks = params.hooks ?? DEFAULT_HOOKS;
  if (params.chainId !== undefined) {
    assertPoolKeyAgainstEvidence(params.chainId, currency0, currency1, params.fee, tickSpacing, hooks);
  }

  const quotedOutParsed = parseUnits(params.amountOutQuoted || "0", params.decimalsOut);
  const slippageBps = clampSlippageBps(params.slippagePercent);
  // Use ceiling division so minOut is never rounded down past the user's tolerance
  const minOut = quotedOutParsed === 0n ? 0n : (quotedOutParsed * (10000n - slippageBps) + 9999n) / 10000n;

  const actions = packActions([V4_ACTIONS.SWAP_EXACT_IN_SINGLE, V4_ACTIONS.SETTLE_ALL, V4_ACTIONS.TAKE_ALL]);

  const swapParam = encodeAbiParameters(
    parseAbiParameters("(address,address,uint24,int24,address),bool,uint128,uint128,bytes"),
    [
      [currency0, currency1, params.fee, tickSpacing, hooks],
      zeroForOne,
      amountInParsed,
      minOut,
      "0x"
    ]
  );

  const settleParam = encodeAbiParameters(
    parseAbiParameters("address,uint256"),
    [params.tokenIn, amountInParsed]
  );

  const takeParam = encodeAbiParameters(
    parseAbiParameters("address,uint256"),
    [params.tokenOut, minOut]
  );

  const v4SwapInput = encodeAbiParameters(
    parseAbiParameters("bytes,bytes[]"),
    [actions, [swapParam, settleParam, takeParam]]
  );

  const sweepInput = encodeAbiParameters(
    parseAbiParameters("address,address,uint256"),
    [SWEEP_ETH_ADDRESS, params.recipient, 0n]
  );

  return {
    commands: (V4_ENCODING_TEMPLATES.swapCommand + V4_ENCODING_TEMPLATES.sweepCommand.slice(2)) as Hex,
    inputs: [v4SwapInput, sweepInput]
  };
}

export function buildAddLiquidityTemplatePayload(params: AddLiquidityTemplateParams): Hex[] {
  const [token0, token1, inOrder] = sortTokens(params.token0, params.token1);
  const tickSpacing = params.tickSpacing ?? feeToTickSpacing(params.fee);
  const hooks = params.hooks ?? DEFAULT_HOOKS;

  const amt0Desired = inOrder ? params.amount0Desired : params.amount1Desired;
  const amt1Desired = inOrder ? params.amount1Desired : params.amount0Desired;
  const min0 = inOrder ? params.amount0Min : params.amount1Min;
  const min1 = inOrder ? params.amount1Min : params.amount0Min;
  const dec0 = inOrder ? params.decimals0 : params.decimals1;
  const dec1 = inOrder ? params.decimals1 : params.decimals0;

  const poolKeyEncoded = encodePoolKey(token0, token1, params.fee, tickSpacing, hooks);

  const encoded = encodeAbiParameters(
    parseAbiParameters("bytes,int24,int24,uint256,uint256,uint256,uint256,address"),
    [
      poolKeyEncoded,
      params.tickLower,
      params.tickUpper,
      parseUnits(amt0Desired || "0", dec0),
      parseUnits(amt1Desired || "0", dec1),
      parseUnits(min0 || "0", dec0),
      parseUnits(min1 || "0", dec1),
      params.recipient
    ]
  );
  return [encoded];
}

export function buildRemoveLiquidityTemplatePayload(params: RemoveLiquidityTemplateParams): Hex[] {
  if (!params.recipient || params.recipient === "0x0000000000000000000000000000000000000000") throw new Error("recipient is required");
  const liquidity = BigInt(params.liquidity || "0");
  if (liquidity === 0n) throw new Error("liquidity must be greater than 0");
  const amount0Min = parseUnits(params.amount0Min || "0", params.decimals0);
  const amount1Min = parseUnits(params.amount1Min || "0", params.decimals1);
  const encoded = encodeAbiParameters(
    parseAbiParameters("uint256,uint128,uint256,uint256,address"),
    [
      BigInt(params.tokenId || "0"),
      liquidity,
      amount0Min,
      amount1Min,
      params.recipient
    ]
  );
  return [encoded];
}
