import type { Address, Hex } from "viem";
import { TEMPO_MODERATO_TOKENS, ROBINHOOD_TESTNET_TOKENS, ROBINHOOD_MAINNET_TOKENS, PHAROS_ATLANTIC_TOKENS, INK_TOKENS, OPTIMISM_TOKENS, ETHEREUM_TOKENS, UNICHAIN_TOKENS, BNB_TOKENS, XLAYER_TOKENS } from "../tokens";

export type TokenInfo = {
  symbol: string;
  name: string;
  address: Address;
  decimals: number;
  /** URL to a token logo image. Put files in /public/tokens/<symbol>.svg or <address>.png */
  logoURI?: string;
  /** True for the chain's native currency (ETH). No approval needed; sent as msg.value. */
  isNative?: boolean;
  /** Set for tokens launched via Doppler. Drives swap routing. */
  dopplerPool?: {
    /** 'v4' = in-auction (V4 hook pool), 'v2' = graduated (Uniswap V2 pair) */
    type: "v4" | "v2";
    /** For V4 pools: hook address used in the PoolKey (Doppler V4Initializer). */
    hookAddress?: Address;
  };
};

export type NetworkConfig = {
  id: number;
  name: string;
  rpcUrl: string;
  wssUrl?: string;
  explorerUrl: string;
  currencySymbol: string;
  factory: Address;
  router: Address;
  /** Router for Doppler-graduated (V2) tokens — uses Doppler's factory (standard Uni V2 hash). */
  dopplerRouter?: Address;
  /** WETH address used by the router for native ETH pairs. */
  weth: Address;
  /** Official token list for this chain. Users can add extra tokens via the custom token flow. */
  tokens: TokenInfo[];
};

export type V4Contracts = {
  poolManager: Address;
  universalRouter: Address;
  quoter: Address;
  positionManager: Address;
  permit2: Address;
  gateway: Address;
  /** HydeTokenFactory address — present only on chains where it's deployed */
  hydeTokenFactory?: Address;
  /** HOODIE launcher-launcher: the meta-factory (mints launchers) + the shared engine (reads/events). */
  hoodieMetaFactory?: Address;
  hoodieEngine?: Address;
  /** The ONE shared HoodieLauncher every creator launches through (clint 23752 — single-tx, no per-user deploy). */
  hoodieSharedLauncher?: Address;
  /** Canonical StateView (read-only V4 pool state) — the chain's read source. */
  stateView?: Address;
  /** The shared HydeHook every HOODIE-numeraire pool is keyed on (anti-snipe fee decay + launch reads). */
  hoodieHook?: Address;
  /** The $HOODIE numeraire token every HOODIE launch pairs against (pool currency1). */
  hoodieNumeraire?: Address;
};

/** The two fixed PoolKey fields shared by every HOODIE-numeraire launch pool (verified on-chain via
 *  hook.active(poolId) — a wrong fee/tick would not resolve the live pool). Dynamic-fee flag + tick 60. */
export const HYDE_DYNAMIC_FEE = 0x800000;
export const HYDE_TICK_SPACING = 60;

export type V4EncodingTemplates = {
  swapCommand: Hex;
  sweepCommand: Hex;
  permit2PermitCommand: Hex;
  swapInputAbi: string;
  addLiquidityInputAbi: string;
  removeLiquidityInputAbi: string;
};

// Replace these with deployed addresses per network.
const PLACEHOLDER_FACTORY = "0x000000000000000000000000000000000000fAc7" as Address;
const PLACEHOLDER_ROUTER = "0x000000000000000000000000000000000000aAA1" as Address;
const PLACEHOLDER_WETH = "0x0000000000000000000000000000000000000000" as Address;

export const TEMPO_MODERATO: NetworkConfig = {
  id: 42431,
  name: "Tempo Moderato Testnet",
  rpcUrl: "https://rpc.moderato.tempo.xyz",
  explorerUrl: "https://moderato.tempo.xyz",
  currencySymbol: "USD",
  factory: PLACEHOLDER_FACTORY,
  router: PLACEHOLDER_ROUTER,
  weth: PLACEHOLDER_WETH,
  tokens: TEMPO_MODERATO_TOKENS,
};

export const ROBINHOOD_TESTNET: NetworkConfig = {
  id: 46630,
  name: "Robinhood Testnet",
  rpcUrl: "https://rpc.testnet.chain.robinhood.com",
  explorerUrl: "https://explorer.testnet.chain.robinhood.com",
  currencySymbol: "ETH",
  // LIVE Hyde OWN-STACK factory (deployed 46630). The launchpad reads its LaunchCreated events here —
  // this is our own contracts, NOT Doppler. (mainnet still rides the Doppler rail until its own deploy.)
  factory: "0x6607BE76A0F8C44AadB5DF3bb13AcD29fb3Ade2C" as Address,
  router: PLACEHOLDER_ROUTER,
  weth: "0x7943e237c7F95DA44E0301572D358911207852Fa",
  tokens: ROBINHOOD_TESTNET_TOKENS,
};

