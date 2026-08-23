import {
  formatUnits,
  keccak256,
  parseEventLogs,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { chainV3Capability, v3ChainRow } from "./chainRegistry";
import { isClaimConfirmed, type ReplacedReason } from "./txStatus";

export const STABLE_V3_CHAIN_ID = 988;
export const STABLE_V3_LAUNCH_FEE = 1_000_000n;
export const INK_V3_CHAIN_ID = 57073;
export const INK_V3_LAUNCH_FEE = 400_000_000_000_000n;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export const stableV3PadAbi = [
  {
    type: "function",
    name: "launch",
    stateMutability: "payable",
    inputs: [
      { name: "name", type: "string" },
      { name: "symbol", type: "string" },
      { name: "salt", type: "bytes32" },
    ],
    outputs: [
      { name: "token", type: "address" },
      { name: "tokenId", type: "uint256" },
    ],
  },
  { type: "function", name: "IMPL", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "LOCKER", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "V3_FACTORY", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "POSITION_MANAGER", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "NUMERAIRE", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "NUMERAIRE_DECIMALS", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "FEE_TIER", stateMutability: "view", inputs: [], outputs: [{ type: "uint24" }] },
  { type: "function", name: "LAUNCH_FEE_ASSET", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "LAUNCH_FEE_AMOUNT", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "LAUNCH_FEE_NATIVE", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "MAX_WALLET_BPS", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "MAX_WALLET_WINDOW_SECS", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
  {
    type: "event",
    name: "LaunchCreated",
    anonymous: false,
    inputs: [
      { name: "token", type: "address", indexed: true },
      { name: "creator", type: "address", indexed: true },
      { name: "pool", type: "address", indexed: false },
      { name: "tokenId", type: "uint256", indexed: false },
      { name: "liquidity", type: "uint128", indexed: false },
    ],
  },
] as const;

export const stableV3LockerAbi = [
  { type: "function", name: "FACTORY", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

export const stableUsdt0Abi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ type: "bool" }],
  },
] as const;

export type StableV3LaunchInput = {
  name: string;
  symbol: string;
  creator: Address;
  salt: Hex;
};

export type StableV3LaunchPreview = {
  feeAmount: bigint;
  balance: bigint;
  allowance: bigint;
  needsApproval: boolean;
  tokenAddress: Address | null;
  tokenId: bigint | null;
};

export type StableV3LaunchStep = "approve" | "approve-confirm" | "launch" | "launch-confirm";

export type StableV3LaunchResult = {
  tokenAddress: Address;
  poolAddress: Address;
  tokenId: bigint;
  transactionHash: Hash;
};

function stableConfig(chainId: number) {
  const row = v3ChainRow(chainId);
  const capability = chainV3Capability(chainId);
  if (!row || capability?.status !== "live") {
    throw new Error(`V3 launch is not verified for chain ${chainId}.`);
  }
  const launchFee = chainId === STABLE_V3_CHAIN_ID
    ? STABLE_V3_LAUNCH_FEE
    : chainId === INK_V3_CHAIN_ID
      ? INK_V3_LAUNCH_FEE
      : null;
  if (launchFee === null) throw new Error(`V3 launch fee is not pinned for chain ${chainId}.`);
  return {
    row,
    pad: row.launchpad.pad as Address,
    locker: row.launchpad.locker as Address,
    implementation: row.launchpad.implementation as Address,
    numeraire: row.numeraire.address as Address,
    launchFee,
    launchFeeNative: chainId === INK_V3_CHAIN_ID,
  };
}

function normalizedInput(input: StableV3LaunchInput): StableV3LaunchInput {
  const name = input.name.trim();
  const symbol = input.symbol.trim().toUpperCase();
  if (name.length < 1 || name.length > 64) throw new Error("Token name must be 1–64 characters.");
  if (!/^[A-Z0-9]{1,10}$/.test(symbol)) throw new Error("Symbol must be 1–10 letters or numbers.");
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.salt)) throw new Error("Launch salt must be exactly 32 bytes.");
  return { ...input, name, symbol };
}

