// V3-line chain evidence GENERATOR (parallel to chainevidence.mjs). Does LIVE reads on each V3 row's RPC,
// asserts against the configured row + gojo's block-pinned expectations (24266) — deriving equality, never
// trusting summary booleans — records raw facts + code hashes, and emits src/utils/chainEvidenceV3.ts.
//
//   node scripts/chainevidence-v3.mjs
//
// Hyde-launchpad (LAUNCH) and swap (TRADE) proofs stay null until they are backed by pinned deployment /
// funded quote evidence. An empty/infra-only artifact keeps the corresponding capability fail-closed.
import { createPublicClient, http, keccak256 } from "viem";
import { writeFileSync } from "node:fs";

// One row per V3-only chain. gojo's block-pinned expectations (24266/24270) are ASSERTED, not assumed —
// including the full 32-byte code hashes. All reads are pinned to `verifyBlock`; any mismatch or read
// failure exits non-zero WITHOUT writing a partial artifact (kami 24267).
const ROWS = [
  {
    chainId: 988,
    name: "Stable",
    rpcUrl: "https://rpc.stable.xyz",
    verifyBlock: 33271706n, // post-deploy verification block; still retained by Stable's pruned public RPC
    numeraire: {
      address: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736",
      expectDecimals: 6,
      expectSymbol: "USDT0",
      expectCodeHash: "0x4d9be648c5bf39973670d9f8b481d5d0b971e6a2db2deccc6b98cde21c5dd83e",
    },
    v3Factory: "0x88F0a512eF09175D456bc9547f914f48C013E4aA",
    expectFactoryCodeHash: "0x2616b5c05e19fc8931cdf2f08bf47e05a7db6859c23add2c32d226092409e939",
    positionManager: "0x3BdC3437405f7D801b6036532713fc1F179136a6",
    expectNpmCodeHash: "0x553e7df57c6a17f6d65f05f5c3a3fa41ddaebeca6cf90a0b2b59da3152c41371",
    feeTier: 10000,
    expectTickSpacing: 200,
    // Hyde's own launchpad on this chain — empty until deployed (then the generator reads + gojo signs).
    hyde: {
      implementation: "0xCA5C4C7cc97C9aA3ea56B5F3a5c50Eb1c086615b",
      pad: "0xE79F17Fe61F9c76824D74C496f122f0AB483ec6A",
      locker: "0xE43314319675eF26724a7d4381D95ac31c246d90",
      verifyBlock: 33271706n,
      deployTx: "0x8876d45e5a0c15b2e3781d410bd0db223a4c52b9752084110b1c4484965719f8",
      expectImplementationCodeHash: "0xce745b5eba4a683f85e250477ced81eb3f04e5ba9a7ed705ef117e2acad6f012",
      expectPadCodeHash: "0x26aa0599221e51251bb88b58d911f07905411f85690da2ea87fd0b505c5310dc",
      expectLockerCodeHash: "0xc45c37ee53500e275f9a166b07d3a44d5df088e6a0ca1a4af71c6c86b768c12e",
      launchRoundTripFdv: "4995.430232 USDT0 (Stable mainnet fork E2E)",
    },
    trade: {
      swapRouter: "0x32eaf9B5d5F2CD7361c5012890C943D7de84C22a",
      quoter: "0xb070179E7032CdA868b53e6C1742F80c9e940d1A",
      expectRouterCodeHash: "0x058094ebcd628e76ed0308fd777ebbe4ece1005e2f1f53e3014f92f3e184277f",
      expectQuoterCodeHash: "0x50e66edfe1f177d8b214cdbccc6de1828b3f1b360e517c2deb98b685e5cbb393",
      verifyBlock: 33443361n,
      // Real Hyde V3 launch + live pool used for the deterministic quote smoke.
      token: "0x8aa67e0D40e9dE58ad10919A8d88FFAf2747EC69",
      amountIn: 100_000n,
      // This account held enough USDT0 and retained an unlimited Router02 allowance at verifyBlock.
      smokeAccount: "0x576d116ef6649bb177659a3ad2f34f6ba1fd9703",
      // Successful funded exactInputSingle call to this exact canonical router on Stable mainnet.
      tradeTx: "0xc7956e4c5075ab6858760e5cb93be296e0975de89bf6d685a89514cf446b3975",
      tradeBlock: 33305719n,
    },
  },
];