// Robinhood Chain Mainnet — chain id 4663 (0x1237), verified live via eth_chainId 2026-07-03.
// WETH verified on-chain (UniswapV2MigratorSplit.weth() + symbol/name check).
export const ROBINHOOD_MAINNET: NetworkConfig = {
  id: 4663,
  name: "Robinhood Chain",
  rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
  explorerUrl: "https://robinhoodchain.blockscout.com",
  currencySymbol: "ETH",
  factory: PLACEHOLDER_FACTORY,   // no V2 factory needed — launches go via Doppler / V4
  router: PLACEHOLDER_ROUTER,
  weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  tokens: ROBINHOOD_MAINNET_TOKENS,
};

export const PHAROS_ATLANTIC_TESTNET: NetworkConfig = {
  id: 688689,
  name: "Pharos Atlantic Testnet",
  rpcUrl: "https://atlantic.dplabs-internal.com",
  wssUrl: "wss://atlantic.dplabs-internal.com",
  explorerUrl: "https://atlantic.pharosscan.xyz/",
  currencySymbol: "USD",
  factory: PLACEHOLDER_FACTORY,
  router: PLACEHOLDER_ROUTER,
  weth: PLACEHOLDER_WETH,
  tokens: PHAROS_ATLANTIC_TOKENS,
};

export const INK_MAINNET: NetworkConfig = {
  id: 57073,
  name: "Ink",
  rpcUrl: "https://rpc-gel.inkonchain.com",
  explorerUrl: "https://explorer.inkonchain.com",
  currencySymbol: "ETH",
  factory: "0xA0E8D06bD1D1B25de55D3fDc6a2F7B1A030ca25B" as Address,
  router: "0xd3B8A589897990d554911a22eCBd748ed088D002" as Address,
  dopplerRouter: "0x936cc31Ce3D0e0abcD76ED29851Ab8bC5f8bEFf9" as Address,
  weth: "0x4200000000000000000000000000000000000006",
  tokens: INK_TOKENS,
};

export const UNICHAIN_MAINNET: NetworkConfig = {
  id: 130,
  name: "Unichain",
  rpcUrl: "https://mainnet.unichain.org",
  explorerUrl: "https://unichain.blockscout.com",
  currencySymbol: "ETH",
  factory: PLACEHOLDER_FACTORY,   // no V2 factory needed — Doppler tokens use V4
  router: PLACEHOLDER_ROUTER,
  weth: "0x4200000000000000000000000000000000000006" as Address,
  tokens: UNICHAIN_TOKENS,
};

// ─── Multichain trade-venue candidates (clint 23047 → kami 23065: curated
// chain-scoped markets + native V4 trade). NOT in the NETWORKS array — a chain
// reaches the switcher only through the capability registry (chainRegistry.ts),
// which derives selectability fail-closed from complete config + retained smoke
// evidence. Every address below was verified on-chain by scripts/chainverify.mjs
// (2026-07-20): eth_getCode ≠ 0x, poolManager() cross-checked from
// StateView+Quoter+PositionManager, router bytecode embeds PoolManager+Permit2.

export const ETHEREUM_MAINNET: NetworkConfig = {
  id: 1,
  name: "Ethereum",
  rpcUrl: "https://ethereum-rpc.publicnode.com",
  explorerUrl: "https://etherscan.io",
  currencySymbol: "ETH",
  factory: PLACEHOLDER_FACTORY,   // no V2 factory — trade venue is V4-only
  router: PLACEHOLDER_ROUTER,
  weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as Address,
  tokens: ETHEREUM_TOKENS,
};

export const BNB_MAINNET: NetworkConfig = {
  id: 56,
  name: "BNB Smart Chain",
  rpcUrl: "https://bsc-rpc.publicnode.com",
  explorerUrl: "https://bscscan.com",
  currencySymbol: "BNB",
  factory: PLACEHOLDER_FACTORY,
  router: PLACEHOLDER_ROUTER,
  weth: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c" as Address, // WBNB — the chain's wrapped native
  tokens: BNB_TOKENS,
};

export const XLAYER_MAINNET: NetworkConfig = {
  id: 196,
  name: "X Layer",
  rpcUrl: "https://rpc.xlayer.tech",
  explorerUrl: "https://www.oklink.com/x-layer",
  currencySymbol: "OKB",
  factory: PLACEHOLDER_FACTORY,
  router: PLACEHOLDER_ROUTER,
  weth: "0xe538905cf8410324e03A5A23C1c177a474D59b2b" as Address, // WOKB — the chain's wrapped native
  tokens: XLAYER_TOKENS,
};

export const OPTIMISM_MAINNET: NetworkConfig = {
  id: 10,
  name: "Optimism",
  rpcUrl: "https://mainnet.optimism.io",
  explorerUrl: "https://optimistic.etherscan.io",
  currencySymbol: "ETH",
  factory: PLACEHOLDER_FACTORY,   // no V2 factory needed — Hyde tokens use V4 only
  router: PLACEHOLDER_ROUTER,     // no V2 router needed — swaps go via HydeV4Gateway
  weth: "0x4200000000000000000000000000000000000006" as Address,
  tokens: OPTIMISM_TOKENS,
};

export const NETWORKS: NetworkConfig[] = [
  ROBINHOOD_MAINNET,
  ROBINHOOD_TESTNET,    // LIVE own-stack sandbox (46630) — board reads our factory's LaunchCreated
  // OPTIMISM_MAINNET,  // legacy lane retired 2026-07-03 — Hydeout is Robinhood-only
  // INK_MAINNET,       // hidden — multichain later
  // UNICHAIN_MAINNET,  // dropped
  // TEMPO_MODERATO,
  // PHAROS_ATLANTIC_TESTNET,
];

