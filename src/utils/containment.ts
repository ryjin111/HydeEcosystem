// EMERGENCY CONTAINMENT (clint 23979-23980 / kami 23986). The deployed HydeTokenFactory + HOODIE engine
// seed EVERY pool at a 1:1 numeraire:token starting price — an IMMUTABLE constructor preset with
// initialTick ≈ 0 (HydeTokenFactory.sol: launch → POOL_MANAGER.initialize(getSqrtPriceAtTick(initialTick));
// `_presets` is constructor-only). Confirmed on-chain: WETH pool tick −1, HOODIE pool tick 2. Result: fresh
// 1B-supply tokens start at ~1× the numeraire price (e.g. HYDE = 1 WETH ≈ $1,918 → $1.9T "FDV").
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
