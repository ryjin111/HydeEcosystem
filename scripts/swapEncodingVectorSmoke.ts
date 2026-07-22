// Encoding-vector gate for the HOODIE swap path (kami's "encoding vector" gate). Runs the REAL card
// encoder `buildHoodieSwap` (esbuild-bundled — not a hand-mirror) through the wired 4663 constants
// (hoodieNumeraire + hoodieHook + HYDE_DYNAMIC_FEE/TICK) and asserts BOTH directions are byte-shaped
// exactly like gojo's proven-green on-chain swaps (23851): commands=0x10, actions=06 0c 0f (TAKE_ALL=0x0f),
// param[0] len=0x180 (wrapped-tuple offset), sorted currencies, dynamic fee/tick60/HydeHook, correct
// direction + SETTLE_ALL/TAKE_ALL legs. BUY=HOODIE→token (zeroForOne=false), SELL=token→HOODIE (true).
//
// Build+run: node_modules/.bin/esbuild scripts/swapEncodingVectorSmoke.ts --bundle --platform=node
//   --format=esm --outfile=<tmp>.mjs && node <tmp>.mjs

import { decodeAbiParameters, parseAbiParameters } from "viem";
import { buildHoodieSwap } from "../src/utils/hoodieSwap";

const HOODIE = "0xC72c01AAB5f5678dc1d6f5C6d2B417d91D402Ba3";
const TOKEN = "0x8a76FeeF3bb0140c122d146caCef6B1A4Ac145f7"; // LILHOODIE (TOKEN < HOODIE)
const HOOK = "0x41078B0012751e7E646DF9B6607e6C4fF8B570C0";
const FEE = 0x800000, TICK = 60;
const ONE = 1000000000000000000n;
const RECIPIENT = "0x800557e7882b42ee49594fa2790300A9697a0e4D";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ✓ ${n}`); };
const bad = (n: string, d: string) => { fail++; console.log(`  ✗ ${n} — ${d}`); };
const eq = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase();

function check(label: string, isBuy: boolean, amountIn: string, expAmountIn: bigint) {
  console.log(`\n[${label}]`);
  const { commands, inputs } = buildHoodieSwap({
    token: TOKEN as `0x${string}`, decimals: 18, isBuy, recipient: RECIPIENT as `0x${string}`,
    amountIn, amountOutQuoted: "0", slippagePercent: "0", chainId: 4663,
  });
  eq(commands, "0x10") ? ok("commands = 0x10 (V4_SWAP only, no SWEEP for the ERC20 pair)") : bad("commands = 0x10", String(commands));
  inputs.length === 1 ? ok("single V4_SWAP input") : bad("inputs.length == 1", String(inputs.length));

  const [actions, params] = decodeAbiParameters(parseAbiParameters("bytes,bytes[]"), inputs[0]) as unknown as [string, string[]];
  eq(actions, "0x060c0f") ? ok("actions = 06 0c 0f (proves TAKE_ALL = 0x0f)") : bad("actions = 0x060c0f", String(actions));

  const p0len = (params[0].length - 2) / 2;
  p0len === 0x180 ? ok(`param[0] length = 0x180 (${p0len} bytes) — wrapped-tuple offset present`)
                  : bad("param[0] length = 0x180", `got 0x${p0len.toString(16)} (0x160 = dropped tuple offset)`);

  const decoded = decodeAbiParameters(
    parseAbiParameters("((address,address,uint24,int24,address),bool,uint128,uint128,uint256,bytes)"),
    params[0] as `0x${string}`,
  ) as unknown as [[[string, string, number, number, string], boolean, bigint, bigint, bigint, string]];
  const [poolKey, z4o, amtIn, , minHop] = decoded[0];
  const [c0, c1, fee, tick, hook] = poolKey;
  // SAME pool for both directions — currencies are always sorted (TOKEN < HOODIE).
  eq(c0, TOKEN) && eq(c1, HOODIE) ? ok("currency0 = token, currency1 = HOODIE (sorted; same pool both ways)") : bad("sorted currencies", `${c0}, ${c1}`);
  (Number(fee) === FEE && Number(tick) === TICK && eq(hook, HOOK)) ? ok("fee = 0x800000, tickSpacing = 60, hook = HydeHook") : bad("pool params", `${fee}, ${tick}, ${hook}`);
  z4o === !isBuy // BUY→false, SELL→true
    ? ok(`zeroForOne = ${!isBuy} (${isBuy ? "BUY HOODIE→token" : "SELL token→HOODIE"})`)
    : bad(`zeroForOne = ${!isBuy}`, String(z4o));
  (amtIn === expAmountIn && minHop === 0n) ? ok(`amountIn = ${expAmountIn}, minHopPriceX36 = 0`) : bad("amountIn/minHop", `${amtIn}, ${minHop}`);

  const inCur = isBuy ? HOODIE : TOKEN;   // SETTLE = the token you pay
  const outCur = isBuy ? TOKEN : HOODIE;  // TAKE   = the token you receive
  const [sAddr, sAmt] = decodeAbiParameters(parseAbiParameters("address,uint256"), params[1] as `0x${string}`) as unknown as [string, bigint];
  (eq(sAddr, inCur) && sAmt === expAmountIn) ? ok(`SETTLE_ALL = (${isBuy ? "HOODIE" : "token"}, ${expAmountIn})`) : bad("SETTLE_ALL", `${sAddr}, ${sAmt}`);
  const [tAddr, tAmt] = decodeAbiParameters(parseAbiParameters("address,uint256"), params[2] as `0x${string}`) as unknown as [string, bigint];
  (eq(tAddr, outCur) && tAmt === 0n) ? ok(`TAKE_ALL = (${isBuy ? "token" : "HOODIE"}, 0)`) : bad("TAKE_ALL", `${tAddr}, ${tAmt}`);
}

// BUY: 1 HOODIE in (gojo golden 23851). SELL: 100 TOKEN in.
check("BUY  HOODIE→token", true, "1", ONE);
check("SELL token→HOODIE", false, "100", 100n * ONE);

console.log(`\nswapEncodingVector: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