const PLACEHOLDER_V4_POOL_MANAGER = "0x000000000000000000000000000000000000beef" as Address;
const PLACEHOLDER_V4_UNIVERSAL_ROUTER = "0x000000000000000000000000000000000000cafe" as Address;
const PLACEHOLDER_V4_QUOTER = "0x000000000000000000000000000000000000f00d" as Address;
const PLACEHOLDER_V4_POSITION_MANAGER = "0x000000000000000000000000000000000000babe" as Address;
const PLACEHOLDER_V4_PERMIT2 = "0x000000000000000000000000000000000000d00d" as Address;
const PLACEHOLDER_V4_GATEWAY = "0x000000000000000000000000000000000000Da7a" as Address;

export const V4_CONTRACTS_BY_CHAIN: Record<number, V4Contracts> = {
  [TEMPO_MODERATO.id]: {
    poolManager: PLACEHOLDER_V4_POOL_MANAGER,
    universalRouter: PLACEHOLDER_V4_UNIVERSAL_ROUTER,
    quoter: PLACEHOLDER_V4_QUOTER,
    positionManager: PLACEHOLDER_V4_POSITION_MANAGER,
    permit2: PLACEHOLDER_V4_PERMIT2,
    gateway: PLACEHOLDER_V4_GATEWAY
  },
  // Robinhood Testnet (46630) — canonical Uniswap V4 core (same deterministic addresses as
  // mainnet 4663), verified on-chain by gojo. The Hyde own-stack (factory/hook/vault/collector/
  // StateView) is separately deployed at fresh 46630 addresses — see ROBINHOOD_TESTNET.factory
  // and ROBINHOOD_TESTNET_STATE_VIEW below.
  [ROBINHOOD_TESTNET.id]: {
    poolManager:      "0x8366a39CC670B4001A1121B8F6A443A643e40951" as Address,
    universalRouter:  "0x8876789976dEcBfCbBbe364623C63652db8C0904" as Address,
    quoter:           PLACEHOLDER_V4_QUOTER, // V4Quoter not deployed on 46630 — quotes degrade to StateView reads
    positionManager:  "0x58daec3116aae6D93017bAAea7749052E8a04fA7" as Address,
    permit2:          "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address,
    gateway:          PLACEHOLDER_V4_GATEWAY, // no HydeV4Gateway on testnet — swaps route via the canonical UniversalRouter (above)
    hydeTokenFactory: "0x6607BE76A0F8C44AadB5DF3bb13AcD29fb3Ade2C" as Address,
  },
  [PHAROS_ATLANTIC_TESTNET.id]: {
    poolManager: PLACEHOLDER_V4_POOL_MANAGER,
    universalRouter: PLACEHOLDER_V4_UNIVERSAL_ROUTER,
    quoter: PLACEHOLDER_V4_QUOTER,
    positionManager: PLACEHOLDER_V4_POSITION_MANAGER,
    permit2: PLACEHOLDER_V4_PERMIT2,
    gateway: PLACEHOLDER_V4_GATEWAY
  },
  // Ink Mainnet — real Uniswap V4 deployments (re-verified by chainverify.mjs 2026-07-20:
  // getCode + poolManager() cross-checks + router-bytecode immutables, official-page match)
  [INK_MAINNET.id]: {
    poolManager: "0x360e68faccca8ca495c1b759fd9eee466db9fb32" as Address,
    universalRouter: "0x112908dac86e20e7241b0927479ea3bf935d1fa0" as Address,
    quoter: "0x3972c00f7ed4885e145823eb7c655375d275a1c5" as Address,
    positionManager: "0x1b35d13a2e2528f192637f14b05f0dc0e7deb566" as Address,
    permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address,
    gateway: "0x21d6Ce25aa1AB3F59eE51b7693A596C6d39A03C9" as Address,
    stateView: "0x76fd297e2d437cd7f76d50f01afe6160f86e9990" as Address,
  },
  // Robinhood Chain Mainnet (4663) — canonical Uniswap V4, every address verified on-chain 2026-07-03:
  //   eth_getCode ≠ 0x on all, and poolManager() cross-checked identical from SIX contracts
  //   (UniswapV4Initializer, DopplerLensQuoter, UniversalRouter, Quoter, PositionManager, StateView).
  //   universalRouter from Bundler.router(); positionManager/stateView are Blockscout-verified sources;
  //   PositionManager.permit2() → canonical Permit2.
  [ROBINHOOD_MAINNET.id]: {
    poolManager:     "0x8366a39CC670B4001A1121B8F6A443A643e40951" as Address,
    universalRouter: "0x8876789976dEcBfCbBbe364623C63652db8C0904" as Address,
    quoter:          "0x7232686FC954f12079cadFC5e9F755a9fEAeb3Ca" as Address,
    positionManager: "0x58daec3116aae6D93017bAAea7749052E8a04fA7" as Address,
    permit2:         "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address,
    gateway:         PLACEHOLDER_V4_GATEWAY, // HydeV4Gateway not yet deployed on 4663 — Foundry deploy needs clint's key
    // LIVE Hyde own-stack WETH factory on 4663 mainnet — REDEPLOYED 2026-07-24 (numeraire-aware $5k
    // preset, audited 08d99a7, kuro broadcast). Supersedes the broken 0x710fEa…509f ($1.9T-bug factory).
    hydeTokenFactory: "0x159A2fa37427299466B0723713eaa260e6124cbc" as Address,
    // LIVE HOODIE launcher-launcher on 4663 mainnet (deployed 2026-07-21, kami 23624).
    hoodieMetaFactory: "0x101Fe0c0328De00F6F6f928B79d512E899fE2fC0" as Address,
    hoodieEngine:      "0x8062951c99CfFA5365f979D5139Cf96b5c77CFCc" as Address,
    // The single shared HoodieLauncher (clint 23752/23771; kami 23767/23769) — the EXISTING registered
    // launcher clint used to launch LILHOODIE, owned by the Hydeout deployer + allowlisted in the engine.
    // Reused as-is (no second mint). `launch` is permissionless → every creator launches through it in ONE
    // tx, and the engine attributes the ACTUAL caller as the creator.
    hoodieSharedLauncher: "0x004E6Fa435757B80adB17ADd67524CcAF4c4305B" as Address,
    stateView:       "0xF3334192D15450CdD385c8B70e03f9A6bD9E673b" as Address, // == ROBINHOOD_STATE_VIEW
    // Shared HydeHook + $HOODIE numeraire for every HOODIE-paired launch (gojo 23855; verified live —
    // hook.active(poolId) resolves LILHOODIE against exactly these). The swap card keys HOODIE pools off these.
    hoodieHook:      "0x41078B0012751e7E646DF9B6607e6C4fF8B570C0" as Address,
    hoodieNumeraire: "0xC72c01AAB5f5678dc1d6f5C6d2B417d91D402Ba3" as Address,
  },
  // Optimism Mainnet — Uniswap V4 (re-verified by chainverify.mjs 2026-07-20)
  [10]: {
    poolManager:      "0x9a13F98Cb987694C9F086b1F5eB990EeA8264Ec3" as Address,
    universalRouter:  "0x851116D9223fabED8E56C0E6b8Ad0c31d98B3507" as Address,
    quoter:           "0x1f3131a13296fb91c90870043742c3cdbff1a8d7" as Address,
    positionManager:  "0x3C3Ea4B57a46241e54610e5f022E5c45859A1017" as Address,
    permit2:          "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address,
    gateway:          "0x21d6Ce25aa1AB3F59eE51b7693A596C6d39A03C9" as Address,
    hydeTokenFactory: "0x9532Dc6534122443a0C14F0Ec6407447f262fF42" as Address,
    stateView:        "0xc18a3169788f4f75a170290584eca6395c75ecdb" as Address,
  },
  // ── The 4 net-new trade-venue chains (kami 23065). Every address verified
  // on-chain by scripts/chainverify.mjs 2026-07-20 (49/49 after correcting
  // Unichain Tether's label to its on-chain symbol USD₮0). Gateways are
  // placeholders: no execution path here yet — the registry keeps these chains
  // un-selectable until kami's gateway-vs-direct-router decision lands. ──
  [ETHEREUM_MAINNET.id]: {
    poolManager:     "0x000000000004444c5dc75cB358380D2e3dE08A90" as Address,
    universalRouter: "0x66a9893cc07d91d95644aedd05d03f95e1dba8af" as Address,
    quoter:          "0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203" as Address,
    positionManager: "0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e" as Address,
    permit2:         "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address,
    gateway:         PLACEHOLDER_V4_GATEWAY,
    stateView:       "0x7ffe42c4a5deea5b0fec41c94c136cf115597227" as Address,
  },
  [UNICHAIN_MAINNET.id]: {
    poolManager:     "0x1f98400000000000000000000000000000000004" as Address,
    universalRouter: "0xef740bf23acae26f6492b10de645d6b98dc8eaf3" as Address,
    quoter:          "0x333e3c607b141b18ff6de9f258db6e77fe7491e0" as Address,
    positionManager: "0x4529a01c7a0410167c5740c487a8de60232617bf" as Address,
    permit2:         "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address,
    gateway:         PLACEHOLDER_V4_GATEWAY,
    stateView:       "0x86e8631a016f9068c3f085faf484ee3f5fdee8f2" as Address,
  },
  [BNB_MAINNET.id]: {
    poolManager:     "0x28e2ea090877bf75740558f6bfb36a5ffee9e9df" as Address,
    universalRouter: "0x1906c1d672b88cd1b9ac7593301ca990f94eae07" as Address,
    quoter:          "0x9f75dd27d6664c475b90e105573e550ff69437b0" as Address,
    positionManager: "0x7a4a5c919ae2541aed11041a1aeee68f1287f95b" as Address,
    permit2:         "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address,
    gateway:         PLACEHOLDER_V4_GATEWAY,
    stateView:       "0xd13dd3d6e93f276fafc9db9e6bb47c1180aee0c4" as Address,
  },
  [XLAYER_MAINNET.id]: {
    poolManager:     "0x360e68faccca8ca495c1b759fd9eee466db9fb32" as Address,
    universalRouter: "0xda00ae15d3a71466517129255255db7c0c0956d3" as Address,
    quoter:          "0x8928074ca1b241d8ec02815881c1af11e8bc5219" as Address,
    positionManager: "0xcf1eafc6928dc385a342e7c6491d371d2871458b" as Address,
    permit2:         "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address,
    gateway:         PLACEHOLDER_V4_GATEWAY,
    stateView:       "0x76fd297e2d437cd7f76d50f01afe6160f86e9990" as Address,
  },
};

