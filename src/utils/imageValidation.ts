/**
 * Client-side pre-check for launch-image uploads (upload-only v1 · kami locked 22280/22285).
 *
 * UX sugar only. The AUTHORITATIVE gate is server-side in `api/_imageBytes.js` (PNG/JPEG magic
 * bytes + readable EXACTLY 500×500 + ≤2 MB) — the browser `file.type` can be spoofed, so nothing
 * here is trusted for security. The form auto-resizes the picked image to a 500×500 PNG before
 * upload, so a legit picture never has to be hand-cropped; the server still enforces 500×500.
 * There is no URL / `data:` / paste path — every image goes through `/api/pin-image`.
 */

/** Server-enforced cap on the stored (already-resized) image. */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/** Client guard on the SOURCE file before we load it into a canvas (avoid OOM on huge inputs). */
export const MAX_SOURCE_BYTES = 10 * 1024 * 1024;

/** The fixed launch-avatar square the client resizes to and the server requires. */
export const AVATAR_SIZE = 500;

/** Static raster types the Upload control advertises via its `accept` attribute. */
export const ALLOWED_IMAGE_MIME = ["image/png", "image/jpeg"] as const;

export type PreCheck = { ok: true } | { ok: false; error: string };

/** Fast, spoofable pre-check before upload. Server magic-byte + dimension validation is authoritative. */
export function preCheckImageFile(file: { type: string; size: number }): PreCheck {
  if (!ALLOWED_IMAGE_MIME.includes(file.type as (typeof ALLOWED_IMAGE_MIME)[number])) {
    return { ok: false, error: "Choose a PNG or JPG image." };
  }
  if (file.size > MAX_SOURCE_BYTES) {
    return { ok: false, error: "Image too large (max 10 MB)." };
  }
  return { ok: true };
}
