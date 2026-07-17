// Headless smoke: locked v1 launch-image gate (kami 22280/22285 · clint 500×500).
// Imports the REAL server modules the /api/pin-image handler runs — not mirrors — then drift-guards
// the form is upload-only + auto-resizes and the endpoint enforces the locked spec:
//   static PNG/JPEG only · readable EXACTLY 500×500 · ≤2 MB · KV limiter only (no bypass) · no upstream body.
// Node 24 strips the .ts types at import; no build step. Red here = the locked gate is broken.
import { readFileSync } from "node:fs";
import {
  sniffImageType, contentTypeFor, MAX_IMAGE_BYTES,
  validateRaster, imageDimensions, REQUIRED_WIDTH, REQUIRED_HEIGHT,
} from "../api/_imageBytes.js";
import { abuseControlConfigured, rateLimitConfig } from "../api/_ratelimit.js";
import { preCheckImageFile, ALLOWED_IMAGE_MIME } from "../src/utils/imageValidation.ts";

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
};

const u16BE = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n, 0); return b; };
const pngWH = (w, h) => {
  const b = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b;
};
const jpegWH = (w, h) => Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08]), u16BE(h), u16BE(w), Buffer.alloc(8),
]);
const GIF89 = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(8)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x24, 0, 0, 0]), Buffer.from("WEBP"), Buffer.alloc(4)]);

// ─── Format sniff: PNG/JPEG only; GIF/WebP/SVG now REJECTED ──────────────────
check("sniff PNG", sniffImageType(pngWH(500, 500)) === "png");
check("sniff JPEG", sniffImageType(jpegWH(500, 500)) === "jpeg");
check("REJECT gif (dropped from v1)", sniffImageType(GIF89) === null);
check("REJECT webp (dropped from v1)", sniffImageType(WEBP) === null);
check("REJECT svg bytes", sniffImageType(Buffer.from('<svg onload=alert(1)></svg>')) === null);
check("REJECT html bytes", sniffImageType(Buffer.from("<!DOCTYPE html><html></html>")) === null);
check("REJECT renamed-svg-as-png (byte truth over MIME)", sniffImageType(Buffer.from("<svg/>")) === null);
check("contentTypeFor png/jpeg", contentTypeFor("png") === "image/png" && contentTypeFor("jpeg") === "image/jpeg");
check("MAX_IMAGE_BYTES is 2 MB", MAX_IMAGE_BYTES === 2 * 1024 * 1024);
check("REQUIRED dims are 500×500", REQUIRED_WIDTH === 500 && REQUIRED_HEIGHT === 500);

// ─── Dimensions: exact 500×500, readable, fail CLOSED otherwise ──────────────
check("dim: png 500×500 parsed", (d => d && d.width === 500 && d.height === 500)(imageDimensions(pngWH(500, 500), "png")));
check("dim: jpeg 500×500 parsed", (d => d && d.width === 500 && d.height === 500)(imageDimensions(jpegWH(500, 500), "jpeg")));
check("validateRaster: exact 500×500 png OK", validateRaster(pngWH(500, 500)).ok === true);
check("validateRaster: exact 500×500 jpeg OK", validateRaster(jpegWH(500, 500)).ok === true);
check("validateRaster: 512×512 rejected (DIMENSIONS)", (r => !r.ok && r.code === "DIMENSIONS")(validateRaster(pngWH(512, 512))));
check("validateRaster: 500×501 rejected (DIMENSIONS)", (r => !r.ok && r.code === "DIMENSIONS")(validateRaster(pngWH(500, 501))));
check("validateRaster: unreadable png header rejected (UNREADABLE, fail CLOSED)",
  (r => !r.ok && r.code === "UNREADABLE")(validateRaster(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(4)]))));
check("validateRaster: gif rejected (NOT_RASTER)", (r => !r.ok && r.code === "NOT_RASTER")(validateRaster(GIF89)));
check("validateRaster: svg rejected (NOT_RASTER)", (r => !r.ok && r.code === "NOT_RASTER")(validateRaster(Buffer.from("<svg/>"))));

// ─── Abuse control: KV limiter ONLY, no env bypass ───────────────────────────
delete process.env.KV_REST_API_URL; delete process.env.KV_REST_API_TOKEN; delete process.env.PIN_ABUSE_CONTROL;
check("abuse: unconfigured → false (endpoint fails closed)", abuseControlConfigured() === false);
process.env.PIN_ABUSE_CONTROL = "external";
check("abuse: env flag does NOT satisfy (bypass removed)", abuseControlConfigured() === false);
delete process.env.PIN_ABUSE_CONTROL;
process.env.KV_REST_API_URL = "https://example.upstash.io"; process.env.KV_REST_API_TOKEN = "tok";
check("abuse: only KV limiter satisfies the guard", abuseControlConfigured() === true);
delete process.env.KV_REST_API_URL; delete process.env.KV_REST_API_TOKEN;

