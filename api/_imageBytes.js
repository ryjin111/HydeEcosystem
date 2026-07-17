// Launch-image byte validation for the pin gate (kami locked spec 22280/22285).
// Locked v1: STATIC PNG/JPEG only, readable EXACTLY 500×500, ≤2 MB. We sniff the actual bytes
// (browser MIME never trusted) AND require readable dimensions — magic bytes alone don't prove a
// real raster, and an unreadable header fails CLOSED. GIF/WebP/SVG/everything else is rejected.
// Underscore-prefixed so Vercel doesn't route it; imported by api/pin-image.js AND the smoke.

/** Hard ceiling for the uploaded (already client-resized) image. tokenURI/IPFS budget. */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 2 MB

/** The launch avatar is a fixed square — the client resizes to this, the server enforces it. */
export const REQUIRED_WIDTH = 500;
export const REQUIRED_HEIGHT = 500;

/** Raster MIME types the Upload control advertises (client pre-check + accept attr). */
export const ALLOWED_IMAGE_MIME = ["image/png", "image/jpeg"];

const startsWith = (buf, bytes, offset = 0) =>
  buf.length >= offset + bytes.length && bytes.every((b, i) => buf[offset + i] === b);

/**
 * Detect the true image format from the leading bytes. PNG or JPEG only — everything else
 * (GIF, WebP, SVG, HTML, text, truncated, or a spoofed content-type) returns null.
 * @param {Uint8Array|Buffer} buf
 * @returns {'png'|'jpeg'|null}
 */
export function sniffImageType(buf) {
  if (!buf || buf.length < 12) return null;
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png"; // \x89PNG\r\n\x1a\n
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return "jpeg";                               // JPEG SOI
  return null;
}

/** Canonical content-type for a sniffed raster kind. */
export function contentTypeFor(kind) {
  return kind === "jpeg" ? "image/jpeg" : "image/png";
}

/**
 * Parse width/height from the format header (no full decode, no deps).
 * Returns { width, height } when confidently readable, else null (caller fails CLOSED).
 * @param {Buffer} buf
 * @param {'png'|'jpeg'} kind
 */
export function imageDimensions(buf, kind) {
  try {
    if (kind === "png") {
      // IHDR: width @16, height @20 (8-byte sig + 4-byte len + "IHDR")
      if (buf.length < 24) return null;
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (kind === "jpeg") {
      let o = 2;
      while (o + 9 < buf.length) {
        if (buf[o] !== 0xff) { o++; continue; }
        const marker = buf[o + 1];
        // SOF0..SOF15 carry frame dimensions (excl. DHT 0xC4, DAC 0xCC, RSTn 0xC8)
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: buf.readUInt16BE(o + 5), width: buf.readUInt16BE(o + 7) };
        }
        if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { o += 2; continue; }
        const segLen = buf.readUInt16BE(o + 2);
        if (segLen < 2) return null;
        o += 2 + segLen;
      }
      return null;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Full raster validation: PNG/JPEG magic-byte sniff + readable EXACT 500×500.
 * Fails CLOSED for a non-raster (GIF/WebP/SVG/spoof) AND for an unreadable header — magic bytes
 * alone are not proof of a real image, so an unparseable dimension header is rejected.
 * @param {Buffer} buf
 * @returns {{ ok: true, kind: string, width: number, height: number } | { ok: false, code: string }}
 */
export function validateRaster(buf) {
  const kind = sniffImageType(buf);
  if (!kind) return { ok: false, code: "NOT_RASTER" };

  const dim = imageDimensions(buf, kind);
  if (!dim) return { ok: false, code: "UNREADABLE" }; // fail closed — can't confirm a real raster

  if (dim.width !== REQUIRED_WIDTH || dim.height !== REQUIRED_HEIGHT) {
    return { ok: false, code: "DIMENSIONS" };
  }
  return { ok: true, kind, width: dim.width, height: dim.height };
}
