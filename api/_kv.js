// Minimal Vercel KV / Upstash Redis (REST) JSON helpers. Reuses the SAME env the pin-image
// rate-limiter already uses (KV_REST_API_URL + KV_REST_API_TOKEN) — no new provisioning.
// Underscore-prefixed so Vercel does not route it as an endpoint.

const base = () => (process.env.KV_REST_API_URL || "").replace(/\/+$/, "");
const token = () => process.env.KV_REST_API_TOKEN || "";

/** True only when the shared KV store is configured. Callers fail CLOSED otherwise. */
export function kvConfigured() {
  return Boolean(base() && token());
}

async function pipeline(commands) {
  const res = await fetch(`${base()}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
    body: JSON.stringify(commands),
  });
  if (!res.ok) throw new Error(`KV ${res.status}`);
  return res.json();
}

/** GET a JSON value by key, or null (missing / unparseable). */
export async function kvGetJSON(key) {
  const data = await pipeline([["GET", key]]);
  const raw = Array.isArray(data) ? data[0]?.result : data?.result;
  if (raw == null) return null;
  try {
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

/** SET a JSON value by key (unconditional overwrite — callers gate create/update above this). */
export async function kvSetJSON(key, value) {
  await pipeline([["SET", key, JSON.stringify(value)]]);
}