const ERC20 = [
  { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
];
const FACTORY = [
  { name: "feeAmountTickSpacing", type: "function", stateMutability: "view", inputs: [{ type: "uint24" }], outputs: [{ type: "int24" }] },
];
const NPM = [
  { name: "factory", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
];
const PAD = [
  { name: "IMPL", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "LOCKER", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "V3_FACTORY", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "POSITION_MANAGER", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "NUMERAIRE", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "NUMERAIRE_DECIMALS", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { name: "FEE_TIER", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint24" }] },
  { name: "LAUNCH_FEE_ASSET", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "LAUNCH_FEE_AMOUNT", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "LAUNCH_FEE_NATIVE", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { name: "MAX_WALLET_BPS", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "MAX_WALLET_WINDOW_SECS", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
];
const LOCKER = [
  { name: "FACTORY", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "POSITION_MANAGER", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "HYDE_BPS", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
];
const QUOTER_V2 = [
  {
    name: "quoteExactInputSingle",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{
      name: "params",
      type: "tuple",
      components: [
        { name: "tokenIn", type: "address" },
        { name: "tokenOut", type: "address" },
        { name: "amountIn", type: "uint256" },
        { name: "fee", type: "uint24" },
        { name: "sqrtPriceLimitX96", type: "uint160" },
      ],
    }],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
];
const SWAP_ROUTER_02 = [
  {
    name: "exactInputSingle",
    type: "function",
    stateMutability: "payable",
    inputs: [{
      name: "params",
      type: "tuple",
      components: [
        { name: "tokenIn", type: "address" },
        { name: "tokenOut", type: "address" },
        { name: "fee", type: "uint24" },
        { name: "recipient", type: "address" },
        { name: "amountIn", type: "uint256" },
        { name: "amountOutMinimum", type: "uint256" },
        { name: "sqrtPriceLimitX96", type: "uint160" },
      ],
    }],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
];

function must(cond, msg) {
  if (!cond) {
    console.error(`  ✗ ASSERT FAILED: ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log(`  ✓ ${msg}`);
}

async function codeFacts(client, address, blockNumber) {
  const code = await client.getCode({ address, blockNumber });
  const bytes = code && code !== "0x" ? (code.length - 2) / 2 : 0;
  return { codeSize: bytes, codeHash: bytes > 0 ? keccak256(code) : "0x" };
}

async function proveRow(row) {
  const at = row.verifyBlock;
  console.log(`\n── ${row.name}/${row.chainId} (${row.rpcUrl}) @block ${at} ──`);
  const client = createPublicClient({ transport: http(row.rpcUrl) });

  const chainId = await client.getChainId();
  must(chainId === row.chainId, `eth_chainId == ${row.chainId}`);

  const decimals = await client.readContract({ address: row.numeraire.address, abi: ERC20, functionName: "decimals", blockNumber: at });
  must(Number(decimals) === row.numeraire.expectDecimals, `USDT0 decimals() == ${row.numeraire.expectDecimals}`);
  const symbol = await client.readContract({ address: row.numeraire.address, abi: ERC20, functionName: "symbol", blockNumber: at });
  must(symbol === row.numeraire.expectSymbol, `USDT0 symbol() == "${row.numeraire.expectSymbol}"`);

  const tickSpacing = await client.readContract({ address: row.v3Factory, abi: FACTORY, functionName: "feeAmountTickSpacing", args: [row.feeTier], blockNumber: at });
  must(Number(tickSpacing) === row.expectTickSpacing, `factory.feeAmountTickSpacing(${row.feeTier}) == ${row.expectTickSpacing}`);
  const npmFactory = await client.readContract({ address: row.positionManager, abi: NPM, functionName: "factory", blockNumber: at });
  must(npmFactory.toLowerCase() === row.v3Factory.toLowerCase(), `NPM.factory() == configured factory ${row.v3Factory}`);

  const f = await codeFacts(client, row.v3Factory, at);
  const n = await codeFacts(client, row.positionManager, at);
  const u = await codeFacts(client, row.numeraire.address, at);
  must(f.codeSize > 0 && n.codeSize > 0 && u.codeSize > 0, `code-size(factory/NPM/USDT0) all > 0 (${f.codeSize}/${n.codeSize}/${u.codeSize})`);
  // Full 32-byte code-hash equality vs gojo's block-pinned values (24270) — a factory/token swap trips this.
  must(f.codeHash.toLowerCase() === row.expectFactoryCodeHash.toLowerCase(), `factory codeHash == ${row.expectFactoryCodeHash}`);
  must(n.codeHash.toLowerCase() === row.expectNpmCodeHash.toLowerCase(), `NPM codeHash == ${row.expectNpmCodeHash}`);
  must(u.codeHash.toLowerCase() === row.numeraire.expectCodeHash.toLowerCase(), `USDT0 codeHash == ${row.numeraire.expectCodeHash}`);
  const block = at.toString();

  // Hyde's OWN launchpad — the LAUNCH gate. Runtime hashes, immutables and both cross-bindings are read
  // at the pinned post-deploy block. Any drift aborts before evidence is written.
  let launch = null;
  if (row.hyde.pad && row.hyde.locker) {
    const hv = row.hyde.verifyBlock;
    const [imf, pf, lf] = await Promise.all([
      codeFacts(client, row.hyde.implementation, hv),
      codeFacts(client, row.hyde.pad, hv),
      codeFacts(client, row.hyde.locker, hv),
    ]);
    must(imf.codeHash.toLowerCase() === row.hyde.expectImplementationCodeHash.toLowerCase(), "Hyde implementation runtime hash matches deploy artifact");
    must(pf.codeHash.toLowerCase() === row.hyde.expectPadCodeHash.toLowerCase(), "Hyde V3 pad runtime hash matches deploy artifact");
    must(lf.codeHash.toLowerCase() === row.hyde.expectLockerCodeHash.toLowerCase(), "Hyde V3 locker runtime hash matches deploy artifact");

    const read = (address, abi, functionName) =>
      client.readContract({ address, abi, functionName, blockNumber: hv });
    const [
      padImpl, padLocker, padFactory, padNpm, padNumeraire, padDecimals, padFeeTier,
      launchFeeAsset, launchFeeAmount, launchFeeNative, maxWalletBps, maxWalletWindow,
      lockerFactory, lockerNpm, hydeBps,
    ] = await Promise.all([
      read(row.hyde.pad, PAD, "IMPL"),
      read(row.hyde.pad, PAD, "LOCKER"),
      read(row.hyde.pad, PAD, "V3_FACTORY"),
      read(row.hyde.pad, PAD, "POSITION_MANAGER"),
      read(row.hyde.pad, PAD, "NUMERAIRE"),
      read(row.hyde.pad, PAD, "NUMERAIRE_DECIMALS"),
      read(row.hyde.pad, PAD, "FEE_TIER"),
      read(row.hyde.pad, PAD, "LAUNCH_FEE_ASSET"),
      read(row.hyde.pad, PAD, "LAUNCH_FEE_AMOUNT"),
      read(row.hyde.pad, PAD, "LAUNCH_FEE_NATIVE"),
      read(row.hyde.pad, PAD, "MAX_WALLET_BPS"),
      read(row.hyde.pad, PAD, "MAX_WALLET_WINDOW_SECS"),
      read(row.hyde.locker, LOCKER, "FACTORY"),
      read(row.hyde.locker, LOCKER, "POSITION_MANAGER"),
      read(row.hyde.locker, LOCKER, "HYDE_BPS"),
    ]);
    must(padImpl.toLowerCase() === row.hyde.implementation.toLowerCase(), "pad.IMPL() matches deployed implementation");
    must(padLocker.toLowerCase() === row.hyde.locker.toLowerCase(), "pad.LOCKER() matches deployed locker");
    must(lockerFactory.toLowerCase() === row.hyde.pad.toLowerCase(), "locker.FACTORY() matches deployed pad");
    must(padFactory.toLowerCase() === row.v3Factory.toLowerCase(), "pad.V3_FACTORY() matches canonical V3 factory");
    must(padNpm.toLowerCase() === row.positionManager.toLowerCase() && lockerNpm.toLowerCase() === row.positionManager.toLowerCase(), "pad + locker position-manager bindings match");
    must(padNumeraire.toLowerCase() === row.numeraire.address.toLowerCase(), "pad numeraire matches configured USDT0");
    must(Number(padDecimals) === row.numeraire.expectDecimals, "pad numeraire decimals match config");
    must(Number(padFeeTier) === row.feeTier, "pad fee tier matches config");
    must(launchFeeAsset.toLowerCase() === row.numeraire.address.toLowerCase() && launchFeeAmount === 1_000_000n && launchFeeNative === false, "launch fee is exactly 1 ERC-20 USDT0");
    must(maxWalletBps === 200n && maxWalletWindow === 600n, "anti-snipe is 2% max wallet for 10 minutes");
    must(hydeBps === 500n, "locker split is 95% creator / 5% Hyde");

    launch = {
      implementation: row.hyde.implementation,
      pad: row.hyde.pad,
      locker: row.hyde.locker,
      implementationCodeSize: imf.codeSize,
      padCodeSize: pf.codeSize,
      lockerCodeSize: lf.codeSize,
      implementationCodeHash: imf.codeHash,
      padCodeHash: pf.codeHash,
      lockerCodeHash: lf.codeHash,
      padLockerBinding: padLocker,
      lockerFactoryBinding: lockerFactory,
      deployTx: row.hyde.deployTx,
      launchRoundTripFdv: row.hyde.launchRoundTripFdv,
      verifiedAtBlock: hv.toString(),
    };
    console.log(`  • Hyde launchpad verified (impl ${imf.codeSize}B / pad ${pf.codeSize}B / locker ${lf.codeSize}B)`);
  } else {
    console.log("  • Hyde launchpad NOT deployed → launch:null → chain stays 'coming'");
  }

  let trade = null;
  if (row.trade) {
    const tv = row.trade.verifyBlock;
    const [routerFacts, quoterFacts, quote, tradeReceipt, tradeTx] = await Promise.all([
      codeFacts(client, row.trade.swapRouter, tv),
      codeFacts(client, row.trade.quoter, tv),
      client.simulateContract({
        address: row.trade.quoter,
        abi: QUOTER_V2,
        functionName: "quoteExactInputSingle",
        args: [{
          tokenIn: row.numeraire.address,
          tokenOut: row.trade.token,
          amountIn: row.trade.amountIn,
          fee: row.feeTier,
          sqrtPriceLimitX96: 0n,
        }],
        blockNumber: tv,
      }),
      client.getTransactionReceipt({ hash: row.trade.tradeTx }),
      client.getTransaction({ hash: row.trade.tradeTx }),
    ]);
    must(routerFacts.codeHash.toLowerCase() === row.trade.expectRouterCodeHash.toLowerCase(), "SwapRouter02 runtime hash matches pinned deployment");
    must(quoterFacts.codeHash.toLowerCase() === row.trade.expectQuoterCodeHash.toLowerCase(), "QuoterV2 runtime hash matches pinned deployment");
    must(routerFacts.codeSize > 0 && quoterFacts.codeSize > 0, "SwapRouter02 + QuoterV2 code-size both > 0");
    must(quote.result[0] > 0n, "QuoterV2 returns a funded Hyde-pool quote");
    must(tradeReceipt.status === "success", "funded SwapRouter02 smoke transaction succeeded");
    must(tradeTx.to?.toLowerCase() === row.trade.swapRouter.toLowerCase(), "funded smoke transaction targets configured SwapRouter02");
    must(tradeReceipt.blockNumber === row.trade.tradeBlock, "funded smoke transaction block matches pinned evidence");
    const amountOutMinimum = (quote.result[0] * 99n) / 100n;
    const routerSimulation = await client.simulateContract({
      account: row.trade.smokeAccount,
      address: row.trade.swapRouter,
      abi: SWAP_ROUTER_02,
      functionName: "exactInputSingle",
      args: [{
        tokenIn: row.numeraire.address,
        tokenOut: row.trade.token,
        fee: row.feeTier,
        recipient: row.trade.smokeAccount,
        amountIn: row.trade.amountIn,
        amountOutMinimum,
        sqrtPriceLimitX96: 0n,
      }],
      value: 0n,
      blockNumber: tv,
    });
    must(routerSimulation.result === quote.result[0], "funded Hyde-pool Router02 simulation matches QuoterV2");

    trade = {
      swapRouter: row.trade.swapRouter,
      quoter: row.trade.quoter,
      swapRouterCodeHash: routerFacts.codeHash,
      quoterCodeHash: quoterFacts.codeHash,
      quoteSmoke: {
        tokenIn: row.numeraire.address,
        tokenOut: row.trade.token,
        fee: row.feeTier,
        amountIn: row.trade.amountIn.toString(),
        amountOut: quote.result[0].toString(),
        routerAmountOut: routerSimulation.result.toString(),
        smokeAccount: row.trade.smokeAccount,
        atBlock: tv.toString(),
      },
      tradeSmoke: { txHash: row.trade.tradeTx, atBlock: tradeReceipt.blockNumber.toString() },
    };
    console.log(`  • Stable V3 trade path verified (quote ${quote.result[0]} / tx ${row.trade.tradeTx})`);
  }

  return {
    chainId: row.chainId,
    generatedAtBlock: row.trade?.verifyBlock?.toString() ?? row.hyde.verifyBlock?.toString() ?? block,
    rpcUrl: row.rpcUrl,
    infra: {
      chainId: row.chainId,
      numeraire: { address: row.numeraire.address, decimals: Number(decimals), symbol },
      factory: { address: row.v3Factory, feeTier: row.feeTier, tickSpacing: Number(tickSpacing), codeHash: f.codeHash, codeSize: f.codeSize },
      positionManager: { address: row.positionManager, factoryBinding: npmFactory, codeHash: n.codeHash, codeSize: n.codeSize },
      numeraireCode: { codeHash: u.codeHash, codeSize: u.codeSize },
      verifiedAtBlock: block,
    },
    launch, // null until Hyde deployed + gojo's round-trip sign-off
    trade,
    readSmoke: launch ? { verifiedAtBlock: row.hyde.verifyBlock.toString() } : null,
  };
}

const results = {};
for (const row of ROWS) {
  results[row.chainId] = await proveRow(row);
}

const header = `// AUTO-GENERATED by scripts/chainevidence-v3.mjs — DO NOT HAND-EDIT.
// Regenerate: node scripts/chainevidence-v3.mjs
// The V3 registry (chainRegistry.ts) derives readiness from THIS artifact's raw facts (addresses, tick
// spacing, code hashes, block) by deriving equality vs the configured row — never trusting summary
// booleans. \`launch\` (Hyde launchpad) and \`trade\` (swap) proofs stay null until pinned live evidence
// exists, so each capability remains fail-closed until its own release gate passes.\n`;

const body = `${header}
export interface V3InfraEvidence {
  chainId: number;
  numeraire: { address: string; decimals: number; symbol: string };
  factory: { address: string; feeTier: number; tickSpacing: number; codeHash: string; codeSize: number };
  positionManager: { address: string; factoryBinding: string; codeHash: string; codeSize: number };
  numeraireCode: { codeHash: string; codeSize: number };
  verifiedAtBlock: string;
}
/** Hyde's OWN deployed launchpad — the LAUNCH-enabled gate (gojo signs after deploy + round-trip). */
export interface V3LaunchEvidence {
  implementation?: string;
  pad: string;
  locker: string;
  implementationCodeSize?: number;
  padCodeSize: number;
  lockerCodeSize: number;
  implementationCodeHash?: string;
  padCodeHash?: string;
  lockerCodeHash?: string;
  padLockerBinding?: string;   // pad.LOCKER() (== locker) — gojo sign-off
  lockerFactoryBinding?: string; // locker.FACTORY() (== pad) — gojo sign-off
  deployTx?: string;
  launchRoundTripFdv?: string; // ~$5k slot0.tick round-trip — gojo sign-off
  verifiedAtBlock?: string;
}
/** Independent swap path — gojo signs after SwapRouter02 + QuoterV2 verify + funded smoke. */
export interface V3TradeEvidence {
  swapRouter: string;
  quoter: string;
  swapRouterCodeHash?: string;
  quoterCodeHash?: string;
  quoteSmoke: { tokenIn?: string; tokenOut?: string; fee?: number; amountIn: string; amountOut: string; routerAmountOut?: string; smokeAccount?: string; atBlock: string };
  tradeSmoke: { txHash: string; atBlock: string };
}
export interface V3ChainEvidence {
  chainId: number;
  generatedAtBlock: string;
  rpcUrl?: string;
  infra?: V3InfraEvidence;
  launch?: V3LaunchEvidence | null;
  trade?: V3TradeEvidence | null;
  readSmoke?: { verifiedAtBlock: string } | null;
}

export const CHAIN_EVIDENCE_V3: Record<number, V3ChainEvidence | undefined> = ${JSON.stringify(results, null, 2)};
`;

writeFileSync("src/utils/chainEvidenceV3.ts", body);
console.log(`\nWrote src/utils/chainEvidenceV3.ts (${Object.keys(results).length} chain(s)). ${process.exitCode ? "ASSERTIONS FAILED" : "OK"}`);
process.exit(process.exitCode ?? 0);
