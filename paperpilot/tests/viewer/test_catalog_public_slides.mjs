import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rootUrl = pathToFileURL(
  resolve(here, "../../../docs/assets/paper-slides-public-root.js"),
).href;
const coreUrl = pathToFileURL(resolve(here, "../../../docs/assets/catalog-core.js")).href;
await import(`${rootUrl}?contract=public-slides-v2`);
await import(`${coreUrl}?contract=public-slides-v2`);

const Core = globalThis.PaperPilotCatalogCore;
const origin = "https://catalog.example.test";
const paperId = `aa${"1".repeat(38)}`;
const otherPaperId = `aa${"2".repeat(38)}`;
const deckId = `sd1-${"b".repeat(64)}`;
const rootPath = "/automatic-paper-search/paper-slides-v1";

function canonicalBytes(value) {
  return new TextEncoder().encode(`${JSON.stringify(value)}\n`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function deck(overrides = {}) {
  return {
    coverage: { kind: "full_text" },
    deck_id: deckId,
    language: "ja",
    paper_id: paperId,
    review: { status: "reviewed" },
    ...overrides,
  };
}

function entryFor(deckBytes, htmlBytes, overrides = {}) {
  const deckSha256 = sha256(deckBytes);
  const htmlSha256 = sha256(htmlBytes);
  const entry = {
    coverage: "full_text",
    deck_id: deckId,
    deck_sha256: deckSha256,
    html_sha256: htmlSha256,
    language: "ja",
    paper_id: paperId,
    reviewed_at: "2026-08-30T01:00:00Z",
    ...overrides,
  };
  const revisionRoot = `${rootPath}/decks/${entry.deck_id}/${entry.deck_sha256}-${entry.html_sha256}`;
  entry.deck_json_path = overrides.deck_json_path || `${revisionRoot}.deck.json`;
  entry.deck_path = overrides.deck_path || `${revisionRoot}.html`;
  return entry;
}

function shard(entries) {
  return { entries, schema_version: "paper-slide-public-index-v1" };
}

function manifest(selectedShardSha, selectedCount = 1) {
  return {
    manifest_path: `${rootPath}/manifest.json`,
    schema_version: "paper-slide-public-manifest-v1",
    shards: Array.from({ length: 256 }, (_, ordinal) => {
      const prefix = ordinal.toString(16).padStart(2, "0");
      return {
        entry_count: prefix === "aa" ? selectedCount : 0,
        path: `${rootPath}/index/${prefix}.json`,
        prefix,
        sha256: prefix === "aa" ? selectedShardSha : "0".repeat(64),
      };
    }),
  };
}

function streamingResponse(bytes, {
  declaredLength = bytes.byteLength,
  responseUrl,
  redirected = false,
  chunks = [bytes],
  body = true,
  tracker = {},
} = {}) {
  let offset = 0;
  return {
    ok: true,
    redirected,
    url: responseUrl,
    headers: {
      get: (name) => name === "content-length" && declaredLength !== null
        ? String(declaredLength)
        : null,
    },
    body: body ? {
      getReader: () => ({
        read: async () => {
          tracker.reads = (tracker.reads || 0) + 1;
          if (offset >= chunks.length) return { done: true, value: undefined };
          const value = chunks[offset];
          offset += 1;
          return { done: false, value };
        },
        cancel: async () => { tracker.cancelled = true; },
      }),
    } : null,
    arrayBuffer: async () => {
      tracker.arrayBufferCalled = true;
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

function buildFixture({
  deckValue = deck(),
  deckBytes = null,
  htmlBytes = new TextEncoder().encode("<!doctype html><title>Reviewed deck</title>\n"),
  entryOverrides = {},
  entries = null,
  responseOptions = {},
} = {}) {
  const servedDeckBytes = deckBytes || canonicalBytes(deckValue);
  const selectedEntry = entryFor(servedDeckBytes, htmlBytes, entryOverrides);
  const selectedEntries = entries || [selectedEntry];
  const shardBytes = canonicalBytes(shard(selectedEntries));
  const manifestBytes = canonicalBytes(manifest(sha256(shardBytes), selectedEntries.length));
  const urls = {
    manifest: new URL(`${rootPath}/manifest.json`, origin).href,
    shard: new URL(`${rootPath}/index/aa.json`, origin).href,
    deck: new URL(selectedEntry.deck_json_path, origin).href,
    html: new URL(selectedEntry.deck_path, origin).href,
  };
  const payloadByUrl = new Map([
    [urls.manifest, manifestBytes],
    [urls.shard, shardBytes],
    [urls.deck, servedDeckBytes],
    [urls.html, htmlBytes],
  ]);
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const bytes = payloadByUrl.get(url);
    if (!bytes) throw new Error(`unexpected fetch: ${url}`);
    return streamingResponse(bytes, {
      responseUrl: url,
      ...(responseOptions[url] || {}),
    });
  };
  return {
    calls,
    fetchImpl,
    htmlBytes,
    manifestBytes,
    selectedEntry,
    servedDeckBytes,
    shardBytes,
    urls,
    validRoot: {
      schema_version: "paper-slide-public-trust-root-v1",
      manifest_path: `${rootPath}/manifest.json`,
      manifest_sha256: sha256(manifestBytes),
    },
  };
}

const base = buildFixture();

assert.equal(
  Core.parsePublicSlideTrustRoot(Core.PUBLIC_SLIDE_TRUST_ROOT),
  null,
  "an unconfigured code-owned root cannot silently trust a network hash",
);
assert.ok(Core.parsePublicSlideTrustRoot(base.validRoot));
for (const arbitrary of [null, undefined, [], "root", 1, Symbol("root")]) {
  assert.equal(Core.parsePublicSlideTrustRoot(arbitrary), null);
  assert.equal(Core.parsePublicSlideManifest(arbitrary), null);
  assert.equal(Core.parsePublicSlideShard(arbitrary), null);
}
for (const hostileRoot of [
  { ...base.validRoot, extra: true },
  { ...base.validRoot, manifest_path: "https://evil.example/manifest.json" },
  { ...base.validRoot, manifest_sha256: null },
  { ...base.validRoot, manifest_sha256: "A".repeat(64) },
  { ...base.validRoot, manifest_sha256: Symbol("hash") },
]) {
  assert.equal(Core.parsePublicSlideTrustRoot(hostileRoot), null);
}

const validManifest = JSON.parse(new TextDecoder().decode(base.manifestBytes));
const parsedManifest = Core.parsePublicSlideManifest(validManifest);
assert.ok(parsedManifest);
assert.equal(parsedManifest.shards[0xaa].path, `${rootPath}/index/aa.json`);
for (const hostileManifest of [
  { ...validManifest, extra: true },
  { ...validManifest, manifest_path: "/paper-slides-v1/manifest.json" },
  { ...validManifest, shards: validManifest.shards.slice(0, 255) },
  {
    ...validManifest,
    shards: validManifest.shards.map((row, index) => index === 0xaa
      ? { ...row, prefix: "ab" } : row),
  },
  {
    ...validManifest,
    shards: validManifest.shards.map((row, index) => index === 0xaa
      ? { ...row, path: "//evil.example/aa.json" } : row),
  },
  {
    ...validManifest,
    shards: validManifest.shards.map((row) => ({ ...row, entry_count: 10_000 })),
  },
]) {
  assert.equal(Core.parsePublicSlideManifest(hostileManifest), null);
}

const validShard = JSON.parse(new TextDecoder().decode(base.shardBytes));
const parsedShard = Core.parsePublicSlideShard(validShard, { prefix: "aa", entryCount: 1 });
assert.ok(parsedShard);
assert.equal(Core.resolvePublicSlideState(parsedShard, paperId).state, "published");
assert.equal(Core.resolvePublicSlideState(parsedShard, otherPaperId).state, "not_published");
assert.equal(Core.resolvePublicSlideState(parsedShard, paperId).entry.deck_path, base.selectedEntry.deck_path);

const hostileEntries = [
  { ...base.selectedEntry, extra: "provider payload" },
  { ...base.selectedEntry, paper_id: `ab${"1".repeat(38)}` },
  { ...base.selectedEntry, deck_path: "https://evil.example/deck/" },
  { ...base.selectedEntry, deck_json_path: `${rootPath}/decks/${deckId}/other.deck.json` },
  { ...base.selectedEntry, html_sha256: "f".repeat(64) },
  { ...base.selectedEntry, deck_sha256: "e".repeat(64) },
  { ...base.selectedEntry, reviewed_at: "9999-99-99T99:99:99Z" },
  { ...base.selectedEntry, reviewed_at: "2026-08-30T01:00:00.1234567Z" },
  { ...base.selectedEntry, language: "fr" },
];
for (const hostileEntry of hostileEntries) {
  assert.equal(
    Core.parsePublicSlideShard(shard([hostileEntry]), { prefix: "aa", entryCount: 1 }),
    null,
  );
}
assert.equal(
  Core.parsePublicSlideShard(shard([base.selectedEntry, base.selectedEntry]), {
    prefix: "aa", entryCount: 2,
  }),
  null,
  "duplicate paper/language identity is rejected",
);
assert.equal(
  Core.parsePublicSlideShard(
    shard([{ ...base.selectedEntry, paper_id: otherPaperId }, base.selectedEntry]),
    { prefix: "aa", entryCount: 2 },
  ),
  null,
  "entries must preserve the builder's canonical identity order",
);

{
  let called = false;
  const result = await Core.loadPublicSlideState(paperId, {
    fetchImpl: async () => { called = true; throw new Error("must not fetch"); },
    cryptoImpl: webcrypto,
    origin,
  });
  assert.equal(result.state, "unverified");
  assert.equal(called, false, "no root hash means no network fetch");
}

{
  const fixture = buildFixture();
  const controller = new AbortController();
  const result = await Core.loadPublicSlideState(paperId, {
    trustRoot: fixture.validRoot,
    fetchImpl: fixture.fetchImpl,
    cryptoImpl: webcrypto,
    origin,
    signal: controller.signal,
  });
  assert.equal(result.state, "published");
  assert.equal(result.entry.paper_id, paperId);
  assert.deepEqual(fixture.calls.map((call) => call.url), [
    fixture.urls.manifest,
    fixture.urls.shard,
    fixture.urls.deck,
    fixture.urls.html,
  ], "publication authenticates the index, deck JSON, and rendered HTML");
  for (const call of fixture.calls) {
    assert.equal(call.options.redirect, "error");
    assert.equal(call.options.credentials, "same-origin");
    assert.equal(call.options.signal, controller.signal);
  }
}

for (const deckValue of [
  deck({ paper_id: otherPaperId }),
  deck({ deck_id: `sd1-${"e".repeat(64)}` }),
  deck({ language: "en" }),
  deck({ coverage: { kind: "abstract_only" } }),
  deck({ review: { status: "provisional" } }),
  deck({ review: null }),
]) {
  const fixture = buildFixture({ deckValue });
  const result = await Core.loadPublicSlideState(paperId, {
    trustRoot: fixture.validRoot,
    fetchImpl: fixture.fetchImpl,
    cryptoImpl: webcrypto,
    origin,
  });
  assert.equal(result.state, "unverified", "deck identity and review must bind to the shard entry");
  assert.deepEqual(fixture.calls.map((call) => call.url), [
    fixture.urls.manifest, fixture.urls.shard, fixture.urls.deck,
  ], "an identity-mismatched deck never advances to the HTML fetch");
}

{
  const fixture = buildFixture({ entryOverrides: { html_sha256: "f".repeat(64) } });
  const result = await Core.loadPublicSlideState(paperId, {
    trustRoot: fixture.validRoot, fetchImpl: fixture.fetchImpl, cryptoImpl: webcrypto, origin,
  });
  assert.equal(result.state, "unverified", "HTML bytes must match the pinned shard hash");
}

{
  const fixture = buildFixture();
  const wrongUrl = `${fixture.urls.manifest}?redirected=1`;
  fixture.fetchImpl = async () => streamingResponse(fixture.manifestBytes, {
    responseUrl: wrongUrl,
  });
  const result = await Core.loadPublicSlideState(paperId, {
    trustRoot: fixture.validRoot, fetchImpl: fixture.fetchImpl, cryptoImpl: webcrypto, origin,
  });
  assert.equal(result.state, "unverified", "response.url must exactly match the expected URL");
}

{
  const fixture = buildFixture();
  const result = await Core.loadPublicSlideState(paperId, {
    trustRoot: fixture.validRoot,
    fetchImpl: async (url) => streamingResponse(fixture.manifestBytes, {
      responseUrl: url,
      redirected: true,
    }),
    cryptoImpl: webcrypto,
    origin,
  });
  assert.equal(result.state, "unverified", "redirected responses fail closed");
}

for (const declaredLength of [null, 1]) {
  const fixture = buildFixture();
  const tracker = {};
  const oversized = new Uint8Array(Core.MAX_PUBLIC_SLIDE_MANIFEST_BYTES + 1);
  const result = await Core.loadPublicSlideState(paperId, {
    trustRoot: fixture.validRoot,
    fetchImpl: async (url) => streamingResponse(oversized, {
      responseUrl: url,
      declaredLength,
      chunks: [
        oversized.subarray(0, Core.MAX_PUBLIC_SLIDE_MANIFEST_BYTES),
        oversized.subarray(Core.MAX_PUBLIC_SLIDE_MANIFEST_BYTES),
      ],
      tracker,
    }),
    cryptoImpl: webcrypto,
    origin,
  });
  assert.equal(result.state, "unverified");
  assert.equal(tracker.cancelled, true, "oversized streams are cancelled without an honest length");
}

for (const artifact of [
  { key: "deck", maximum: Core.MAX_PUBLIC_SLIDE_DECK_BYTES },
  { key: "html", maximum: Core.MAX_PUBLIC_SLIDE_HTML_BYTES },
]) {
  const responseOptions = {};
  const fixture = buildFixture({ responseOptions });
  const tracker = {};
  const oversized = new Uint8Array(artifact.maximum + 1);
  responseOptions[fixture.urls[artifact.key]] = {
    chunks: [oversized.subarray(0, artifact.maximum), oversized.subarray(artifact.maximum)],
    declaredLength: artifact.key === "deck" ? null : 1,
    tracker,
  };
  const result = await Core.loadPublicSlideState(paperId, {
    trustRoot: fixture.validRoot,
    fetchImpl: fixture.fetchImpl,
    cryptoImpl: webcrypto,
    origin,
  });
  assert.equal(result.state, "unverified", `${artifact.key} has an independent byte ceiling`);
  assert.equal(tracker.cancelled, true, `${artifact.key} oversize stream is cancelled`);
}

{
  const fixture = buildFixture();
  const tracker = {};
  const result = await Core.loadPublicSlideState(paperId, {
    trustRoot: fixture.validRoot,
    fetchImpl: async (url) => streamingResponse(fixture.manifestBytes, {
      responseUrl: url,
      body: false,
      tracker,
    }),
    cryptoImpl: webcrypto,
    origin,
  });
  assert.equal(result.state, "unverified");
  assert.equal(tracker.arrayBufferCalled, undefined, "a missing stream never falls back to arrayBuffer");
}

{
  const fixture = buildFixture();
  const tracker = {};
  const result = await Core.loadPublicSlideState(paperId, {
    trustRoot: fixture.validRoot,
    fetchImpl: async (url) => streamingResponse(fixture.manifestBytes, {
      responseUrl: url,
      declaredLength: Core.MAX_PUBLIC_SLIDE_MANIFEST_BYTES + 1,
      tracker,
    }),
    cryptoImpl: webcrypto,
    origin,
  });
  assert.equal(result.state, "unverified");
  assert.equal(tracker.reads, undefined, "oversize Content-Length fails before reading the stream");
}

{
  const fixture = buildFixture();
  const controller = new AbortController();
  const pending = Core.loadPublicSlideState(paperId, {
    trustRoot: fixture.validRoot,
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      assert.equal(options.signal, controller.signal);
      options.signal.addEventListener("abort", () => {
        reject(new DOMException("abandoned", "AbortError"));
      }, { once: true });
    }),
    cryptoImpl: webcrypto,
    origin,
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(pending, (error) => error?.name === "AbortError");
}

console.log("catalog reviewed public-slide trust contract passed");