/** True once the HydeV4Gateway is actually deployed on the chain — the swap lane
 *  stays honestly disabled until then (no submitting swaps to a placeholder). */
export function isGatewayLive(chainId: number): boolean {
  const gateway = V4_CONTRACTS_BY_CHAIN[chainId]?.gateway;
  return !!gateway && gateway !== PLACEHOLDER_V4_GATEWAY;
}

/** Doppler protocol deployment on a chain — drives the token-launch (launchpad) flow. */
export type DopplerContracts = {
  airlock: Address;
  bundler: Address;
  dopplerDeployer: Address;
  tokenFactory: Address;
  uniswapV4Initializer: Address;
  dopplerLensQuoter: Address;
  governanceFactory: Address;
  noOpGovernanceFactory: Address;
  noOpMigrator: Address;
  streamableFeesLockerV2: Address;
  uniswapV2MigratorSplit: Address;
};

// Robinhood Chain Mainnet (4663) Doppler stack.
// Source: docs.doppler.lol contract-addresses page, cross-checked byte-identical against
// @whetstone-research/doppler-sdk@1.0.27 address map; key contracts eth_getCode-verified on-chain 2026-07-03.
export const DOPPLER_CONTRACTS_BY_CHAIN: Record<number, DopplerContracts> = {
  [ROBINHOOD_MAINNET.id]: {
    airlock:                "0xeb7C034704eF8Dcd2D32324c1545f62fB4aD0862" as Address,
    bundler:                "0xEdE0B5fae363232c396724Fa962250Fa197cc5a1" as Address,
    dopplerDeployer:        "0x4389AD34938B14F25cff7ED983c53f5a42A2573f" as Address,
    tokenFactory:           "0x1B37D3a72082029c44B35B604Ea473617580b69a" as Address, // DopplerERC20V1Factory
    uniswapV4Initializer:   "0x6cce158B6D1747617fc218592B4D60B239B957ea" as Address,
    dopplerLensQuoter:      "0xf4c22465532f64777FfcD7770831AEca38F35c04" as Address,
    governanceFactory:      "0xDeb0447DAE3EB177c4dbA8bBCCCa25c8F273B7ef" as Address,
    noOpGovernanceFactory:  "0x85f37f74Ef2478A770318bc810177a9835911aD7" as Address,
    noOpMigrator:           "0xba2F330EDb16cD8056f5988d8CE19BbC63475A0e" as Address,
    streamableFeesLockerV2: "0x7B6147AC3F615bdb764e7EbD5f517dac1AD163B8" as Address,
    uniswapV2MigratorSplit: "0xB05046cEa797c993FB5b583098B1c4682e9Da333" as Address,
  },
};

