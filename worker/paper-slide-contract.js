// Pure contract for the Paper Slide request plane. This module intentionally
// owns no Worker bindings, network calls, or workflow dispatch.

export const PAPER_SLIDE_ERROR_SCHEMA_VERSION = "paper-slide-error-v1";

export const PAPER_ID_PATTERN = /^[0-9a-f]{40}(?![\s\S])/;
export const PAPER_SLIDE_REQUEST_ID_PATTERN =
  /^paper-slide-[A-Za-z0-9_-]{22}(?![\s\S])/;
export const STATUS_CAPABILITY_PATTERN = /^psc_[A-Za-z0-9_-]{43}(?![\s\S])/;
export const CAPABILITY_HASH_PATTERN = /^[0-9a-f]{64}(?![\s\S])/;

export const PAPER_SLIDE_STATUSES = Object.freeze([
  "queued",
  "running",
  "validating",
  "awaiting_review",
  "publishing",
  "published",
  "failed",
  "rejected",
  "expired",
]);

export const PAPER_SLIDE_PHASES = Object.freeze([
  "resolving_source",
  "fetching",
  "extracting",
  "generating",
  "validating",
  "awaiting_review",
  "promoting",
  "deploying",
  "smoke",
]);

export const PAPER_SLIDE_FAILURE_CODES = Object.freeze([
  "PAPER_SLIDE_REQUEST_INVALID",
  "PAPER_SLIDE_PAPER_NOT_FOUND",
  "PAPER_SLIDE_SOURCE_UNTRUSTED",
  "PAPER_SLIDE_SOURCE_RESTRICTED",
  "PAPER_SLIDE_FETCH_FAILED",
  "PAPER_SLIDE_FETCH_LIMIT_EXCEEDED",
  "PAPER_SLIDE_PDF_INVALID",
  "PAPER_SLIDE_PDF_ENCRYPTED",
  "PAPER_SLIDE_EXTRACTION_FAILED",
  "PAPER_SLIDE_EXTRACTION_INSUFFICIENT",
  "PAPER_SLIDE_BUDGET_EXCEEDED",
  "PAPER_SLIDE_PROVIDER_FAILED",
  "PAPER_SLIDE_OUTPUT_INVALID",
  "PAPER_SLIDE_CITATION_INVALID",
  "PAPER_SLIDE_SECRET_DETECTED",
  "PAPER_SLIDE_REVIEW_REQUIRED",
  "PAPER_SLIDE_REVIEW_REJECTED",
  "PAPER_SLIDE_CANDIDATE_EXPIRED",
  "PAPER_SLIDE_PROMOTION_CONFLICT",
  "PAPER_SLIDE_PUBLISH_FAILED",
]);

export const PAPER_SLIDE_HTTP_ERROR_CODES = Object.freeze([
  "BODY_TOO_LARGE",
  "BUDGET_EXHAUSTED",
  "EDGE_REQUIRED",
  "INVALID_BODY",
  "INVALID_REQUEST",
  "METHOD_NOT_ALLOWED",
  "NOT_FOUND",
  "ORIGIN_FORBIDDEN",
  "PAPER_NOT_FOUND",
  "PAPER_UNAVAILABLE",
  "RATE_LIMITED",
  "REQUEST_NOT_FOUND",
  "SERVICE_UNAVAILABLE",
  "UNSUPPORTED_MEDIA_TYPE",
]);

const REQUEST_KEYS = Object.freeze([
  "coverage_preference",
  "language",
  "paper_id",
]);
const STATUS_REQUEST_KEYS = Object.freeze(["request_id"]);
const STATUS_RECORD_KEYS = Object.freeze([
  "coverage",
  "deck_id",
  "message_code",
  "paper_id",
  "phase",
  "preview_available",
  "preview_expires_at",
  "public_url",
  "retryable",
  "status",
  "updated_at",
]);
const COVERAGES = new Set(["full_text", "abstract_only"]);
const FAILURE_CODES = new Set(PAPER_SLIDE_FAILURE_CODES);
const HTTP_ERROR_CODES = new Set(PAPER_SLIDE_HTTP_ERROR_CODES);
const RUNNING_PHASES = new Set(["resolving_source", "fetching", "extracting", "generating"]);
const PUBLISHING_PHASES = new Set(["promoting", "deploying", "smoke"]);
const FAILURE_STATUSES = new Set(["failed", "rejected", "expired"]);
const MESSAGE_CODES = Object.freeze({
  queued: "PAPER_SLIDE_QUEUED",
  resolving_source: "PAPER_SLIDE_RESOLVING_SOURCE",
  fetching: "PAPER_SLIDE_FETCHING",
  extracting: "PAPER_SLIDE_EXTRACTING",
  generating: "PAPER_SLIDE_GENERATING",
  validating: "PAPER_SLIDE_VALIDATING",
  awaiting_review: "PAPER_SLIDE_AWAITING_REVIEW",
  promoting: "PAPER_SLIDE_PROMOTING",
  deploying: "PAPER_SLIDE_DEPLOYING",
  smoke: "PAPER_SLIDE_SMOKE",
  published: "PAPER_SLIDE_PUBLISHED",
  failed: "PAPER_SLIDE_FAILED",
  rejected: "PAPER_SLIDE_REJECTED",
  expired: "PAPER_SLIDE_EXPIRED",
});
const DECK_ID_PATTERN = /^sd1-[0-9a-f]{64}(?![\s\S])/;
const UTC_TIMESTAMP_PATTERN =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?Z(?![\s\S])/;
const PUBLIC_DECK_PATH_PATTERN = new RegExp(
  "^/automatic-paper-search/paper-slides-v1/decks/" +
  "(sd1-[0-9a-f]{64})/[0-9a-f]{64}-[0-9a-f]{64}\\.html$",
);
const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function hasExactOwnKeys(value, expected) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function invalidRequest() {
  return { ok: false, error_code: "INVALID_REQUEST" };
}

