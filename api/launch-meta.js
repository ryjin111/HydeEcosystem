// /api/launch-meta — creator-signed OFF-CHAIN metadata (image + description) for own-stack launch
// tokens whose contract stores only name/symbol (HydeERC20 has no tokenURI). GET is a public read;
// POST is an authenticated write.
//
// SECURITY (kami 22853 · gojo 22859). The write is authenticated by a CREATOR WALLET SIGNATURE, never
// a bare address claim:
//   • Signed message = fixed purpose/version prefix + chainId + token + image + issuedAt + description
//     (domain-separated so a signature from any OTHER Hyde flow — SIWE etc. — can't be lifted/replayed).
//   • Server recovers the signer and verifies it equals the token's ON-CHAIN launch creator, read from
//     the factory's LaunchCreated event ON THE RPC FOR THE SAME chainId that is in the signed payload
//     (chainId-bound lookup — a testnet sig can't be validated against a mainnet creator).
//   • No LaunchCreated for the token ⇒ no creator ⇒ reject (un-launched addresses can't be pre-seeded).
//   • Replay guard: bounded issuedAt freshness window AND per-(chainId,token) monotonic issuedAt.
//   • Namespaced by chainId:token, creator-only updates, strict CID/description limits, rate-limited,
//     fails CLOSED when KV / abuse-control is unconfigured.
// A metadata failure NEVER affects the already-confirmed launch — the client surfaces an explicit retry.
import { createPublicClient, http, parseAbiItem, recoverMessageAddress, isAddress, getAddress } from "viem";
import { kvConfigured, kvGetJSON, kvSetJSON } from "./_kv.js";
import { abuseControlConfigured, checkRateLimit, clientIp } from "./_ratelimit.js";

const json = (res, status, body) => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
};

// Own-stack chains that support off-chain metadata. chainId → its RPC + HydeTokenFactory. Extend as
// own-stack deploys land on new chains (mainnet 4663 rides Doppler today → not here).
const OWNSTACK = {
  46630: { rpc: "https://rpc.testnet.chain.robinhood.com", factory: "0x136914042064972913D54f024CccBA049C8cF03F" },
};
const LAUNCH_CREATED = parseAbiItem(
  "event LaunchCreated(address indexed token, address indexed creator, bytes32 indexed poolId, uint256 tokenId, uint256 presetId)"
);

const MAX_DESC = 280;
const IPFS_RE = /^ipfs:\/\/[A-Za-z0-9]{20,120}$/;
const FRESH_WINDOW_SEC = 600; // the signature must be issued within ±10 min (bounds replay)
const MAX_BODY = 16 * 1024;

const key = (chainId, token) => `launchmeta:${chainId}:${token.toLowerCase()}`;

/** Canonical signed message — MUST byte-match src/utils/launchMeta.ts buildLaunchMetaMessage().
 *  The literal first line is the domain/purpose tag (prevents cross-flow signature replay). */
function canonicalMessage({ chainId, token, image, description, issuedAt }) {
  return [
    "Hyde launch metadata v1",
    `chainId:${chainId}`,
    `token:${token.toLowerCase()}`,
    `image:${image || ""}`,
    `issuedAt:${issuedAt}`,
    `description:${description ?? ""}`,
  ].join("\n");
}

/** Authoritative creator for a token, read from LaunchCreated on the RPC for THIS chainId. */
async function onchainCreator(chainId, token) {
  const cfg = OWNSTACK[chainId];
  if (!cfg) return null;
  const client = createPublicClient({ transport: http(cfg.rpc) });
  // Single indexed-token filter; the own-stack factory is recently deployed (small history).
  const logs = await client.getLogs({
    address: cfg.factory,
    event: LAUNCH_CREATED,
    args: { token },
    fromBlock: 0n,
    toBlock: "latest",
  });
  if (!logs.length) return null;
  return getAddress(logs[0].args.creator);
}