/** StateView (read-only V4 pool state) on Robinhood mainnet — Blockscout-verified, poolManager() cross-checked. */
export const ROBINHOOD_STATE_VIEW = "0xF3334192D15450CdD385c8B70e03f9A6bD9E673b" as Address;

/** StateView on Robinhood Testnet (46630) — part of the fresh 0.0004-ETH own-stack deploy (block 91418522).
 *  Used for pool reads + quote fallback where the canonical V4Quoter isn't deployed on this chain. MUST
 *  track ROBINHOOD_TESTNET.factory on any redeploy — the old StateView cannot quote the new pool. */
export const ROBINHOOD_TESTNET_STATE_VIEW = "0x81d5A6B7433420F7011612771eA74Ef71e239206" as Address;

/** HydeFeeVault on Robinhood Testnet (46630) — part of the fresh 0.0004-ETH own-stack deploy (block
 *  91418522). Source of the creator's claimable WETH (`creatorClaimable(token)`) for "My Launches".
 *  MUST track ROBINHOOD_TESTNET.factory on any redeploy. */
export const ROBINHOOD_TESTNET_VAULT = "0xF6318a4C874E9D2EBE627B05A247AD9d6401731C" as Address;

/** HydeFeeVault addresses on 4663 mainnet (gojo 23892 / kami 23894). Creator fees settle here in the
 *  vault's SETTLEMENT_TOKEN — $HOODIE for the HOODIE stack, WETH for the WETH stack. `claimCreator(token)`
 *  always pays the immutable on-chain `creator[token]`. */
export const MAINNET_HOODIE_FEE_VAULT = "0x1ee72dCb5a18ddcC069e4E604Ba59ac5a0930DB4" as Address;
export const MAINNET_WETH_FEE_VAULT = "0x02Ce83859BEa69d248973Aa4beE09D7e12Ed0227" as Address; // REDEPLOYED 2026-07-24 (new $5k WETH stack; old 0x04C204…D791 retired w/ broken factory)
/** HydeFeeCollector for the 4663 HOODIE stack (gojo 23892/23899). `collect(token)` harvests accrued V4
 *  fees into the vault as `rawFees` (permissionless, swap-free, no oracle). */
export const MAINNET_HOODIE_FEE_COLLECTOR = "0x08610aE598a24799e1843C683695B0Fc63b1bd6f" as Address;

