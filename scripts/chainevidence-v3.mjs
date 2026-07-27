// V3-line chain evidence GENERATOR (parallel to chainevidence.mjs). Does LIVE reads on each V3 row's RPC,
// asserts against the configured row + gojo's block-pinned expectations (24266) — deriving equality, never
// trusting summary booleans — records raw facts + code hashes, and emits src/utils/chainEvidenceV3.ts.
//
//   node scripts/chainevidence-v3.mjs
//
// Hyde-launchpad (LAUNCH) and swap (TRADE) proofs stay null until gojo signs them (deploy round-trip /
// funded quote). An empty/infra-only artifact keeps the chain fail-closed 'coming', launch/Swap disabled.
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
    console.log("  • Hyde launchpad NOT deployed → launch:null → chain stays 'coming' (launch-only, Swap disabled)");
  }

  return {
    chainId: row.chainId,
    generatedAtBlock: row.hyde.verifyBlock?.toString() ?? block,
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
    trade: null, // null until gojo verifies SwapRouter02 + QuoterV2 + funded smoke (launch-only otherwise)
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
// booleans. \`launch\` (Hyde launchpad) and \`trade\` (swap) proofs stay null until gojo signs them, so a
// chain is fail-closed 'coming' (launch/Swap disabled) until real deployment + round-trip evidence.\n`;

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
  quoteSmoke: { amountIn: string; amountOut: string; atBlock: string };
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
