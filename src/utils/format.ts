import { formatUnits } from "viem";
import type { NumeraireInfo } from "./chainRegistry";

/** Price render that switches on the chain's numeraire (shiro V3_MULTICHAIN_UI_DESIGN §3).
 *  USD-pegged numeraire (USDT0/USDC, 6-dec) → "$1.23"; native numeraire (WETH, 18-dec) →
 *  "0.0000123 WETH". A 6-dec USDT0 pool and an 18-dec WETH pool render correctly from the SAME
 *  component — the UI half of audit-item-#1 (the $1.9T-class bug is decimals + formatting). */
export function formatPrice(value: bigint | number, n: NumeraireInfo): string {
  const num = typeof value === "bigint" ? Number(formatUnits(value, n.decimals)) : value;
  // NaN/Infinity is an ERROR, not $0 — never render a bad number as a real economic value (kami 24254).
  if (!Number.isFinite(num)) {
    return "—";
  }
  if (n.usdPegged) {
    // sub-cent memecoin launches need sig-figs, not "$0.00"
    const frac = Math.abs(num) < 0.01 ? Math.max(n.displayDecimals, 6) : n.displayDecimals;
    return `$${num.toLocaleString(undefined, { maximumFractionDigits: frac })}`;
  }
  return `${num.toLocaleString(undefined, { maximumFractionDigits: n.displayDecimals })} ${n.symbol}`;
}

/** FDV render: USD-pegged → "$5,000"; native → "2.61 WETH". */
export function formatFdv(fdv: number, n: NumeraireInfo): string {
  if (!Number.isFinite(fdv)) {
    return "—";
  }
  return n.usdPegged
    ? `$${fdv.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
    : `${fdv.toLocaleString(undefined, { maximumFractionDigits: n.displayDecimals })} ${n.symbol}`;
}

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
