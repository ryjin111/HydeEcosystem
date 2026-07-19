// Minimal Vercel KV / Upstash Redis (REST) helpers. Reuses the SAME env the pin-image rate-limiter
// uses (KV_REST_API_URL + KV_REST_API_TOKEN) — no new provisioning. Underscore-prefixed: not routed.

const base = () => (process.env.KV_REST_API_URL || "").replace(/\/+$/, "");
const token = () => process.env.KV_REST_API_TOKEN || "";

/** True only when the shared KV store is configured. Callers fail CLOSED otherwise. */
export function kvConfigured() {
  return Boolean(base() && token());
}

/** Run one Redis command via the Upstash REST pipeline. Throws on any transport/command error so the
 *  caller can fail closed (never silently degrade). */
async function command(args) {
  const res = await fetch(`${base()}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
    body: JSON.stringify([args]),
  });
  if (!res.ok) throw new Error(`KV ${res.status}`);
  const data = await res.json();
  const entry = Array.isArray(data) ? data[0] : data;
  if (entry && entry.error) throw new Error(`KV cmd error: ${entry.error}`);
  return entry ? entry.result : null;
}

/** HGETALL → plain object, or null when the hash is missing/empty. Throws on transport error. */
export async function kvHGetAll(key) {
  const raw = await command(["HGETALL", key]);
  if (!raw) return null;
  if (Array.isArray(raw)) {
    if (raw.length === 0) return null;
    const obj = {};
    for (let i = 0; i + 1 < raw.length; i += 2) obj[raw[i]] = raw[i + 1];
    return obj;
  }
  return typeof raw === "object" && Object.keys(raw).length ? raw : null;
}

/** Atomic Lua EVAL — the compare-and-write happens in ONE server-side op (no read→compare→write race).
 *  Throws on transport error so the caller returns 502 rather than treating a failure as a fresh write. */
export async function kvEval(script, keys, args) {
  return command(["EVAL", script, String(keys.length), ...keys, ...args.map((a) => String(a))]);
}