async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  let total = 0;
  for await (const c of req) {
    const b = Buffer.isBuffer(c) ? c : Buffer.from(c);
    total += b.length;
    if (total > MAX_BODY) throw new Error("too large");
    chunks.push(b);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function handleGet(res, url) {
  const chainId = Number(url.searchParams.get("chainId"));
  const token = url.searchParams.get("token") || "";
  if (!OWNSTACK[chainId] || !isAddress(token)) return json(res, 400, { error: "bad request" });
  if (!kvConfigured()) return json(res, 200, { meta: null }); // no store → nothing indexed (honest)
  try {
    const meta = await kvGetJSON(key(chainId, token));
    return json(res, 200, {
      meta: meta ? { image: meta.image || "", description: meta.description || "" } : null,
    });
  } catch {
    return json(res, 200, { meta: null }); // fail-neutral read
  }
}

async function handlePost(req, res) {
  // Fail CLOSED before any work when the store or its abuse control isn't configured.
  if (!kvConfigured()) return json(res, 503, { error: "Metadata store isn't configured yet.", code: "UNCONFIGURED" });
  if (!abuseControlConfigured()) return json(res, 503, { error: "Metadata store isn't configured yet.", code: "NO_ABUSE_CONTROL" });

  const rl = await checkRateLimit(clientIp(req));
  if (!rl.allowed) return json(res, 429, { error: "Too many requests — try again later." });

  let body;
  try {
    body = await readJson(req);
  } catch {
    return json(res, 400, { error: "invalid JSON body" });
  }
  const { chainId: rawChainId, token, image = "", description = "", issuedAt, signature } = body || {};
  const chainId = Number(rawChainId);

  // ── strict validation ──────────────────────────────────────────────────────
  if (!OWNSTACK[chainId]) return json(res, 400, { error: "unsupported chain" });
  if (typeof token !== "string" || !isAddress(token)) return json(res, 400, { error: "bad token address" });
  if (typeof image !== "string" || (image !== "" && !IPFS_RE.test(image))) return json(res, 400, { error: "image must be an ipfs:// CID" });
  if (typeof description !== "string" || description.length > MAX_DESC) return json(res, 400, { error: `description must be ≤ ${MAX_DESC} chars` });
  if (image === "" && description.trim() === "") return json(res, 400, { error: "nothing to save" });
  if (!Number.isInteger(issuedAt)) return json(res, 400, { error: "bad issuedAt" });
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature)) return json(res, 400, { error: "bad signature" });

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - issuedAt) > FRESH_WINDOW_SEC) return json(res, 400, { error: "signature expired — re-sign", code: "STALE" });

  // ── recover the signer from the domain-separated message ────────────────────
  let signer;
  try {
    signer = await recoverMessageAddress({
      message: canonicalMessage({ chainId, token, image, description, issuedAt }),
      signature,
    });
  } catch {
    return json(res, 400, { error: "signature recovery failed" });
  }

  // ── verify against the ON-CHAIN creator for THIS chainId (authoritative) ─────
  let creator;
  try {
    creator = await onchainCreator(chainId, token);
  } catch {
    return json(res, 502, { error: "couldn't verify the creator on-chain — retry", code: "RPC" });
  }
  if (!creator) return json(res, 404, { error: "not an own-stack launch on this chain" });
  if (getAddress(signer) !== creator) return json(res, 403, { error: "signer is not the token creator" });

  // ── creator-only update + per-namespace monotonic replay guard ──────────────
  const k = key(chainId, token);
  let existing = null;
  try {
    existing = await kvGetJSON(k);
  } catch {
    /* treat as create */
  }
  if (existing) {
    if (existing.creator && getAddress(existing.creator) !== creator) return json(res, 403, { error: "creator mismatch" });
    if (typeof existing.issuedAt === "number" && issuedAt <= existing.issuedAt) return json(res, 409, { error: "stale update — re-sign", code: "REPLAY" });
  }

  try {
    await kvSetJSON(k, { image, description, creator, issuedAt, updatedAt: now });
  } catch {
    return json(res, 502, { error: "save failed — retry", code: "STORE" });
  }
  return json(res, 200, { ok: true, meta: { image, description } });
}

export default async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (req.method === "GET") return handleGet(res, url);
  if (req.method === "POST") return handlePost(req, res);
  res.setHeader("Allow", "GET, POST");
  return json(res, 405, { error: "Method not allowed" });
}
