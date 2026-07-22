// Regression gate for the Profile holdings bug (clint 23885 / kami 23886): launching LILHOODIE showed
// $HOODIE as a holding. Runs the REAL app filter `isMainnetOwnStackLaunch` (esbuild-bundled, live 4663)
// against the exact two tokens clint's wallet holds — asserts the HOODIE-engine launch is INCLUDED and the
// $HOODIE / WETH base assets are EXCLUDED. The old clone-bytecode `isHydeLaunch` did the opposite.
//
// Build+run: node_modules/.bin/esbuild scripts/profileHoldingsSmoke.ts --bundle --platform=node
//   --format=esm --outfile=<tmp>.mjs && node <tmp>.mjs
import { isMainnetOwnStackLaunch } from "../src/hooks/useDopplerTokens";
import { ROBINHOOD_MAINNET } from "../src/utils/constants";

const LILHOODIE = "0x8a76FeeF3bb0140c122d146caCef6B1A4Ac145f7" as `0x${string}`; // clint's HOODIE-engine launch
const HOODIE = "0xC72c01AAB5f5678dc1d6f5C6d2B417d91D402Ba3" as `0x${string}`;    // base numeraire — must be excluded
const WETH = ROBINHOOD_MAINNET.weth as `0x${string}`;                            // base asset — must be excluded

let pass = 0, fail = 0;
const check = async (label: string, addr: `0x${string}`, want: boolean) => {
  const got = await isMainnetOwnStackLaunch(addr).catch(() => null);
  if (got === want) { pass++; console.log(`  ✓ ${label}: ${got}`); }
  else { fail++; console.log(`  ✗ ${label}: got ${got} want ${want}`); }
};

await check("LILHOODIE included (HOODIE-engine launch)", LILHOODIE, true);
await check("HOODIE excluded (base numeraire)", HOODIE, false);
await check("WETH excluded (base asset)", WETH, false);

console.log(`\nprofileHoldings: ${pass} passed, ${fail} failed`);
// Set exitCode and let node drain the viem keep-alive sockets (forcing process.exit here trips a libuv
// teardown assertion on Windows) — the result above is the source of truth.
process.exitCode = fail === 0 ? 0 : 1;
