// Headless smoke: the Pinata pin adapter (clint 23712 "you use the pinata now"; kami 23715/23730).
// Imports the REAL api/_pinata.js the /api/pin-image handler runs — not a mirror — and drives it with a
// mocked global fetch (no network). Verifies: fail-closed when unconfigured; multipart POST with Bearer
// auth to BOTH the proven classic endpoint (default → `IpfsHash`) and the v3 endpoint (override → adds
// `network=public`, `data.cid`); CID-shape validation; and on ANY upstream failure throw PIN_FAILED
// carrying the status ONLY (never the upstream body — no key/internal leak, kami 22285).
import { isConfigured, pinToPinata } from "../api/_pinata.js";

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
};

// clint's real CIDv1 (23709) — the exact shape his dedicated Pinata gateway serves + launch-meta's IPFS_RE accepts.
const CID = "bafkreiewq3r2t2jwazwyvfuwp7h2sd2k6hw26tu73xfz3g6cxlsexfveum";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // bytes are pre-validated upstream

const realFetch = globalThis.fetch;
let last = null;
const install = (impl) => { globalThis.fetch = async (url, init) => { last = { url, init }; return impl(url, init); }; };
const ok200 = (obj) => ({ ok: true, status: 200, json: async () => obj });
const call = async () => { try { return { r: await pinToPinata(PNG, "image/png", "png") }; } catch (e) { return { e }; } };

// ── fail CLOSED when unconfigured ────────────────────────────────────────────
delete process.env.PINATA_JWT; delete process.env.PINATA_PIN_ENDPOINT;
check("isConfigured() false without PINATA_JWT", isConfigured() === false);
check("unconfigured → throws UNCONFIGURED (no fetch)", (await call()).e?.code === "UNCONFIGURED");

process.env.PINATA_JWT = "test.jwt.value";
check("isConfigured() true with PINATA_JWT", isConfigured() === true);

// ── DEFAULT: proven classic pinning API → IpfsHash ───────────────────────────
install(() => ok200({ IpfsHash: CID, PinSize: 123, Timestamp: "t" }));
const classic = await call();
check("default → returns cid from IpfsHash (classic)", classic.r?.cid === CID);
check("default POSTs to the proven classic pinFileToIPFS endpoint",
  last.url === "https://api.pinata.cloud/pinning/pinFileToIPFS" && last.init.method === "POST");
check("Authorization: Bearer <jwt> sent", last.init.headers.Authorization === "Bearer test.jwt.value");
check("classic body carries `file` only (no `network` — matches Potatopad's proven contract)",
  last.init.body instanceof FormData && last.init.body.has("file") && !last.init.body.has("network"));
check("no manual Content-Type (fetch derives the multipart boundary)",
  !("Content-Type" in last.init.headers) && !("content-type" in last.init.headers));

// ── OVERRIDE: v3 upload API → adds network=public, reads data.cid ─────────────
process.env.PINATA_PIN_ENDPOINT = "https://uploads.pinata.cloud/v3/files";
install(() => ok200({ data: { cid: CID, id: "abc" } }));
const v3 = await call();
check("v3 override → returns cid from data.cid", v3.r?.cid === CID);
check("v3 override POSTs to uploads.pinata.cloud/v3/files", last.url === "https://uploads.pinata.cloud/v3/files");
check("v3 body carries `file` + `network=public`",
  last.init.body.has("file") && last.init.body.get("network") === "public");
delete process.env.PINATA_PIN_ENDPOINT;

// ── failure modes all fail closed as PIN_FAILED, status-only (no upstream body leak) ─────────────────
install(() => ({ ok: false, status: 503, text: async () => "SECRET UPSTREAM ERROR", json: async () => ({ err: "SECRET" }) }));
const bad = await call();
check("non-200 → PIN_FAILED", bad.e?.code === "PIN_FAILED");
check("error message carries status ONLY, not the upstream body",
  bad.e && bad.e.message.includes("503") && !/SECRET/i.test(bad.e.message));

install(() => ok200({ IpfsHash: "not-a-real-cid" }));
check("invalid CID shape → PIN_FAILED", (await call()).e?.code === "PIN_FAILED");

install(() => ok200({ nope: true }));
check("missing CID → PIN_FAILED", (await call()).e?.code === "PIN_FAILED");

install(() => ({ ok: true, status: 200, json: async () => { throw new Error("bad json"); } }));
check("non-JSON upstream → PIN_FAILED", (await call()).e?.code === "PIN_FAILED");

install(() => { throw new Error("network down"); });
check("transport throw → PIN_FAILED", (await call()).e?.code === "PIN_FAILED");

globalThis.fetch = realFetch;
console.log(`\n${pass}/${pass + fail} checks passed`);
process.exitCode = fail ? 1 : 0; // natural exit — process.exit() trips a libuv teardown assert on Windows
