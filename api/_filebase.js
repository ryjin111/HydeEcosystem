// Filebase IPFS pinning via its S3-compatible API (kami 22245: pin → return CID).
// Self-contained AWS SigV4 signer (Node crypto, no SDK dep). PUT to an IPFS-enabled bucket;
// Filebase returns the pinned CID in the `x-amz-meta-cid` response header.
// Underscore-prefixed so Vercel does not route it; imported by api/pin-image.js.
//
// Config (Vercel env — fail CLOSED if any is missing, never a silent no-pin):
//   FILEBASE_KEY · FILEBASE_SECRET · FILEBASE_BUCKET   (required)
//   FILEBASE_S3_ENDPOINT (default https://s3.filebase.com) · FILEBASE_REGION (default us-east-1)
import { createHash, createHmac, randomUUID } from "node:crypto";

const ENDPOINT = () => (process.env.FILEBASE_S3_ENDPOINT || "https://s3.filebase.com").replace(/\/+$/, "");
const REGION = () => process.env.FILEBASE_REGION || "us-east-1";

/** True only when every required Filebase credential is present. */
export function isConfigured() {
  return Boolean(process.env.FILEBASE_KEY && process.env.FILEBASE_SECRET && process.env.FILEBASE_BUCKET);
}

const sha256hex = (data) => createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();

/** RFC3986 path-segment encoding (S3 canonical URI); '/' preserved by the caller. */
const enc = (s) =>
  encodeURIComponent(s).replace(/[!*'()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

function amzDates() {
  const iso = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ""); // YYYYMMDDTHHMMSSZ
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

/**
 * Pin raster bytes to Filebase IPFS and return the content CID.
 * @param {Buffer} body raw image bytes (already magic-byte validated by the caller)
 * @param {string} contentType canonical image/* type
 * @param {string} ext file extension (png/jpg/gif/webp)
 * @returns {Promise<{ cid: string, key: string }>}
 * @throws Error with .code = 'UNCONFIGURED' | 'PIN_FAILED'
 */
export async function pinToFilebase(body, contentType, ext) {
  if (!isConfigured()) {
    const e = new Error("Filebase is not configured");
    e.code = "UNCONFIGURED";
    throw e;
  }

  const bucket = process.env.FILEBASE_BUCKET;
  const region = REGION();
  const endpoint = ENDPOINT();
  const host = new URL(endpoint).host;
  const key = `launch/${randomUUID()}.${ext}`;

  // Path-style canonical URI: /<bucket>/<key> (each segment encoded, '/' preserved).
  const canonicalUri = "/" + [bucket, ...key.split("/")].map(enc).join("/");
  const { amzDate, dateStamp } = amzDates();
  const payloadHash = sha256hex(body);

  const canonicalHeaders =
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [
    "PUT", canonicalUri, "", canonicalHeaders, signedHeaders, payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonicalRequest),
  ].join("\n");

  const kDate = hmac("AWS4" + process.env.FILEBASE_SECRET, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${process.env.FILEBASE_KEY}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  let res;
  try {
    res = await fetch(`${endpoint}${canonicalUri}`, {
      method: "PUT",
      headers: {
        "Authorization": authorization,
        "x-amz-date": amzDate,
        "x-amz-content-sha256": payloadHash,
        "Content-Type": contentType,
      },
      body,
    });
  } catch (err) {
    const e = new Error(`Filebase request failed: ${err?.message || err}`);
    e.code = "PIN_FAILED";
    throw e;
  }

  if (!res.ok) {
    // Never surface the upstream response body (kami 22285) — status code only, no bucket/internal leak.
    const e = new Error(`Filebase PUT failed (status ${res.status})`);
    e.code = "PIN_FAILED";
    throw e;
  }

  const cid = res.headers.get("x-amz-meta-cid");
  if (!cid || !/^[a-zA-Z0-9]+$/.test(cid)) {
    const e = new Error("Filebase did not return a CID (is the bucket IPFS-enabled?)");
    e.code = "PIN_FAILED";
    throw e;
  }

  return { cid, key };
}
