// POST /api/pin-image — the single server-side gate for launch images (kami 22245/22249/22263).
// Fail-closed abuse control (rate-limit) → raw bytes → 2 MB cap → magic-byte + dimension raster
// validation (browser MIME never trusted) → pin to Pinata IPFS → { cid, uri: "ipfs://<cid>" }.
// Fails CLOSED (503) when the Pinata credential OR an abuse control are unconfigured. Upstream failure
// detail is logged server-side only — callers get a generic 502 (no key/internal leakage).
import { validateRaster, contentTypeFor, MAX_IMAGE_BYTES } from "./_imageBytes.js";
import { isConfigured, pinToPinata } from "./_pinata.js";
import { abuseControlConfigured, checkRateLimit, clientIp } from "./_ratelimit.js";

const json = (res, status, body) => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
};

/** Read the request body into a Buffer, aborting past `max` bytes (streamed size gate). */
async function readBodyCapped(req, max) {
  if (Buffer.isBuffer(req.body)) {
    if (req.body.length > max) throw Object.assign(new Error("too large"), { code: "TOO_LARGE" });
    return req.body;
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > max) throw Object.assign(new Error("too large"), { code: "TOO_LARGE" });
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  // Fail closed BEFORE reading a body: no credentials ⇒ no pin, no silent fallback.
  if (!isConfigured()) {
    return json(res, 503, { error: "Image uploads aren't configured yet.", code: "UNCONFIGURED" });
  }
  // Fail closed when the KV rate-limiter isn't configured — a public credential-backed pin
  // endpoint must never be enabled without an enforceable abuse control (no env bypass).
  if (!abuseControlConfigured()) {
    return json(res, 503, { error: "Image uploads aren't configured yet.", code: "NO_ABUSE_CONTROL" });
  }

  const rl = await checkRateLimit(clientIp(req));
  if (!rl.allowed) return json(res, 429, { error: "Too many uploads — please try again later." });

  let body;
  try {
    body = await readBodyCapped(req, MAX_IMAGE_BYTES);
  } catch (err) {
    if (err?.code === "TOO_LARGE") return json(res, 413, { error: "Image too large (max 2 MB)." });
    return json(res, 400, { error: "Could not read the uploaded image." });
  }
  if (!body || body.length === 0) return json(res, 400, { error: "Empty upload." });

  // Authoritative check: the actual bytes must be a raster within the dimension caps. A renamed
  // SVG/HTML/polyglot claiming image/png, or a decompression-bomb canvas, is rejected here.
  const check = validateRaster(body);
  if (!check.ok) {
    return json(res, 415, { error: "Only a static PNG or JPG at exactly 500×500 (≤2 MB) is accepted." });
  }

  try {
    const { cid } = await pinToPinata(body, contentTypeFor(check.kind), check.kind === "jpeg" ? "jpg" : check.kind);
    return json(res, 200, { cid, uri: `ipfs://${cid}` });
  } catch (err) {
    if (err?.code === "UNCONFIGURED") {
      return json(res, 503, { error: "Image uploads aren't configured yet.", code: "UNCONFIGURED" });
    }
    // Diagnostics stay server-side; callers get a generic message (no upstream/key leakage).
    console.error("[pin-image] pin failed:", String(err?.message || err));
    return json(res, 502, { error: "Pinning failed — please try again." });
  }
}
