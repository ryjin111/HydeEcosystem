// Multi-chain V4 address verification gate (kami's acceptance contract, msg 23060).
// For each candidate chain: chainId matches → eth_getCode ≠ 0x on every V4 address →
// poolManager() cross-checked from StateView + V4Quoter + PositionManager →
// PositionManager.permit2() == canonical Permit2 → UniversalRouter bytecode EMBEDS
// the PoolManager + Permit2 addresses (immutables live in deployed code — a router
// pointing at a different PoolManager cannot pass) → every token-list candidate
// proves its symbol()+decimals() on-chain. Anything failing is EXCLUDED, not wired.
// Candidate addresses come from developers.uniswap.org/contracts/v4/deployments
// (fetched 2026-07-20); this script is the on-chain proof, not the source of truth.
// Where a chain config carries a Hyde gateway, its deployed bytecode is proven
// too (kami 23086 #2): executeSwap selector present + the chain's UniversalRouter
// embedded as an immutable. (Permit2 is NOT expected in gateway code — a
// pass-through gateway never touches Permit2; the user's permit names the
// ROUTER as spender, and the router's own Permit2 embedding is checked below.)
import { keccak256, toHex } from "viem";

const SEL_EXECUTE_SWAP = keccak256(toHex("executeSwap(bytes,bytes[],uint256)")).slice(2, 10);
const SEL_POOL_MANAGER = "0xdc4c90d3"; // poolManager()
const SEL_PERMIT2 = "0x12261ee7";      // permit2()
const SEL_SYMBOL = "0x95d89b41";       // symbol()
const SEL_DECIMALS = "0x313ce567";     // decimals()
const CANONICAL_PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

