// viem's `waitForTransactionReceipt` RESOLVES every replacement receipt — including a successful
// CANCELLATION self-tx and unrelated same-nonce replacements — and a mined-but-REVERTED receipt carries
// status "reverted" without throwing (kami 23902/23908). So a single-effect write (e.g. claimCreator) is
// only truly confirmed when the mined receipt is a success AND it is the original tx or a `repriced`
// speed-up of it. This pure decision is unit-tested by a deterministic status/reason matrix.
export type ReplacedReason = "repriced" | "cancelled" | "replaced";
export type ReceiptStatus = "success" | "reverted";

/** True iff the write actually took effect: a successful receipt for the original tx or a repriced
 *  (same to/value/input, higher gas) speed-up. A cancellation or an unrelated replacement — both of which
 *  viem resolves with their own success receipt — and any reverted receipt are NOT confirmations. */
export function isClaimConfirmed(status: ReceiptStatus, replacedReason: ReplacedReason | null): boolean {
  if (status !== "success") return false;
  return replacedReason === null || replacedReason === "repriced";
}
