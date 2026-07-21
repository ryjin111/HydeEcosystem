// Pinata IPFS pinning (clint 23712 "you use the pinata now"; kami 23730 confirmed the Potatopad-proven
// contract is safe to mirror). Pinning + display are the SAME provider (clint's dedicated Pinata gateway
// is set as VITE_IPFS_GATEWAY), so every launch image we pin resolves on that gateway — no cross-provider miss.
//
// Endpoint-AGNOSTIC so kami can switch in Vercel with zero code change:
//   • DEFAULT = the Potatopad-proven classic pinning API (works with a plain JWT), returns `IpfsHash`.
//   • v3 upload API (kami 23715) via PINATA_PIN_ENDPOINT=https://uploads.pinata.cloud/v3/files — needs the
//     `network` field and returns `data.cid`. Both response shapes are parsed; the CID_RE guard is identical.
// Self-contained multipart POST (global fetch + FormData, no SDK dep). Underscore-prefixed: not routed.
//
// Config (Vercel env — fail CLOSED if missing, never a silent no-pin):
//   PINATA_JWT                              (required — a scoped Pinata API-key JWT, server-side SECRET)
//   PINATA_PIN_ENDPOINT (optional override; default https://api.pinata.cloud/pinning/pinFileToIPFS)

const ENDPOINT = () =>
  (process.env.PINATA_PIN_ENDPOINT || "https://api.pinata.cloud/pinning/pinFileToIPFS").replace(/\/+$/, "");

/** Real CID shape — CIDv0 (base58btc `Qm…`) or CIDv1 base32 (`b…`) — MUST satisfy launch-meta's IPFS_RE. */
const CID_RE = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,})$/;

/** True only when the Pinata credential is present. Callers fail CLOSED otherwise. */
export function isConfigured() {
  return Boolean(process.env.PINATA_JWT);
}

/**
 * Pin raster bytes to Pinata and return the content CID.
 * @param {Buffer} body raw image bytes (already magic-byte + dimension validated by the caller)
 * @param {string} contentType canonical image/* type
 * @param {string} ext file extension (png/jpg)
 * @returns {Promise<{ cid: string }>}
 * @throws Error with .code = 'UNCONFIGURED' | 'PIN_FAILED'
 */
export async function pinToPinata(body, contentType, ext) {
  if (!isConfigured()) {
    const e = new Error("Pinata is not configured");
    e.code = "UNCONFIGURED";
    throw e;
  }

  const endpoint = ENDPOINT();
  // multipart/form-data — DO NOT set Content-Type manually; fetch derives the boundary from FormData.
  const form = new FormData();
  // The v3 upload API requires a `network` field; the classic pinning API doesn't use it (send only `file`).
  if (endpoint.includes("uploads.pinata.cloud")) form.append("network", "public");
  form.append("file", new Blob([body], { type: contentType }), `launch.${ext}`);

  let res;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.PINATA_JWT}` },
      body: form,
    });
  } catch (err) {
    const e = new Error(`Pinata request failed: ${err?.message || err}`);
    e.code = "PIN_FAILED";
    throw e;
  }

  if (!res.ok) {
    // Never surface the upstream response body (kami 22285) — status code only, no key/internal leak.
    const e = new Error(`Pinata pin failed (status ${res.status})`);
    e.code = "PIN_FAILED";
    throw e;
  }

  let data;
  try {
    data = await res.json();
  } catch {
    const e = new Error("Pinata returned a non-JSON response");
    e.code = "PIN_FAILED";
    throw e;
  }

  // classic → { IpfsHash }; v3 → { data: { cid } }. The CID_RE guard rejects anything malformed either way.
  const cid = (data?.IpfsHash || data?.data?.cid || data?.cid || "").toString();
  if (!CID_RE.test(cid)) {
    const e = new Error("Pinata did not return a valid CID");
    e.code = "PIN_FAILED";
    throw e;
  }

  return { cid };
}
