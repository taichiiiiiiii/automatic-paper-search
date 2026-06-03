// Tests for worker/response.js — the helper module extracted from
// worker/index.ts in Phase 0c (theme-pipeline v2). Pins behavior of:
//
//   json()                    — JSON response envelope + cache/CORS headers
//   isRateLimited()           — per-IP KV bucket, 1h TTL, 5/h cap
//   isGloballyRateLimited()   — global KV bucket, 24h TTL, 100/day cap
//
// Why: worker/index.ts grows in v2 (queue consumer, callback, R2 manifest
// route). Splitting these helpers out keeps each surface unit-testable
// and removes the temptation to test them indirectly via the fetch
// entry-point.

import {
  json,
  isRateLimited,
  isGloballyRateLimited,
  RATE_LIMIT_PER_HOUR,
  RATE_LIMIT_GLOBAL_PER_DAY,
} from "./response.js";

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; process.stdout.write(`  ok  ${name}\n`); })
    .catch((e) => {
      failed++;
      failures.push({ name, e });
      process.stdout.write(`  FAIL ${name}\n    ${e.stack || e.message}\n`);
    });
}
function eq(a, b, msg = "") {
  if (a !== b) throw new Error(`${msg}\n    expected: ${JSON.stringify(b)}\n    actual:   ${JSON.stringify(a)}`);
}
function truthy(v, msg) { if (!v) throw new Error(msg || `expected truthy, got ${v}`); }

// Minimal in-memory KV stub — only the methods we use (get/put). put
// records the TTL so we can assert the bucket window.
function makeKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  const ttls = new Map();
  return {
    async get(key) { return store.has(key) ? String(store.get(key)) : null; },
    async put(key, value, opts) {
      store.set(key, value);
      if (opts?.expirationTtl) ttls.set(key, opts.expirationTtl);
    },
    _store: store,
    _ttls: ttls,
  };
}

const tests = [];

// ---- json() ----

tests.push(test("json() sets content-type application/json; charset=utf-8", async () => {
  const r = json({ ok: true, status: "queued", slug: "x" });
  eq(r.headers.get("content-type"), "application/json; charset=utf-8");
}));

tests.push(test("json() sets cache-control no-store", async () => {
  const r = json({ ok: true, status: "queued" });
  eq(r.headers.get("cache-control"), "no-store");
}));

tests.push(test("json() sets access-control-allow-origin: * (GH Pages cross-origin)", async () => {
  // The viewer ships from github.io and the Worker lives on a *.workers.dev
  // (or CF custom domain). Without ACAO the browser blocks the response.
  const r = json({ ok: true, status: "queued" });
  eq(r.headers.get("access-control-allow-origin"), "*");
}));

tests.push(test("json() does NOT set vary: origin when ACAO is *", async () => {
  // Vary: Origin is meaningful only when ACAO reflects the request
  // origin — with a static "*" it just splits CDN cache by origin
  // header for nothing. Pin removal so a future review doesn't
  // re-add it without flipping ACAO too.
  const r = json({ ok: true, status: "queued" });
  eq(r.headers.get("vary"), null);
}));

tests.push(test("json() serializes the body", async () => {
  const r = json({ ok: false, status: "error", message: "boom" });
  const parsed = await r.json();
  eq(parsed.ok, false);
  eq(parsed.status, "error");
  eq(parsed.message, "boom");
}));

tests.push(test("json() propagates init.status code", async () => {
  const r = json({ ok: false, status: "rate_limited" }, { status: 429 });
  eq(r.status, 429);
}));

tests.push(test("json() defaults to 200 when init omits status", async () => {
  const r = json({ ok: true, status: "queued" });
  eq(r.status, 200);
}));

// ---- isRateLimited() ----

tests.push(test("isRateLimited returns false on first hit", async () => {
  const kv = makeKV();
  eq(await isRateLimited("1.2.3.4", kv), false);
  eq(kv._store.get("rl:1.2.3.4"), "1");
}));

tests.push(test("isRateLimited increments the counter", async () => {
  const kv = makeKV({ "rl:1.2.3.4": "3" });
  eq(await isRateLimited("1.2.3.4", kv), false);
  eq(kv._store.get("rl:1.2.3.4"), "4");
}));

tests.push(test("isRateLimited returns true at the cap", async () => {
  const kv = makeKV({ "rl:1.2.3.4": String(RATE_LIMIT_PER_HOUR) });
  eq(await isRateLimited("1.2.3.4", kv), true);
}));

tests.push(test("isRateLimited does NOT write when already over cap", async () => {
  // Defensive: a request that's already rate-limited must not increment
  // the counter further. Without this guard, a hostile client could
  // push the bucket arbitrarily high and grief subsequent good-faith
  // requests when KV expirationTtl resets the window.
  const kv = makeKV({ "rl:abuse": String(RATE_LIMIT_PER_HOUR + 3) });
  eq(await isRateLimited("abuse", kv), true);
  eq(kv._store.get("rl:abuse"), String(RATE_LIMIT_PER_HOUR + 3));
  eq(kv._ttls.has("rl:abuse"), false, "TTL must not be (re)set on over-cap read");
}));

tests.push(test("isRateLimited sets 1h TTL on the IP bucket", async () => {
  const kv = makeKV();
  await isRateLimited("9.9.9.9", kv);
  eq(kv._ttls.get("rl:9.9.9.9"), 3600);
}));

tests.push(test("isRateLimited handles unparseable raw count", async () => {
  const kv = makeKV({ "rl:1.2.3.4": "garbage" });
  eq(await isRateLimited("1.2.3.4", kv), false);
  eq(kv._store.get("rl:1.2.3.4"), "1");
}));

// ---- isGloballyRateLimited() ----

tests.push(test("isGloballyRateLimited returns false on first hit", async () => {
  const kv = makeKV();
  eq(await isGloballyRateLimited(kv), false);
}));

tests.push(test("isGloballyRateLimited returns true at the daily cap", async () => {
  const today = new Date().toISOString().slice(0, 10);
  const kv = makeKV({ [`rl:global:${today}`]: String(RATE_LIMIT_GLOBAL_PER_DAY) });
  eq(await isGloballyRateLimited(kv), true);
}));

tests.push(test("isGloballyRateLimited does NOT write when already over cap", async () => {
  const today = new Date().toISOString().slice(0, 10);
  const key = `rl:global:${today}`;
  const kv = makeKV({ [key]: String(RATE_LIMIT_GLOBAL_PER_DAY + 7) });
  eq(await isGloballyRateLimited(kv), true);
  eq(kv._store.get(key), String(RATE_LIMIT_GLOBAL_PER_DAY + 7));
  eq(kv._ttls.has(key), false);
}));

tests.push(test("isGloballyRateLimited sets 24h TTL", async () => {
  const kv = makeKV();
  await isGloballyRateLimited(kv);
  const today = new Date().toISOString().slice(0, 10);
  eq(kv._ttls.get(`rl:global:${today}`), 86400);
}));

tests.push(test("isGloballyRateLimited keys by UTC date", async () => {
  const kv = makeKV();
  await isGloballyRateLimited(kv);
  const today = new Date().toISOString().slice(0, 10);
  truthy(kv._store.has(`rl:global:${today}`), "key should be rl:global:<today UTC>");
}));

tests.push(test("constants expose the documented caps", async () => {
  eq(RATE_LIMIT_PER_HOUR, 5);
  eq(RATE_LIMIT_GLOBAL_PER_DAY, 100);
}));

await Promise.all(tests);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.e.stack || f.e.message}`);
  process.exit(1);
}
