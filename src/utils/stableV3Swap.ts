import {
  keccak256,
  parseUnits,
  type Address,
  type PublicClient,
} from "viem";
import { chainV3Capability, v3ChainRow } from "./chainRegistry";

export const stableV3QuoterAbi = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [{
      name: "params",
      type: "tuple",
      components: [
        { name: "tokenIn", type: "address" },
        { name: "tokenOut", type: "address" },
        { name: "amountIn", type: "uint256" },
        { name: "fee", type: "uint24" },
        { name: "sqrtPriceLimitX96", type: "uint160" },
      ],
    }],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

export const stableV3SwapRouterAbi = [
  {
    type: "function",
    name: "exactInputSingle",
    stateMutability: "payable",
    inputs: [{
      name: "params",
      type: "tuple",
      components: [
        { name: "tokenIn", type: "address" },
        { name: "tokenOut", type: "address" },
        { name: "fee", type: "uint24" },
        { name: "recipient", type: "address" },
        { name: "amountIn", type: "uint256" },
        { name: "amountOutMinimum", type: "uint256" },
        { name: "sqrtPriceLimitX96", type: "uint160" },
      ],
    }],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

export const stableV3SwapErc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "maxWallet",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "maxWalletExpiry",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
] as const;

export type StableV3SwapSide = "buy" | "sell";

export type StableV3SwapQuote = {
  amountOut: bigint;
  sqrtPriceX96After: bigint;
  initializedTicksCrossed: number;
  gasEstimate: bigint;
};

export function stableV3SwapConfig(chainId: number) {
  const row = v3ChainRow(chainId);
  const capability = chainV3Capability(chainId);
  if (!row || capability?.trade?.engine !== "v3-single-sided") {
    throw new Error(`Stable V3 swap is not verified for chain ${chainId}.`);
  }
  return {
    router: row.swapRouter as Address,
    quoter: row.quoter as Address,
    routerCodeHash: row.swapRouterCodeHash,
    quoterCodeHash: row.quoterCodeHash,
    numeraire: row.numeraire.address as Address,
    numeraireSymbol: row.numeraire.symbol,
    numeraireDecimals: row.numeraire.decimals,
    feeTier: row.feeTier,
  };
}

export function stableV3Amount(value: string, decimals: number): bigint {
  if (!/^\d+(?:\.\d*)?$/.test(value.trim())) return 0n;
  try {
    return parseUnits(value.trim(), decimals);
  } catch {
    return 0n;
  }
}

export function stableV3MinOut(amountOut: bigint, slippageBps: number): bigint {
  const safeBps = Math.min(5_000, Math.max(0, Math.floor(slippageBps)));
  return (amountOut * BigInt(10_000 - safeBps)) / 10_000n;
}

export function stableV3SwapTokens(
  chainId: number,
  token: Address,
  side: StableV3SwapSide,
): { tokenIn: Address; tokenOut: Address } {
  const { numeraire } = stableV3SwapConfig(chainId);
  return side === "buy"
    ? { tokenIn: numeraire, tokenOut: token }
    : { tokenIn: token, tokenOut: numeraire };
}

export async function assertStableV3SwapDeployment(publicClient: PublicClient, chainId: number): Promise<void> {
  const config = stableV3SwapConfig(chainId);
  const liveChainId = await publicClient.getChainId();
  if (liveChainId !== chainId) throw new Error(`RPC is on chain ${liveChainId}, expected ${chainId}.`);
  const [routerCode, quoterCode] = await Promise.all([
    publicClient.getBytecode({ address: config.router }),
    publicClient.getBytecode({ address: config.quoter }),
  ]);
  if (!routerCode || routerCode === "0x" || keccak256(routerCode).toLowerCase() !== config.routerCodeHash.toLowerCase()) {
    throw new Error("Stable SwapRouter02 does not match the verified deployment.");
  }
  if (!quoterCode || quoterCode === "0x" || keccak256(quoterCode).toLowerCase() !== config.quoterCodeHash.toLowerCase()) {
    throw new Error("Stable QuoterV2 does not match the verified deployment.");
  }
}

export async function quoteStableV3Swap(
  publicClient: PublicClient,
  chainId: number,
  token: Address,
  side: StableV3SwapSide,
  amountIn: bigint,
): Promise<StableV3SwapQuote> {
  if (amountIn <= 0n) throw new Error("Enter an amount.");
  const config = stableV3SwapConfig(chainId);
  const { tokenIn, tokenOut } = stableV3SwapTokens(chainId, token, side);
  const simulation = await publicClient.simulateContract({
    address: config.quoter,
    abi: stableV3QuoterAbi,
    functionName: "quoteExactInputSingle",
    args: [{
      tokenIn,
      tokenOut,
      amountIn,
      fee: config.feeTier,
      sqrtPriceLimitX96: 0n,
    }],
  });
  const [amountOut, sqrtPriceX96After, initializedTicksCrossed, gasEstimate] = simulation.result;
  if (amountOut <= 0n) throw new Error("No output is available for this amount.");
  return {
    amountOut,
    sqrtPriceX96After,
    initializedTicksCrossed,
    gasEstimate,
  };
}

export async function preflightStableV3Swap(
  publicClient: PublicClient,
  chainId: number,
  account: Address,
  token: Address,
  side: StableV3SwapSide,
  amountIn: bigint,
  amountOutMinimum: bigint,
): Promise<bigint> {
  const config = stableV3SwapConfig(chainId);
  const { tokenIn, tokenOut } = stableV3SwapTokens(chainId, token, side);
  const simulation = await publicClient.simulateContract({
    account,
    address: config.router,
    abi: stableV3SwapRouterAbi,
    functionName: "exactInputSingle",
    args: [{
      tokenIn,
      tokenOut,
      fee: config.feeTier,
      recipient: account,
      amountIn,
      amountOutMinimum,
      sqrtPriceLimitX96: 0n,
    }],
    value: 0n,
  });
  return simulation.result;
}
