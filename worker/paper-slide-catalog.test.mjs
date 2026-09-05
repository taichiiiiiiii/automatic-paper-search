import {
  PAPER_SLIDE_CATALOG_MANIFEST_SCHEMA,
  PAPER_SLIDE_CATALOG_MAX_MANIFEST_BYTES,
  PAPER_SLIDE_CATALOG_PIN_SCHEMA,
  PAPER_SLIDE_CATALOG_RECORD_SCHEMA,
  canonicalPaperSlideJobKey,
  createPaperSlideCatalogAdapter,
} from "./paper-slide-catalog.js";

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    passed++;
    process.stdout.write(`  ok  ${name}\n`);
  }).catch((error) => {
    failed++;
    failures.push({ name, error });
    process.stdout.write(`  FAIL ${name}\n    ${error.stack || error.message}\n`);
  });
}

function eq(actual, expected, message = "") {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}\nexpected ${JSON.stringify(expected)}\nactual   ${JSON.stringify(actual)}`);
  }
}

async function rejects(fn, message = "expected rejection") {
  try {
    await fn();
  } catch {
    return;
  }
  throw new Error(message);
}

const PAPER_ID = "a".repeat(40);
const OTHER_PAPER_ID = "b".repeat(40);
const SNAPSHOT = "catalog-2026-09-04.1";
const MANIFEST_KEY = "approved/paper-slides/manifest.json";
const RECORDS_PREFIX = "approved/paper-slides/records/";
const encoder = new TextEncoder();

async function digest(value) {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  const hashed = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(hashed, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalMaterial(overrides = {}) {
  return {
    deck_profile: "paper-slide-v1",
    deck_schema_version: "slide-deck-v1",
    extractor_version: "extractor-v1",
    input: {
      content_sha256: "1".repeat(64),
      coverage: "full_text",
      pdf_url: "https://openreview.net/pdf?id=trusted-source",
    },
    license_policy_version: "license-policy-v1",
    model: "gpt-5.6-sol",
    paper_id: PAPER_ID,
    prompt_version: "paper-slide-prompt-v1",
    provider: "openai",
    source: {
      landing_url: "https://openreview.net/forum?id=trusted-source",
      source: "openreview",
      source_id: "trusted-source",
    },
    ...overrides,
  };
}

async function eligibleRecord(overrides = {}) {
  const material = overrides.canonical_material ?? canonicalMaterial();
  return {
    canonical_material: material,
    eligible: true,
    failure_code: null,
    paper_id: PAPER_ID,
    schema_version: PAPER_SLIDE_CATALOG_RECORD_SCHEMA,
    snapshot_version: SNAPSHOT,
    ...overrides,
  };
}

async function unavailableRecord(overrides = {}) {
  const base = {
    canonical_material: null,
    eligible: false,
    failure_code: "PAPER_SLIDE_SOURCE_RESTRICTED",
    paper_id: PAPER_ID,
    schema_version: PAPER_SLIDE_CATALOG_RECORD_SCHEMA,
    snapshot_version: SNAPSHOT,
  };
  return { ...base, ...overrides };
}

async function fixture({ records = null, manifestPatch = {}, pinPatch = {}, binding = null } = {}) {
  const recordValues = records ?? [await eligibleRecord()];
  const objects = new Map();
  const entries = [];
  for (const record of recordValues) {
    const text = JSON.stringify(record);
    objects.set(`${RECORDS_PREFIX}${record.paper_id}.json`, text);
    entries.push({ paper_id: record.paper_id, sha256: await digest(text) });
  }
  entries.sort((left, right) => left.paper_id.localeCompare(right.paper_id));
  const manifest = {
    record_count: entries.length,
    records: entries,
    schema_version: PAPER_SLIDE_CATALOG_MANIFEST_SCHEMA,
    snapshot_version: SNAPSHOT,
    ...manifestPatch,
  };
  const manifestText = JSON.stringify(manifest);
  objects.set(MANIFEST_KEY, manifestText);
  const calls = [];
  const actualBinding = binding ?? {
    async get(key) {
      calls.push(key);
      return objects.get(key) ?? null;
    },
  };
  const pin = {
    manifest_key: MANIFEST_KEY,
    manifest_sha256: await digest(manifestText),
    records_prefix: RECORDS_PREFIX,
    schema_version: PAPER_SLIDE_CATALOG_PIN_SCHEMA,
    snapshot_version: SNAPSHOT,
    ...pinPatch,
  };
  return {
    adapter: createPaperSlideCatalogAdapter({ binding: actualBinding, pin }),
    calls,
    manifest,
    objects,
    pin,
  };
}

const tests = [];

tests.push(test("resolves an exact paper/language record to the closed API projection", async () => {
  const source = await eligibleRecord();
  const { adapter, calls } = await fixture({ records: [source] });
  const jobKey = await canonicalPaperSlideJobKey(source.canonical_material, "ja");
  const result = await adapter.resolve(PAPER_ID, "ja");
  eq(result, {
    paper_id: PAPER_ID,
    eligible: true,
    snapshot_version: SNAPSHOT,
    job_key: jobKey,
  });
  eq(Object.keys(result).sort(), ["eligible", "job_key", "paper_id", "snapshot_version"]);
  eq(Object.isFrozen(result), true);
  eq(calls, [MANIFEST_KEY, `${RECORDS_PREFIX}${PAPER_ID}.json`]);
}));

tests.push(test("unknown paper IDs return null without a guessed record read", async () => {
  const { adapter, calls } = await fixture();
  eq(await adapter.resolve(OTHER_PAPER_ID, "ja"), null);
  eq(calls, [MANIFEST_KEY]);
}));

tests.push(test("manifest is validated once while each exact record read stays digest checked", async () => {
  const other = await eligibleRecord({
    canonical_material: canonicalMaterial({ paper_id: OTHER_PAPER_ID }),
    paper_id: OTHER_PAPER_ID,
  });
  const { adapter, calls } = await fixture({ records: [await eligibleRecord(), other] });
  await adapter.resolve(PAPER_ID, "ja");
  await adapter.resolve(OTHER_PAPER_ID, "en");
  eq(calls, [
    MANIFEST_KEY,
    `${RECORDS_PREFIX}${PAPER_ID}.json`,
    `${RECORDS_PREFIX}${OTHER_PAPER_ID}.json`,
  ]);
}));

tests.push(test("accepts KV byte values and R2-style arrayBuffer objects", async () => {
  const source = await eligibleRecord();
  const recordText = JSON.stringify(source);
  const manifest = {
    record_count: 1,
    records: [{ paper_id: PAPER_ID, sha256: await digest(recordText) }],
    schema_version: PAPER_SLIDE_CATALOG_MANIFEST_SCHEMA,
    snapshot_version: SNAPSHOT,
  };
  const manifestText = JSON.stringify(manifest);
  const manifestBytes = encoder.encode(manifestText);
  const recordBytes = encoder.encode(recordText);
  const binding = {
    async get(key) {
      if (key === MANIFEST_KEY) return manifestBytes.buffer;
      if (key === `${RECORDS_PREFIX}${PAPER_ID}.json`) {
        return { async arrayBuffer() { return recordBytes.buffer; } };
      }
      return null;
    },
  };
  const adapter = createPaperSlideCatalogAdapter({
    binding,
    pin: {
      manifest_key: MANIFEST_KEY,
      manifest_sha256: await digest(manifestBytes),
      records_prefix: RECORDS_PREFIX,
      schema_version: PAPER_SLIDE_CATALOG_PIN_SCHEMA,
      snapshot_version: SNAPSHOT,
    },
  });
  eq(
    (await adapter.resolve(PAPER_ID, "ja")).job_key,
    await canonicalPaperSlideJobKey(source.canonical_material, "ja"),
  );
}));

tests.push(test("projects an approved unavailable record and no canonical source material", async () => {
  const source = await unavailableRecord();
  const { adapter } = await fixture({ records: [source] });
  const expectedJobKey = await digest(JSON.stringify({
    job_key_schema: "paper-slide-unavailable-key-v1",
    paper_id: PAPER_ID,
    language: "ja",
    snapshot_version: SNAPSHOT,
    failure_code: "PAPER_SLIDE_SOURCE_RESTRICTED",
  }));
  eq(await adapter.resolve(PAPER_ID, "ja"), {
    paper_id: PAPER_ID,
    eligible: false,
    snapshot_version: SNAPSHOT,
    job_key: expectedJobKey,
    failure_code: "PAPER_SLIDE_SOURCE_RESTRICTED",
  });
}));

tests.push(test("invalid lookup identifiers and languages fail closed before storage", async () => {
  const { adapter, calls } = await fixture();
  for (const [paperId, language] of [
    ["A".repeat(40), "ja"],
    [`${PAPER_ID}/../../secret`, "ja"],
    [PAPER_ID, "JA"],
    [PAPER_ID, "ja/../../secret"],
  ]) {
    await rejects(() => adapter.resolve(paperId, language));
  }
  eq(calls, []);
}));

tests.push(test("manifest digest, snapshot, count, order, and closed schema are enforced", async () => {
  const badDigest = await fixture({ pinPatch: { manifest_sha256: "0".repeat(64) } });
  await rejects(() => badDigest.adapter.resolve(PAPER_ID, "ja"));

  const badSnapshot = await fixture({ manifestPatch: { snapshot_version: "other" } });
  await rejects(() => badSnapshot.adapter.resolve(PAPER_ID, "ja"));

  const badCount = await fixture({ manifestPatch: { record_count: 2 } });
  await rejects(() => badCount.adapter.resolve(PAPER_ID, "ja"));

  const duplicate = await fixture();
  duplicate.manifest.records.push({ ...duplicate.manifest.records[0] });
  duplicate.manifest.record_count = 2;
  const duplicateText = JSON.stringify(duplicate.manifest);
  duplicate.objects.set(MANIFEST_KEY, duplicateText);
  duplicate.pin.manifest_sha256 = await digest(duplicateText);
  const duplicateAdapter = createPaperSlideCatalogAdapter({
    binding: { get: (key) => duplicate.objects.get(key) ?? null },
    pin: duplicate.pin,
  });
  await rejects(() => duplicateAdapter.resolve(PAPER_ID, "ja"));

  const extra = await fixture({ manifestPatch: { __proto_pollution__: true } });
  await rejects(() => extra.adapter.resolve(PAPER_ID, "ja"));

  const polluted = await fixture();
  const pollutedText = `${JSON.stringify(polluted.manifest).slice(0, -1)},"__proto__":{"polluted":true}}`;
  polluted.objects.set(MANIFEST_KEY, pollutedText);
  const pollutedAdapter = createPaperSlideCatalogAdapter({
    binding: { get: (key) => polluted.objects.get(key) ?? null },
    pin: { ...polluted.pin, manifest_sha256: await digest(pollutedText) },
  });
  await rejects(() => pollutedAdapter.resolve(PAPER_ID, "ja"));
  eq({}.polluted, undefined);
}));

tests.push(test("a 28,300-paper one-record manifest stays inside the 8 MiB ceiling", async () => {
  const records = Array.from({ length: 28_300 }, (_, index) => ({
    paper_id: index.toString(16).padStart(40, "0"),
    sha256: "1".repeat(64),
  }));
  const manifest = {
    record_count: records.length,
    records,
    schema_version: PAPER_SLIDE_CATALOG_MANIFEST_SCHEMA,
    snapshot_version: SNAPSHOT,
  };
  const manifestBytes = encoder.encode(JSON.stringify(manifest));
  eq(manifestBytes.byteLength < PAPER_SLIDE_CATALOG_MAX_MANIFEST_BYTES, true);
  const adapter = createPaperSlideCatalogAdapter({
    binding: { get: (key) => key === MANIFEST_KEY ? manifestBytes : null },
    pin: {
      manifest_key: MANIFEST_KEY,
      manifest_sha256: await digest(manifestBytes),
      records_prefix: RECORDS_PREFIX,
      schema_version: PAPER_SLIDE_CATALOG_PIN_SCHEMA,
      snapshot_version: SNAPSHOT,
    },
  });
  eq(await adapter.resolve(PAPER_ID, "ja"), null);
}));

tests.push(test("missing, malformed, non-UTF-8, and oversized manifests fail closed", async () => {
  const missingPin = {
    manifest_key: MANIFEST_KEY,
    manifest_sha256: "0".repeat(64),
    records_prefix: RECORDS_PREFIX,
    schema_version: PAPER_SLIDE_CATALOG_PIN_SCHEMA,
    snapshot_version: SNAPSHOT,
  };
  const missing = createPaperSlideCatalogAdapter({ binding: { get: async () => null }, pin: missingPin });
  await rejects(() => missing.resolve(PAPER_ID, "ja"));

  for (const bytes of ["{", new Uint8Array([0xff, 0xfe]), "x".repeat(257)]) {
    const pin = { ...missingPin, manifest_sha256: await digest(
      typeof bytes === "string" ? bytes : bytes,
    ) };
    const adapter = createPaperSlideCatalogAdapter({
      binding: { get: async () => bytes },
      pin,
      maximumManifestBytes: 256,
    });
    await rejects(() => adapter.resolve(PAPER_ID, "ja"));
  }
}));

tests.push(test("streaming bindings are bounded and cancelled on oversize", async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(100));
      controller.enqueue(new Uint8Array(100));
    },
    cancel() { cancelled = true; },
  });
  const pin = {
    manifest_key: MANIFEST_KEY,
    manifest_sha256: "0".repeat(64),
    records_prefix: RECORDS_PREFIX,
    schema_version: PAPER_SLIDE_CATALOG_PIN_SCHEMA,
    snapshot_version: SNAPSHOT,
  };
  const adapter = createPaperSlideCatalogAdapter({
    binding: { get: async () => ({ body: stream }) },
    pin,
    maximumManifestBytes: 128,
  });
  await rejects(() => adapter.resolve(PAPER_ID, "ja"));
  eq(cancelled, true);
}));

tests.push(test("record digest mismatch, absence, malformed JSON, and extra fields fail closed", async () => {
  const mismatch = await fixture();
  mismatch.objects.set(`${RECORDS_PREFIX}${PAPER_ID}.json`, "{}");
  await rejects(() => mismatch.adapter.resolve(PAPER_ID, "ja"));

  const absent = await fixture();
  absent.objects.delete(`${RECORDS_PREFIX}${PAPER_ID}.json`);
  await rejects(() => absent.adapter.resolve(PAPER_ID, "ja"));

  const malformed = await fixture();
  const malformedText = "{";
  malformed.objects.set(`${RECORDS_PREFIX}${PAPER_ID}.json`, malformedText);
  malformed.manifest.records[0].sha256 = await digest(malformedText);
  const malformedManifest = JSON.stringify(malformed.manifest);
  malformed.objects.set(MANIFEST_KEY, malformedManifest);
  const malformedAdapter = createPaperSlideCatalogAdapter({
    binding: { get: (key) => malformed.objects.get(key) ?? null },
    pin: { ...malformed.pin, manifest_sha256: await digest(malformedManifest) },
  });
  await rejects(() => malformedAdapter.resolve(PAPER_ID, "ja"));

  const extraRecord = { ...await eligibleRecord(), attacker: true };
  const extra = await fixture({ records: [extraRecord] });
  await rejects(() => extra.adapter.resolve(PAPER_ID, "ja"));
}));

tests.push(test("oversized records fail closed after their pinned manifest resolves", async () => {
  const oversizedText = "x".repeat(257);
  const manifest = {
    record_count: 1,
    records: [{ paper_id: PAPER_ID, sha256: await digest(oversizedText) }],
    schema_version: PAPER_SLIDE_CATALOG_MANIFEST_SCHEMA,
    snapshot_version: SNAPSHOT,
  };
  const manifestText = JSON.stringify(manifest);
  const objects = new Map([
    [MANIFEST_KEY, manifestText],
    [`${RECORDS_PREFIX}${PAPER_ID}.json`, oversizedText],
  ]);
  const adapter = createPaperSlideCatalogAdapter({
    binding: { get: (key) => objects.get(key) ?? null },
    pin: {
      manifest_key: MANIFEST_KEY,
      manifest_sha256: await digest(manifestText),
      records_prefix: RECORDS_PREFIX,
      schema_version: PAPER_SLIDE_CATALOG_PIN_SCHEMA,
      snapshot_version: SNAPSHOT,
    },
    maximumRecordBytes: 256,
  });
  await rejects(() => adapter.resolve(PAPER_ID, "ja"));
}));

tests.push(test("records cannot supply job keys independently of trusted material", async () => {
  const alteredMaterial = canonicalMaterial({ prompt_version: "paper-slide-prompt-v2" });
  const stale = await eligibleRecord({ canonical_material: alteredMaterial, job_key: "9".repeat(64) });
  const { adapter } = await fixture({ records: [stale] });
  await rejects(() => adapter.resolve(PAPER_ID, "ja"));

  const first = await canonicalPaperSlideJobKey(canonicalMaterial(), "ja");
  const second = await canonicalPaperSlideJobKey(alteredMaterial, "ja");
  eq(first === second, false);
}));

tests.push(test("one paper record derives distinct ja and en job keys", async () => {
  const { adapter, calls } = await fixture();
  const ja = await adapter.resolve(PAPER_ID, "ja");
  const en = await adapter.resolve(PAPER_ID, "en");
  eq(ja.paper_id, en.paper_id);
  eq(ja.job_key === en.job_key, false);
  eq(calls, [
    MANIFEST_KEY,
    `${RECORDS_PREFIX}${PAPER_ID}.json`,
    `${RECORDS_PREFIX}${PAPER_ID}.json`,
  ]);
}));

tests.push(test("coverage and source URL relationships are closed", async () => {
  for (const material of [
    canonicalMaterial({ input: { content_sha256: "1".repeat(64), coverage: "abstract_only", pdf_url: "https://example.org/p.pdf" } }),
    canonicalMaterial({ input: { content_sha256: "1".repeat(64), coverage: "full_text", pdf_url: null } }),
    canonicalMaterial({ source: { landing_url: "http://127.0.0.1/p", source: "openreview", source_id: "id" } }),
    { ...canonicalMaterial(), unexpected: true },
    canonicalMaterial({ provider: new String("openai") }),
  ]) {
    await rejects(() => canonicalPaperSlideJobKey(material, "ja"));
  }
  const abstract = canonicalMaterial({
    input: { content_sha256: "2".repeat(64), coverage: "abstract_only", pdf_url: null },
  });
  eq((await canonicalPaperSlideJobKey(abstract, "ja")).length, 64);
  await rejects(() => canonicalPaperSlideJobKey(abstract, "JA"));
}));

tests.push(test("pin and constructor configuration reject prototype pollution and unsafe keys", async () => {
  const base = await fixture();
  const inheritedPin = Object.create(base.pin);
  await rejects(async () => createPaperSlideCatalogAdapter({
    binding: { get() { return null; } },
    pin: inheritedPin,
  }));
  for (const patch of [
    { manifest_key: "../manifest.json" },
    { records_prefix: "approved//records/" },
    { records_prefix: "approved/records" },
  ]) {
    await rejects(async () => createPaperSlideCatalogAdapter({
      binding: { get() { return null; } },
      pin: { ...base.pin, ...patch },
    }));
  }
  await rejects(async () => createPaperSlideCatalogAdapter({ binding: {}, pin: base.pin }));
  await rejects(async () => createPaperSlideCatalogAdapter({
    binding: { get() { return null; } },
    pin: { ...base.pin, snapshot_version: new String(SNAPSHOT) },
  }));
  await rejects(async () => createPaperSlideCatalogAdapter({
    binding: { get() { return null; } },
    pin: base.pin,
    maximumRecordBytes: 65 * 1024,
  }));
}));

tests.push(test("the adapter never uses global fetch", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("network forbidden"); };
  try {
    const { adapter } = await fixture();
    eq((await adapter.resolve(PAPER_ID, "ja")).eligible, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
}));

tests.push(test("the binding get method is captured exactly once", async () => {
  const base = await fixture();
  let accesses = 0;
  const binding = {
    get get() {
      accesses++;
      return async () => null;
    },
  };
  const adapter = createPaperSlideCatalogAdapter({ binding, pin: base.pin });
  eq(accesses, 1);
  await rejects(() => adapter.resolve(PAPER_ID, "ja"));
  eq(accesses, 1);
}));

await Promise.all(tests);
process.stdout.write(`\npaper-slide-catalog: ${passed} passed, ${failed} failed\n`);
if (failures.length > 0) process.exitCode = 1;
