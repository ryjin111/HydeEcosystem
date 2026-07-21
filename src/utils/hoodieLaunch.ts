import type { Address, PublicClient, WalletClient } from "viem";
import { parseEventLogs } from "viem";
import { V4_CONTRACTS_BY_CHAIN, hoodieLauncherAbi, hoodieEngineAbi } from "./constants";

/* ─── HOODIE shared-launcher lane (Robinhood 4663 mainnet) ───────────────────────
 *
 * clint 23752 "one hoodielauncher is enough": there is ONE HoodieLauncher, minted once by Hydeout via the
 * meta-factory (fixed domain salt) and registered in the engine's allowlist. EVERY creator launches through
 * that same launcher in a SINGLE tx — the engine records the ACTUAL caller as the creator (the launcher's
 * `owner` is branding-only and never gates a launch, HoodieLauncher.sol), and the per-(launcher, creator)
 * nonce keeps each user's predicted address independent. No per-user launcher deploy. Every token is
 * immutably $HOODIE-paired; the flat 0.0004 ETH fee rides as `msg.value` on `launch` (no approval, no faucet).
 */

export const HOODIE_DEFAULT_PRESET_ID = 0n;

/** The shared launcher + engine for a chain (throws if the HOODIE stack isn't configured there). */
function hoodieAddrs(chainId: number): { engine: Address; launcher: Address } {
  const cfg = V4_CONTRACTS_BY_CHAIN[chainId];
  if (!cfg?.hoodieEngine || !cfg?.hoodieSharedLauncher) {
    throw new Error(`HOODIE launcher not configured for chain ${chainId}`);
  }
  return { engine: cfg.hoodieEngine, launcher: cfg.hoodieSharedLauncher };
}

export type HoodieLaunchInput = {
  name: string;
  symbol: string;
  /** Registered creator / fee recipient — IMMUTABLE after launch (the actual caller at launch). */
  creator: Address;
};

export type HoodieLaunchPreview = {
  /** The shared HoodieLauncher every launch routes through. */
  launcherAddress: Address;
  /** Deterministic clone address for the creator's NEXT launch of this symbol through the shared launcher. */
  tokenAddress: Address;
  /** Flat native-ETH launch fee in wei (from the engine's `launchFeeAmount`). */
  feeAmount: bigint;
};

/** Read-only pre-flight: predicts the token address for (sharedLauncher, creator, symbol) and reads the fee. */
export async function simulateHoodieLaunch(
  publicClient: PublicClient,
  chainId: number,
  input: HoodieLaunchInput,
): Promise<HoodieLaunchPreview> {
  const { engine, launcher } = hoodieAddrs(chainId);

  const [paused, feeAmount, tokenAddress] = await Promise.all([
    publicClient.readContract({ address: engine, abi: hoodieEngineAbi, functionName: "paused" }),
    publicClient.readContract({ address: engine, abi: hoodieEngineAbi, functionName: "launchFeeAmount" }),
    publicClient.readContract({
      address: engine, abi: hoodieEngineAbi, functionName: "predictNextFor",
      args: [launcher, input.creator, input.symbol.trim()],
    }),
  ]);
  if (paused) throw new Error("Launches are paused on the HOODIE engine.");

  return { launcherAddress: launcher, tokenAddress: tokenAddress as Address, feeAmount: feeAmount as bigint };
}

export type HoodieLaunchStep = "launch" | "confirm";

export type HoodieLaunchResult = {
  tokenAddress: Address;
  tokenId: bigint;
  transactionHash: string;
};

/**
 * Single-tx launch through the shared launcher (the flat native-ETH fee rides as `msg.value`). `onStep`
 * fires before the wallet action + after submit so the UI can narrate. Returns the launched token from the
 * emitted `HoodieLaunchCreated` event.
 */
export async function executeHoodieLaunch(
  publicClient: PublicClient,
  walletClient: WalletClient,
  chainId: number,
  input: HoodieLaunchInput,
  onStep?: (step: HoodieLaunchStep) => void,
): Promise<HoodieLaunchResult> {
  const { engine, launcher } = hoodieAddrs(chainId);
  const account = input.creator;
  const chain = walletClient.chain;

  // One payable tx: launch through the shared launcher (all-or-revert in the engine).
  const feeAmount = (await publicClient.readContract({
    address: engine, abi: hoodieEngineAbi, functionName: "launchFeeAmount",
  })) as bigint;
  onStep?.("launch");
  const launchHash = await walletClient.writeContract({
    address: launcher, abi: hoodieLauncherAbi, functionName: "launch",
    args: [input.name.trim(), input.symbol.trim(), HOODIE_DEFAULT_PRESET_ID],
    value: feeAmount, account, chain,
  });
  onStep?.("confirm");
  const receipt = await publicClient.waitForTransactionReceipt({ hash: launchHash });

  // The engine emits HoodieLaunchCreated(launcher, creator, token, poolId, tokenId).
  const events = parseEventLogs({ abi: hoodieEngineAbi, eventName: "HoodieLaunchCreated", logs: receipt.logs });
  const created = events[0];
  if (!created) throw new Error("Launch confirmed but no HoodieLaunchCreated event found in the receipt.");

  return {
    tokenAddress: created.args.token as Address,
    tokenId: created.args.tokenId as bigint,
    transactionHash: launchHash,
  };
}
