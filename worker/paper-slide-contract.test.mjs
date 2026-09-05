import {
  PAPER_SLIDE_REQUEST_ID_PATTERN,
  PAPER_SLIDE_FAILURE_CODES,
  PAPER_SLIDE_HTTP_ERROR_CODES,
  STATUS_CAPABILITY_PATTERN,
  createPaperSlideCredentials,
  isPaperSlideRequestId,
  isStatusCapability,
  projectPaperSlideStatus,
  sha256Hex,
  validatePaperSlideRequest,
  validatePaperSlideStatusRequest,
} from "./paper-slide-contract.js";

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      process.stdout.write(`  ok  ${name}\n`);
    })
    .catch((error) => {
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

function truthy(value, message = "expected truthy") {
  if (!value) throw new Error(message);
}

const PAPER_ID = "a".repeat(40);
const VALID_BODY = {
  paper_id: PAPER_ID,
  language: "ja",
  coverage_preference: "auto",
};

const tests = [];

tests.push(test("accepts the exact closed request object", () => {
  eq(validatePaperSlideRequest(VALID_BODY), { ok: true, value: VALID_BODY });
}));

tests.push(test("accepts both supported languages", () => {
  eq(validatePaperSlideRequest({ ...VALID_BODY, language: "en" }).ok, true);
}));

tests.push(test("rejects missing, unknown, and inherited keys", () => {
  eq(validatePaperSlideRequest({ paper_id: PAPER_ID, language: "ja" }).ok, false);
  eq(validatePaperSlideRequest({ ...VALID_BODY, title: "untrusted" }).ok, false);
  const inherited = Object.create({ coverage_preference: "auto" });
  inherited.paper_id = PAPER_ID;
  inherited.language = "ja";
  eq(validatePaperSlideRequest(inherited).ok, false);
  const hiddenExtra = Object.create({ title: "untrusted" });
  Object.assign(hiddenExtra, VALID_BODY);
  eq(validatePaperSlideRequest(hiddenExtra).ok, false);
}));

tests.push(test("rejects arrays, scalars, and null", () => {
  for (const value of [null, [], "paper", 1, true]) {
    eq(validatePaperSlideRequest(value).ok, false);
  }
}));

tests.push(test("requires exactly 40 lowercase paper-id hex characters", () => {
  for (const paper_id of ["a".repeat(39), "a".repeat(41), "A".repeat(40), `${"a".repeat(39)}g`]) {
    eq(validatePaperSlideRequest({ ...VALID_BODY, paper_id }).ok, false, paper_id);
  }
}));

tests.push(test("rejects unsupported language and coverage preference", () => {
  eq(validatePaperSlideRequest({ ...VALID_BODY, language: "fr" }).ok, false);
  eq(validatePaperSlideRequest({ ...VALID_BODY, coverage_preference: "full_text" }).ok, false);
}));

tests.push(test("creates independent opaque request and capability values", () => {
  let seed = 0;
  const randomBytes = (length) => Uint8Array.from({ length }, () => seed++ & 0xff);
  const credentials = createPaperSlideCredentials(randomBytes);
  truthy(PAPER_SLIDE_REQUEST_ID_PATTERN.test(credentials.requestId));
  truthy(STATUS_CAPABILITY_PATTERN.test(credentials.statusCapability));
  truthy(credentials.requestId !== credentials.statusCapability);
  eq(credentials.requestId, "paper-slide-AAECAwQFBgcICQoLDA0ODw");
  eq(credentials.statusCapability, "psc_EBESExQVFhcYGRobHB0eHyAhIiMkJSYnKCkqKywtLi8");
}));

tests.push(test("requests 16 bytes for IDs and 32 independent bytes for capabilities", () => {
  const lengths = [];
  createPaperSlideCredentials((length) => {
    lengths.push(length);
    return new Uint8Array(length);
  });
  eq(lengths, [16, 32]);
}));

tests.push(test("rejects malformed random-byte provider output", () => {
  let threw = false;
  try {
    createPaperSlideCredentials(() => new Uint8Array(3));
  } catch {
    threw = true;
  }
  truthy(threw);
}));

tests.push(test("request and capability validators use absolute endings", () => {
  const credentials = createPaperSlideCredentials((length) => new Uint8Array(length));
  eq(isPaperSlideRequestId(credentials.requestId), true);
  eq(isStatusCapability(credentials.statusCapability), true);
  for (const suffix of ["\n", "\r", " ", "."] ) {
    eq(isPaperSlideRequestId(`${credentials.requestId}${suffix}`), false);
    eq(isStatusCapability(`${credentials.statusCapability}${suffix}`), false);
  }
}));

tests.push(test("sha256Hex returns a stable lowercase digest", async () => {
  eq(await sha256Hex("capability"), "38a5be91af79d7e5ba9809bf383c699b6864ee50446239fe56a45e32b84638fe");
}));

tests.push(test("generation and HTTP error enums remain separate and closed", () => {
  truthy(PAPER_SLIDE_FAILURE_CODES.includes("PAPER_SLIDE_SOURCE_UNTRUSTED"));
  truthy(PAPER_SLIDE_FAILURE_CODES.every((code) => code.startsWith("PAPER_SLIDE_")));
  truthy(PAPER_SLIDE_HTTP_ERROR_CODES.includes("INVALID_REQUEST"));
  eq(PAPER_SLIDE_HTTP_ERROR_CODES.includes("PAPER_SLIDE_SOURCE_UNTRUSTED"), false);
}));

tests.push(test("accepts only the exact status request body without a capability", () => {
  const id = createPaperSlideCredentials((length) => new Uint8Array(length)).requestId;
  eq(validatePaperSlideStatusRequest({ request_id: id }), {
    ok: true,
    value: { request_id: id },
  });
  eq(validatePaperSlideStatusRequest({ request_id: id, status_cap: "secret" }).ok, false);
  eq(validatePaperSlideStatusRequest({ request_id: "bad" }).ok, false);
}));

const STATUS_ID = "paper-slide-AAAAAAAAAAAAAAAAAAAAAA";
const DECK_ID = `sd1-${"b".repeat(64)}`;
const PUBLIC_URL = `/automatic-paper-search/paper-slides-v1/decks/${DECK_ID}/${"c".repeat(64)}-${"d".repeat(64)}.html`;
const UPDATED_AT = "2026-09-04T00:00:00Z";

function statusRecord(overrides = {}) {
  return {
    paper_id: PAPER_ID,
    status: "queued",
    phase: null,
    coverage: null,
    deck_id: null,
    preview_available: false,
    preview_expires_at: null,
    public_url: null,
    message_code: "PAPER_SLIDE_QUEUED",
    updated_at: UPDATED_AT,
    retryable: null,
    ...overrides,
  };
}

tests.push(test("projects queued status to the exact public envelope", () => {
  eq(projectPaperSlideStatus(statusRecord(), STATUS_ID), {
    ok: true,
    request_id: STATUS_ID,
    paper_id: PAPER_ID,
    status: "queued",
    phase: null,
    coverage: null,
    deck_id: null,
    preview_available: false,
    preview_expires_at: null,
    public_url: null,
    message_code: "PAPER_SLIDE_QUEUED",
    updated_at: UPDATED_AT,
  });
}));

tests.push(test("projects running, validating, and publishing with closed phases", () => {
  for (const [status, phase, message_code, extra] of [
    ["running", "extracting", "PAPER_SLIDE_EXTRACTING", {}],
    ["validating", "validating", "PAPER_SLIDE_VALIDATING", {}],
    ["publishing", "deploying", "PAPER_SLIDE_DEPLOYING", {
      coverage: "abstract_only",
      deck_id: DECK_ID,
    }],
  ]) {
    truthy(projectPaperSlideStatus(statusRecord({ status, phase, message_code, ...extra }), STATUS_ID));
  }
  eq(projectPaperSlideStatus(statusRecord({
    status: "running",
    phase: "promoting",
    message_code: "PAPER_SLIDE_PROMOTING",
  }), STATUS_ID), null);
}));

tests.push(test("awaiting review exposes no private path and only bounded preview metadata", () => {
  truthy(projectPaperSlideStatus(statusRecord({
    status: "awaiting_review",
    phase: "awaiting_review",
    coverage: "full_text",
    deck_id: DECK_ID,
    preview_available: true,
    preview_expires_at: "2026-09-04T00:10:00Z",
    message_code: "PAPER_SLIDE_AWAITING_REVIEW",
  }), STATUS_ID));
  eq(projectPaperSlideStatus(statusRecord({
    status: "awaiting_review",
    phase: "awaiting_review",
    coverage: "full_text",
    deck_id: DECK_ID,
    preview_available: false,
    preview_expires_at: "2026-09-04T00:10:00Z",
    message_code: "PAPER_SLIDE_AWAITING_REVIEW",
  }), STATUS_ID), null);
  eq(projectPaperSlideStatus(statusRecord({
    status: "awaiting_review",
    phase: "awaiting_review",
    coverage: "full_text",
    deck_id: DECK_ID,
    preview_available: true,
    preview_expires_at: UPDATED_AT,
    message_code: "PAPER_SLIDE_AWAITING_REVIEW",
  }), STATUS_ID), null);
}));

tests.push(test("projects only an exact reviewed same-site path as published", () => {
  const result = projectPaperSlideStatus(statusRecord({
    status: "published",
    coverage: "full_text",
    deck_id: DECK_ID,
    public_url: PUBLIC_URL,
    message_code: "PAPER_SLIDE_PUBLISHED",
  }), STATUS_ID);
  eq(result?.public_url, PUBLIC_URL);
  for (const bad of [
    `https://evil.example${PUBLIC_URL}`,
    `${PUBLIC_URL}?cap=secret`,
    `${PUBLIC_URL}#fragment`,
    PUBLIC_URL.replace("/automatic-paper-search/", "/"),
    PUBLIC_URL.replace(".html", ".deck.json"),
    PUBLIC_URL.replace(DECK_ID, `sd1-${"e".repeat(64)}`),
  ]) {
    eq(projectPaperSlideStatus(statusRecord({
      status: "published",
      coverage: "full_text",
      deck_id: DECK_ID,
      public_url: bad,
      message_code: "PAPER_SLIDE_PUBLISHED",
    }), STATUS_ID), null, bad);
  }
}));

tests.push(test("terminal failure statuses alone expose retryable", () => {
  for (const [status, message_code, retryable, extra] of [
    ["failed", "PAPER_SLIDE_FAILED", true, {}],
    ["rejected", "PAPER_SLIDE_REJECTED", false, { coverage: "full_text", deck_id: DECK_ID }],
    ["expired", "PAPER_SLIDE_EXPIRED", true, { coverage: "abstract_only", deck_id: DECK_ID }],
  ]) {
    const result = projectPaperSlideStatus(statusRecord({
      status,
      message_code,
      retryable,
      ...extra,
    }), STATUS_ID);
    eq(result?.retryable, retryable);
  }
}));

tests.push(test("rejects impossible fields, invented progress, and invalid timestamps", () => {
  eq(projectPaperSlideStatus({ ...statusRecord(), progress: 50 }, STATUS_ID), null);
  eq(projectPaperSlideStatus(statusRecord({ coverage: "full_text" }), STATUS_ID), null);
  eq(projectPaperSlideStatus(statusRecord({ retryable: true }), STATUS_ID), null);
  eq(projectPaperSlideStatus(statusRecord({ updated_at: "2026-02-30T00:00:00Z" }), STATUS_ID), null);
  eq(projectPaperSlideStatus(statusRecord({ message_code: "provider secret" }), STATUS_ID), null);
}));

await Promise.all(tests);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const item of failures) console.log(`  - ${item.name}: ${item.error.stack || item.error.message}`);
  process.exit(1);
}