/** Fee split — creator gets 90 of the 95% net remainder (5% Hyde), the other 5% is retained in-kind as
 *  locked LP at collect. So settled creator claimable ≈ rawFees × 9000/9500 (gojo: rawH 1049.82 → 994.61). */
export const HYDE_CREATOR_BPS = 9000n;
export const HYDE_NET_BPS = 9500n;

/** HydeFeeCollector surface — the permissionless, swap-free, oracle-free harvest of accrued V4 fees into
 *  the vault (gojo 23892). Reverts only UNKNOWN; sims green even at 0. */
export const hydeCollectorAbi = [
  { type: "function", name: "collect", stateMutability: "nonpayable", inputs: [{ name: "token", type: "address" }], outputs: [] },
] as const;

/** HydeFeeVault surface — per-token creator-claimable + rawFees getters, the safe harvest (`claimCreator`
 *  sends `creatorClaimable[token]` to the immutable `creator[token]`, reverts only `NOTHING`), and `settle`
 *  (splits a raw leg 90 creator / 5 Hyde into creatorClaimable; numeraire leg is a pure reclassification —
 *  ungated, callerMinOut 0; the LT leg is the system's only swap: TWAP-floored + deviation-gated, so a
 *  caller-derived nonzero minOut only adds protection — gojo 23892/23904). */
export const hydeVaultAbi = [
  { type: "function", name: "creatorClaimable", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "rawFees", stateMutability: "view", inputs: [{ name: "token", type: "address" }, { name: "asset", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "claimCreator", stateMutability: "nonpayable", inputs: [{ name: "token", type: "address" }], outputs: [] },
  { type: "function", name: "settle", stateMutability: "nonpayable", inputs: [{ name: "token", type: "address" }, { name: "asset", type: "address" }, { name: "amountIn", type: "uint256" }, { name: "callerMinOut", type: "uint256" }, { name: "deadline", type: "uint256" }], outputs: [] },
] as const;

// Template encoding config for auto payload generation.
// Adjust ABI parameter lists and command byte to match your deployed V4 periphery.
export const V4_ENCODING_TEMPLATES: V4EncodingTemplates = {
  swapCommand: "0x10",
  sweepCommand: "0x04",
  permit2PermitCommand: "0x0a",
  // Outer envelope: (packed actions bytes, per-action params array)
  swapInputAbi: "bytes,bytes[]",
  // Outer envelope for add-liquidity multicall: poolKeyEncoded, ticks, amounts, mins, recipient
  addLiquidityInputAbi: "bytes,int24,int24,uint256,uint256,uint256,uint256,address",
  // Remove-liquidity: tokenId, liquidity, amount0Min, amount1Min, recipient
  removeLiquidityInputAbi: "uint256,uint128,uint256,uint256,address"
};

export const routerAbi = [
  {
    type: "function",
    name: "getAmountsOut",
    stateMutability: "view",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "path", type: "address[]" }
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }]
  },
  {
    type: "function",
    name: "swapExactTokensForTokens",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" }
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }]
  },
  {
    type: "function",
    name: "addLiquidity",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tokenA", type: "address" },
      { name: "tokenB", type: "address" },
      { name: "amountADesired", type: "uint256" },
      { name: "amountBDesired", type: "uint256" },
      { name: "amountAMin", type: "uint256" },
      { name: "amountBMin", type: "uint256" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" }
    ],
    outputs: [
      { name: "amountA", type: "uint256" },
      { name: "amountB", type: "uint256" },
      { name: "liquidity", type: "uint256" }
    ]
  },
  {
    type: "function",
    name: "removeLiquidity",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tokenA", type: "address" },
      { name: "tokenB", type: "address" },
      { name: "liquidity", type: "uint256" },
      { name: "amountAMin", type: "uint256" },
      { name: "amountBMin", type: "uint256" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" }
    ],
    outputs: [
      { name: "amountA", type: "uint256" },
      { name: "amountB", type: "uint256" }
    ]
  },
  {
    type: "function",
    name: "swapExactETHForTokens",
    stateMutability: "payable",
    inputs: [
      { name: "amountOutMin", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" }
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }]
  },
  {
    type: "function",
    name: "swapExactTokensForETH",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" }
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }]
  },
  {
    type: "function",
    name: "addLiquidityETH",
    stateMutability: "payable",
    inputs: [
      { name: "token", type: "address" },
      { name: "amountTokenDesired", type: "uint256" },
      { name: "amountTokenMin", type: "uint256" },
      { name: "amountETHMin", type: "uint256" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" }
    ],
    outputs: [
      { name: "amountToken", type: "uint256" },
      { name: "amountETH", type: "uint256" },
      { name: "liquidity", type: "uint256" }
    ]
  },
  {
    type: "function",
    name: "removeLiquidityETH",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "liquidity", type: "uint256" },
      { name: "amountTokenMin", type: "uint256" },
      { name: "amountETHMin", type: "uint256" },
      { name: "to", type: "address" },
      { name: "deadline", type: "uint256" }
    ],
    outputs: [
      { name: "amountToken", type: "uint256" },
      { name: "amountETH", type: "uint256" }
    ]
  }
] as const;

export const factoryAbi = [
  {
    type: "function",
    name: "getPair",
    stateMutability: "view",
    inputs: [
      { name: "tokenA", type: "address" },
      { name: "tokenB", type: "address" }
    ],
    outputs: [{ name: "pair", type: "address" }]
  }
] as const;