async function assertRuntimeHash(
  publicClient: PublicClient,
  address: Address,
  expected: string,
  label: string,
) {
  const code = await publicClient.getBytecode({ address });
  if (!code || code === "0x") throw new Error(`${label} is not deployed.`);
  const actual = keccak256(code);
  if (actual.toLowerCase() !== expected.toLowerCase()) throw new Error(`${label} bytecode does not match the verified deployment.`);
}

/** Live pre-flight. This deliberately re-checks runtime hashes and critical bindings instead of trusting
 * the UI registry alone. If allowance is already sufficient, it also simulates the full launch and returns
 * the exact token address. With no allowance, token assignment remains pending until the approval lands. */
export async function previewStableV3Launch(
  publicClient: PublicClient,
  chainId: number,
  rawInput: StableV3LaunchInput,
): Promise<StableV3LaunchPreview> {
  const input = normalizedInput(rawInput);
  const { row, pad, locker, implementation, numeraire, launchFee, launchFeeNative } = stableConfig(chainId);
  const liveChainId = await publicClient.getChainId();
  if (liveChainId !== chainId) throw new Error(`RPC is on chain ${liveChainId}, expected ${chainId}.`);

  await Promise.all([
    assertRuntimeHash(publicClient, implementation, row.launchpad.implementationCodeHash, "Token implementation"),
    assertRuntimeHash(publicClient, pad, row.launchpad.padCodeHash, "Stable V3 pad"),
    assertRuntimeHash(publicClient, locker, row.launchpad.lockerCodeHash, "Stable V3 fee locker"),
  ]);

  const [
    padImpl,
    padLocker,
    lockerFactory,
    padFactory,
    padPositionManager,
    padNumeraire,
    padDecimals,
    padFeeTier,
    feeAsset,
    feeAmount,
    feeNative,
    maxWalletBps,
    maxWalletWindow,
    tokenBalance,
    tokenAllowance,
  ] = await Promise.all([
    publicClient.readContract({ address: pad, abi: stableV3PadAbi, functionName: "IMPL" }),
    publicClient.readContract({ address: pad, abi: stableV3PadAbi, functionName: "LOCKER" }),
    publicClient.readContract({ address: locker, abi: stableV3LockerAbi, functionName: "FACTORY" }),
    publicClient.readContract({ address: pad, abi: stableV3PadAbi, functionName: "V3_FACTORY" }),
    publicClient.readContract({ address: pad, abi: stableV3PadAbi, functionName: "POSITION_MANAGER" }),
    publicClient.readContract({ address: pad, abi: stableV3PadAbi, functionName: "NUMERAIRE" }),
    publicClient.readContract({ address: pad, abi: stableV3PadAbi, functionName: "NUMERAIRE_DECIMALS" }),
    publicClient.readContract({ address: pad, abi: stableV3PadAbi, functionName: "FEE_TIER" }),
    publicClient.readContract({ address: pad, abi: stableV3PadAbi, functionName: "LAUNCH_FEE_ASSET" }),
    publicClient.readContract({ address: pad, abi: stableV3PadAbi, functionName: "LAUNCH_FEE_AMOUNT" }),
    publicClient.readContract({ address: pad, abi: stableV3PadAbi, functionName: "LAUNCH_FEE_NATIVE" }),
    publicClient.readContract({ address: pad, abi: stableV3PadAbi, functionName: "MAX_WALLET_BPS" }),
    publicClient.readContract({ address: pad, abi: stableV3PadAbi, functionName: "MAX_WALLET_WINDOW_SECS" }),
    publicClient.readContract({ address: numeraire, abi: stableUsdt0Abi, functionName: "balanceOf", args: [input.creator] }),
    publicClient.readContract({ address: numeraire, abi: stableUsdt0Abi, functionName: "allowance", args: [input.creator, pad] }),
  ]);

  const bindingMismatch =
    padImpl.toLowerCase() !== implementation.toLowerCase()
    || padLocker.toLowerCase() !== locker.toLowerCase()
    || lockerFactory.toLowerCase() !== pad.toLowerCase()
    || padFactory.toLowerCase() !== row.v3Factory.toLowerCase()
    || padPositionManager.toLowerCase() !== row.positionManager.toLowerCase()
    || padNumeraire.toLowerCase() !== numeraire.toLowerCase()
    || Number(padDecimals) !== row.numeraire.decimals
    || Number(padFeeTier) !== row.feeTier
    || feeAsset.toLowerCase() !== (launchFeeNative ? ZERO_ADDRESS : numeraire).toLowerCase()
    || feeAmount !== launchFee
    || feeNative !== launchFeeNative
    || maxWalletBps !== 200n
    || maxWalletWindow !== 600n;
  if (bindingMismatch) throw new Error("V3 deployment configuration no longer matches the verified manifest.");
  const balance = launchFeeNative
    ? await publicClient.getBalance({ address: input.creator })
    : tokenBalance;
  const allowance = launchFeeNative ? feeAmount : tokenAllowance;
  if (balance < feeAmount) {
    const feeSymbol = launchFeeNative ? row.nativeSymbol : row.numeraire.symbol;
    throw new Error(
      `You need ${formatUnits(feeAmount, launchFeeNative ? 18 : row.numeraire.decimals)} ${feeSymbol} to launch; wallet balance is ${formatUnits(balance, launchFeeNative ? 18 : row.numeraire.decimals)} ${feeSymbol}.`,
    );
  }

  const needsApproval = allowance < feeAmount;
  if (needsApproval) {
    return { feeAmount, balance, allowance, needsApproval, tokenAddress: null, tokenId: null };
  }

  const simulation = await publicClient.simulateContract({
    address: pad,
    abi: stableV3PadAbi,
    functionName: "launch",
    args: [input.name, input.symbol, input.salt],
    account: input.creator,
    value: launchFeeNative ? feeAmount : undefined,
  });
  const [tokenAddress, tokenId] = simulation.result;
  return { feeAmount, balance, allowance, needsApproval, tokenAddress, tokenId };
}

