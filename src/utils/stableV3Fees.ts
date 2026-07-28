import {
  keccak256,
  zeroAddress,
  type Address,
  type Hash,
  type PublicClient,
  type WalletClient,
} from "viem";
import { chainV3Capability, v3ChainRow } from "./chainRegistry";
import { isClaimConfirmed, type ReplacedReason } from "./txStatus";

const BPS = 10_000n;
const HYDE_BPS = 500n;

export const stableV3FeeLockerAbi = [
  {
    type: "function",
    name: "FACTORY",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "POSITION_MANAGER",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "positionOf",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [
      { name: "creator", type: "address" },
      { name: "token0", type: "address" },
      { name: "token1", type: "address" },
      { name: "numeraire", type: "address" },
      { name: "tokenId", type: "uint256" },
      { name: "feeTier", type: "uint24" },
      { name: "cumulativeNumeraireFees", type: "uint256" },
      { name: "graduated", type: "bool" },
      { name: "registered", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "collect",
    stateMutability: "nonpayable",
    inputs: [{ name: "token", type: "address" }],
    outputs: [
      { name: "amount0", type: "uint256" },
      { name: "amount1", type: "uint256" },
    ],
  },
] as const;

export type StableV3CreatorFeeQuote = {
  creator: Address;
  grossToken: bigint;
  grossNumeraire: bigint;
  creatorToken: bigint;
  creatorNumeraire: bigint;
};

function stableV3FeeConfig(chainId: number) {
  const row = v3ChainRow(chainId);
  const capability = chainV3Capability(chainId);
  if (!row || capability?.status !== "live" || capability.engine !== "v3-single-sided") {
    throw new Error(`Stable V3 creator fees are not verified for chain ${chainId}.`);
  }
  return {
    row,
    locker: row.launchpad.locker as Address,
    pad: row.launchpad.pad as Address,
    positionManager: row.positionManager as Address,
    numeraire: row.numeraire.address as Address,
  };
}

function creatorShare(amount: bigint): bigint {
  return amount - ((amount * HYDE_BPS) / BPS);
}

/** Re-check the exact deployed locker before exposing a write. Its runtime hash pins all immutable
 * recipients/bindings; the explicit reads make a registry or redeploy mismatch fail closed too. */
export async function assertStableV3FeeDeployment(
  publicClient: PublicClient,
  chainId: number,
): Promise<void> {
  const { row, locker, pad, positionManager } = stableV3FeeConfig(chainId);
  const liveChainId = await publicClient.getChainId();
  if (liveChainId !== chainId) throw new Error(`RPC is on chain ${liveChainId}, expected ${chainId}.`);

  const [code, factory, livePositionManager] = await Promise.all([
    publicClient.getBytecode({ address: locker }),
    publicClient.readContract({ address: locker, abi: stableV3FeeLockerAbi, functionName: "FACTORY" }),
    publicClient.readContract({ address: locker, abi: stableV3FeeLockerAbi, functionName: "POSITION_MANAGER" }),
  ]);
  if (!code || code === "0x") throw new Error("Stable V3 fee locker is not deployed.");
  if (keccak256(code).toLowerCase() !== row.launchpad.lockerCodeHash.toLowerCase()) {
    throw new Error("Stable V3 fee locker bytecode does not match the verified deployment.");
  }
  if (
    factory.toLowerCase() !== pad.toLowerCase()
    || livePositionManager.toLowerCase() !== positionManager.toLowerCase()
  ) {
    throw new Error("Stable V3 fee locker bindings do not match the verified deployment.");
  }
}

/** Simulate the real permissionless collect. The result is the currently owed gross pool fees and the
 * exact 95% creator remainder for both assets; no synthetic claim balance exists on V3. */
export async function quoteStableV3CreatorFees(args: {
  publicClient: PublicClient;
  chainId: number;
  token: Address;
  caller?: Address;
}): Promise<StableV3CreatorFeeQuote> {
  const { publicClient, chainId, token, caller = zeroAddress } = args;
  const { row, locker, numeraire } = stableV3FeeConfig(chainId);
  await assertStableV3FeeDeployment(publicClient, chainId);

  const position = await publicClient.readContract({
    address: locker,
    abi: stableV3FeeLockerAbi,
    functionName: "positionOf",
    args: [token],
  });
  const [creator, token0, token1, positionNumeraire, , feeTier, , , registered] = position;
  const tokenLower = token.toLowerCase();
  const numeraireLower = numeraire.toLowerCase();
  const validPair =
    (token0.toLowerCase() === tokenLower && token1.toLowerCase() === numeraireLower)
    || (token1.toLowerCase() === tokenLower && token0.toLowerCase() === numeraireLower);
  if (
    !registered
    || !validPair
    || positionNumeraire.toLowerCase() !== numeraireLower
    || Number(feeTier) !== row.feeTier
  ) {
    throw new Error("This token is not a verified Stable V3 launch position.");
  }

  const simulation = await publicClient.simulateContract({
    address: locker,
    abi: stableV3FeeLockerAbi,
    functionName: "collect",
    args: [token],
    account: caller,
  });
  const [amount0, amount1] = simulation.result;
  const tokenIs0 = token0.toLowerCase() === tokenLower;
  const grossToken = tokenIs0 ? amount0 : amount1;
  const grossNumeraire = tokenIs0 ? amount1 : amount0;
  return {
    creator,
    grossToken,
    grossNumeraire,
    creatorToken: creatorShare(grossToken),
    creatorNumeraire: creatorShare(grossNumeraire),
  };
}

/** Broadcast the exact preflighted collect and wait for one real confirmation. Anyone may pay gas, but
 * the locker always pushes 95% to its immutable creator and 5% to Hyde; the caller cannot redirect it. */
export async function collectStableV3CreatorFees(args: {
  publicClient: PublicClient;
  walletClient: WalletClient;
  chainId: number;
  token: Address;
  account: Address;
}): Promise<{ hash: Hash; quote: StableV3CreatorFeeQuote }> {
  const { publicClient, walletClient, chainId, token, account } = args;
  const { locker } = stableV3FeeConfig(chainId);
  const quote = await quoteStableV3CreatorFees({ publicClient, chainId, token, caller: account });
  if (quote.grossToken === 0n && quote.grossNumeraire === 0n) {
    throw new Error("No creator fees are available yet.");
  }

  const simulation = await publicClient.simulateContract({
    address: locker,
    abi: stableV3FeeLockerAbi,
    functionName: "collect",
    args: [token],
    account,
  });
  const hash = await walletClient.writeContract({
    ...simulation.request,
    chain: walletClient.chain,
  });
  let replacedReason: ReplacedReason | null = null;
  const receipt = await publicClient.waitForTransactionReceipt({
    hash,
    confirmations: 1,
    onReplaced: (replacement) => {
      replacedReason = replacement.reason as ReplacedReason;
    },
  });
  if (!isClaimConfirmed(receipt.status, replacedReason)) {
    if (replacedReason === "cancelled") throw new Error("Fee collection was cancelled.");
    if (replacedReason === "replaced") throw new Error("Fee collection was replaced by another transaction.");
    throw new Error("Fee collection reverted on-chain.");
  }
  return { hash, quote };
}