export const erc20Abi = [
  {
    type: "function",
    name: "name",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }]
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }]
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }]
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "uint256" }]
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" }
    ],
    outputs: [{ type: "uint256" }]
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" }
    ],
    outputs: [{ type: "bool" }]
  },
  {
    type: "function",
    name: "totalSupply",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }]
  }
] as const;

export const v4QuoterAbi = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          {
            name: "poolKey",
            type: "tuple",
            components: [
              { name: "currency0", type: "address" },
              { name: "currency1", type: "address" },
              { name: "fee", type: "uint24" },
              { name: "tickSpacing", type: "int24" },
              { name: "hooks", type: "address" }
            ]
          },
          { name: "zeroForOne", type: "bool" },
          { name: "exactAmount", type: "uint128" },
          { name: "hookData", type: "bytes" }
        ]
      }
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "gasEstimate", type: "uint256" }
    ]
  }
] as const;

export const universalRouterAbi = [
  {
    type: "function",
    name: "execute",
    stateMutability: "payable",
    inputs: [
      { name: "commands", type: "bytes" },
      { name: "inputs", type: "bytes[]" },
      { name: "deadline", type: "uint256" }
    ],
    outputs: []
  }
] as const;

export const v4PositionManagerAbi = [
  {
    type: "function",
    name: "multicall",
    stateMutability: "payable",
    inputs: [
      { name: "data", type: "bytes[]" },
      { name: "deadline", type: "uint256" }
    ],
    outputs: [{ name: "results", type: "bytes[]" }]
  }
] as const;

export const permit2Abi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" }
    ],
    outputs: []
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "token", type: "address" },
      { name: "spender", type: "address" }
    ],
    outputs: [
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
      { name: "nonce", type: "uint48" }
    ]
  }
] as const;

// The 2-arg execute(bytes,bytes[]) overload (selector 0x24856bc3) — the EXACT entrypoint gojo proved
// green on the live 4663 router (HoodieLiveSwapProof, 23811/23851). Separate from universalRouterAbi's
// 3-arg (deadline) overload so viem resolves the function unambiguously. HOODIE swaps carry msg.value=0.
export const universalRouterExecuteAbi = [
  {
    type: "function",
    name: "execute",
    stateMutability: "payable",
    inputs: [
      { name: "commands", type: "bytes" },
      { name: "inputs", type: "bytes[]" }
    ],
    outputs: []
  }
] as const;

// HydeHook — the shared anti-snipe hook keying every HOODIE-numeraire pool. `active(poolId)` proves the
// pool exists AND returns its launchTime (gojo 23855); the fee-decay constants drive the honest live-fee
// note (startFee/baseFee are pips ÷1e6). Verified live: window 300, startFee 30000 (3%), baseFee 10000 (1%).
export const hydeHookAbi = [
  {
    type: "function",
    name: "active",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [
      { name: "exists", type: "bool" },
      { name: "token", type: "address" },
      { name: "launchTime", type: "uint64" }
    ]
  },
  { type: "function", name: "antiSnipeWindow", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "startFee", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "baseFee", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }
] as const;

// HydeERC20 launch-token protection getters (the token itself, gojo 23855). `maxWallet` = max balance a
// wallet may RECEIVE (1% of supply); enforced on `to` only while `now < maxWalletExpiry` → buys can be
// capped during the window, sells are NEVER gated. balanceOf/decimals reuse erc20Abi.
export const hydeLaunchTokenAbi = [
  { type: "function", name: "maxWallet", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "maxWalletExpiry", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] }
] as const;

