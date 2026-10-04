// Tests for worker/themes-post.js — the POST /api/themes orchestration
// extracted from worker/index.ts (M-5b) so the full chain can run under
// plain Node 20 (no TS-strip step, so index.ts itself cannot be
// imported here — see worker/README.md).
//
// Covers: origin/content-type/body-size gates run first and short
// circuit before any KV read/write or subrequest (M-1, L-6); a manifest
// fetch failure never collapses into "exists" (H-1); a KV put throw or
// a dispatch throw both fail closed as JSON errors instead of an
// uncaught 500 (L-1); redirect: "manual" on both outbound fetches (L-7; workerd rejects "error");
// and the full happy-path order (input validation → manifest dedup →
// per-IP limit → global cap → dispatch → response).

import { createThemesPostHandler, MAX_BODY_BYTES } from "./themes-post.js";
import { PAGES_ORIGIN } from "./response.js";

let passed = 0;
let failed = 0;
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

const PAT = "ghp_super-secret-dispatch-token";
const ENV = {
  GH_OWNER: "taichiiiiiiii",
  GH_REPO: "automatic-paper-search",
  GH_WORKFLOW_FILE: "theme-on-demand.yml",
  GH_REF: "develop",
  GH_DISPATCH_PAT: PAT,
};

function makeKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  let getCalls = 0;
  let putCalls = 0;
  const kv = {
    async get(key) { getCalls++; return store.has(key) ? String(store.get(key)) : null; },
    async put(key, value) { putCalls++; store.set(key, value); },
    get calls() { return getCalls + putCalls; },
  };
  return kv;
}

function throwingKV(message = "KV unavailable") {
  return {
    async get() { throw new Error(message); },
    async put() { throw new Error(message); },
  };
}

function putThrowingKV(message = "KV put failed") {
  return {
    async get() { return null; },
    async put() { throw new Error(message); },
  };
}

