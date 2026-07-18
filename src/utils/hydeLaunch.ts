import type { Address, PublicClient, WalletClient } from "viem";
import { parseEventLogs } from "viem";
import {
  V4_CONTRACTS_BY_CHAIN,
  ROBINHOOD_TESTNET,
  ROBINHOOD_TESTNET_USDG,
  hydeTokenFactoryAbi,
  mockUsdgAbi,
  erc20Abi,
} from "./constants";

/* ─── Hyde own-stack launch lane (Robinhood Testnet 46630) ───────────────────
 *
 * The launchpad's LIVE own-stack path — launches go through OUR HydeTokenFactory
 * (not Doppler). One `launch(LaunchParams{name,symbol,presetId})` atomically:
 * clones HydeERC20, seeds all 1B single-sided into the LT-only range, and hands
 * the position NFT to the collector's PERMANENT custody (the permanently-locked, grows-
 * every-trade LP). `creator := msg.sender` and is immutable.
 *
 * Fee: a flat $1 in the mock USDG (6-dec) charged to the launch-fee treasury,
 * with prior USDG approval to the factory. On this sandbox the USDG `mint` is a
 * public faucet, so the UI tops the creator up to the fee before approving.
 *
 * Sequence (each a wallet tx): [faucet USDG if short] → [approve USDG if short]
 * → launch. Gas is paid in testnet ETH (creator's own — testnet faucet).
 */

export const HYDE_TESTNET_CHAIN_ID = ROBINHOOD_TESTNET.id; // 46630

/** The single launchable preset (both address-sort branches) on the deployed factory. */
export const HYDE_DEFAULT_PRESET_ID = 0n;

function factoryAddress(chainId: number): Address {
  const f = V4_CONTRACTS_BY_CHAIN[chainId]?.hydeTokenFactory;
  if (!f) throw new Error(`Hyde own-stack factory not configured for chain ${chainId}`);
  return f;
}

function usdgAddress(chainId: number): Address {
  if (chainId !== HYDE_TESTNET_CHAIN_ID) throw new Error(`Mock USDG faucet only on Robinhood Testnet (got ${chainId})`);
  return ROBINHOOD_TESTNET_USDG;
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
  /** $1 launch fee in USDG base units (6-dec). */
  feeAmount: bigint;
  /** Creator's current USDG balance — the UI faucets the shortfall before approving. */
  usdgBalance: bigint;
  needsFaucet: boolean;
  needsApproval: boolean;
};

/** Read-only pre-flight: predicts the clone address + fee/approval state. No wallet needed. */
export async function simulateHydeLaunch(
  publicClient: PublicClient,
  chainId: number,
  input: HydeLaunchInput
): Promise<HydeLaunchPreview> {
  const factory = factoryAddress(chainId);
  const usdg = usdgAddress(chainId);

  const [paused, feeAmount, tokenAddress] = await Promise.all([
    publicClient.readContract({ address: factory, abi: hydeTokenFactoryAbi, functionName: "paused" }),
    publicClient.readContract({ address: factory, abi: hydeTokenFactoryAbi, functionName: "launchFeeAmount" }),
    publicClient.readContract({
      address: factory, abi: hydeTokenFactoryAbi, functionName: "predictNext",
      args: [input.creator, input.symbol.trim()],
    }),
  ]);
  if (paused) throw new Error("Launches are paused on this factory.");

  const [usdgBalance, allowance] = await Promise.all([
    publicClient.readContract({ address: usdg, abi: erc20Abi, functionName: "balanceOf", args: [input.creator] }),
    publicClient.readContract({ address: usdg, abi: erc20Abi, functionName: "allowance", args: [input.creator, factory] }),
  ]);

  return {
    tokenAddress: tokenAddress as Address,
    feeAmount: feeAmount as bigint,
    usdgBalance: usdgBalance as bigint,
    needsFaucet: (usdgBalance as bigint) < (feeAmount as bigint),
    needsApproval: (allowance as bigint) < (feeAmount as bigint),
  };
}

export type HydeLaunchStep = "faucet" | "approve" | "launch" | "confirm";

export type HydeLaunchResult = {
  tokenAddress: Address;
  tokenId: bigint;
  transactionHash: string;
};

/**
 * Faucet-top-up USDG (if short) → approve (if short) → launch. `onStep` fires
 * before each wallet action so the UI can narrate the multi-tx flow.
 */
export async function executeHydeLaunch(
  publicClient: PublicClient,
  walletClient: WalletClient,
  chainId: number,
  input: HydeLaunchInput,
  onStep?: (step: HydeLaunchStep) => void
): Promise<HydeLaunchResult> {
  const factory = factoryAddress(chainId);
  const usdg = usdgAddress(chainId);
  const account = input.creator;
  const chain = walletClient.chain;

  const feeAmount = (await publicClient.readContract({
    address: factory, abi: hydeTokenFactoryAbi, functionName: "launchFeeAmount",
  })) as bigint;

  // 1. Faucet the mock USDG up to the fee if the creator is short (sandbox-only public mint).
  const balance = (await publicClient.readContract({
    address: usdg, abi: erc20Abi, functionName: "balanceOf", args: [account],
  })) as bigint;
  if (balance < feeAmount) {
    onStep?.("faucet");
    const mintHash = await walletClient.writeContract({
      address: usdg, abi: mockUsdgAbi, functionName: "mint",
      args: [account, feeAmount - balance], account, chain,
    });
    await publicClient.waitForTransactionReceipt({ hash: mintHash });
  }

  // 2. Approve the factory to pull the $1 fee if the allowance is short.
  const allowance = (await publicClient.readContract({
    address: usdg, abi: erc20Abi, functionName: "allowance", args: [account, factory],
  })) as bigint;
  if (allowance < feeAmount) {
    onStep?.("approve");
    const approveHash = await walletClient.writeContract({
      address: usdg, abi: erc20Abi, functionName: "approve",
      args: [factory, feeAmount], account, chain,
    });
    await publicClient.waitForTransactionReceipt({ hash: approveHash });
  }

  // 3. Launch — creator := msg.sender, single tx, all-or-revert.
  onStep?.("launch");
  const launchHash = await walletClient.writeContract({
    address: factory, abi: hydeTokenFactoryAbi, functionName: "launch",
    args: [{ name: input.name.trim(), symbol: input.symbol.trim(), presetId: HYDE_DEFAULT_PRESET_ID }],
    account, chain,
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
