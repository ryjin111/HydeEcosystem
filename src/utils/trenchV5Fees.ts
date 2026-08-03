import {
  decodeFunctionResult,
  encodeFunctionData,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { trenchV5LockerAbi } from "./trenchV5";
import { isClaimConfirmed, type ReplacedReason } from "./txStatus";

/** Canonical deterministic Multicall3 deployment used by Hydeout's supported EVM chains. */
export const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11" as Address;

const multicall3Abi = [{
  type: "function",
  name: "aggregate3",
  stateMutability: "payable",
  inputs: [{
    name: "calls",
    type: "tuple[]",
    components: [
      { name: "target", type: "address" },
      { name: "allowFailure", type: "bool" },
      { name: "callData", type: "bytes" },
    ],
  }],
  outputs: [{
    name: "returnData",
    type: "tuple[]",
    components: [
      { name: "success", type: "bool" },
      { name: "returnData", type: "bytes" },
    ],
  }],
}] as const;

type BatchResult = { success: boolean; returnData: Hex };

export type TrenchV5CreatorFeeQuote = {
  tokenAmount: bigint;
  quoteAmount: bigint;
};

/**
 * One atomic transaction: harvest every permanent NFT, then drain both creator claim buckets.
 * Each locker call is permissionless and pays only the creator recorded during launch.
 */
export function encodeTrenchV5ClaimAll(
  locker: Address,
  token: Address,
  numeraire: Address,
  includeCollect: boolean,
): Hex {
  const calls: Array<{ target: Address; allowFailure: false; callData: Hex }> = [];
  if (includeCollect) {
    calls.push({
      target: locker,
      allowFailure: false,
      callData: encodeFunctionData({
        abi: trenchV5LockerAbi,
        functionName: "collect",
        args: [token],
      }),
    });
  }
  calls.push(
    {
      target: locker,
      allowFailure: false,
      callData: encodeFunctionData({
        abi: trenchV5LockerAbi,
        functionName: "claimCreator",
        args: [token, token],
      }),
    },
    {
      target: locker,
      allowFailure: false,
      callData: encodeFunctionData({
        abi: trenchV5LockerAbi,
        functionName: "claimCreator",
        args: [token, numeraire],
      }),
    },
  );

  return encodeFunctionData({ abi: multicall3Abi, functionName: "aggregate3", args: [calls] });
}

function decodeClaimAmount(result: BatchResult | undefined): bigint {
  if (!result?.success) throw new Error("V5 fee batch sub-call failed.");
  return decodeFunctionResult({
    abi: trenchV5LockerAbi,
    functionName: "claimCreator",
    data: result.returnData,
  }) as bigint;
}

/** Exact eth_call of the wallet payload. This includes currently uncollected LP fees. */
export async function quoteTrenchV5ClaimAll(args: {
  publicClient: PublicClient;
  locker: Address;
  token: Address;
  numeraire: Address;
  includeCollect: boolean;
  account?: Address;
}): Promise<TrenchV5CreatorFeeQuote> {
  const data = encodeTrenchV5ClaimAll(args.locker, args.token, args.numeraire, args.includeCollect);
  const response = await args.publicClient.call({
    account: args.account,
    to: MULTICALL3_ADDRESS,
    data,
  });
  if (!response.data) throw new Error("V5 fee simulation returned no data.");

  const results = decodeFunctionResult({
    abi: multicall3Abi,
    functionName: "aggregate3",
    data: response.data,
  }) as readonly BatchResult[];
  const expectedLength = args.includeCollect ? 3 : 2;
  if (results.length !== expectedLength) throw new Error("V5 fee simulation returned an invalid result.");

  return {
    tokenAmount: decodeClaimAmount(results[results.length - 2]),
    quoteAmount: decodeClaimAmount(results[results.length - 1]),
  };
}

/** Broadcast the exact preflighted batch and require a successful, non-cancelled receipt. */
export async function runTrenchV5ClaimAll(args: {
  publicClient: PublicClient;
  walletClient: WalletClient;
  locker: Address;
  token: Address;
  numeraire: Address;
  includeCollect: boolean;
  account: Address;
}): Promise<void> {
  const data = encodeTrenchV5ClaimAll(args.locker, args.token, args.numeraire, args.includeCollect);
  await args.publicClient.call({ account: args.account, to: MULTICALL3_ADDRESS, data });

  const hash = await args.walletClient.sendTransaction({
    account: args.account,
    chain: args.walletClient.chain,
    to: MULTICALL3_ADDRESS,
    data,
    value: 0n,
  });
  let replaced: ReplacedReason | null = null;
  const receipt = await args.publicClient.waitForTransactionReceipt({
    hash,
    onReplaced: (replacement) => {
      replaced = replacement.reason as ReplacedReason;
    },
  });
  if (!isClaimConfirmed(receipt.status, replaced)) {
    throw new Error(replaced === "cancelled" ? "CANCELLED" : "REVERTED");
  }
}