// Programmable fetch stub keyed by URL prefix. Each call is recorded
// (url, init) so tests can assert call counts, order, and that
// `redirect: "manual"` was actually passed through.
function makeFetch({ manifest, dispatch } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    if (url.startsWith("https://raw.githubusercontent.com")) {
      if (typeof manifest === "function") return manifest(url, init);
      if (manifest?.throws) throw manifest.throws;
      return manifest?.response ?? new Response("[]", { status: 200 });
    }
    if (url.startsWith("https://api.github.com")) {
      if (typeof dispatch === "function") return dispatch(url, init);
      if (dispatch?.throws) throw dispatch.throws;
      return dispatch?.response ?? new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch url: ${url}`);
  };
  impl.calls = calls;
  return impl;
}

function postRequest(body = { theme: "Vision Transformer" }, headers = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Request("https://worker.test/api/themes", {
    method: "POST",
    headers: {
      origin: PAGES_ORIGIN,
      "content-type": "application/json",
      "cf-connecting-ip": "203.0.113.5",
      ...headers,
    },
    body: text,
  });
}

async function readJson(response) {
  return JSON.parse(await response.text());
}

const tests = [];

// ---- construction ----

tests.push(test("createThemesPostHandler requires an injected fetch", () => {
  let threw = false;
  try { createThemesPostHandler({}); } catch (e) { threw = e instanceof TypeError; }
  truthy(threw, "expected TypeError without fetch");
}));

// ---- M-1: origin gate ----

tests.push(test("rejects a POST with a mismatched Origin, 403, before any work", async () => {
  const fetchImpl = makeFetch();
  const kv = makeKV();
  const handlePost = createThemesPostHandler({ fetch: fetchImpl });
  const request = postRequest({ theme: "Vision Transformer" }, { origin: "https://evil.example" });
  const response = await handlePost(request, { ...ENV, RATE_LIMIT_KV: kv });
  eq(response.status, 403);
  eq((await readJson(response)).ok, false);
  eq(fetchImpl.calls.length, 0, "must not fetch the manifest or dispatch");
  eq(kv.calls, 0, "must not touch KV");
}));

tests.push(test("rejects a POST with no Origin header, 403", async () => {
  const fetchImpl = makeFetch();
  const handlePost = createThemesPostHandler({ fetch: fetchImpl });
  const request = new Request("https://worker.test/api/themes", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.5" },
    body: JSON.stringify({ theme: "Vision Transformer" }),
  });
  const response = await handlePost(request, { ...ENV, RATE_LIMIT_KV: makeKV() });
  eq(response.status, 403);
  eq(fetchImpl.calls.length, 0);
}));

tests.push(test("origin rejection carries the fixed-origin CORS headers", async () => {
  const handlePost = createThemesPostHandler({ fetch: makeFetch() });
  const request = postRequest({ theme: "x" }, { origin: "https://evil.example" });
  const response = await handlePost(request, { ...ENV, RATE_LIMIT_KV: makeKV() });
  eq(response.headers.get("access-control-allow-origin"), PAGES_ORIGIN);
  eq(response.headers.get("vary"), "Origin");
}));

// ---- M-1: content-type gate ----

tests.push(test("rejects a non-JSON content-type, 415, before any work", async () => {
  const fetchImpl = makeFetch();
  const kv = makeKV();
  const handlePost = createThemesPostHandler({ fetch: fetchImpl });
  const request = postRequest({ theme: "Vision Transformer" }, { "content-type": "text/plain" });
  const response = await handlePost(request, { ...ENV, RATE_LIMIT_KV: kv });
  eq(response.status, 415);
  eq(fetchImpl.calls.length, 0);
  eq(kv.calls, 0);
}));

tests.push(test("accepts application/json with a charset parameter", async () => {
  const fetchImpl = makeFetch();
  const handlePost = createThemesPostHandler({ fetch: fetchImpl });
  const request = postRequest(
    { theme: "Vision Transformer" },
    { "content-type": "application/json; charset=utf-8" },
  );
  const response = await handlePost(request, { ...ENV, RATE_LIMIT_KV: makeKV() });
  eq(response.status, 200);
}));

tests.push(test("rejects a missing content-type header, 415", async () => {
  const handlePost = createThemesPostHandler({ fetch: makeFetch() });
  const request = new Request("https://worker.test/api/themes", {
    method: "POST",
    headers: { origin: PAGES_ORIGIN, "cf-connecting-ip": "203.0.113.5" },
    body: JSON.stringify({ theme: "Vision Transformer" }),
  });
  const response = await handlePost(request, { ...ENV, RATE_LIMIT_KV: makeKV() });
  eq(response.status, 415);
}));

// ---- M-1: content-type gate, additional non-JSON-but-json-ish types ----

tests.push(test("rejects content-type application/json-seq, 415", async () => {
  const fetchImpl = makeFetch();
  const handlePost = createThemesPostHandler({ fetch: fetchImpl });
  const request = postRequest({ theme: "Vision Transformer" }, { "content-type": "application/json-seq" });
  const response = await handlePost(request, { ...ENV, RATE_LIMIT_KV: makeKV() });
  eq(response.status, 415);
  eq(fetchImpl.calls.length, 0);
}));

tests.push(test("rejects content-type application/jsonp, 415", async () => {
  const fetchImpl = makeFetch();
  const handlePost = createThemesPostHandler({ fetch: fetchImpl });
  const request = postRequest({ theme: "Vision Transformer" }, { "content-type": "application/jsonp" });
  const response = await handlePost(request, { ...ENV, RATE_LIMIT_KV: makeKV() });
  eq(response.status, 415);
  eq(fetchImpl.calls.length, 0);
}));

// ---- L-6: body size gate ----

tests.push(test("rejects a declared content-length over 1KB, 413, without reading the body", async () => {
  const fetchImpl = makeFetch();
  const kv = makeKV();
  const handlePost = createThemesPostHandler({ fetch: fetchImpl });
  // The title promises the body is never read — assert that for real via
  // a stream whose pull() flips a flag, instead of only inferring it from
  // the absence of downstream side effects (no fetch/KV calls).
  //
  // highWaterMark: 0 is load-bearing: a default ReadableStream (hwm 1)
  // proactively invokes pull() on construction to pre-fill its internal
  // queue, regardless of whether anything ever calls getReader().read() —
  // that's the stream's own queuing behavior, not a signal that our
  // handler read it. With hwm 0 the desired size is never positive, so
  // pull() only fires in response to an explicit .read() call, which is
  // exactly what readBoundedBody() in themes-post.js must never make when
  // content-length already exceeds the cap.
  let pulled = false;
  const stream = new ReadableStream({
    pull(controller) {
      pulled = true;
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ theme: "x".repeat(2000) })));
      controller.close();
    },
  }, { highWaterMark: 0 });
  const request = new Request("https://worker.test/api/themes", {
    method: "POST",
    headers: {
      origin: PAGES_ORIGIN,
      "content-type": "application/json",
      "cf-connecting-ip": "203.0.113.5",
      "content-length": String(MAX_BODY_BYTES + 1),
    },
    body: stream,
    duplex: "half",
  });
  const response = await handlePost(request, { ...ENV, RATE_LIMIT_KV: kv });
  eq(response.status, 413);
  eq(fetchImpl.calls.length, 0);
  eq(kv.calls, 0);
  eq(pulled, false, "the body stream must never be read when content-length already exceeds the cap");
}));

tests.push(test("rejects a body that streams past 1KB even without content-length", async () => {
  const fetchImpl = makeFetch();
  const handlePost = createThemesPostHandler({ fetch: fetchImpl });
  const oversized = JSON.stringify({ theme: "x".repeat(2000) });
  const request = new Request("https://worker.test/api/themes", {
    method: "POST",
    headers: { origin: PAGES_ORIGIN, "content-type": "application/json", "cf-connecting-ip": "203.0.113.5" },
    body: oversized,
  });
  const response = await handlePost(request, { ...ENV, RATE_LIMIT_KV: makeKV() });
  eq(response.status, 413);
  eq(fetchImpl.calls.length, 0);
}));

tests.push(test("accepts a body exactly at the 1KB boundary (content-length path)", async () => {
  // validatePostInput only reads `.theme`; an extra `pad` field is inert
  // for validation but lets the body reach exactly MAX_BODY_BYTES so this
  // test actually exercises the boundary, not a ~30-byte body.
  const base = JSON.stringify({ theme: "Vision Transformer", pad: "" });
  const padLen = MAX_BODY_BYTES - base.length;
  truthy(padLen >= 0, `base body already exceeds MAX_BODY_BYTES: ${base.length}`);
  const body = JSON.stringify({ theme: "Vision Transformer", pad: "x".repeat(padLen) });
  eq(body.length, MAX_BODY_BYTES, "test setup must hit the boundary exactly");
  const handlePost = createThemesPostHandler({ fetch: makeFetch() });
  const request = postRequest(body, { "content-length": String(body.length) });
  const response = await handlePost(request, { ...ENV, RATE_LIMIT_KV: makeKV() });
  eq(response.status, 200);
}));

// ---- parse / validation (unchanged ordering) ----

tests.push(test("invalid JSON body -> 400 invalid, before manifest/KV", async () => {
  const fetchImpl = makeFetch();
  const kv = makeKV();
  const handlePost = createThemesPostHandler({ fetch: fetchImpl });
  const request = postRequest("not json");
  const response = await handlePost(request, { ...ENV, RATE_LIMIT_KV: kv });
  eq(response.status, 400);
  eq((await readJson(response)).status, "invalid");
  eq(fetchImpl.calls.length, 0);
  eq(kv.calls, 0);
}));

tests.push(test("invalid theme pattern -> 400 invalid, before manifest/KV", async () => {
  const fetchImpl = makeFetch();
  const kv = makeKV();
  const handlePost = createThemesPostHandler({ fetch: fetchImpl });
  const request = postRequest({ theme: "$(rm -rf ~)" });
  const response = await handlePost(request, { ...ENV, RATE_LIMIT_KV: kv });
  eq(response.status, 400);
  eq((await readJson(response)).status, "invalid");
  eq(fetchImpl.calls.length, 0);
  eq(kv.calls, 0);
}));

// ---- H-1: manifest-failure fail-closed contract ----

tests.push(test("manifest fetch throw -> 503 error (not exists), no KV charge, no dispatch", async () => {
  const fetchImpl = makeFetch({ manifest: { throws: new Error("network down") } });
  const kv = makeKV();
  const handlePost = createThemesPostHandler({ fetch: fetchImpl });
  const response = await handlePost(postRequest(), { ...ENV, RATE_LIMIT_KV: kv });
  eq(response.status, 503);
  const body = await readJson(response);
  eq(body.ok, false);
  eq(body.status, "error");
  eq(kv.calls, 0, "no rate-limit charge on manifest failure");
  eq(fetchImpl.calls.length, 1, "must not reach dispatch");
}));

tests.push(test("manifest non-ok response -> 503 error (not exists)", async () => {
  const fetchImpl = makeFetch({ manifest: { response: new Response("gateway timeout", { status: 504 }) } });
  const handlePost = createThemesPostHandler({ fetch: fetchImpl });
  const response = await handlePost(postRequest(), { ...ENV, RATE_LIMIT_KV: makeKV() });
  eq(response.status, 503);
  eq((await readJson(response)).status, "error");
}));

tests.push(test("manifest JSON parse error -> 503 error (not exists)", async () => {
  const fetchImpl = makeFetch({ manifest: { response: new Response("not json", { status: 200 }) } });
  const handlePost = createThemesPostHandler({ fetch: fetchImpl });
  const response = await handlePost(postRequest(), { ...ENV, RATE_LIMIT_KV: makeKV() });
  eq(response.status, 503);
  eq((await readJson(response)).status, "error");
}));

tests.push(test("manifest valid JSON that is not an array -> 503 error (not exists)", async () => {
  const fetchImpl = makeFetch({
    manifest: { response: new Response(JSON.stringify({ slug: "vision-transformer" }), { status: 200 }) },
  });
  const handlePost = createThemesPostHandler({ fetch: fetchImpl });
  const response = await handlePost(postRequest(), { ...ENV, RATE_LIMIT_KV: makeKV() });
  eq(response.status, 503);
  eq((await readJson(response)).status, "error");
}));

tests.push(test("manifest array containing the slug -> exists, no KV charge, no dispatch", async () => {
  const fetchImpl = makeFetch({
    manifest: { response: new Response(JSON.stringify([{ slug: "vision-transformer" }]), { status: 200 }) },
  });
  const kv = makeKV();
  const handlePost = createThemesPostHandler({ fetch: fetchImpl });
  const response = await handlePost(postRequest({ theme: "Vision Transformer" }), { ...ENV, RATE_LIMIT_KV: kv });
  eq(response.status, 200);
  const body = await readJson(response);
  eq(body.ok, true);
  eq(body.status, "exists");
  eq(body.slug, "vision-transformer");
  eq(kv.calls, 0);
  eq(fetchImpl.calls.length, 1, "must not reach dispatch");
}));

tests.push(test("manifest array without the slug -> proceeds to dispatch (queued)", async () => {
  const fetchImpl = makeFetch({ manifest: { response: new Response(JSON.stringify([{ slug: "other" }]), { status: 200 }) } });
  const handlePost = createThemesPostHandler({ fetch: fetchImpl });
  const response = await handlePost(postRequest({ theme: "Vision Transformer" }), { ...ENV, RATE_LIMIT_KV: makeKV() });
  eq(response.status, 200);
  const body = await readJson(response);
  eq(body.status, "queued");
  eq(fetchImpl.calls.length, 2, "manifest + dispatch");
}));

// ---- rate limiting (existing behaviour preserved) ----

tests.push(test("missing cf-connecting-ip -> 400, after manifest, before any KV call", async () => {
  const fetchImpl = makeFetch();
  const kv = makeKV();
  const handlePost = createThemesPostHandler({ fetch: fetchImpl });
  const request = postRequest({ theme: "Vision Transformer" }, { "cf-connecting-ip": "" });
  const response = await handlePost(request, { ...ENV, RATE_LIMIT_KV: kv });
  eq(response.status, 400);
  eq(fetchImpl.calls.length, 1, "manifest already checked");
  eq(kv.calls, 0);
}));

tests.push(test("per-IP cap reached -> 429, no dispatch", async () => {
  const fetchImpl = makeFetch();
  const kv = makeKV({ "rl:203.0.113.5": "5" });
  const handlePost = createThemesPostHandler({ fetch: fetchImpl });
  const response = await handlePost(postRequest(), { ...ENV, RATE_LIMIT_KV: kv });
  eq(response.status, 429);
  eq(fetchImpl.calls.length, 1, "must not dispatch");
}));

tests.push(test("global daily cap reached -> 429, no dispatch", async () => {
  const today = new Date().toISOString().slice(0, 10);
  const fetchImpl = makeFetch();
  const kv = makeKV({ [`rl:global:${today}`]: "100" });
  const handlePost = createThemesPostHandler({ fetch: fetchImpl });
  const response = await handlePost(postRequest(), { ...ENV, RATE_LIMIT_KV: kv });
  eq(response.status, 429);
  eq(fetchImpl.calls.length, 1, "must not dispatch");
}));

// ---- L-1: KV put throw and dispatch throw fail closed ----

tests.push(test("per-IP KV throw -> 503 JSON error with CORS headers, no dispatch", async () => {
  const fetchImpl = makeFetch();
  const handlePost = createThemesPostHandler({ fetch: fetchImpl });
  const response = await handlePost(postRequest(), { ...ENV, RATE_LIMIT_KV: throwingKV() });
  eq(response.status, 503);
  eq(response.headers.get("access-control-allow-origin"), PAGES_ORIGIN);
  eq(response.headers.get("vary"), "Origin");
  eq((await readJson(response)).ok, false);
  eq(fetchImpl.calls.length, 1, "must not dispatch");
}));

tests.push(test("per-IP KV put throw (get succeeds) -> 503 JSON error, no dispatch", async () => {
  const fetchImpl = makeFetch();
  const handlePost = createThemesPostHandler({ fetch: fetchImpl });
  const response = await handlePost(postRequest(), { ...ENV, RATE_LIMIT_KV: putThrowingKV() });
  eq(response.status, 503);
  eq(fetchImpl.calls.length, 1);
}));

tests.push(test("global KV throw -> 503 JSON error, no dispatch", async () => {
  const fetchImpl = makeFetch();
  const ipOnly = makeKV();
  const kv = {
    async get(key) { return ipOnly.get(key); },
    async put(key, value) {
      if (key.startsWith("rl:global:")) throw new Error("global KV down");
      return ipOnly.put(key, value);
    },
  };
  const handlePost = createThemesPostHandler({ fetch: fetchImpl });
  const response = await handlePost(postRequest(), { ...ENV, RATE_LIMIT_KV: kv });
  eq(response.status, 503);
  eq(fetchImpl.calls.length, 1);
}));

tests.push(test("dispatchWorkflow throw -> 502 JSON error, not an uncaught exception", async () => {
  const fetchImpl = makeFetch({ dispatch: { throws: new Error("fetch failed") } });
  const handlePost = createThemesPostHandler({ fetch: fetchImpl });
  const response = await handlePost(postRequest(), { ...ENV, RATE_LIMIT_KV: makeKV() });
  eq(response.status, 502);
  const body = await readJson(response);
  eq(body.ok, false);
  truthy(!JSON.stringify(body).includes(PAT), "must not leak the PAT");
}));

tests.push(test("dispatchWorkflow non-ok response -> 502 JSON error", async () => {
  const fetchImpl = makeFetch({ dispatch: { response: new Response("nope", { status: 500 }) } });
  const handlePost = createThemesPostHandler({ fetch: fetchImpl });
  const response = await handlePost(postRequest(), { ...ENV, RATE_LIMIT_KV: makeKV() });
  eq(response.status, 502);
  eq((await readJson(response)).ok, false);
}));

tests.push(test("neither dispatch throw nor failure logs the PAT", async () => {
  const originalError = console.error;
  const logged = [];
  console.error = (...args) => { logged.push(args.join(" ")); };
  try {
    const fetchImpl = makeFetch({ dispatch: { throws: new Error("boom") } });
    const handlePost = createThemesPostHandler({ fetch: fetchImpl });
    await handlePost(postRequest(), { ...ENV, RATE_LIMIT_KV: makeKV() });
    const fetchImpl2 = makeFetch({ dispatch: { response: new Response("server detail", { status: 502 }) } });
    const handlePost2 = createThemesPostHandler({ fetch: fetchImpl2 });
    await handlePost2(postRequest({ theme: "Other Theme" }), { ...ENV, RATE_LIMIT_KV: makeKV() });
  } finally {
    console.error = originalError;
  }
  for (const line of logged) {
    truthy(!line.includes(PAT), `log line leaked the PAT: ${line}`);
  }
}));

// ---- L-7: redirect: "manual" on outbound fetches (a 3xx is !ok, so it fails closed) ----

tests.push(test("manifest fetch passes redirect: manual", async () => {
  const fetchImpl = makeFetch();
  const handlePost = createThemesPostHandler({ fetch: fetchImpl });
  await handlePost(postRequest(), { ...ENV, RATE_LIMIT_KV: makeKV() });
  const manifestCall = fetchImpl.calls.find((c) => c.url.startsWith("https://raw.githubusercontent.com"));
  eq(manifestCall.init.redirect, "manual");
}));

tests.push(test("dispatch fetch passes redirect: manual", async () => {
  const fetchImpl = makeFetch();
  const handlePost = createThemesPostHandler({ fetch: fetchImpl });
  await handlePost(postRequest(), { ...ENV, RATE_LIMIT_KV: makeKV() });
  const dispatchCall = fetchImpl.calls.find((c) => c.url.startsWith("https://api.github.com"));
  eq(dispatchCall.init.redirect, "manual");
}));

tests.push(test("manifest 3xx under redirect: manual -> 503 error, no dispatch", async () => {
  const fetchImpl = makeFetch({
    manifest: { response: new Response(null, { status: 302, headers: { location: "https://attacker.test/" } }) },
  });
  const handlePost = createThemesPostHandler({ fetch: fetchImpl });
  const res = await handlePost(postRequest(), { ...ENV, RATE_LIMIT_KV: makeKV() });
  eq(res.status, 503);
  eq((await readJson(res)).status, "error");
  eq(fetchImpl.calls.filter((c) => c.url.startsWith("https://api.github.com")).length, 0);
}));

tests.push(test("dispatch 3xx under redirect: manual -> 502 error", async () => {
  const fetchImpl = makeFetch({ dispatch: { response: new Response(null, { status: 307, headers: { location: "https://attacker.test/" } }) } });
  const handlePost = createThemesPostHandler({ fetch: fetchImpl });
  const res = await handlePost(postRequest(), { ...ENV, RATE_LIMIT_KV: makeKV() });
  eq(res.status, 502);
}));

// ---- happy path / overall order ----

tests.push(test("happy path: queued response includes slug and server-generated request_id", async () => {
  const fetchImpl = makeFetch();
  const response = await createThemesPostHandler({ fetch: fetchImpl })(
    postRequest({ theme: "Vision Transformer" }),
    { ...ENV, RATE_LIMIT_KV: makeKV() },
  );
  eq(response.status, 200);
  const body = await readJson(response);
  eq(body.ok, true);
  eq(body.status, "queued");
  eq(body.slug, "vision-transformer");
  truthy(/^theme-[0-9a-f-]{36}$/.test(body.request_id), `unexpected request_id: ${body.request_id}`);
  eq(fetchImpl.calls.length, 2);
}));

tests.push(test("happy path response carries the fixed-origin CORS headers", async () => {
  const response = await createThemesPostHandler({ fetch: makeFetch() })(
    postRequest(),
    { ...ENV, RATE_LIMIT_KV: makeKV() },
  );
  eq(response.headers.get("access-control-allow-origin"), PAGES_ORIGIN);
  eq(response.headers.get("vary"), "Origin");
}));

await Promise.all(tests);

// ---- createRequestId failure (unchanged 500 path) ----
//
// Monkey-patches globalThis.crypto.randomUUID, which every other test
// that reaches createRequestId() also calls — so this must run strictly
// after the concurrent batch above finishes, not interleaved with it
// (tests.push() above starts executing immediately; mixing this in would
// make unrelated tests observe the patched throw and fail with a
// spurious 500).
await test("request-id generation failure -> 500, no dispatch", async () => {
  const originalRandomUUID = globalThis.crypto.randomUUID;
  globalThis.crypto.randomUUID = () => { throw new Error("entropy unavailable"); };
  try {
    const fetchImpl = makeFetch();
    const handlePost = createThemesPostHandler({ fetch: fetchImpl });
    const response = await handlePost(postRequest(), { ...ENV, RATE_LIMIT_KV: makeKV() });
    eq(response.status, 500);
    eq(fetchImpl.calls.length, 1, "manifest checked, dispatch never reached");
  } finally {
    globalThis.crypto.randomUUID = originalRandomUUID;
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.e.stack || f.e.message}`);
  process.exit(1);
}
