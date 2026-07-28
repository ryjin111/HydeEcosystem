// Cached, same-origin Robinhood launch index for the SPA. Without this relay every browser independently
// hits Blockscout's public API and cold profile/launchpad loads can be rate-limited (HTTP 429). Vercel's
// shared CDN serves successful snapshots for five minutes and stale snapshots for a day while refreshing.
// This endpoint is read-only and returns only launches from the two pinned Hyde emitters.

const BLOCKSCOUT = "https://robinhoodchain.blockscout.com";
const WETH_FACTORY = "0x159A2fa37427299466B0723713eaa260e6124cbc";
const WETH_FACTORY_BLOCK = 17418907n;
const HOODIE_ENGINE = "0x8062951c99CfFA5365f979D5139Cf96b5c77CFCc";
const HOODIE_ENGINE_BLOCK = 15652257n;
const HOODIE = "0xC72c01AAB5f5678dc1d6f5C6d2B417d91D402Ba3";
const WETH = "0x4200000000000000000000000000000000000006";
const LAUNCH_CREATED_TOPIC = "0x8af4c8ab7fe4c9373619cf9401e1cd3d4a3c3794b4dbc6fdf28648062817790e";
const HOODIE_LAUNCH_CREATED_TOPIC = "0x972f647994f3d28b970cea4db05f18ae9917dc52b856f836eb66266659572ca0";
const MAX_SHOWN = 60;

const json = (res, status, body) => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function resilientFetch(url) {
  let response;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    response = await fetch(url);
    if (response.status !== 429 && response.status < 500) return response;
    if (attempt < 4) await wait(250 * (2 ** attempt));
  }
  return response;
}

function topicAddress(topic) {
  if (typeof topic !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(topic)) return null;
  return `0x${topic.slice(-40)}`;
}

function integer(value) {
  try {
    return Number(BigInt(value));
  } catch {
    return 0;
  }
}

async function explorerLogs(address, fromBlock, topic0) {
  const url = new URL(`${BLOCKSCOUT}/api`);
  url.searchParams.set("module", "logs");
  url.searchParams.set("action", "getLogs");
  url.searchParams.set("fromBlock", fromBlock.toString());
  url.searchParams.set("toBlock", "latest");
  url.searchParams.set("address", address);
  url.searchParams.set("topic0", topic0);
  url.searchParams.set("page", "1");
  url.searchParams.set("offset", "1000");
  const response = await resilientFetch(url);
  if (!response?.ok) throw new Error(`Blockscout logs HTTP ${response?.status ?? 503}`);
  const payload = await response.json();
  if (payload?.status === "1" && Array.isArray(payload.result)) return payload.result;
  if (payload?.status === "0" && payload?.message === "No logs found" && Array.isArray(payload.result)) return [];
  throw new Error(typeof payload?.result === "string" ? payload.result : "Blockscout logs unavailable");
}

async function explorerToken(address) {
  const response = await resilientFetch(`${BLOCKSCOUT}/api/v2/tokens/${address}`);
  if (!response?.ok) throw new Error(`Blockscout token HTTP ${response?.status ?? 503}`);
  const token = await response.json();
  if (!token?.name || !token?.symbol) throw new Error("Blockscout token metadata incomplete");
  return token;
}

export async function loadRobinhoodLaunches() {
  const [wethLogs, hoodieLogs] = await Promise.all([
    explorerLogs(WETH_FACTORY, WETH_FACTORY_BLOCK, LAUNCH_CREATED_TOPIC),
    explorerLogs(HOODIE_ENGINE, HOODIE_ENGINE_BLOCK, HOODIE_LAUNCH_CREATED_TOPIC),
  ]);
  const rows = [
    ...wethLogs.map((log) => ({
      token: topicAddress(log?.topics?.[1]),
      creator: topicAddress(log?.topics?.[2]),
      block: integer(log?.blockNumber),
      timestamp: integer(log?.timeStamp),
      hoodie: false,
    })),
    ...hoodieLogs.map((log) => ({
      token: topicAddress(log?.topics?.[3]),
      creator: topicAddress(log?.topics?.[2]),
      block: integer(log?.blockNumber),
      timestamp: integer(log?.timeStamp),
      hoodie: true,
    })),
  ]
    .filter((row) => row.token)
    .sort((a, b) => b.block - a.block)
    .slice(0, MAX_SHOWN);

  const pools = [];
  for (let index = 0; index < rows.length; index += 5) {
    const batch = rows.slice(index, index + 5);
    const metadata = await Promise.all(batch.map((row) => explorerToken(row.token)));
    batch.forEach((row, offset) => {
      const meta = metadata[offset];
      pools.push({
        address: row.token,
        chainId: 4663,
        baseToken: {
          address: row.token,
          name: meta.name,
          symbol: meta.symbol,
          decimals: meta.decimals ? Number(meta.decimals) : 18,
        },
        quoteToken: row.hoodie
          ? { address: HOODIE, name: "Hoodie", symbol: "HOODIE", decimals: 18 }
          : { address: WETH, name: "Wrapped Ether", symbol: "WETH", decimals: 18 },
        launchEngine: "v4-hook",
        type: "v4",
        dollarLiquidity: null,
        volumeUsd: null,
        marketCapUsd: null,
        priceUsd: null,
        createdAt: new Date(row.timestamp * 1000).toISOString(),
        progress: null,
        creator: row.creator || null,
        creatorClaimable: null,
      });
    });
  }

  const seen = new Set();
  return pools.filter((pool) => {
    const key = pool.address.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return json(res, 405, { error: "method not allowed" });
  }
  try {
    const pools = await loadRobinhoodLaunches();
    res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=86400");
    return json(res, 200, { pools, indexedAt: new Date().toISOString() });
  } catch (error) {
    res.setHeader("Cache-Control", "no-store");
    return json(res, 502, {
      error: error instanceof Error ? error.message : "Robinhood launch index unavailable",
    });
  }
}
