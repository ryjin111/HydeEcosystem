// WETH-ONLY EMERGENCY CONTAINMENT (clint 24004 / kami 24005+24008; RCA gojo 23992). The factory/engine
// seed pools from an IMMUTABLE, NUMERAIRE-AGNOSTIC preset (`HydeTokenFactory.sol:341`): the same fixed seed
// tick (~±60000 ≈ 0.00248 quote/token) + a misaligned WIDE range, applied regardless of numeraire. A fixed
// quote-denominated seed = a fixed numeraire price; the wide range let a few buys walk it to the ~1:1 wall.
// It was NOT a 1:1 seed. Because the preset is quote-denominated, the SAME bug is catastrophic only for an
// EXPENSIVE numeraire: WETH token → 1 WETH ≈ $1,918 → $1.9T FDV (broken); HOODIE token → ~$4,086 FDV (sane,
// accepted by clint — HOODIE stays fully live). So containment is WETH-STACK ONLY.
//
// While active, WETH-paired launches + trade routes are paused; HOODIE launches/buys/sells are untouched.
// No cosmetic price/FDV clamp — the honest number stays; the banner explains it. Permanent fix = redeploy the
// WETH factory with a numeraire-aware preset + migrate existing WETH pools (Clint-owned FDV/depth call).
// LIFTED 2026-07-24: WETH factory redeployed with the numeraire-aware $5k preset (0x159A…4cbc, audited
// 08d99a7; on-chain-verified HOOK/WETH/tickSpacing=60/preset/seed). The $1.9T-bug root cause is fixed at
// the contract level, so containment is no longer needed — WETH launches/trade resume on the corrected stack.
export const WETH_CONTAINMENT = {
  active: false,
  // Copy matched to capability. WETH pairs have no audited in-app sell → trading unavailable; launch copy is
  // WETH-scoped (HOODIE launches are NOT paused).
  noSell: "Trading temporarily unavailable — launch price under review.",
  launch: "WETH-paired launches are paused — a pool pricing correction is in progress. HOODIE launches are unaffected.",
} as const;