export function validatePaperSlideRequest(value) {
  if (!hasExactOwnKeys(value, REQUEST_KEYS)) return invalidRequest();
  if (typeof value.paper_id !== "string" || !PAPER_ID_PATTERN.test(value.paper_id)) {
    return invalidRequest();
  }
  if (value.language !== "ja" && value.language !== "en") return invalidRequest();
  if (value.coverage_preference !== "auto") return invalidRequest();
  return {
    ok: true,
    value: Object.freeze({
      paper_id: value.paper_id,
      language: value.language,
      coverage_preference: value.coverage_preference,
    }),
  };
}

export function validatePaperSlideStatusRequest(value) {
  if (!hasExactOwnKeys(value, STATUS_REQUEST_KEYS)) return invalidRequest();
  if (!isPaperSlideRequestId(value.request_id)) return invalidRequest();
  return {
    ok: true,
    value: Object.freeze({ request_id: value.request_id }),
  };
}

function encodeBase64Url(bytes) {
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const secondPresent = index + 1 < bytes.length;
    const thirdPresent = index + 2 < bytes.length;
    const second = secondPresent ? bytes[index + 1] : 0;
    const third = thirdPresent ? bytes[index + 2] : 0;
    const value = (first << 16) | (second << 8) | third;
    output += BASE64URL_ALPHABET[(value >>> 18) & 63];
    output += BASE64URL_ALPHABET[(value >>> 12) & 63];
    if (secondPresent) output += BASE64URL_ALPHABET[(value >>> 6) & 63];
    if (thirdPresent) output += BASE64URL_ALPHABET[value & 63];
  }
  return output;
}

function secureRandomBytes(length) {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

function readRandomBytes(randomBytes, length) {
  const value = randomBytes(length);
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new Error("random byte provider returned an invalid value");
  }
  return value;
}

export function createPaperSlideCredentials(randomBytes = secureRandomBytes) {
  const requestBytes = readRandomBytes(randomBytes, 16);
  const capabilityBytes = readRandomBytes(randomBytes, 32);
  const requestId = `paper-slide-${encodeBase64Url(requestBytes)}`;
  const statusCapability = `psc_${encodeBase64Url(capabilityBytes)}`;
  if (!isPaperSlideRequestId(requestId) || !isStatusCapability(statusCapability)) {
    throw new Error("generated Paper Slide credentials violate their contract");
  }
  return Object.freeze({ requestId, statusCapability });
}

export function isPaperSlideRequestId(value) {
  return typeof value === "string" && PAPER_SLIDE_REQUEST_ID_PATTERN.test(value);
}

export function isStatusCapability(value) {
  return typeof value === "string" && STATUS_CAPABILITY_PATTERN.test(value);
}

export function isCapabilityHash(value) {
  return typeof value === "string" && CAPABILITY_HASH_PATTERN.test(value);
}

export function isPaperSlideFailureCode(value) {
  return typeof value === "string" && FAILURE_CODES.has(value);
}

export function isPaperSlideHttpErrorCode(value) {
  return typeof value === "string" && HTTP_ERROR_CODES.has(value);
}