async function waitForEffect(publicClient: PublicClient, hash: Hash, label: string) {
  let replacedReason: ReplacedReason | null = null;
  const receipt = await publicClient.waitForTransactionReceipt({
    hash,
    onReplaced: (replacement) => {
      replacedReason = replacement.reason as ReplacedReason;
    },
  });
  if (!isClaimConfirmed(receipt.status, replacedReason)) {
    if (replacedReason === "cancelled") throw new Error(`${label} was cancelled.`);
    if (replacedReason === "replaced") throw new Error(`${label} was replaced by a different transaction.`);
    throw new Error(`${label} reverted on-chain.`);
  }
  return receipt;
}

export async function executeStableV3Launch(
  publicClient: PublicClient,
  walletClient: WalletClient,
  chainId: number,
  rawInput: StableV3LaunchInput,
  onStep?: (step: StableV3LaunchStep) => void,
): Promise<StableV3LaunchResult> {
  const input = normalizedInput(rawInput);
  const { pad, numeraire, launchFeeNative } = stableConfig(chainId);
  const account = input.creator;

  const firstPreview = await previewStableV3Launch(publicClient, chainId, input);
  if (!launchFeeNative && firstPreview.needsApproval) {
    onStep?.("approve");
    const approvalHash = await walletClient.writeContract({
      address: numeraire,
      abi: stableUsdt0Abi,
      functionName: "approve",
      args: [pad, firstPreview.feeAmount],
      account,
      chain: walletClient.chain,
    });
    onStep?.("approve-confirm");
    await waitForEffect(publicClient, approvalHash, "USDT0 approval");
  }

  // Simulate after the approval is mined, so the exact launch call is proven against current mainnet state.
  onStep?.("launch");
  const simulation = await publicClient.simulateContract({
    address: pad,
    abi: stableV3PadAbi,
    functionName: "launch",
    args: [input.name, input.symbol, input.salt],
    account,
    value: launchFeeNative ? firstPreview.feeAmount : undefined,
  });
  const launchHash = await walletClient.writeContract(simulation.request);
  onStep?.("launch-confirm");
  const receipt = await waitForEffect(publicClient, launchHash, "Token launch");

  const events = parseEventLogs({
    abi: stableV3PadAbi,
    eventName: "LaunchCreated",
    logs: receipt.logs,
  });
  const created = events[0];
  if (!created) throw new Error("Launch confirmed, but the LaunchCreated event was missing.");

  return {
    tokenAddress: created.args.token,
    poolAddress: created.args.pool,
    tokenId: created.args.tokenId,
    transactionHash: launchHash,
  };
}
