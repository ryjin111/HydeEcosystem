// /api/launch-meta — creator-signed OFF-CHAIN metadata (image + description) for own-stack launch
// tokens whose contract stores only name/symbol (HydeERC20 has no tokenURI). GET is a public read;
// POST is an authenticated write.
//
// SECURITY (kami 22853/22867 · gojo 22859/22864). The write is authenticated by a CREATOR WALLET
// SIGNATURE, never a bare address claim:
//   • Signed message = fixed purpose/version prefix + chainId + token + image + issuedAt + description
//     (domain-separated so a signature from any OTHER Hyde flow — SIWE etc. — can't be lifted/replayed).
//   • Server recovers the signer and verifies it equals the token's ON-CHAIN launch creator, read from
//     the factory's LaunchCreated event ON THE RPC FOR THE SAME chainId in the payload (chainId-bound),
//     bounded from the factory deploy block (never fromBlock:0). No LaunchCreated ⇒ reject.
//   • Replay/rollback guard is ATOMIC: a single Lua compare-and-write enforces per-(chainId,token)
//     strictly-increasing issuedAt + creator-immutability in one server-side op (no read→compare→write
//     race). Any KV failure ⇒ 502 (never "treat as create"). Plus a bounded issuedAt freshness window.
//   • Strict input validation (real CID shape, 64/65-byte signature, size cap even for pre-parsed
//     bodies, trimmed description), rate-limited, fails CLOSED when KV / abuse-control is unconfigured.
// A metadata failure NEVER affects the already-confirmed launch — the client surfaces an explicit retry.
import { createPublicClient, http, parseAbiItem, recoverMessageAddress, isAddress, getAddress } from "viem";
import { OWNSTACK } from "./_ownstack.js";
import { kvConfigured, kvHGetAll, kvEval } from "./_kv.js";
import { abuseControlConfigured, checkRateLimit, clientIp } from "./_ratelimit.js";

const json = (res, status, body) => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
};

const LAUNCH_CREATED = parseAbiItem(
  "event LaunchCreated(address indexed token, address indexed creator, bytes32 indexed poolId, uint256 tokenId, uint256 presetId)"
);
// HOODIE launcher-launcher tokens emit this from the engine (carrying the HUMAN creator) instead of the
// WETH factory's LaunchCreated. `token` is indexed, so `args:{token}` filters exactly like the WETH path.
const HOODIE_LAUNCH_CREATED = parseAbiItem(
  "event HoodieLaunchCreated(address indexed launcher, address indexed creator, address indexed token, bytes32 poolId, uint256 tokenId)"
);
// Stable V3 launches use the same HydeERC20 implementation but a V3-specific pad/event shape.
const STABLE_V3_LAUNCH_CREATED = parseAbiItem(
  "event LaunchCreated(address indexed token, address indexed creator, address pool, uint256 tokenId, uint128 liquidity)"
);

const MAX_DESC = 280;
const MAX_BODY = 16 * 1024;
const FRESH_WINDOW_SEC = 600; // the signature must be issued within ±10 min (bounds replay)
// Real CID shape: CIDv0 (base58btc `Qm…`) or CIDv1 base32 (`b…`). Rejects fakes like `ipfs://aaaa…`.
// pin-image returns a BARE file CID (no subpath), so `/` is intentionally disallowed (gojo LOW-2).
const IPFS_RE = /^ipfs:\/\/(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,})$/;
// 65-byte (r,s,v) or 64-byte EIP-2098 compact signature — no unbounded hex.
const SIG_RE = /^0x([0-9a-fA-F]{130}|[0-9a-fA-F]{128})$/;

const key = (chainId, token) => `launchmeta:${chainId}:${token.toLowerCase()}`;

// Atomic compare-and-write: reject a non-increasing issuedAt (replay/rollback) or a creator change,
// else HSET the record — all in one Redis op so concurrent writes can't reorder past the guard.
const CAS_SCRIPT = `
local curIssued = redis.call('HGET', KEYS[1], 'issuedAt')
if curIssued and tonumber(ARGV[1]) <= tonumber(curIssued) then return 'REPLAY' end
local curCreator = redis.call('HGET', KEYS[1], 'creator')
if curCreator and string.lower(curCreator) ~= string.lower(ARGV[2]) then return 'CREATOR_MISMATCH' end
redis.call('HSET', KEYS[1], 'issuedAt', ARGV[1], 'creator', ARGV[2], 'image', ARGV[3], 'description', ARGV[4], 'updatedAt', ARGV[5])
return 'OK'
`;

/** Canonical signed message — MUST byte-match src/utils/launchMeta.ts buildLaunchMetaMessage().
 *  The literal first line is the domain/purpose tag (prevents cross-flow signature replay). Built from
 *  the RECEIVED field values (never re-parsed from the message), so free text in `description` — which
 *  is last — can never forge an earlier field. */
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

/** Authoritative creator for a token, read from LaunchCreated on the RPC for THIS chainId, bounded
 *  from the factory deploy block (never fromBlock:0 — kami B-blocker #2 / gojo LOW-1). */
