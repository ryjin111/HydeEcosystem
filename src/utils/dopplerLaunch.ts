import type { Address, PublicClient, WalletClient } from "viem";
import { parseEther } from "viem";
import {
  DopplerSDK,
  MulticurveBuilder,
  getAddresses,
  type CreateMulticurveParams,
} from "@whetstone-research/doppler-sdk/evm";

/* ─── Robinhood Chain (4663) Doppler launch lane ─────────────────────────────
 *
 * The ONLY launch recipe that works on 4663 (proven by live mainnet simulate,
 * scripts/launchSmoke.mjs) — every choice below is forced by what Doppler
 * actually deployed on this chain:
 *
 *  • token   = DopplerERC20V1 (the standard DERC20 factory is NOT on 4663)
 *  • pool    = multicurve initialized through the Rehype Doppler Hook
 *              (classic UniswapV4Initializer dynamic auctions revert with
 *              HookAddressNotValid — SDK bytecode/flags skew vs 4663 deploys)
 *  • fees    = decay 3% → 1% over the first hour (snipers pay the top fee),
 *              routed 100% to the beneficiary = the registered creator
 *  • gov     = noOp (no DAO ceremony for launchpad tokens)
 *  • exit    = UniswapV2MigratorSplit — graduation to a real V2 pool
 *
 * Fee/ownership invariant (decision locked in #hydeout): the creator address
 * is registered at launch and is IMMUTABLE — the UI must show and confirm the
 * full address (plus the predicted token address) before submit.
 */

export const ROBINHOOD_CHAIN_ID = 4663 as const;

/** 1B fixed supply @ 18 decimals — the launchpad standard (clint-approved). */
export const LAUNCH_TOTAL_SUPPLY = parseEther("1000000000");
/**
 * 100% of supply goes to the launch curve — nothing pre-minted, nothing held
 * back (pump.fun convention; proven to simulate on 4663). Keeps the supply
 * disclosure trivially honest: "1B total, all on the curve".
 */
export const LAUNCH_TOKENS_FOR_SALE = LAUNCH_TOTAL_SUPPLY;

/** Fee decay: launch trades start at 3%, settle at 1% after the first hour. */
const START_FEE = 30_000; // 3% (V4 fee units, 1e6 = 100%)
const END_FEE = 10_000;   // 1%
const FEE_DECAY_SECONDS = 3_600;

const WAD = 10n ** 18n;

export type RobinhoodLaunchInput = {
  name: string;
  symbol: string;
  /** Optional metadata URI (logo/description JSON). Empty string accepted. */
  tokenURI?: string;
  /** Registered creator / fee recipient — IMMUTABLE after launch. */
  creator: Address;
  /** Optional platform integrator address (protocol fee share). */
  integrator?: Address;
};

export function buildRobinhoodLaunchParams(
  input: RobinhoodLaunchInput
): CreateMulticurveParams<typeof ROBINHOOD_CHAIN_ID> {
  const addresses = getAddresses(ROBINHOOD_CHAIN_ID);
  const rehypeHook = addresses.rehypeDopplerHook;
  if (!rehypeHook) throw new Error("Rehype Doppler Hook not configured for Robinhood Chain");

  const builder = MulticurveBuilder.forChain(ROBINHOOD_CHAIN_ID)
    .tokenConfig({
      type: "dopplerERC20V1",
      name: input.name.trim(),
      symbol: input.symbol.trim(),
      tokenURI: input.tokenURI ?? "",
    })
    .saleConfig({
      initialSupply: LAUNCH_TOTAL_SUPPLY,
      numTokensToSell: LAUNCH_TOKENS_FOR_SALE,
      numeraire: addresses.weth,
    })
    // Curve shape comes from the SDK's tick-based presets — no external price
    // feed involved, so a price-API outage can never block a launch.
    .withMarketCapPresets()
    .withRehypeDopplerHook({
      hookAddress: rehypeHook,
      // Fees route to beneficiary fees (the creator), not buybacks — but the
      // hook requires a buyback destination; the creator receives either way.
      buybackDestination: input.creator,
      feeRoutingMode: "routeToBeneficiaryFees",
      feeDistributionInfo: {
        assetFeesToAssetBuybackWad: 0n,
        assetFeesToNumeraireBuybackWad: 0n,
        assetFeesToBeneficiaryWad: WAD,
        assetFeesToLpWad: 0n,
        numeraireFeesToAssetBuybackWad: 0n,
        numeraireFeesToNumeraireBuybackWad: 0n,
        numeraireFeesToBeneficiaryWad: WAD,
        numeraireFeesToLpWad: 0n,
      },
      startFee: START_FEE,
      endFee: END_FEE,
      durationSeconds: FEE_DECAY_SECONDS,
    })
    .withGovernance({ type: "noOp" })
    .withMigration({ type: "uniswapV2Split" })
    .withUserAddress(input.creator);

  if (input.integrator) builder.withIntegrator(input.integrator);

  return builder.build();
}

function sdkFor(publicClient: PublicClient, walletClient?: WalletClient) {
  return new DopplerSDK({
    publicClient,
    walletClient,
    chainId: ROBINHOOD_CHAIN_ID,
  } as ConstructorParameters<typeof DopplerSDK>[0]);
}

export type RobinhoodLaunchPreview = {
  /** Predicted token address — shown on the confirm screen before gas. */
  tokenAddress: Address;
  poolId: string;
  gasEstimate?: bigint;
};

/** Read-only pre-flight: predicts token address + poolId. No wallet needed. */
export async function simulateRobinhoodLaunch(
  publicClient: PublicClient,
  input: RobinhoodLaunchInput
): Promise<RobinhoodLaunchPreview> {
  const params = buildRobinhoodLaunchParams(input);
  const sim = await sdkFor(publicClient).factory.simulateCreateMulticurve(params);
  return {
    tokenAddress: sim.tokenAddress,
    poolId: sim.poolId,
    gasEstimate: sim.gasEstimate,
  };
}

export type RobinhoodLaunchResult = {
  tokenAddress: Address;
  poolId: string;
  transactionHash: string;
};

/**
 * Simulate-then-execute with the SAME params, so the token address shown on
 * the confirm screen is guaranteed to match the launched token.
 */
export async function executeRobinhoodLaunch(
  publicClient: PublicClient,
  walletClient: WalletClient,
  input: RobinhoodLaunchInput
): Promise<RobinhoodLaunchResult> {
  const params = buildRobinhoodLaunchParams(input);
  const sim = await sdkFor(publicClient, walletClient).factory.simulateCreateMulticurve(params);
  const result = await sim.execute();
  return {
    tokenAddress: result.tokenAddress,
    poolId: result.poolId,
    transactionHash: result.transactionHash,
  };
}
