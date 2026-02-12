import { encodeAbiParameters, parseAbiParameters, parseUnits, type Hex } from "viem";
import { V4_ENCODING_TEMPLATES } from "./constants";

type SwapTemplateParams = {
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  fee: number;
  recipient: `0x${string}`;
  amountIn: string;
  amountOutQuoted: string;
  slippagePercent: string;
  decimalsIn: number;
  decimalsOut: number;
};

type AddLiquidityTemplateParams = {
  token0: `0x${string}`;
  token1: `0x${string}`;
  fee: number;
  tickLower: number;
  tickUpper: number;
  amount0Desired: string;
  amount1Desired: string;
  amount0Min: string;
  amount1Min: string;
  decimals0: number;
  decimals1: number;
  recipient: `0x${string}`;
};

type RemoveLiquidityTemplateParams = {
  tokenId: string;
  liquidity: string;
  amount0Min: string;
  amount1Min: string;
  recipient: `0x${string}`;
  decimals0: number;
  decimals1: number;
};

function clampSlippageBps(value: string): bigint {
  const pct = Number(value || "0");
  if (!Number.isFinite(pct) || pct < 0) return 0n;
  return BigInt(Math.floor(pct * 100));
}

export function buildSwapTemplatePayload(params: SwapTemplateParams): { commands: Hex; inputs: Hex[] } {
  const amountInParsed = parseUnits(params.amountIn || "0", params.decimalsIn);
  const quotedOutParsed = parseUnits(params.amountOutQuoted || "0", params.decimalsOut);
  const slippageBps = clampSlippageBps(params.slippagePercent);
  const minOut = (quotedOutParsed * (10000n - slippageBps)) / 10000n;

  const encodedInput = encodeAbiParameters(parseAbiParameters(V4_ENCODING_TEMPLATES.swapInputAbi), [
    params.tokenIn,
    params.tokenOut,
    params.fee,
    params.recipient,
    amountInParsed,
    minOut,
    true
  ]);

  return {
    commands: V4_ENCODING_TEMPLATES.swapCommand,
    inputs: [encodedInput]
  };
}

export function buildAddLiquidityTemplatePayload(params: AddLiquidityTemplateParams): Hex[] {
  const encoded = encodeAbiParameters(parseAbiParameters(V4_ENCODING_TEMPLATES.addLiquidityInputAbi), [
    params.token0,
    params.token1,
    params.fee,
    params.tickLower,
    params.tickUpper,
    parseUnits(params.amount0Desired || "0", params.decimals0),
    parseUnits(params.amount1Desired || "0", params.decimals1),
    parseUnits(params.amount0Min || "0", params.decimals0),
    parseUnits(params.amount1Min || "0", params.decimals1),
    params.recipient
  ]);
  return [encoded];
}

export function buildRemoveLiquidityTemplatePayload(params: RemoveLiquidityTemplateParams): Hex[] {
  const encoded = encodeAbiParameters(parseAbiParameters(V4_ENCODING_TEMPLATES.removeLiquidityInputAbi), [
    BigInt(params.tokenId || "0"),
    BigInt(params.liquidity || "0"),
    parseUnits(params.amount0Min || "0", params.decimals0),
    parseUnits(params.amount1Min || "0", params.decimals1),
    params.recipient
  ]);
  return [encoded];
}