// ─── Rate config: positive + bounded (window=0/NaN can't defeat it) ──────────
delete process.env.PIN_RATE_LIMIT; delete process.env.PIN_RATE_WINDOW_SEC;
check("rate: defaults 20 / 3600", (c => c.limit === 20 && c.windowSec === 3600)(rateLimitConfig()));
process.env.PIN_RATE_WINDOW_SEC = "0";
check("rate: window=0 rejected → default 3600", rateLimitConfig().windowSec === 3600);
process.env.PIN_RATE_WINDOW_SEC = "-5";
check("rate: negative window → default", rateLimitConfig().windowSec === 3600);
process.env.PIN_RATE_WINDOW_SEC = "abc";
check("rate: NaN window → default", rateLimitConfig().windowSec === 3600);
process.env.PIN_RATE_WINDOW_SEC = "600"; process.env.PIN_RATE_LIMIT = "50";
check("rate: valid config parsed (50 / 600)", (c => c.limit === 50 && c.windowSec === 600)(rateLimitConfig()));
process.env.PIN_RATE_LIMIT = "0";
check("rate: limit=0 rejected → default 20", rateLimitConfig().limit === 20);
delete process.env.PIN_RATE_LIMIT; delete process.env.PIN_RATE_WINDOW_SEC;

// ─── Client pre-check (UX only) ──────────────────────────────────────────────
check("preCheck allowlist is PNG/JPEG only", ALLOWED_IMAGE_MIME.length === 2 && ALLOWED_IMAGE_MIME.includes("image/png") && ALLOWED_IMAGE_MIME.includes("image/jpeg"));
check("preCheck: png ok", preCheckImageFile({ type: "image/png", size: 1000 }).ok === true);
check("preCheck: gif rejected", preCheckImageFile({ type: "image/gif", size: 100 }).ok === false);
check("preCheck: svg rejected", preCheckImageFile({ type: "image/svg+xml", size: 100 }).ok === false);

// ─── Drift guard: form upload-only + auto-resize ─────────────────────────────
const formSrc = readFileSync(new URL("../src/components/LaunchTokenForm.tsx", import.meta.url), "utf8");
check("drift: form POSTs to /api/pin-image", formSrc.includes("/api/pin-image"));
check("drift: form auto-resizes to 500×500 (canvas)", formSrc.includes("toAvatarBlob") && formSrc.includes("createImageBitmap") && formSrc.includes("canvas.toBlob"));
check("drift: form uploads a normalized image/png blob", formSrc.includes('"Content-Type": "image/png"'));
check("drift: form stores the returned ipfs:// uri", formSrc.includes("data.uri") && formSrc.includes('startsWith("ipfs://")'));
check("drift: NO readAsDataURL / paste / data: path", !formSrc.includes("readAsDataURL") && !/setImageUrl\(e\.target\.value/.test(formSrc));
check("drift: accept is PNG/JPEG only (no gif/webp/svg)", formSrc.includes('accept="image/png,image/jpeg"') && !formSrc.includes("image/gif") && !formSrc.includes("image/webp") && !formSrc.includes("image/svg+xml"));

// ─── Drift guard: server gate matches locked spec ────────────────────────────
const handlerSrc = readFileSync(new URL("../api/pin-image.js", import.meta.url), "utf8");
check("drift: handler validateRaster (exact 500×500) before pinning", handlerSrc.includes("validateRaster"));
check("drift: handler fails closed 503 (Filebase + abuse control)", handlerSrc.includes("isConfigured") && handlerSrc.includes("abuseControlConfigured") && handlerSrc.includes("NO_ABUSE_CONTROL"));
check("drift: handler rate-limits with 429", handlerSrc.includes("checkRateLimit") && handlerSrc.includes("429"));
check("drift: 502 leaks NO upstream detail (server console only)", !/502,\s*\{[^}]*detail/.test(handlerSrc) && handlerSrc.includes("console.error"));

const rlSrc = readFileSync(new URL("../api/_ratelimit.js", import.meta.url), "utf8");
check("drift: rate-limit bypass flag REMOVED", !rlSrc.includes("PIN_ABUSE_CONTROL"));
check("drift: rate config bounded", rlSrc.includes("boundedInt"));

const fbSrc = readFileSync(new URL("../api/_filebase.js", import.meta.url), "utf8");
check("drift: filebase never reads/returns upstream body", !fbSrc.includes("res.text()"));

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exitCode = fail ? 1 : 0; // natural exit — process.exit() trips a libuv teardown assert on Windows
