// Abuse control for the public credential-backed pin endpoint (kami 22263 blocker 1).
// Fixed-window per-IP limiter backed by Vercel KV / Upstash Redis (REST). Shared state is
// required — an in-memory counter is bypassable across serverless instances, so this uses KV.
// Underscore-prefixed so Vercel does not route it; imported by api/pin-image.js.
//
// Config (Vercel env):
//   KV_REST_API_URL + KV_REST_API_TOKEN   → enables the server-side limiter (Upstash-compatible)
//     (Upstash's own integration names them UPSTASH_REDIS_REST_URL/TOKEN — accepted as aliases, KV_* wins)
//   PIN_RATE_LIMIT (default 20) · PIN_RATE_WINDOW_SEC (default 3600)
// The limiter is the ONLY accepted abuse control — there is no env bypass (a flag without a real
// gate is zero control and would expose the paid pin credentials publicly, kami 22283).

const kvUrl = () => process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const kvToken = () => process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
const kvConfigured = () => Boolean(kvUrl() && kvToken());

/** True only when the shared KV limiter is configured. The pin endpoint fails CLOSED otherwise. */
export function abuseControlConfigured() {
  return kvConfigured();
}

/** Positive-bounded integer from env, else the default — a 0/negative/NaN window can't defeat the limiter. */
function boundedInt(raw, def, min, max) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) return def;
  return n;
}

/** Effective, validated limiter config (exported so the bound-checking is directly testable). */
export function rateLimitConfig() {
  return {
    limit: boundedInt(process.env.PIN_RATE_LIMIT, 20, 1, 10000),
    windowSec: boundedInt(process.env.PIN_RATE_WINDOW_SEC, 3600, 1, 86400),
  };
}

/**
 * Consume one token for `ip` in the current fixed window.
 * @returns {Promise<{ allowed: boolean, enforced: boolean, count?: number, limit?: number }>}
 * When only an external edge control is configured (no KV), returns enforced:false, allowed:true
 * (the edge already rate-limited before we ran). Fails CLOSED (allowed:false) if KV errors.
 */
export async function checkRateLimit(ip) {
  if (!kvConfigured()) return { allowed: true, enforced: false };

  const { limit, windowSec } = rateLimitConfig();
  const bucket = Math.floor(Date.now() / 1000 / windowSec);
  const key = `pinrl:${bucket}:${ip || "unknown"}`;
  const base = kvUrl().replace(/\/+$/, "");

  try {
    const res = await fetch(`${base}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${kvToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify([["INCR", key], ["EXPIRE", key, windowSec]]),
    });
    if (!res.ok) return { allowed: false, enforced: true }; // fail closed on store error
    const data = await res.json();
    const count = Number(Array.isArray(data) ? data?.[0]?.result : data?.result) || 0;
    return { allowed: count <= limit, enforced: true, count, limit };
  } catch {
    return { allowed: false, enforced: true }; // fail closed — never silently drop the limit
  }
}

/** Best-effort client IP from Vercel's forwarded headers. */
export function clientIp(req) {
  const xff = req.headers?.["x-forwarded-for"];
  if (typeof xff === "string" && xff.length) return xff.split(",")[0].trim();
  return req.headers?.["x-real-ip"] || "unknown";
}