export async function onchainCreator(cfg, token, client = createPublicClient({ transport: http(cfg.rpc) })) {
  // Primary source: the WETH HydeTokenFactory's LaunchCreated.
  if (cfg.factory) {
    const wethLogs = await client.getLogs({
      address: cfg.factory, event: LAUNCH_CREATED, args: { token },
      fromBlock: cfg.deploymentBlock, toBlock: "latest",
    });
    if (wethLogs.length) return getAddress(wethLogs[0].args.creator);
  }
  // Second source (if configured): the HOODIE engine's HoodieLaunchCreated — the human creator, bounded
  // from the engine's OWN deploy block. The signer==creator check downstream is unchanged (no weakening).
  if (cfg.hoodieEngine) {
    const hoodieLogs = await client.getLogs({
      address: cfg.hoodieEngine, event: HOODIE_LAUNCH_CREATED, args: { token },
      fromBlock: cfg.hoodieDeploymentBlock, toBlock: "latest",
    });
    if (hoodieLogs.length) return getAddress(hoodieLogs[0].args.creator);
  }
  // Stable V3 source: HydeV3Pad.LaunchCreated carries the immutable human creator.
  if (cfg.v3Pad) {
    const v3Logs = await client.getLogs({
      address: cfg.v3Pad, event: STABLE_V3_LAUNCH_CREATED, args: { token },
      fromBlock: cfg.v3DeploymentBlock, toBlock: "latest",
    });
    if (v3Logs.length) return getAddress(v3Logs[0].args.creator);
  }
  return null;
}

async function readJson(req) {
  if (req.body && typeof req.body === "object") {
    // Enforce the size cap even when Vercel supplies an already-parsed body (kami B-blocker #3).
    if (JSON.stringify(req.body).length > MAX_BODY) throw new Error("too large");
    return req.body;
  }
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
    const rec = await kvHGetAll(key(chainId, token));
    return json(res, 200, {
      meta: rec ? { image: rec.image || "", description: rec.description || "" } : null,
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
  } catch (err) {
    if (err?.message === "too large") return json(res, 413, { error: "payload too large" });
    return json(res, 400, { error: "invalid JSON body" });
  }
  const { chainId: rawChainId, token, image = "", description = "", issuedAt, signature } = body || {};
  const chainId = Number(rawChainId);
  const cfg = OWNSTACK[chainId];

  // ── strict validation ──────────────────────────────────────────────────────
  if (!cfg) return json(res, 400, { error: "unsupported chain" });
  if (typeof token !== "string" || !isAddress(token)) return json(res, 400, { error: "bad token address" });
  if (typeof image !== "string" || (image !== "" && !IPFS_RE.test(image))) return json(res, 400, { error: "image must be a valid ipfs:// CID" });
  if (typeof description !== "string" || description.length > MAX_DESC) return json(res, 400, { error: `description must be ≤ ${MAX_DESC} chars` });
  if (!Number.isInteger(issuedAt)) return json(res, 400, { error: "bad issuedAt" });
  if (typeof signature !== "string" || !SIG_RE.test(signature)) return json(res, 400, { error: "bad signature" });

  // Store the TRIMMED description so a whitespace-only value can't render an empty box (kami B-blocker #4).
  const descStored = description.trim();
  if (image === "" && descStored === "") return json(res, 400, { error: "nothing to save" });

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - issuedAt) > FRESH_WINDOW_SEC) return json(res, 400, { error: "signature expired — re-sign", code: "STALE" });

  // ── recover the signer from the domain-separated message (received values, verbatim) ─────────────
  let signer;
  try {
    signer = await recoverMessageAddress({
      message: canonicalMessage({ chainId, token, image, description, issuedAt }),
      signature,
    });
  } catch {
    return json(res, 400, { error: "signature recovery failed" });
  }

  // ── verify against the ON-CHAIN creator for THIS chainId (authoritative, deploy-block-bounded) ───
  let creator;
  try {
    creator = await onchainCreator(cfg, token);
  } catch {
    return json(res, 502, { error: "couldn't verify the creator on-chain — retry", code: "RPC" });
  }
  if (!creator) return json(res, 404, { error: "not an own-stack launch on this chain" });
  if (getAddress(signer) !== creator) return json(res, 403, { error: "signer is not the token creator" });

  // ── ATOMIC compare-and-write (replay/rollback + creator-immutability in one op) ──────────────────
  let result;
  try {
    result = await kvEval(CAS_SCRIPT, [key(chainId, token)], [issuedAt, creator, image, descStored, now]);
  } catch {
    return json(res, 502, { error: "save failed — retry", code: "STORE" });
  }
  if (result === "REPLAY") return json(res, 409, { error: "stale update — re-sign", code: "REPLAY" });
  if (result === "CREATOR_MISMATCH") return json(res, 403, { error: "creator mismatch" });
  if (result !== "OK") return json(res, 502, { error: "save failed — retry", code: "STORE" });

  return json(res, 200, { ok: true, meta: { image, description: descStored } });
}

export default async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (req.method === "GET") return handleGet(res, url);
  if (req.method === "POST") return handlePost(req, res);
  res.setHeader("Allow", "GET, POST");
  return json(res, 405, { error: "Method not allowed" });
}
