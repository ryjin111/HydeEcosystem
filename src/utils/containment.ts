// EMERGENCY CONTAINMENT (clint 23979-23980 / kami 23986; RCA per gojo 23992). The deployed
// HydeTokenFactory + HOODIE engine seed every pool from an IMMUTABLE, NUMERAIRE-AGNOSTIC preset (fixed
// constructor `_presets[]`, `HydeTokenFactory.sol:341`): the SAME fixed seed tick (~±60000 ≈ 0.00248
// quote/token) + a misaligned WIDE liquidity range, applied regardless of numeraire. A fixed
// quote-denominated seed = a fixed numeraire price, and the range is so wide a few buys walked it up to the
// ~1:1 wall (observed pool ticks WETH −1 / HOODIE 2 → HYDE = 1 WETH ≈ $1,918 → $1.9T FDV). Structurally
// identical for HOODIE, just cheap. Not repairable in place — needs a factory redeploy with numeraire-aware
// presets + a tighter range (separate, Clint-owned).
//
// Until the factory/engine are REDEPLOYED with corrected preset ticks and pools re-seeded, production must:
//  • NOT create new pools (launch) — every new launch inherits the 1:1 seed.
//  • NOT route users to BUY into the mispriced pools.
//  • Keep SELLING open — never trap a holder's funds.
// NO cosmetic price clamp — the honest-ugly $/FDV stays visible (kami/shiro: hiding it would read as "fixed").
export const CONTAINMENT = {
  active: true,
  // Copy matched to capability (kami 23991):
  //  • sellOpen — a surface with an AUDITED in-app sell (HOODIE swap): buy off, sell stays.
  //  • noSell   — a surface with no audited sell path (WETH pairs, external links, cards).
  //  • launch   — the launch form.
  sellOpen: "Buying & new launches paused — pool pricing correction in progress. Selling remains available.",
  noSell: "Trading temporarily unavailable — launch price under review.",
  launch: "New launches are paused — a pool pricing correction is in progress.",
} as const;
