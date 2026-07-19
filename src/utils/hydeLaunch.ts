import type { Address, PublicClient, WalletClient } from "viem";
import { parseEventLogs } from "viem";
import {
  V4_CONTRACTS_BY_CHAIN,
  ROBINHOOD_TESTNET,
  hydeTokenFactoryAbi,
} from "./constants";

/* ─── Hyde own-stack launch lane (Robinhood Testnet 46630) ───────────────────
 *
 * The launchpad's LIVE own-stack path — launches go through OUR HydeTokenFactory (not Doppler).
 * One PAYABLE `launch(LaunchParams{name,symbol,presetId})` call atomically: charges a flat native-ETH
 * fee (msg.value), clones HydeERC20, seeds all 1B single-sided into the LT-only range, and hands the
 * position NFT to the collector's PERMANENT custody. `creator := msg.sender` and is immutable.
 *
 * Fee: a flat 0.0004 ETH paid as `msg.value` on the launch call — NO ERC-20 approval and NO faucet,
 * so the whole launch is ONE wallet transaction. Gas is paid in testnet ETH (creator's own).
 */

export const HYDE_TESTNET_CHAIN_ID = ROBINHOOD_TESTNET.id; // 46630

/** The single launchable preset (both address-sort branches) on the deployed factory. */
export const HYDE_DEFAULT_PRESET_ID = 0n;

function factoryAddress(chainId: number): Address {
  const f = V4_CONTRACTS_BY_CHAIN[chainId]?.hydeTokenFactory;
  if (!f) throw new Error(`Hyde own-stack factory not configured for chain ${chainId}`);
  return f;
}

export type HydeLaunchInput = {
  name: string;
  symbol: string;
  /** Registered creator / fee recipient — IMMUTABLE after launch (msg.sender at launch). */
  creator: Address;
};

export type HydeLaunchPreview = {
  /** Deterministic clone address for the creator's NEXT launch of this symbol (from `predictNext`). */
  tokenAddress: Address;
  /** Flat native-ETH launch fee in wei (from `launchFeeAmount`). */
  feeAmount: bigint;
};

/** Read-only pre-flight: predicts the clone address + reads the flat fee. Fee/prediction only — no
 *  wallet balance/allowance read (the wallet rejects an underfunded tx; kami 22958). */
export async function simulateHydeLaunch(
  publicClient: PublicClient,
  chainId: number,
  input: HydeLaunchInput
): Promise<HydeLaunchPreview> {
  const factory = factoryAddress(chainId);

  const [paused, feeAmount, tokenAddress] = await Promise.all([
    publicClient.readContract({ address: factory, abi: hydeTokenFactoryAbi, functionName: "paused" }),
    publicClient.readContract({ address: factory, abi: hydeTokenFactoryAbi, functionName: "launchFeeAmount" }),
    publicClient.readContract({
      address: factory, abi: hydeTokenFactoryAbi, functionName: "predictNext",
      args: [input.creator, input.symbol.trim()],
    }),
  ]);
  if (paused) throw new Error("Launches are paused on this factory.");

  return { tokenAddress: tokenAddress as Address, feeAmount: feeAmount as bigint };
}

export type HydeLaunchStep = "launch" | "confirm";

export type HydeLaunchResult = {
  tokenAddress: Address;
  tokenId: bigint;
  transactionHash: string;
};

/**
 * Single payable launch: the flat native-ETH fee rides as `msg.value` — no faucet, no approval.
 * `onStep` fires before the wallet action and before the confirmation wait so the UI can narrate.
 */
export async function executeHydeLaunch(
  publicClient: PublicClient,
  walletClient: WalletClient,
  chainId: number,
  input: HydeLaunchInput,
  onStep?: (step: HydeLaunchStep) => void
): Promise<HydeLaunchResult> {
  const factory = factoryAddress(chainId);
  const account = input.creator;
  const chain = walletClient.chain;

  const feeAmount = (await publicClient.readContract({
    address: factory, abi: hydeTokenFactoryAbi, functionName: "launchFeeAmount",
  })) as bigint;

  // ONE tx: creator := msg.sender, the flat fee rides as msg.value, all-or-revert.
  onStep?.("launch");
  const launchHash = await walletClient.writeContract({
    address: factory, abi: hydeTokenFactoryAbi, functionName: "launch",
    args: [{ name: input.name.trim(), symbol: input.symbol.trim(), presetId: HYDE_DEFAULT_PRESET_ID }],
    value: feeAmount, account, chain,
  });
  onStep?.("confirm");
  const receipt = await publicClient.waitForTransactionReceipt({ hash: launchHash });

  // Parse the token address off the emitted LaunchCreated event (authoritative over the prediction).
  const events = parseEventLogs({ abi: hydeTokenFactoryAbi, eventName: "LaunchCreated", logs: receipt.logs });
  const created = events[0];
  if (!created) throw new Error("Launch confirmed but no LaunchCreated event found in the receipt.");

  return {
    tokenAddress: created.args.token as Address,
    tokenId: created.args.tokenId as bigint,
    transactionHash: launchHash,
  };
}
