import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { parseEventLogs } from "viem";
import { V4_CONTRACTS_BY_CHAIN, hoodieMetaFactoryAbi, hoodieLauncherAbi, hoodieEngineAbi } from "./constants";

/* ─── HOODIE launcher-launcher lane (Robinhood 4663 mainnet) ─────────────────────
 *
 * The "launch a launcher" mechanic: a creator first deploys their OWN `HoodieLauncher` (once, via the
 * meta-factory), then launches HOODIE-paired tokens through it. Every token is immutably $HOODIE-paired.
 *
 * We use ONE deterministic launcher per creator (salt = bytes32(0)) so a creator has a single stable
 * launcher: the first launch deploys it (2 txs: createLauncher + launch), every launch after reuses it
 * (1 tx). The flat 0.0004 ETH fee rides as `msg.value` on `launch` — no approval, no faucet.
 */

/** One deterministic launcher per creator: salt = bytes32(0). First launch deploys it; later launches reuse it. */
export const HOODIE_LAUNCHER_SALT = ("0x" + "0".repeat(64)) as Hex;
export const HOODIE_DEFAULT_PRESET_ID = 0n;

function hoodieAddrs(chainId: number): { meta: Address; engine: Address } {
  const cfg = V4_CONTRACTS_BY_CHAIN[chainId];
  if (!cfg?.hoodieMetaFactory || !cfg?.hoodieEngine) {
    throw new Error(`HOODIE launcher-launcher not configured for chain ${chainId}`);
  }
  return { meta: cfg.hoodieMetaFactory, engine: cfg.hoodieEngine };
}

async function launcherFor(publicClient: PublicClient, meta: Address, creator: Address): Promise<{ launcher: Address; exists: boolean }> {
  const launcher = (await publicClient.readContract({
    address: meta, abi: hoodieMetaFactoryAbi, functionName: "predictLauncher", args: [creator, HOODIE_LAUNCHER_SALT],
  })) as Address;
  const code = await publicClient.getCode({ address: launcher });
  return { launcher, exists: !!code && code !== "0x" };
}

export type HoodieLaunchInput = {
  name: string;
  symbol: string;
  /** Registered creator / fee recipient — IMMUTABLE after launch (the actual caller at launch). */
  creator: Address;
};

export type HoodieLaunchPreview = {
  /** The creator's deterministic launcher (deployed on demand for the first launch). */
  launcherAddress: Address;
  /** True if the launcher already exists (so this launch is 1 tx, not 2). */
  launcherExists: boolean;
  /** Deterministic clone address for the creator's NEXT launch of this symbol through the launcher. */
  tokenAddress: Address;
  /** Flat native-ETH launch fee in wei (from the engine's `launchFeeAmount`). */
  feeAmount: bigint;
};

/** Read-only pre-flight: predicts the launcher + token addresses and reads the flat fee. */
export async function simulateHoodieLaunch(
  publicClient: PublicClient,
  chainId: number,
  input: HoodieLaunchInput,
): Promise<HoodieLaunchPreview> {
  const { meta, engine } = hoodieAddrs(chainId);
  const { launcher, exists } = await launcherFor(publicClient, meta, input.creator);

  const [paused, feeAmount, tokenAddress] = await Promise.all([
    publicClient.readContract({ address: engine, abi: hoodieEngineAbi, functionName: "paused" }),
    publicClient.readContract({ address: engine, abi: hoodieEngineAbi, functionName: "launchFeeAmount" }),
    publicClient.readContract({
      address: engine, abi: hoodieEngineAbi, functionName: "predictNextFor",
      args: [launcher, input.creator, input.symbol.trim()],
    }),
  ]);
  if (paused) throw new Error("Launches are paused on the HOODIE engine.");

  return { launcherAddress: launcher, launcherExists: exists as boolean, tokenAddress: tokenAddress as Address, feeAmount: feeAmount as bigint };
}

export type HoodieLaunchStep = "createLauncher" | "launch" | "confirm";

export type HoodieLaunchResult = {
  tokenAddress: Address;
  tokenId: bigint;
  transactionHash: string;
};

/**
 * Two-step launcher-launcher: deploy the creator's launcher if it doesn't exist yet, then launch through
 * it (the flat native-ETH fee rides as `msg.value`). `onStep` fires before each wallet action so the UI
 * can narrate. Returns the launched token from the emitted `HoodieLaunchCreated` event.
 */
export async function executeHoodieLaunch(
  publicClient: PublicClient,
  walletClient: WalletClient,
  chainId: number,
  input: HoodieLaunchInput,
  onStep?: (step: HoodieLaunchStep) => void,
): Promise<HoodieLaunchResult> {
  const { meta, engine } = hoodieAddrs(chainId);
  const account = input.creator;
  const chain = walletClient.chain;

  const { launcher, exists } = await launcherFor(publicClient, meta, account);

  // Step 1 — deploy the creator's launcher (only the first time).
  if (!exists) {
    onStep?.("createLauncher");
    const createHash = await walletClient.writeContract({
      address: meta, abi: hoodieMetaFactoryAbi, functionName: "createLauncher", args: [HOODIE_LAUNCHER_SALT], account, chain,
    });
    await publicClient.waitForTransactionReceipt({ hash: createHash });
  }

  // Step 2 — launch through the launcher (payable flat fee, all-or-revert).
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