const CHAINS = [
  {
    key: "ethereum", id: 1, name: "Ethereum",
    rpcs: ["https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com", "https://cloudflare-eth.com"],
    v4: {
      poolManager: "0x000000000004444c5dc75cB358380D2e3dE08A90",
      universalRouter: "0x66a9893cc07d91d95644aedd05d03f95e1dba8af",
      positionManager: "0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e",
      stateView: "0x7ffe42c4a5deea5b0fec41c94c136cf115597227",
      quoter: "0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203",
      permit2: CANONICAL_PERMIT2,
    },
    wrappedNative: { addr: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", expectSymbol: "WETH" },
    tokens: [
      { symbol: "USDC", addr: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
      { symbol: "USDT", addr: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 },
      { symbol: "WBTC", addr: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", decimals: 8 },
      { symbol: "DAI", addr: "0x6B175474E89094C44Da98b954EedeAC495271d0F", decimals: 18 },
    ],
  },
  {
    key: "arbitrum", id: 42161, name: "Arbitrum One",
    rpcs: [process.env.ARBITRUM_RPC_URL, "https://arb1.arbitrum.io/rpc", "https://arbitrum-one-rpc.publicnode.com"].filter(Boolean),
    v4: {
      poolManager: "0x360e68faccca8ca495c1b759fd9eee466db9fb32",
      universalRouter: "0xa51afafe0263b40edaef0df8781ea9aa03e381a3",
      positionManager: "0xd88f38f930b7952f2db2432cb002e7abbf3dd869",
      stateView: "0x76fd297e2d437cd7f76d50f01afe6160f86e9990",
      quoter: "0x3972c00f7ed4885e145823eb7c655375d275a1c5",
      permit2: CANONICAL_PERMIT2,
    },
    wrappedNative: { addr: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", expectSymbol: "WETH" },
    tokens: [
      { symbol: "USDC", addr: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6 },
      { symbol: "USD₮0", addr: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", decimals: 6 },
      { symbol: "ARB", addr: "0x912CE59144191C1204E64559FE8253a0e49E6548", decimals: 18 },
      { symbol: "WBTC", addr: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f", decimals: 8 },
    ],
  },
  {
    key: "optimism", id: 10, name: "Optimism",
    rpcs: ["https://mainnet.optimism.io", "https://optimism-rpc.publicnode.com"],
    v4: {
      poolManager: "0x9a13F98Cb987694C9F086b1F5eB990EeA8264Ec3",
      universalRouter: "0x851116D9223fabED8E56C0E6b8Ad0c31d98B3507",
      positionManager: "0x3C3Ea4B57a46241e54610e5f022E5c45859A1017",
      stateView: "0xc18a3169788f4f75a170290584eca6395c75ecdb",
      quoter: "0x1f3131a13296fb91c90870043742c3cdbff1a8d7",
      permit2: CANONICAL_PERMIT2,
    },
    wrappedNative: { addr: "0x4200000000000000000000000000000000000006", expectSymbol: "WETH" },
    tokens: [
      { symbol: "USDC", addr: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", decimals: 6 },
      { symbol: "USDT", addr: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", decimals: 6 },
      { symbol: "OP", addr: "0x4200000000000000000000000000000000000042", decimals: 18 },
      { symbol: "WBTC", addr: "0x68f180fcCe6836688e9084f035309E29Bf0A2095", decimals: 8 },
    ],
    gateway: "0x21d6Ce25aa1AB3F59eE51b7693A596C6d39A03C9",
  },
  {
    key: "unichain", id: 130, name: "Unichain",
    rpcs: ["https://mainnet.unichain.org", "https://unichain-rpc.publicnode.com"],
    v4: {
      poolManager: "0x1f98400000000000000000000000000000000004",
      universalRouter: "0xef740bf23acae26f6492b10de645d6b98dc8eaf3",
      positionManager: "0x4529a01c7a0410167c5740c487a8de60232617bf",
      stateView: "0x86e8631a016f9068c3f085faf484ee3f5fdee8f2",
      quoter: "0x333e3c607b141b18ff6de9f258db6e77fe7491e0",
      permit2: CANONICAL_PERMIT2,
    },
    wrappedNative: { addr: "0x4200000000000000000000000000000000000006", expectSymbol: "WETH" },
    tokens: [
      { symbol: "USDC", addr: "0x078D782b760474a361dDA0AF3839290b0EF57AD6", decimals: 6 },
      // Tether on Unichain = the omnichain USDT0 deploy; on-chain symbol is literally "USD₮0"
      { symbol: "USD₮0", addr: "0x9151434b16b9763660705744891fA906F660EcC5", decimals: 6 },
    ],
  },
  {
    key: "bnb", id: 56, name: "BNB Smart Chain",
    rpcs: ["https://bsc-rpc.publicnode.com", "https://bsc-dataseed.bnbchain.org"],
    v4: {
      poolManager: "0x28e2ea090877bf75740558f6bfb36a5ffee9e9df",
      universalRouter: "0x1906c1d672b88cd1b9ac7593301ca990f94eae07",
      positionManager: "0x7a4a5c919ae2541aed11041a1aeee68f1287f95b",
      stateView: "0xd13dd3d6e93f276fafc9db9e6bb47c1180aee0c4",
      quoter: "0x9f75dd27d6664c475b90e105573e550ff69437b0",
      permit2: CANONICAL_PERMIT2,
    },
    wrappedNative: { addr: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", expectSymbol: "WBNB" },
    tokens: [
      { symbol: "USDT", addr: "0x55d398326f99059fF775485246999027B3197955", decimals: 18 },
      { symbol: "USDC", addr: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", decimals: 18 },
      { symbol: "BTCB", addr: "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c", decimals: 18 },
      { symbol: "ETH", addr: "0x2170Ed0880ac9A755fd29B2688956BD959F933F8", decimals: 18 },
    ],
  },
  {
    key: "xlayer", id: 196, name: "X Layer",
    rpcs: ["https://rpc.xlayer.tech", "https://xlayerrpc.okx.com"],
    v4: {
      poolManager: "0x360e68faccca8ca495c1b759fd9eee466db9fb32",
      universalRouter: "0xda00ae15d3a71466517129255255db7c0c0956d3",
      positionManager: "0xcf1eafc6928dc385a342e7c6491d371d2871458b",
      stateView: "0x76fd297e2d437cd7f76d50f01afe6160f86e9990",
      quoter: "0x8928074ca1b241d8ec02815881c1af11e8bc5219",
      permit2: CANONICAL_PERMIT2,
    },
    wrappedNative: { addr: "0xe538905cf8410324e03A5A23C1c177a474D59b2b", expectSymbol: "WOKB" },
    tokens: [
      { symbol: "USDT", addr: "0x1E4a5963aBFD975d8c9021ce480b42188849D41d", decimals: 6 },
      { symbol: "USDC", addr: "0x74b7F16337b8972027F6196A17a631aC6dE26d22", decimals: 6 },
      { symbol: "WETH", addr: "0x5A77f1443D16ee5761d310e38b62f77f726bC71c", decimals: 18 },
    ],
  },
  {
    key: "ink", id: 57073, name: "Ink",
    rpcs: ["https://rpc-gel.inkonchain.com"],
    v4: {
      poolManager: "0x360e68faccca8ca495c1b759fd9eee466db9fb32",
      universalRouter: "0x112908dac86e20e7241b0927479ea3bf935d1fa0",
      positionManager: "0x1b35d13a2e2528f192637f14b05f0dc0e7deb566",
      stateView: "0x76fd297e2d437cd7f76d50f01afe6160f86e9990",
      quoter: "0x3972c00f7ed4885e145823eb7c655375d275a1c5",
      permit2: CANONICAL_PERMIT2,
    },
    wrappedNative: { addr: "0x4200000000000000000000000000000000000006", expectSymbol: "WETH" },
    tokens: [], // INK_TOKENS list already exists in-app; V4 row verification only
    gateway: "0x21d6Ce25aa1AB3F59eE51b7693A596C6d39A03C9",
  },
];

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
};

async function rpc(url, method, params) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

async function pickRpc(chain) {
  for (const url of chain.rpcs) {
    try {
      const idHex = await rpc(url, "eth_chainId", []);
      if (parseInt(idHex, 16) === chain.id) return url;
      console.log(`  (rpc ${url} answered chainId ${parseInt(idHex, 16)} ≠ ${chain.id} — skipping)`);
    } catch (e) {
      console.log(`  (rpc ${url} unreachable: ${e.message} — trying next)`);
    }
  }
  return null;
}

const strip = (a) => a.toLowerCase().replace(/^0x/, "");
const addrFromWord = (hex) => "0x" + hex.slice(-40);

function decodeString(hex) {
  const h = hex.replace(/^0x/, "");
  if (h.length === 64) { // bytes32-style symbol (MKR pattern)
    return Buffer.from(h, "hex").toString("utf8").replace(/\0+$/, "");
  }
  const len = parseInt(h.slice(64, 128), 16);
  return Buffer.from(h.slice(128, 128 + len * 2), "hex").toString("utf8");
}

const requestedChain = process.argv[2]?.toLowerCase();
const selectedChains = requestedChain
  ? CHAINS.filter((chain) => chain.key === requestedChain || String(chain.id) === requestedChain)
  : CHAINS;
if (requestedChain && selectedChains.length === 0) {
  console.error(`Unknown chain "${requestedChain}". Available: ${CHAINS.map((chain) => `${chain.key} (${chain.id})`).join(", ")}`);
  process.exit(1);
}

for (const chain of selectedChains) {
  console.log(`\n── ${chain.name} (${chain.id}) ──`);
  const url = await pickRpc(chain);
  check(`${chain.key}: reachable RPC agrees chainId=${chain.id}`, !!url, url ?? "no RPC reachable");
  if (!url) continue;

  const call = (to, data) => rpc(url, "eth_call", [{ to, data }, "latest"]);
  const code = (addr) => rpc(url, "eth_getCode", [addr, "latest"]);

  // 1. every V4 address + wrapped native has deployed code
  const codes = {};
  for (const [label, addr] of [...Object.entries(chain.v4), ["wrappedNative", chain.wrappedNative.addr]]) {
    try { codes[label] = await code(addr); } catch (e) { codes[label] = "0x"; }
  }
  const noCode = Object.entries(codes).filter(([, c]) => !c || c === "0x").map(([l]) => l);
  check(`${chain.key}: eth_getCode ≠ 0x on all ${Object.keys(codes).length} addresses`, noCode.length === 0,
    noCode.length ? `EMPTY: ${noCode.join(", ")}` : "poolManager/router/posm/stateView/quoter/permit2/wrapped");

  // 2. poolManager() cross-check from the three periphery contracts that expose it
  const crossResults = [];
  for (const src of ["stateView", "quoter", "positionManager"]) {
    try {
      const out = await call(chain.v4[src], SEL_POOL_MANAGER);
      crossResults.push([src, addrFromWord(out)]);
    } catch (e) {
      crossResults.push([src, `call failed: ${e.message}`]);
    }
  }
  const allMatch = crossResults.every(([, got]) => strip(got) === strip(chain.v4.poolManager));
  check(`${chain.key}: poolManager() identical from StateView+Quoter+PositionManager`, allMatch,
    allMatch ? chain.v4.poolManager : crossResults.map(([s, g]) => `${s}→${g}`).join(" · "));

  // 3. PositionManager.permit2() == canonical Permit2
  let permit2Got = "call failed";
  try { permit2Got = addrFromWord(await call(chain.v4.positionManager, SEL_PERMIT2)); } catch {}
  check(`${chain.key}: PositionManager.permit2() == canonical`, strip(permit2Got) === strip(CANONICAL_PERMIT2), permit2Got);

  // 4. UniversalRouter deployed bytecode embeds PoolManager + Permit2 (immutables in code)
  const routerCode = (codes.universalRouter ?? "0x").toLowerCase();
  const embedsPM = routerCode.includes(strip(chain.v4.poolManager));
  const embedsP2 = routerCode.includes(strip(CANONICAL_PERMIT2));
  check(`${chain.key}: UniversalRouter bytecode embeds PoolManager + Permit2`, embedsPM && embedsP2,
    `poolManager:${embedsPM} permit2:${embedsP2} (${(routerCode.length - 2) / 2}b code)`);

  // 4b. Hyde gateway (where configured): deployed code + executeSwap selector +
  //     the chain's UniversalRouter embedded as an immutable. Permit2 embedding
  //     reported as INFO only (see header — not expected in a pass-through gateway).
  if (chain.gateway) {
    const gwCode = ((await code(chain.gateway)) ?? "0x").toLowerCase();
    const gwHasSel = gwCode.includes(SEL_EXECUTE_SWAP);
    const gwEmbedsRouter = gwCode.includes(strip(chain.v4.universalRouter));
    check(`${chain.key}: gateway ${chain.gateway.slice(0, 10)}… code + executeSwap selector + embeds UniversalRouter`,
      gwCode !== "0x" && gwHasSel && gwEmbedsRouter,
      `${(gwCode.length - 2) / 2}b · selector:${gwHasSel} · embedsRouter:${gwEmbedsRouter} · embedsPermit2(info):${gwCode.includes(strip(CANONICAL_PERMIT2))}`);
  }

  // 5. wrapped native + every token candidate proves symbol()+decimals()
  const tokenChecks = [{ symbol: chain.wrappedNative.expectSymbol, addr: chain.wrappedNative.addr, decimals: 18 }, ...chain.tokens];
  for (const t of tokenChecks) {
    let got = { symbol: "?", decimals: -1 };
    try {
      got.symbol = decodeString(await call(t.addr, SEL_SYMBOL));
      got.decimals = parseInt(await call(t.addr, SEL_DECIMALS), 16);
    } catch {}
    check(`${chain.key}: token ${t.symbol} @ ${t.addr.slice(0, 10)}… symbol+decimals prove out`,
      got.symbol === t.symbol && got.decimals === t.decimals,
      `on-chain: ${got.symbol}/${got.decimals} expected ${t.symbol}/${t.decimals}`);
  }
}

console.log(`\n${pass}/${pass + fail} chain-verification checks passed`);
process.exitCode = fail === 0 ? 0 : 1;