export async function sha256Hex(value) {
  if (typeof value !== "string") throw new TypeError("sha256 input must be a string");
  const bytes = new TextEncoder().encode(value);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function isReviewedPublishedPath(value, expectedDeckId = null) {
  if (typeof value !== "string") return false;
  const match = PUBLIC_DECK_PATH_PATTERN.exec(value);
  return match !== null && (expectedDeckId === null || match[1] === expectedDeckId);
}

function isUtcTimestamp(value) {
  if (typeof value !== "string" || !UTC_TIMESTAMP_PATTERN.test(value)) return false;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return false;
  const normalizedSeconds = new Date(milliseconds).toISOString().slice(0, 19);
  return normalizedSeconds === value.slice(0, 19);
}

export function projectPaperSlideStatus(record, requestId, nowMs = null) {
  if (!isPaperSlideRequestId(requestId) || !hasExactOwnKeys(record, STATUS_RECORD_KEYS)) {
    return null;
  }
  if (
    nowMs !== null &&
    (!Number.isFinite(nowMs) || nowMs < 0 || !Number.isFinite(new Date(nowMs).getTime()))
  ) {
    return null;
  }
  const {
    paper_id,
    status,
    phase,
    coverage,
    deck_id,
    preview_available,
    preview_expires_at,
    public_url,
    message_code,
    updated_at,
    retryable,
  } = record;
  if (typeof paper_id !== "string" || !PAPER_ID_PATTERN.test(paper_id)) return null;
  if (!PAPER_SLIDE_STATUSES.includes(status)) return null;
  if (phase !== null && !PAPER_SLIDE_PHASES.includes(phase)) return null;
  if (coverage !== null && !COVERAGES.has(coverage)) return null;
  if (deck_id !== null && (typeof deck_id !== "string" || !DECK_ID_PATTERN.test(deck_id))) {
    return null;
  }
  if (typeof preview_available !== "boolean") return null;
  if (preview_expires_at !== null && !isUtcTimestamp(preview_expires_at)) return null;
  if (!isUtcTimestamp(updated_at)) return null;

  let expectedMessageCode;
  if (status === "queued") {
    expectedMessageCode = MESSAGE_CODES.queued;
    if (
      phase !== null || coverage !== null || deck_id !== null || preview_available ||
      preview_expires_at !== null || public_url !== null || retryable !== null
    ) {
      return null;
    }
  } else if (status === "running") {
    expectedMessageCode = MESSAGE_CODES[phase];
    if (
      !RUNNING_PHASES.has(phase) || coverage !== null || deck_id !== null || preview_available ||
      preview_expires_at !== null || public_url !== null || retryable !== null
    ) {
      return null;
    }
  } else if (status === "validating") {
    expectedMessageCode = MESSAGE_CODES.validating;
    if (
      phase !== "validating" || coverage !== null || deck_id !== null || preview_available ||
      preview_expires_at !== null || public_url !== null || retryable !== null
    ) {
      return null;
    }
  } else if (status === "awaiting_review") {
    expectedMessageCode = MESSAGE_CODES.awaiting_review;
    if (
      phase !== "awaiting_review" || !COVERAGES.has(coverage) || deck_id === null ||
      public_url !== null || retryable !== null ||
      (preview_available ? preview_expires_at === null : preview_expires_at !== null)
    ) {
      return null;
    }
    if (preview_available && Date.parse(preview_expires_at) <= Date.parse(updated_at)) return null;
    if (preview_available && nowMs !== null && Date.parse(preview_expires_at) <= nowMs) return null;
  } else if (status === "publishing") {
    expectedMessageCode = MESSAGE_CODES[phase];
    if (
      !PUBLISHING_PHASES.has(phase) || !COVERAGES.has(coverage) || deck_id === null ||
      preview_available || preview_expires_at !== null || public_url !== null || retryable !== null
    ) {
      return null;
    }
  } else if (status === "published") {
    expectedMessageCode = MESSAGE_CODES.published;
    if (
      phase !== null || !COVERAGES.has(coverage) || deck_id === null || preview_available ||
      preview_expires_at !== null || !isReviewedPublishedPath(public_url, deck_id) || retryable !== null
    ) {
      return null;
    }
  } else {
    expectedMessageCode = MESSAGE_CODES[status];
    if (
      phase !== null || preview_available || preview_expires_at !== null || public_url !== null ||
      typeof retryable !== "boolean"
    ) {
      return null;
    }
    if ((status === "rejected" || status === "expired") && (!COVERAGES.has(coverage) || deck_id === null)) {
      return null;
    }
    if (deck_id !== null && !COVERAGES.has(coverage)) return null;
  }
  if (message_code !== expectedMessageCode) return null;

  const response = {
    ok: true,
    request_id: requestId,
    paper_id,
    status,
    phase,
    coverage,
    deck_id,
    preview_available,
    preview_expires_at,
    public_url,
    message_code,
    updated_at,
  };
  if (FAILURE_STATUSES.has(status)) response.retryable = retryable;
  return Object.freeze(response);
}
