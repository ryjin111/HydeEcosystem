import { formatUnits } from "viem";

export function formatAmount(value: bigint | undefined, decimals = 18, max = 6): string {
  if (value === undefined) {
    return "0";
  }
  const out = Number(formatUnits(value, decimals));
  if (!Number.isFinite(out)) {
    return "0";
  }
  return out.toLocaleString(undefined, { maximumFractionDigits: max });
}

export function shortenAddress(address?: string): string {
  if (!address) {
    return "";
  }
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function calcMinAmount(value: bigint, slippageBps: number): bigint {
  const base = 10000n;
  const slippage = BigInt(slippageBps);
  return (value * (base - slippage)) / base;
}