// HydeTokenFactory — REAL deployed interface (contracts/src/HydeTokenFactory.sol). The launch entrypoint
// is `launch(LaunchParams{name,symbol,presetId})` with `creator := msg.sender` (NOT a passed arg); it
// charges a flat 0.0004 ETH fee via `msg.value` (payable — no approval) and emits `LaunchCreated`. Immutable getters (WETH /
// tickSpacing / HOOK) are exposed for own-stack pool-key derivation in the swap path.
export const hydeTokenFactoryAbi = [
  {
    type: "function",
    name: "launch",
    stateMutability: "payable",
    inputs: [
      {
        name: "lp",
        type: "tuple",
        components: [
          { name: "name",     type: "string" },
          { name: "symbol",   type: "string" },
          { name: "presetId", type: "uint256" },
        ],
      },
    ],
    outputs: [
      { name: "token",   type: "address" },
      { name: "tokenId", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "predictNext",
    stateMutability: "view",
    inputs: [
      { name: "launcher", type: "address" },
      { name: "symbol",   type: "string" },
    ],
    outputs: [{ name: "", type: "address" }],
  },
  { type: "function", name: "launchFeeAmount",   stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "launchFeeTreasury", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "WETH",              stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "tickSpacing",       stateMutability: "view", inputs: [], outputs: [{ name: "", type: "int24" }] },
  { type: "function", name: "HOOK",              stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "paused",            stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "presetCount",       stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  {
    type: "event",
    name: "LaunchCreated",
    inputs: [
      { name: "token",    type: "address", indexed: true },
      { name: "creator",  type: "address", indexed: true },
      { name: "poolId",   type: "bytes32", indexed: true },
      { name: "tokenId",  type: "uint256", indexed: false },
      { name: "presetId", type: "uint256", indexed: false },
    ],
  },
] as const;

// HOODIE launcher-launcher (live 4663). The meta-factory mints launchers; Hydeout reuses ONE existing shared
// launcher (clint 23771 / kami 23767) that every creator launches HOODIE-paired tokens through, via the shared
// engine (== HydeTokenFactory bound to $HOODIE). The meta-factory ABI is retained for admin/off-chain reads only.
export const hoodieMetaFactoryAbi = [
  { type: "function", name: "createLauncher", stateMutability: "nonpayable", inputs: [{ name: "userSalt", type: "bytes32" }], outputs: [{ name: "launcher", type: "address" }] },
  { type: "function", name: "predictLauncher", stateMutability: "view", inputs: [{ name: "creator", type: "address" }, { name: "userSalt", type: "bytes32" }], outputs: [{ type: "address" }] },
] as const;

export const hoodieLauncherAbi = [
  {
    type: "function", name: "launch", stateMutability: "payable",
    inputs: [{ name: "name", type: "string" }, { name: "symbol", type: "string" }, { name: "presetId", type: "uint256" }],
    outputs: [{ name: "token", type: "address" }, { name: "tokenId", type: "uint256" }],
  },
] as const;

export const hoodieEngineAbi = [
  { type: "function", name: "launchFeeAmount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  {
    type: "function", name: "predictNextFor", stateMutability: "view",
    inputs: [{ name: "launcher", type: "address" }, { name: "creator", type: "address" }, { name: "symbol", type: "string" }],
    outputs: [{ type: "address" }],
  },
  {
    type: "event", name: "HoodieLaunchCreated",
    inputs: [
      { name: "launcher", type: "address", indexed: true },
      { name: "creator", type: "address", indexed: true },
      { name: "token", type: "address", indexed: true },
      { name: "poolId", type: "bytes32", indexed: false },
      { name: "tokenId", type: "uint256", indexed: false },
    ],
  },
] as const;

export const hydeGatewayAbi = [
  {
    type: "function",
    name: "executeSwap",
    stateMutability: "payable",
    inputs: [
      { name: "commands", type: "bytes" },
      { name: "inputs", type: "bytes[]" },
      { name: "deadline", type: "uint256" }
    ],
    outputs: []
  },
  {
    type: "function",
    name: "executePositionMulticall",
    stateMutability: "payable",
    inputs: [
      { name: "data", type: "bytes[]" },
      { name: "deadline", type: "uint256" }
    ],
    outputs: [{ name: "results", type: "bytes[]" }]
  }
] as const;

export const V4_ACTIONS = {
  SWAP_EXACT_IN_SINGLE: 0x06,
  SETTLE_ALL: 0x0c,
  // 0x0f = TAKE_ALL. (0x09 is SWAP_EXACT_OUT — the bug that broke every swap: the router misread
  // amountIn as OPEN_DELTA and reverted; gojo proved 0x0f green buy+sell on the live 4663 router, 23811.)
  TAKE_ALL: 0x0f,
} as const;

export const SWEEP_ETH_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

// ─── MasterChef (yield farming) ───────────────────────────────────────────
export const PLACEHOLDER_MASTERCHEF = "0x000000000000000000000000000000000000cHeF" as Address;

export const masterChefAbi = [
  {
    type: "function", name: "pendingReward", stateMutability: "view",
    inputs: [{ name: "_pid", type: "uint256" }, { name: "_user", type: "address" }],
    outputs: [{ name: "", type: "uint256" }]
  },
  {
    type: "function", name: "userInfo", stateMutability: "view",
    inputs: [{ name: "_pid", type: "uint256" }, { name: "_user", type: "address" }],
    outputs: [{ name: "amount", type: "uint256" }, { name: "rewardDebt", type: "uint256" }]
  },
  {
    type: "function", name: "deposit", stateMutability: "nonpayable",
    inputs: [{ name: "_pid", type: "uint256" }, { name: "_amount", type: "uint256" }],
    outputs: []
  },
  {
    type: "function", name: "withdraw", stateMutability: "nonpayable",
    inputs: [{ name: "_pid", type: "uint256" }, { name: "_amount", type: "uint256" }],
    outputs: []
  }
] as const;

// ─── StakingPool (single-token staking) ──────────────────────────────────
export const PLACEHOLDER_STAKING_POOL = "0x000000000000000000000000000000000000P00L" as Address;

export const stakingPoolAbi = [
  {
    type: "function", name: "pendingReward", stateMutability: "view",
    inputs: [{ name: "_user", type: "address" }],
    outputs: [{ name: "", type: "uint256" }]
  },
  {
    type: "function", name: "userInfo", stateMutability: "view",
    inputs: [{ name: "_user", type: "address" }],
    outputs: [{ name: "amount", type: "uint256" }, { name: "rewardDebt", type: "uint256" }]
  },
  {
    type: "function", name: "deposit", stateMutability: "nonpayable",
    inputs: [{ name: "_amount", type: "uint256" }],
    outputs: []
  },
  {
    type: "function", name: "withdraw", stateMutability: "nonpayable",
    inputs: [{ name: "_amount", type: "uint256" }],
    outputs: []
  },
  {
    type: "function", name: "harvest", stateMutability: "nonpayable",
    inputs: [],
    outputs: []
  }
] as const;
