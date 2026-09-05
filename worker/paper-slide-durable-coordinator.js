// Production-oriented strongly consistent Paper Slide coordinator boundary.
//
// All correctness-sensitive state lives in one named Durable Object. The
// client intentionally does not forward caller-provided timestamps: rate
// windows, TTLs, and the daily new-job ceiling use the Durable Object's clock.
// This module only supplies the binding boundary; it does not dispatch jobs or
// configure/deploy a Worker.

import {
  PAPER_ID_PATTERN,
  isCapabilityHash,
  isPaperSlideRequestId,
  projectPaperSlideStatus,
  sha256Hex,
} from "./paper-slide-contract.js";

export const PAPER_SLIDE_DURABLE_COORDINATOR_NAME = "paper-slide-coordinator-v1";
export const PAPER_SLIDE_DURABLE_COORDINATOR_SCHEMA =
  "paper-slide-durable-coordinator-v1";
export const PAPER_SLIDE_DURABLE_COORDINATOR_MAX_BODY_BYTES = 4096;
export const PAPER_SLIDE_DURABLE_JOB_RETENTION_SECONDS = 30 * 86_400;
export const PAPER_SLIDE_DURABLE_CLAIM_LEASE_SECONDS = 900;
export const PAPER_SLIDE_DURABLE_CLAIM_RECLAIM_GRACE_SECONDS = 6 * 3_600;

const INTERNAL_PATH = "/v1/paper-slide-coordinator";
const RESPONSE_BODY_LIMIT = 16_384;
// Keep every emitted timestamp inside the status contract's four-digit year.
const MAX_DATE_MS = 253_402_300_799_999;
const DUMMY_CAPABILITY_HASH = "0".repeat(64);
const DUMMY_JOB_KEY = "job:missing";
const REQUEST_EXPIRY_RING_SLOTS = 25;
const JOB_RETENTION_RING_SLOTS = 31;
const UPDATE_TOKEN_HEADER = "x-paper-slide-coordinator-update-token";
const JOB_KEY_PATTERN = /^[0-9a-f]{64}(?![\s\S])/;
export const PAPER_SLIDE_DURABLE_JOB_ID_PATTERN =
  /^paper-slide-job-[A-Za-z0-9_-]{22}(?![\s\S])/;
const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const CONTENT_LENGTH = /^(?:0|[1-9][0-9]*)(?![\s\S])/;
const JSON_CONTENT_TYPE =
  /^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i;
const UPDATE_TOKEN_PATTERN = /^[\x21-\x7e]{32,256}(?![\s\S])/;
const MAX_SECRET_COMPARE_LENGTH = 256;
const CLAIMANT_TOKEN_PATTERN = /^psct_[A-Za-z0-9_-]{43}(?![\s\S])/;

const ACTIVE_DEDUP_STATES = new Set([
  "queued",
  "running",
  "validating",
  "awaiting_review",
  "publishing",
  "published",
]);
const TERMINAL_CLEANUP_STATUSES = new Set(["failed", "rejected", "expired"]);
const IMMUTABLE_SAME_STATUS = new Set([
  "awaiting_review",
  "published",
  "failed",
  "rejected",
  "expired",
]);
const ALLOWED_TRANSITIONS = Object.freeze({
  queued: new Set(["queued", "running", "failed"]),
  running: new Set(["running", "validating", "failed"]),
  validating: new Set(["validating", "awaiting_review", "failed"]),
  awaiting_review: new Set(["awaiting_review", "publishing", "failed", "rejected", "expired"]),
  publishing: new Set(["publishing", "published", "failed"]),
  published: new Set(["published"]),
  failed: new Set(["failed"]),
  rejected: new Set(["rejected"]),
  expired: new Set(["expired"]),
});
const PHASE_RANKS = Object.freeze({
  running: new Map([
    ["resolving_source", 0],
    ["fetching", 1],
    ["extracting", 2],
    ["generating", 3],
  ]),
  publishing: new Map([
    ["promoting", 0],
    ["deploying", 1],
    ["smoke", 2],
  ]),
});
const RECLAIMABLE_PHASES = new Set(["resolving_source", "fetching", "extracting"]);
const LEASE_CLOSING_STATUSES = new Set([
  "awaiting_review", "published", "failed", "rejected", "expired",
]);
const STATUS_UPDATE_KEYS = Object.freeze([
  "coverage",
  "deck_id",
  "message_code",
  "phase",
  "preview_available",
  "preview_expires_at",
  "public_url",
  "retryable",
  "status",
  "updated_at",
]);
const VALIDATION_REQUEST_ID = `paper-slide-${"A".repeat(22)}`;

const OPERATION_INPUT_KEYS = Object.freeze({
  claim_job: ["claimant_hash", "job_id", "lease_generation", "reclaim"],
  consume_request_attempt: ["ip"],
  consume_status_attempt: ["ip"],
  reserve_or_join: [
    "capability_hash",
    "coverage_preference",
    "job_key",
    "language",
    "paper_id",
    "request_id",
  ],
  read_authorized_status: ["capability_hash", "request_id"],
  revoke_request: ["request_id"],
  update_claimed_job_status: ["claimant_hash", "job_id", "lease_generation", "status"],
  update_job_status: ["job_id", "status"],
});

const DEFAULTS = Object.freeze({
  requestLimitPerHour: 2,
  requestGlobalLimitPerHour: 200,
  statusLimitPerMinute: 12,
  statusGlobalLimitPerMinute: 60,
  dailyJobLimit: 20,
  dispatchTtlSeconds: 900,
  requestTtlSeconds: 86_400,
  candidateTtlSeconds: 86_400,
  claimLeaseSeconds: PAPER_SLIDE_DURABLE_CLAIM_LEASE_SECONDS,
});
const MAX_SERVER_NOW_MS =
  MAX_DATE_MS - PAPER_SLIDE_DURABLE_JOB_RETENTION_SECONDS * 1000;
const MAX_JOB_ALIAS_COUNT = REQUEST_EXPIRY_RING_SLOTS * DEFAULTS.requestGlobalLimitPerHour;

const CONFIG_FIELDS = Object.freeze([
  ["requestLimitPerHour", "PAPER_SLIDE_REQUEST_LIMIT_PER_HOUR", DEFAULTS.requestLimitPerHour],
  ["requestGlobalLimitPerHour", "PAPER_SLIDE_REQUEST_GLOBAL_LIMIT_PER_HOUR", DEFAULTS.requestGlobalLimitPerHour],
  ["statusLimitPerMinute", "PAPER_SLIDE_STATUS_LIMIT_PER_MINUTE", DEFAULTS.statusLimitPerMinute],
  ["statusGlobalLimitPerMinute", "PAPER_SLIDE_STATUS_GLOBAL_LIMIT_PER_MINUTE", DEFAULTS.statusGlobalLimitPerMinute],
  ["dailyJobLimit", "PAPER_SLIDE_DAILY_JOB_LIMIT", DEFAULTS.dailyJobLimit],
  ["dispatchTtlSeconds", "PAPER_SLIDE_DISPATCH_TTL_SECONDS", DEFAULTS.dispatchTtlSeconds],
  ["requestTtlSeconds", "PAPER_SLIDE_REQUEST_TTL_SECONDS", 86_400],
  ["candidateTtlSeconds", "PAPER_SLIDE_CANDIDATE_TTL_SECONDS", 86_400],
  ["claimLeaseSeconds", "PAPER_SLIDE_CLAIM_LEASE_SECONDS", PAPER_SLIDE_DURABLE_CLAIM_LEASE_SECONDS],
]);

class ClosedRequestError extends Error {}
class ClosedForbiddenError extends Error {}
class ClosedOperationError extends Error {}
class ClosedClockError extends Error {}

export class PaperSlideDurableCoordinatorClientError extends Error {
  constructor(message = "Paper Slide durable coordinator is unavailable") {
    super(message);
    this.name = "PaperSlideDurableCoordinatorClientError";
  }
}

export function isPaperSlideDurableJobId(value) {
  return typeof value === "string" && PAPER_SLIDE_DURABLE_JOB_ID_PATTERN.test(value);
}

export function isPaperSlideClaimantToken(value) {
  return typeof value === "string" && CLAIMANT_TOKEN_PATTERN.test(value);
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

function secureJobId() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `paper-slide-job-${encodeBase64Url(bytes)}`;
}

function hasExactOwnKeys(value, expected) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function requireIp(ip) {
  if (typeof ip !== "string" || ip.length === 0 || ip.length > 128) {
    throw new ClosedRequestError();
  }
}

function requireServerNow(nowMs) {
  if (!Number.isFinite(nowMs) || nowMs < 0 || nowMs > MAX_SERVER_NOW_MS) {
    throw new ClosedClockError();
  }
  return Math.floor(nowMs);
}

function parseBoundedConfig(env) {
  const result = {};
  for (const [field, binding, maximum] of CONFIG_FIELDS) {
    const raw = env?.[binding];
    if (raw === undefined || raw === null || raw === "") {
      result[field] = DEFAULTS[field];
      continue;
    }
    const text = String(raw);
    if (!/^(?:0|[1-9][0-9]{0,15})(?![\s\S])/.test(text)) throw new ClosedClockError();
    const value = Number(text);
    if (!Number.isSafeInteger(value) || value > maximum) throw new ClosedClockError();
    result[field] = value;
  }
  return Object.freeze(result);
}

function utcDay(nowMs) {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function isUtcDay(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?![\s\S])/.test(value)) {
    return false;
  }
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function secondsUntilNextUtcDay(nowMs) {
  const date = new Date(nowMs);
  const next = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
  return Math.max(1, Math.min(86_400, Math.ceil((next - nowMs) / 1000)));
}

function timingSafeEqual(left, right) {
  const safeLeft = typeof left === "string" ? left : "";
  const safeRight = typeof right === "string" ? right : "";
  let difference = safeLeft.length ^ safeRight.length;
  for (let index = 0; index < MAX_SECRET_COMPARE_LENGTH; index++) {
    difference |= (safeLeft.charCodeAt(index % Math.max(safeLeft.length, 1)) || 0) ^
      (safeRight.charCodeAt(index % Math.max(safeRight.length, 1)) || 0);
  }
  return difference === 0;
}

function copyStatus(record) {
  return {
    paper_id: record.paper_id,
    status: record.status,
    phase: record.phase,
    coverage: record.coverage,
    deck_id: record.deck_id,
    preview_available: record.preview_available,
    preview_expires_at: record.preview_expires_at,
    public_url: record.public_url,
    message_code: record.message_code,
    updated_at: record.updated_at,
    retryable: record.retryable,
  };
}

function queuedStatus(paperId, nowMs) {
  return {
    paper_id: paperId,
    status: "queued",
    phase: null,
    coverage: null,
    deck_id: null,
    preview_available: false,
    preview_expires_at: null,
    public_url: null,
    message_code: "PAPER_SLIDE_QUEUED",
    updated_at: new Date(nowMs).toISOString(),
    retryable: null,
  };
}

function resolvingSourceStatus(nowMs) {
  return {
    status: "running",
    phase: "resolving_source",
    coverage: null,
    deck_id: null,
    preview_available: false,
    preview_expires_at: null,
    public_url: null,
    message_code: "PAPER_SLIDE_RESOLVING_SOURCE",
    updated_at: new Date(nowMs).toISOString(),
    retryable: null,
  };
}

function closeClaim(job) {
  job.claimantHash = null;
  job.claimLeaseExpiresAtMs = null;
  job.providerFenced = false;
}

function hiddenClaimResult() {
  return {
    claimed: false,
    reclaimed: false,
    lease_generation: null,
    lease_expires_at: null,
  };
}

function successfulClaimResult(job, reclaimed) {
  return {
    claimed: true,
    reclaimed,
    lease_generation: job.claimGeneration,
    lease_expires_at: new Date(job.claimLeaseExpiresAtMs).toISOString(),
  };
}

function expireCandidate(job, nowMs) {
  if (
    job.status.status !== "awaiting_review" ||
    job.candidateExpiresAtMs === null ||
    nowMs < job.candidateExpiresAtMs
  ) {
    return false;
  }
  job.status = {
    paper_id: job.status.paper_id,
    status: "expired",
    phase: null,
    coverage: job.status.coverage,
    deck_id: job.status.deck_id,
    preview_available: false,
    preview_expires_at: null,
    public_url: null,
    message_code: "PAPER_SLIDE_EXPIRED",
    updated_at: new Date(nowMs).toISOString(),
    retryable: true,
  };
  job.candidateExpiresAtMs = null;
  closeClaim(job);
  return true;
}

function expireQueuedDispatch(job, nowMs) {
  if (
    job.status.status !== "queued" ||
    job.dispatchExpiresAtMs === null ||
    nowMs < job.dispatchExpiresAtMs
  ) {
    return false;
  }
  job.status = {
    paper_id: job.status.paper_id,
    status: "failed",
    phase: null,
    coverage: null,
    deck_id: null,
    preview_available: false,
    preview_expires_at: null,
    public_url: null,
    message_code: "PAPER_SLIDE_FAILED",
    updated_at: new Date(nowMs).toISOString(),
    retryable: true,
  };
  job.dispatchExpiresAtMs = null;
  closeClaim(job);
  return true;
}

function transitionJob(job, status, nowMs, candidateTtlSeconds) {
  if (!hasExactOwnKeys(status, STATUS_UPDATE_KEYS)) throw new ClosedOperationError();
  const nextStatus = copyStatus({ paper_id: job.status.paper_id, ...status });
  if (!projectPaperSlideStatus(nextStatus, VALIDATION_REQUEST_ID)) {
    throw new ClosedOperationError();
  }
  if (Date.parse(nextStatus.updated_at) > nowMs) throw new ClosedOperationError();
  const transitions = ALLOWED_TRANSITIONS[job.status.status];
  if (!transitions || !transitions.has(nextStatus.status)) throw new ClosedOperationError();
  if (Date.parse(nextStatus.updated_at) < Date.parse(job.status.updated_at)) {
    throw new ClosedOperationError();
  }
  const phaseRanks = PHASE_RANKS[nextStatus.status];
  if (
    nextStatus.status === job.status.status &&
    phaseRanks &&
    phaseRanks.get(nextStatus.phase) < phaseRanks.get(job.status.phase)
  ) {
    throw new ClosedOperationError();
  }
  if (
    nextStatus.status === job.status.status &&
    IMMUTABLE_SAME_STATUS.has(nextStatus.status) &&
    JSON.stringify(nextStatus) !== JSON.stringify(job.status)
  ) {
    throw new ClosedOperationError();
  }
  let candidateExpiresAtMs = null;
  if (nextStatus.status === "awaiting_review") {
    const explicitExpiry = nextStatus.preview_expires_at === null
      ? null
      : Date.parse(nextStatus.preview_expires_at);
    const maximumExpiry = Date.parse(nextStatus.updated_at) + candidateTtlSeconds * 1000;
    if (explicitExpiry !== null && explicitExpiry > maximumExpiry) {
      throw new ClosedOperationError();
    }
    candidateExpiresAtMs = explicitExpiry ?? maximumExpiry;
  }
  job.status = nextStatus;
  job.candidateExpiresAtMs = candidateExpiresAtMs;
  if (nextStatus.status !== "queued") job.dispatchExpiresAtMs = null;
}

function assertReservation(input) {
  if (
    typeof input.paper_id !== "string" || !PAPER_ID_PATTERN.test(input.paper_id) ||
    (input.language !== "ja" && input.language !== "en") ||
    input.coverage_preference !== "auto" ||
    typeof input.job_key !== "string" || !JOB_KEY_PATTERN.test(input.job_key) ||
    !isPaperSlideRequestId(input.request_id) ||
    !isCapabilityHash(input.capability_hash)
  ) {
    throw new ClosedRequestError();
  }
}

function validateOperationEnvelope(value) {
  if (!hasExactOwnKeys(value, ["input", "operation", "schema_version"])) {
    throw new ClosedRequestError();
  }
  if (value.schema_version !== PAPER_SLIDE_DURABLE_COORDINATOR_SCHEMA) {
    throw new ClosedRequestError();
  }
  const expected = OPERATION_INPUT_KEYS[value.operation];
  if (!expected || !hasExactOwnKeys(value.input, expected)) throw new ClosedRequestError();
  return value;
}

function closedJson(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "private, no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

function closedError(error, status) {
  return closedJson({
    schema_version: PAPER_SLIDE_DURABLE_COORDINATOR_SCHEMA,
    ok: false,
    error,
  }, status);
}

async function readBoundedBody(request) {
  const declaredRaw = request.headers.get("content-length");
  let declared = null;
  if (declaredRaw !== null) {
    if (!CONTENT_LENGTH.test(declaredRaw)) throw new ClosedRequestError();
    declared = Number(declaredRaw);
    if (!Number.isSafeInteger(declared)) throw new ClosedRequestError();
    if (declared > PAPER_SLIDE_DURABLE_COORDINATOR_MAX_BODY_BYTES) {
      throw new ClosedRequestError();
    }
  }
  if (request.body === null) throw new ClosedRequestError();
  let reader;
  try {
    reader = request.body.getReader();
  } catch {
    throw new ClosedRequestError();
  }
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new ClosedRequestError();
      total += value.byteLength;
      if (total > PAPER_SLIDE_DURABLE_COORDINATOR_MAX_BODY_BYTES) {
        try { await reader.cancel(); } catch {}
        throw new ClosedRequestError();
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ClosedRequestError) throw error;
    try { await reader.cancel(); } catch {}
    throw new ClosedRequestError();
  }
  if (declared !== null && declared !== total) throw new ClosedRequestError();
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ClosedRequestError();
  }
}

function requestKey(requestId) { return `request:${requestId}`; }
function capabilityKey(capabilityHash) { return `capability:${capabilityHash}`; }
function jobKey(jobId) { return `job:${jobId}`; }
function cacheKey(canonicalKey) { return `cache:${canonicalKey}`; }

async function trustedNow(transaction, observedNowMs) {
  const nowMs = requireServerNow(observedNowMs);
  const last = await transaction.get("meta:last-clock-ms");
  if (last !== undefined && (
    !Number.isInteger(last) || last < 0 || last > MAX_SERVER_NOW_MS || nowMs < last
  )) {
    throw new ClosedClockError();
  }
  await transaction.put("meta:last-clock-ms", nowMs);
  return nowMs;
}

function requireRateWindow(value) {
  if (value === undefined) return null;
  if (!hasExactOwnKeys(value, ["counts", "globalCount", "window"])) {
    throw new ClosedOperationError();
  }
  const countKeys = value.counts !== null &&
      typeof value.counts === "object" && !Array.isArray(value.counts)
    ? Object.keys(value.counts)
    : [];
  if (
      !Number.isSafeInteger(value.globalCount) || value.globalCount < 0 ||
      value.globalCount > DEFAULTS.requestGlobalLimitPerHour ||
      !Number.isSafeInteger(value.window) || value.window < 0 ||
      value.counts === null || typeof value.counts !== "object" || Array.isArray(value.counts) ||
      !countKeys.every((key) =>
        /^[0-9a-f]{64}(?![\s\S])/.test(key) &&
        Number.isSafeInteger(value.counts[key]) && value.counts[key] > 0 &&
        value.counts[key] <= DEFAULTS.statusLimitPerMinute
      ) ||
      countKeys.length > DEFAULTS.requestGlobalLimitPerHour ||
      countKeys.reduce((sum, key) => sum + value.counts[key], 0) !== value.globalCount) {
    throw new ClosedOperationError();
  }
  return value;
}

function requireRequestRecord(value) {
  if (value === undefined) return null;
  if (!hasExactOwnKeys(value, ["capabilityHash", "expiresAtMs", "jobId"]) ||
      !isCapabilityHash(value.capabilityHash) ||
      !Number.isSafeInteger(value.expiresAtMs) || value.expiresAtMs < 0 ||
      value.expiresAtMs > MAX_DATE_MS ||
      !isPaperSlideDurableJobId(value.jobId)) {
    throw new ClosedOperationError();
  }
  return value;
}

function requireCapabilityRecord(value) {
  if (value === undefined) return null;
  if (!hasExactOwnKeys(value, ["expiresAtMs", "requestId"]) ||
      !Number.isSafeInteger(value.expiresAtMs) || value.expiresAtMs < 0 ||
      value.expiresAtMs > MAX_DATE_MS ||
      !isPaperSlideRequestId(value.requestId)) {
    throw new ClosedOperationError();
  }
  return value;
}

function requireRequestExpiryBucket(value) {
  if (value === undefined) return null;
  if (!hasExactOwnKeys(value, ["entries", "epochHour"]) ||
      !Number.isSafeInteger(value.epochHour) || value.epochHour < 0 ||
      !Array.isArray(value.entries) || value.entries.length > DEFAULTS.requestGlobalLimitPerHour ||
      !value.entries.every((entry) =>
        hasExactOwnKeys(entry, ["capabilityHash", "expiresAtMs", "requestId"]) &&
        isCapabilityHash(entry.capabilityHash) &&
        Number.isSafeInteger(entry.expiresAtMs) && entry.expiresAtMs >= 0 &&
        entry.expiresAtMs <= MAX_DATE_MS &&
        isPaperSlideRequestId(entry.requestId)
      )) {
    throw new ClosedOperationError();
  }
  return value;
}

function requireJobRecord(value) {
  if (value === undefined) return null;
  if (!hasExactOwnKeys(value, [
    "aliasCount", "cacheKey", "candidateExpiresAtMs", "claimGeneration", "claimLeaseExpiresAtMs",
    "claimReclaimCount", "claimantHash", "coveragePreference", "dispatchExpiresAtMs", "jobId",
    "language", "paperId", "providerFenced", "retentionExpiresAtMs", "status",
  ]) ||
      !isPaperSlideDurableJobId(value.jobId) ||
      !Number.isSafeInteger(value.aliasCount) || value.aliasCount < 0 ||
      value.aliasCount > MAX_JOB_ALIAS_COUNT ||
      typeof value.cacheKey !== "string" || !JOB_KEY_PATTERN.test(value.cacheKey) ||
      !Number.isInteger(value.claimGeneration) || value.claimGeneration < 0 ||
      value.claimGeneration > 2 ||
      !Number.isInteger(value.claimReclaimCount) || value.claimReclaimCount < 0 ||
      value.claimReclaimCount > 1 || value.claimReclaimCount >= Math.max(1, value.claimGeneration) ||
      (value.claimantHash !== null && !isCapabilityHash(value.claimantHash)) ||
      (value.claimLeaseExpiresAtMs !== null &&
        (!Number.isSafeInteger(value.claimLeaseExpiresAtMs) || value.claimLeaseExpiresAtMs < 0 ||
          value.claimLeaseExpiresAtMs > MAX_DATE_MS)) ||
      typeof value.providerFenced !== "boolean" ||
      !PAPER_ID_PATTERN.test(value.paperId) ||
      (value.language !== "ja" && value.language !== "en") ||
      value.coveragePreference !== "auto" ||
      (value.candidateExpiresAtMs !== null &&
        (!Number.isSafeInteger(value.candidateExpiresAtMs) || value.candidateExpiresAtMs < 0 ||
          value.candidateExpiresAtMs > MAX_DATE_MS)) ||
      (value.dispatchExpiresAtMs !== null &&
        (!Number.isSafeInteger(value.dispatchExpiresAtMs) || value.dispatchExpiresAtMs < 0 ||
          value.dispatchExpiresAtMs > MAX_DATE_MS)) ||
      !Number.isSafeInteger(value.retentionExpiresAtMs) || value.retentionExpiresAtMs < 0 ||
      value.retentionExpiresAtMs > MAX_DATE_MS ||
      (value.status?.status === "queued") !== (value.dispatchExpiresAtMs !== null) ||
      (value.status?.status === "awaiting_review") !== (value.candidateExpiresAtMs !== null) ||
      projectPaperSlideStatus(value.status, VALIDATION_REQUEST_ID) === null) {
    throw new ClosedOperationError();
  }
  const updatedAtMs = Date.parse(value.status.updated_at);
  const claimantPresent = value.claimantHash !== null;
  const leasePresent = value.claimLeaseExpiresAtMs !== null;
  const preProviderRunning = value.status.status === "running" &&
    RECLAIMABLE_PHASES.has(value.status.phase);
  const providerActive = (
    value.status.status === "running" && value.status.phase === "generating"
  ) || value.status.status === "validating";
  if (value.retentionExpiresAtMs < updatedAtMs ||
      (value.dispatchExpiresAtMs !== null && value.dispatchExpiresAtMs < updatedAtMs) ||
      (value.candidateExpiresAtMs !== null && value.candidateExpiresAtMs < updatedAtMs) ||
      (value.claimLeaseExpiresAtMs !== null && value.claimLeaseExpiresAtMs < updatedAtMs) ||
      (value.claimLeaseExpiresAtMs !== null &&
        value.claimLeaseExpiresAtMs > value.retentionExpiresAtMs) ||
      (value.claimGeneration === 0 && (claimantPresent || leasePresent || value.claimReclaimCount !== 0)) ||
      ((value.claimGeneration === 2) !== (value.claimReclaimCount === 1)) ||
      (preProviderRunning && (!claimantPresent || !leasePresent || value.providerFenced)) ||
      (providerActive && (!claimantPresent || leasePresent || !value.providerFenced)) ||
      (!preProviderRunning && !providerActive &&
        (claimantPresent || leasePresent || value.providerFenced))) {
    throw new ClosedOperationError();
  }
  return value;
}

function requireJobRetentionBucket(value) {
  if (value === undefined) return null;
  if (!hasExactOwnKeys(value, ["entries", "epochDay"]) ||
      !Number.isSafeInteger(value.epochDay) || value.epochDay < 0 ||
      !Array.isArray(value.entries) || value.entries.length > DEFAULTS.dailyJobLimit ||
      !value.entries.every((entry) =>
        hasExactOwnKeys(entry, ["expiresAtMs", "jobId"]) &&
        Number.isSafeInteger(entry.expiresAtMs) && entry.expiresAtMs >= 0 &&
        entry.expiresAtMs <= MAX_DATE_MS &&
        isPaperSlideDurableJobId(entry.jobId)
      )) {
    throw new ClosedOperationError();
  }
  return value;
}

async function cleanRetainedJobs(transaction, entries, nowMs) {
  const remaining = [];
  for (const entry of entries) {
    if (entry.expiresAtMs > nowMs) {
      remaining.push(entry);
      continue;
    }
    const job = requireJobRecord(await transaction.get(jobKey(entry.jobId)));
    if (job && job.jobId === entry.jobId && job.retentionExpiresAtMs === entry.expiresAtMs) {
      await deleteJobAndCache(transaction, job);
    }
  }
  return remaining;
}

async function deleteJobAndCache(transaction, job) {
  await transaction.delete(jobKey(job.jobId));
  const mapped = await transaction.get(cacheKey(job.cacheKey));
  if (mapped === job.jobId) await transaction.delete(cacheKey(job.cacheKey));
}

async function sweepCurrentJobRetention(transaction, nowMs) {
  const epochDay = Math.floor(nowMs / 86_400_000);
  const key = `expiry:job:${epochDay % JOB_RETENTION_RING_SLOTS}`;
  const bucket = requireJobRetentionBucket(await transaction.get(key));
  if (bucket === null) return;
  const remaining = await cleanRetainedJobs(transaction, bucket.entries, nowMs);
  if (bucket.epochDay !== epochDay && remaining.length > 0) throw new ClosedOperationError();
  if (remaining.length === 0) await transaction.delete(key);
  else await transaction.put(key, { epochDay: bucket.epochDay, entries: remaining });
}

async function indexRetainedJob(transaction, job, nowMs) {
  const epochDay = Math.floor(job.retentionExpiresAtMs / 86_400_000);
  const key = `expiry:job:${epochDay % JOB_RETENTION_RING_SLOTS}`;
  const bucket = requireJobRetentionBucket(await transaction.get(key));
  let entries = [];
  if (bucket !== null) {
    entries = await cleanRetainedJobs(transaction, bucket.entries, nowMs);
    if (bucket.epochDay !== epochDay && entries.length > 0) throw new ClosedOperationError();
  }
  if (entries.length >= DEFAULTS.dailyJobLimit) throw new ClosedOperationError();
  entries.push({ jobId: job.jobId, expiresAtMs: job.retentionExpiresAtMs });
  await transaction.put(key, { epochDay, entries });
}

async function releaseJobAlias(transaction, job) {
  if (job.aliasCount <= 0) throw new ClosedOperationError();
  job.aliasCount--;
  if (job.aliasCount === 0 && TERMINAL_CLEANUP_STATUSES.has(job.status.status)) {
    await transaction.delete(jobKey(job.jobId));
    const mapped = await transaction.get(cacheKey(job.cacheKey));
    if (mapped === job.jobId) await transaction.delete(cacheKey(job.cacheKey));
    return;
  }
  await transaction.put(jobKey(job.jobId), job);
}

async function removeRequestAssociation(transaction, requestId, expectedRequest = null) {
  const request = requireRequestRecord(await transaction.get(requestKey(requestId)));
  if (request === null) return false;
  if (expectedRequest !== null && (
    request.capabilityHash !== expectedRequest.capabilityHash ||
    request.expiresAtMs !== expectedRequest.expiresAtMs ||
    request.jobId !== expectedRequest.jobId
  )) {
    throw new ClosedOperationError();
  }
  const capability = requireCapabilityRecord(
    await transaction.get(capabilityKey(request.capabilityHash)),
  );
  await transaction.delete(requestKey(requestId));
  if (capability && capability.requestId === requestId &&
      capability.expiresAtMs === request.expiresAtMs) {
    await transaction.delete(capabilityKey(request.capabilityHash));
  }
  const job = requireJobRecord(await transaction.get(jobKey(request.jobId)));
  if (job !== null) {
    if (job.jobId !== request.jobId) throw new ClosedOperationError();
    await releaseJobAlias(transaction, job);
  }
  return true;
}

async function consumeRateWindow(
  transaction,
  key,
  window,
  ipHash,
  perIpLimit,
  globalLimit,
) {
  const stored = requireRateWindow(await transaction.get(key));
  const record = stored !== null && stored.window === window
    ? stored
    : { window, globalCount: 0, counts: {} };
  // Check the global guard first so rotating IPs cannot amplify storage after
  // the bounded window has already reached its ceiling.
  if (record.globalCount >= globalLimit) return { allowed: false };
  const perIpCount = record.counts[ipHash] ?? 0;
  if (perIpCount >= perIpLimit) return { allowed: false };
  record.globalCount++;
  record.counts[ipHash] = perIpCount + 1;
  await transaction.put(key, record);
  return { allowed: true };
}

// HTTP/storage core for a deployed DurableObject subclass. The deployment
// wrapper must extend DurableObject from `cloudflare:workers`, call super(),
// construct this service with its ctx/env, and delegate fetch().
export class PaperSlideDurableCoordinatorService {
  constructor(state, env, testHooks = {}) {
    this.state = state;
    this.env = env ?? {};
    this.now = typeof testHooks.now === "function" ? testHooks.now : () => Date.now();
    this.createJobId = typeof testHooks.createJobId === "function"
      ? testHooks.createJobId
      : secureJobId;
    try {
      this.config = parseBoundedConfig(this.env);
      if (this.config.claimLeaseSeconds < 1) throw new ClosedClockError();
    } catch {
      this.config = null;
    }
    const token = this.env.PAPER_SLIDE_COORDINATOR_UPDATE_TOKEN;
    this.updateToken = typeof token === "string" && UPDATE_TOKEN_PATTERN.test(token) ? token : null;
  }

  async fetch(request) {
    try {
      if (this.config === null) throw new ClosedClockError();
      const url = new URL(request.url);
      if (url.pathname !== INTERNAL_PATH || url.search !== "") {
        return closedError("not_found", 404);
      }
      if (request.method !== "POST") return closedError("method_not_allowed", 405);
      if (!JSON_CONTENT_TYPE.test(request.headers.get("content-type") ?? "") ||
          ![null, "identity"].includes(request.headers.get("content-encoding")?.trim().toLowerCase() ?? null)) {
        return closedError("invalid_request", 400);
      }
      const envelope = validateOperationEnvelope(await readBoundedBody(request));
      if ([
        "claim_job", "update_claimed_job_status", "update_job_status", "revoke_request",
      ].includes(envelope.operation)) {
        const supplied = request.headers.get(UPDATE_TOKEN_HEADER);
        const expected = this.updateToken ?? "!".repeat(32);
        if (this.updateToken === null || typeof supplied !== "string" ||
            supplied.length > MAX_SECRET_COMPARE_LENGTH ||
            !timingSafeEqual(supplied, expected)) {
          throw new ClosedForbiddenError();
        }
      }
      const result = await this.#operate(envelope.operation, envelope.input);
      return closedJson({
        schema_version: PAPER_SLIDE_DURABLE_COORDINATOR_SCHEMA,
        ok: true,
        result,
      });
    } catch (error) {
      if (error instanceof ClosedRequestError) return closedError("invalid_request", 400);
      if (error instanceof ClosedForbiddenError) return closedError("forbidden", 403);
      if (error instanceof ClosedOperationError) return closedError("operation_rejected", 409);
      return closedError("service_unavailable", 503);
    }
  }

  async #operate(operation, input) {
    const observedNowMs = requireServerNow(this.now());
    if (!this.state?.storage || typeof this.state.storage.transaction !== "function") {
      throw new ClosedOperationError();
    }
    if (operation === "consume_request_attempt") {
      requireIp(input.ip);
      const ipHash = await sha256Hex(input.ip);
      return this.state.storage.transaction(async (transaction) => {
        const nowMs = await trustedNow(transaction, observedNowMs);
        const hour = Math.floor(nowMs / 3_600_000);
        const result = await consumeRateWindow(
          transaction,
          "rate:request:current",
          hour,
          ipHash,
          this.config.requestLimitPerHour,
          this.config.requestGlobalLimitPerHour,
        );
        return {
          allowed: result.allowed,
          retry_after_seconds: result.allowed ? null : 3600,
        };
      });
    }
    if (operation === "consume_status_attempt") {
      requireIp(input.ip);
      const ipHash = await sha256Hex(input.ip);
      return this.state.storage.transaction(async (transaction) => {
        const nowMs = await trustedNow(transaction, observedNowMs);
        const minute = Math.floor(nowMs / 60_000);
        const result = await consumeRateWindow(
          transaction,
          "rate:status:current",
          minute,
          ipHash,
          this.config.statusLimitPerMinute,
          this.config.statusGlobalLimitPerMinute,
        );
        return {
          allowed: result.allowed,
          retry_after_seconds: result.allowed ? null : 60,
        };
      });
    }
    if (operation === "reserve_or_join") {
      assertReservation(input);
      const newJobId = this.createJobId();
      if (!isPaperSlideDurableJobId(newJobId)) throw new ClosedOperationError();
      return this.state.storage.transaction(async (transaction) => {
        const nowMs = await trustedNow(transaction, observedNowMs);
        return this.#reserve(transaction, input, nowMs, newJobId);
      });
    }
    if (operation === "read_authorized_status") {
      if (!isPaperSlideRequestId(input.request_id) || !isCapabilityHash(input.capability_hash)) {
        throw new ClosedRequestError();
      }
      return this.state.storage.transaction(async (transaction) => {
        const nowMs = await trustedNow(transaction, observedNowMs);
        const requestRecord = requireRequestRecord(await transaction.get(requestKey(input.request_id)));
        const capabilityRecord = requestRecord === null
          ? null
          : requireCapabilityRecord(await transaction.get(
            capabilityKey(requestRecord.capabilityHash),
          ));
        const capabilityMatches = timingSafeEqual(
          requestRecord?.capabilityHash ?? DUMMY_CAPABILITY_HASH,
          input.capability_hash,
        );
        const storedJob = requireJobRecord(await transaction.get(
          requestRecord?.jobId ? jobKey(requestRecord.jobId) : DUMMY_JOB_KEY,
        ));
        if (storedJob && storedJob.jobId !== requestRecord?.jobId) {
          throw new ClosedOperationError();
        }
        const queuedExpired = storedJob ? expireQueuedDispatch(storedJob, nowMs) : false;
        if (!requestRecord || nowMs >= requestRecord.expiresAtMs) {
          if (requestRecord) {
            await transaction.delete(requestKey(input.request_id));
            await transaction.delete(capabilityKey(requestRecord.capabilityHash));
            if (storedJob) await releaseJobAlias(transaction, storedJob);
          }
          return { found: false };
        }
        if (!capabilityRecord || capabilityRecord.requestId !== input.request_id ||
            capabilityRecord.expiresAtMs !== requestRecord.expiresAtMs ||
            requestRecord.expiresAtMs > nowMs + this.config.requestTtlSeconds * 1000) {
          throw new ClosedOperationError();
        }
        if (!capabilityMatches || !storedJob) {
          if (queuedExpired && storedJob) {
            await transaction.put(jobKey(storedJob.jobId), storedJob);
          }
          return { found: false };
        }
        if (queuedExpired || expireCandidate(storedJob, nowMs)) {
          await transaction.put(jobKey(storedJob.jobId), storedJob);
        }
        return { found: true, status: copyStatus(storedJob.status) };
      });
    }
    if (operation === "claim_job") {
      if (!isPaperSlideDurableJobId(input.job_id) ||
          !isCapabilityHash(input.claimant_hash) ||
          !Number.isInteger(input.lease_generation) ||
          input.lease_generation < 0 || input.lease_generation > 2 ||
          typeof input.reclaim !== "boolean") {
        throw new ClosedRequestError();
      }
      return this.state.storage.transaction(async (transaction) => {
        const nowMs = await trustedNow(transaction, observedNowMs);
        const job = requireJobRecord(await transaction.get(jobKey(input.job_id)));
        if (!job || job.jobId !== input.job_id) return hiddenClaimResult();
        if (nowMs >= job.retentionExpiresAtMs) {
          await deleteJobAndCache(transaction, job);
          return hiddenClaimResult();
        }
        if (expireQueuedDispatch(job, nowMs)) {
          await transaction.put(jobKey(job.jobId), job);
          return hiddenClaimResult();
        }
        if (job.status.status === "queued") {
          if (input.lease_generation !== 0 || input.reclaim) return hiddenClaimResult();
          transitionJob(
            job,
            resolvingSourceStatus(nowMs),
            nowMs,
            this.config.candidateTtlSeconds,
          );
          job.claimGeneration = 1;
          job.claimReclaimCount = 0;
          job.claimantHash = input.claimant_hash;
          job.claimLeaseExpiresAtMs = nowMs + this.config.claimLeaseSeconds * 1000;
          job.providerFenced = false;
          await transaction.put(jobKey(job.jobId), job);
          return successfulClaimResult(job, false);
        }

        const preProvider = job.status.status === "running" &&
          RECLAIMABLE_PHASES.has(job.status.phase) && !job.providerFenced;
        if (!preProvider) return hiddenClaimResult();
        const sameClaimant = timingSafeEqual(job.claimantHash, input.claimant_hash);
        if (sameClaimant && input.reclaim && job.claimGeneration === 2 &&
            job.claimReclaimCount === 1 && input.lease_generation === 1 &&
            nowMs < job.claimLeaseExpiresAtMs) {
          // Exact replay of the one permitted reclaim after its response was
          // lost. As with generation-zero confirmation, do not extend the
          // lease until the caller proves it learned generation two.
          return successfulClaimResult(job, true);
        }
        if (sameClaimant && !input.reclaim &&
            (input.lease_generation === 0 || input.lease_generation === job.claimGeneration) &&
            nowMs < job.claimLeaseExpiresAtMs) {
          // Generation zero is the replay of a possibly lost initial response;
          // it confirms but does not extend the original lease. Once the caller
          // has learned the generation, later confirmations also heartbeat it.
          if (input.lease_generation === job.claimGeneration) {
            job.claimLeaseExpiresAtMs = nowMs + this.config.claimLeaseSeconds * 1000;
            await transaction.put(jobKey(job.jobId), job);
          }
          return successfulClaimResult(job, false);
        }
        const reclaimAtMs = job.claimLeaseExpiresAtMs +
          PAPER_SLIDE_DURABLE_CLAIM_RECLAIM_GRACE_SECONDS * 1000;
        if (!input.reclaim || sameClaimant ||
            input.lease_generation !== job.claimGeneration ||
            nowMs < reclaimAtMs || job.claimReclaimCount >= 1 ||
            job.claimGeneration >= 2) {
          return hiddenClaimResult();
        }
        job.status = {
          paper_id: job.status.paper_id,
          ...resolvingSourceStatus(nowMs),
        };
        job.claimGeneration++;
        job.claimReclaimCount++;
        job.claimantHash = input.claimant_hash;
        job.claimLeaseExpiresAtMs = nowMs + this.config.claimLeaseSeconds * 1000;
        job.providerFenced = false;
        await transaction.put(jobKey(job.jobId), job);
        return successfulClaimResult(job, true);
      });
    }
    if (operation === "update_claimed_job_status") {
      if (!isPaperSlideDurableJobId(input.job_id) ||
          !isCapabilityHash(input.claimant_hash) ||
          !Number.isInteger(input.lease_generation) ||
          input.lease_generation < 1 || input.lease_generation > 2) {
        throw new ClosedRequestError();
      }
      return this.state.storage.transaction(async (transaction) => {
        const nowMs = await trustedNow(transaction, observedNowMs);
        const job = requireJobRecord(await transaction.get(jobKey(input.job_id)));
        if (!job || job.jobId !== input.job_id) throw new ClosedOperationError();
        if (nowMs >= job.retentionExpiresAtMs) {
          await deleteJobAndCache(transaction, job);
          return { updated: false };
        }
        if (job.claimGeneration !== input.lease_generation ||
            !timingSafeEqual(job.claimantHash ?? DUMMY_CAPABILITY_HASH, input.claimant_hash)) {
          throw new ClosedOperationError();
        }
        const preProvider = job.status.status === "running" &&
          RECLAIMABLE_PHASES.has(job.status.phase) && !job.providerFenced;
        const providerActive = (
          job.status.status === "running" && job.status.phase === "generating"
        ) || job.status.status === "validating";
        if (!preProvider && !providerActive) throw new ClosedOperationError();
        const closing = LEASE_CLOSING_STATUSES.has(input.status?.status);
        if (preProvider && !closing && nowMs >= job.claimLeaseExpiresAtMs) {
          throw new ClosedOperationError();
        }
        if (preProvider && !closing && input.status?.status !== "running") {
          // validating is intentionally unreachable until the claimant has
          // atomically committed running/generating as the provider fence.
          throw new ClosedOperationError();
        }
        transitionJob(job, input.status, nowMs, this.config.candidateTtlSeconds);
        if (closing) {
          closeClaim(job);
        } else if (job.status.status === "running" && job.status.phase === "generating") {
          // This is the atomic provider fence. It is deliberately permanent:
          // a crash after this commit requires reconciliation, never a timeout
          // takeover that could overlap an already-started provider call.
          job.providerFenced = true;
          job.claimLeaseExpiresAtMs = null;
        } else if (preProvider) {
          job.claimLeaseExpiresAtMs = nowMs + this.config.claimLeaseSeconds * 1000;
        }
        await transaction.put(jobKey(job.jobId), job);
        return { updated: true };
      });
    }
    if (operation === "update_job_status") {
      if (!isPaperSlideDurableJobId(input.job_id)) {
        throw new ClosedRequestError();
      }
      return this.state.storage.transaction(async (transaction) => {
        const nowMs = await trustedNow(transaction, observedNowMs);
        const job = requireJobRecord(await transaction.get(jobKey(input.job_id)));
        if (!job) throw new ClosedOperationError();
        if (job.jobId !== input.job_id) throw new ClosedOperationError();
        if (nowMs >= job.retentionExpiresAtMs) {
          await deleteJobAndCache(transaction, job);
          return { updated: false };
        }
        if (expireCandidate(job, nowMs)) {
          if (job.aliasCount === 0) {
            await deleteJobAndCache(transaction, job);
          } else {
            await transaction.put(jobKey(job.jobId), job);
          }
          return { updated: false };
        }
        const administrativeTransition =
          (input.status?.status === "failed" &&
            ["queued", "running", "validating", "awaiting_review", "publishing"].includes(
              job.status.status,
            )) ||
          (["awaiting_review", "publishing"].includes(job.status.status) &&
            ["publishing", "published", "failed", "rejected", "expired"].includes(
              input.status?.status,
            ));
        if (!administrativeTransition) throw new ClosedOperationError();
        transitionJob(job, input.status, nowMs, this.config.candidateTtlSeconds);
        closeClaim(job);
        if (job.aliasCount === 0 && TERMINAL_CLEANUP_STATUSES.has(job.status.status)) {
          await transaction.delete(jobKey(job.jobId));
          const mapped = await transaction.get(cacheKey(job.cacheKey));
          if (mapped === job.jobId) await transaction.delete(cacheKey(job.cacheKey));
        } else {
          await transaction.put(jobKey(job.jobId), job);
        }
        return { updated: true };
      });
    }
    if (operation === "revoke_request") {
      if (!isPaperSlideRequestId(input.request_id)) throw new ClosedRequestError();
      return this.state.storage.transaction(async (transaction) => {
        const nowMs = await trustedNow(transaction, observedNowMs);
        const request = requireRequestRecord(await transaction.get(requestKey(input.request_id)));
        if (!request) return { revoked: false };
        const job = requireJobRecord(await transaction.get(jobKey(request.jobId)));
        if (!job || job.jobId !== request.jobId) throw new ClosedOperationError();
        await transaction.delete(requestKey(input.request_id));
        await transaction.delete(capabilityKey(request.capabilityHash));
        await releaseJobAlias(transaction, job);
        return { revoked: nowMs < request.expiresAtMs };
      });
    }
    throw new ClosedRequestError();
  }

  async #reserve(transaction, input, nowMs, newJobId) {
    const storedRequest = requireRequestRecord(await transaction.get(requestKey(input.request_id)));
    if (storedRequest && nowMs < storedRequest.expiresAtMs) throw new ClosedOperationError();
    if (storedRequest) {
      await removeRequestAssociation(transaction, input.request_id, storedRequest);
    }
    const storedCapability = requireCapabilityRecord(
      await transaction.get(capabilityKey(input.capability_hash)),
    );
    if (storedCapability && nowMs < storedCapability.expiresAtMs) throw new ClosedOperationError();
    if (storedCapability) {
      const associatedRequest = requireRequestRecord(
        await transaction.get(requestKey(storedCapability.requestId)),
      );
      if (associatedRequest &&
          associatedRequest.capabilityHash === input.capability_hash &&
          associatedRequest.expiresAtMs === storedCapability.expiresAtMs) {
        await removeRequestAssociation(transaction, storedCapability.requestId, associatedRequest);
      } else {
        await transaction.delete(capabilityKey(input.capability_hash));
      }
    }

    await sweepCurrentJobRetention(transaction, nowMs);

    const expiresAtMs = nowMs + this.config.requestTtlSeconds * 1000;
    // Index by issue hour, not expiry hour. With a 24-hour hard TTL and a
    // 25-slot ring, a reused slot is guaranteed expired while each bucket is
    // bounded by the request global limit for exactly one rate window.
    const issueHour = Math.floor(nowMs / 3_600_000);
    const expiryBucketKey = `expiry:request:${issueHour % REQUEST_EXPIRY_RING_SLOTS}`;
    const oldBucket = requireRequestExpiryBucket(await transaction.get(expiryBucketKey));
    let expiryEntries;
    if (oldBucket === null || oldBucket.epochHour !== issueHour) {
      if (oldBucket !== null) {
        for (const oldEntry of oldBucket.entries) {
          if (oldEntry.expiresAtMs > nowMs) throw new ClosedOperationError();
          const oldRequest = requireRequestRecord(
            await transaction.get(requestKey(oldEntry.requestId)),
          );
          if (oldRequest &&
              oldRequest.expiresAtMs === oldEntry.expiresAtMs &&
              oldRequest.capabilityHash === oldEntry.capabilityHash) {
            await transaction.delete(requestKey(oldEntry.requestId));
            const oldJob = requireJobRecord(await transaction.get(jobKey(oldRequest.jobId)));
            if (oldJob) {
              if (oldJob.jobId !== oldRequest.jobId) throw new ClosedOperationError();
              await releaseJobAlias(transaction, oldJob);
            }
          }
          const oldCapability = requireCapabilityRecord(
            await transaction.get(capabilityKey(oldEntry.capabilityHash)),
          );
          if (oldCapability &&
              oldCapability.expiresAtMs === oldEntry.expiresAtMs &&
              oldCapability.requestId === oldEntry.requestId) {
            await transaction.delete(capabilityKey(oldEntry.capabilityHash));
          }
        }
      }
      expiryEntries = [];
    } else {
      expiryEntries = oldBucket.entries;
    }
    if (expiryEntries.length >= this.config.requestGlobalLimitPerHour) {
      throw new ClosedOperationError();
    }

    const mappedJobId = await transaction.get(cacheKey(input.job_key));
    if (mappedJobId !== undefined &&
        !isPaperSlideDurableJobId(mappedJobId)) {
      throw new ClosedOperationError();
    }
    let job = mappedJobId === undefined
      ? null
      : requireJobRecord(await transaction.get(jobKey(mappedJobId)));
    if (mappedJobId !== undefined && job === null) throw new ClosedOperationError();
    if (job && job.jobId !== mappedJobId) throw new ClosedOperationError();
    if (job && (
      job.cacheKey !== input.job_key ||
      job.paperId !== input.paper_id ||
      job.language !== input.language ||
      job.coveragePreference !== input.coverage_preference
    )) {
      throw new ClosedOperationError();
    }
    if (job && nowMs >= job.retentionExpiresAtMs) {
      await deleteJobAndCache(transaction, job);
      job = null;
    }
    if (job && expireQueuedDispatch(job, nowMs)) {
      if (job.aliasCount === 0) {
        await transaction.delete(jobKey(job.jobId));
        await transaction.delete(cacheKey(job.cacheKey));
        job = null;
      } else {
        await transaction.put(jobKey(job.jobId), job);
      }
    }
    if (job && expireCandidate(job, nowMs)) {
      if (job.aliasCount === 0) {
        await transaction.delete(jobKey(job.jobId));
        await transaction.delete(cacheKey(job.cacheKey));
        job = null;
      } else {
        await transaction.put(jobKey(job.jobId), job);
      }
    }
    let deduplicated = Boolean(job && ACTIVE_DEDUP_STATES.has(job.status.status));
    if (!deduplicated) {
      const day = utcDay(nowMs);
      const dailyKey = "daily:current";
      const dailyRecord = await transaction.get(dailyKey);
      if (dailyRecord !== undefined && (
        !hasExactOwnKeys(dailyRecord, ["count", "day"]) ||
        !isUtcDay(dailyRecord.day) ||
        !Number.isSafeInteger(dailyRecord.count) || dailyRecord.count < 0 ||
        dailyRecord.count > DEFAULTS.dailyJobLimit
      )) {
        throw new ClosedOperationError();
      }
      const jobsToday = dailyRecord?.day === day ? dailyRecord.count : 0;
      if (jobsToday >= this.config.dailyJobLimit) {
        return {
          ok: false,
          reason: "daily_job_limited",
          retry_after_seconds: secondsUntilNextUtcDay(nowMs),
        };
      }
      if (await transaction.get(jobKey(newJobId)) !== undefined) {
        throw new ClosedOperationError();
      }
      const jobId = newJobId;
      job = {
        jobId,
        cacheKey: input.job_key,
        aliasCount: 0,
        claimantHash: null,
        claimGeneration: 0,
        claimLeaseExpiresAtMs: null,
        claimReclaimCount: 0,
        providerFenced: false,
        paperId: input.paper_id,
        language: input.language,
        coveragePreference: input.coverage_preference,
        candidateExpiresAtMs: null,
        dispatchExpiresAtMs: nowMs + this.config.dispatchTtlSeconds * 1000,
        retentionExpiresAtMs: nowMs + PAPER_SLIDE_DURABLE_JOB_RETENTION_SECONDS * 1000,
        status: queuedStatus(input.paper_id, nowMs),
      };
      await transaction.put(jobKey(jobId), job);
      await transaction.put(cacheKey(input.job_key), jobId);
      await transaction.put(dailyKey, { day, count: jobsToday + 1 });
      await indexRetainedJob(transaction, job, nowMs);
      deduplicated = false;
    }
    await transaction.put(requestKey(input.request_id), {
      capabilityHash: input.capability_hash,
      expiresAtMs,
      jobId: job.jobId,
    });
    await transaction.put(capabilityKey(input.capability_hash), {
      expiresAtMs,
      requestId: input.request_id,
    });
    job.aliasCount++;
    await transaction.put(jobKey(job.jobId), job);
    expiryEntries.push({
      capabilityHash: input.capability_hash,
      expiresAtMs,
      requestId: input.request_id,
    });
    await transaction.put(expiryBucketKey, { epochHour: issueHour, entries: expiryEntries });
    return { ok: true, deduplicated, job_id: job.jobId };
  }
}

async function readBoundedResponse(response) {
  if (response.body === null) throw new PaperSlideDurableCoordinatorClientError();
  let reader;
  try {
    reader = response.body.getReader();
  } catch {
    throw new PaperSlideDurableCoordinatorClientError();
  }
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error();
      total += value.byteLength;
      if (total > RESPONSE_BODY_LIMIT) {
        try { await reader.cancel(); } catch {}
        throw new Error();
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new PaperSlideDurableCoordinatorClientError();
  }
}

export function createPaperSlideDurableCoordinatorClient({
  namespace,
  updateToken = null,
  objectName = PAPER_SLIDE_DURABLE_COORDINATOR_NAME,
} = {}) {
  if (!namespace || typeof namespace.idFromName !== "function" || typeof namespace.get !== "function") {
    throw new TypeError("Paper Slide Durable Object namespace is required");
  }
  if (typeof objectName !== "string" || objectName.length === 0 || objectName.length > 128) {
    throw new TypeError("Paper Slide Durable Object name is invalid");
  }
  if (updateToken !== null &&
      (typeof updateToken !== "string" || !UPDATE_TOKEN_PATTERN.test(updateToken))) {
    throw new TypeError("Paper Slide coordinator update token is invalid");
  }
  const stub = namespace.get(namespace.idFromName(objectName));
  if (!stub || typeof stub.fetch !== "function") {
    throw new TypeError("Paper Slide Durable Object stub is invalid");
  }

  async function post(operation, input, allowUpdate = false) {
    const text = JSON.stringify({
      schema_version: PAPER_SLIDE_DURABLE_COORDINATOR_SCHEMA,
      operation,
      input,
    });
    if (new TextEncoder().encode(text).byteLength > PAPER_SLIDE_DURABLE_COORDINATOR_MAX_BODY_BYTES) {
      throw new PaperSlideDurableCoordinatorClientError();
    }
    const headers = new Headers({ "content-type": "application/json" });
    if (allowUpdate) {
      if (updateToken === null) throw new PaperSlideDurableCoordinatorClientError();
      headers.set(UPDATE_TOKEN_HEADER, updateToken);
    }
    let response;
    try {
      response = await stub.fetch(new Request(`https://durable.invalid${INTERNAL_PATH}`, {
        method: "POST",
        headers,
        body: text,
      }));
    } catch {
      throw new PaperSlideDurableCoordinatorClientError();
    }
    const body = await readBoundedResponse(response);
    if (!response.ok || !hasExactOwnKeys(body, ["ok", "result", "schema_version"]) ||
        body.schema_version !== PAPER_SLIDE_DURABLE_COORDINATOR_SCHEMA || body.ok !== true) {
      throw new PaperSlideDurableCoordinatorClientError();
    }
    return body.result;
  }

  return Object.freeze({
    async consumeRequestAttempt(ip, _nowMs) {
      const result = await post("consume_request_attempt", { ip });
      if (!hasExactOwnKeys(result, ["allowed", "retry_after_seconds"]) ||
          typeof result.allowed !== "boolean" ||
          (result.retry_after_seconds !== null && !Number.isInteger(result.retry_after_seconds))) {
        throw new PaperSlideDurableCoordinatorClientError();
      }
      return { allowed: result.allowed, retryAfterSeconds: result.retry_after_seconds };
    },
    async consumeStatusAttempt(ip, _nowMs) {
      const result = await post("consume_status_attempt", { ip });
      if (!hasExactOwnKeys(result, ["allowed", "retry_after_seconds"]) ||
          typeof result.allowed !== "boolean" ||
          (result.retry_after_seconds !== null && !Number.isInteger(result.retry_after_seconds))) {
        throw new PaperSlideDurableCoordinatorClientError();
      }
      return { allowed: result.allowed, retryAfterSeconds: result.retry_after_seconds };
    },
    async reserveOrJoin({
      paperId,
      language,
      coveragePreference,
      jobKey: canonicalJobKey,
      requestId,
      capabilityHash,
    }) {
      const result = await post("reserve_or_join", {
        paper_id: paperId,
        language,
        coverage_preference: coveragePreference,
        job_key: canonicalJobKey,
        request_id: requestId,
        capability_hash: capabilityHash,
      });
      if (hasExactOwnKeys(result, ["ok", "reason", "retry_after_seconds"]) &&
          result.ok === false && result.reason === "daily_job_limited" &&
          Number.isInteger(result.retry_after_seconds)) {
        return {
          ok: false,
          reason: result.reason,
          retryAfterSeconds: result.retry_after_seconds,
        };
      }
      if (!hasExactOwnKeys(result, ["deduplicated", "job_id", "ok"]) ||
          result.ok !== true || typeof result.deduplicated !== "boolean" ||
          !isPaperSlideDurableJobId(result.job_id)) {
        throw new PaperSlideDurableCoordinatorClientError();
      }
      return { ok: true, deduplicated: result.deduplicated, jobId: result.job_id };
    },
    async readAuthorizedStatus({ requestId, capabilityHash }) {
      const result = await post("read_authorized_status", {
        request_id: requestId,
        capability_hash: capabilityHash,
      });
      if (hasExactOwnKeys(result, ["found"]) && result.found === false) return null;
      if (!hasExactOwnKeys(result, ["found", "status"]) || result.found !== true) {
        throw new PaperSlideDurableCoordinatorClientError();
      }
      const status = projectPaperSlideStatus(result.status, VALIDATION_REQUEST_ID);
      if (status === null) throw new PaperSlideDurableCoordinatorClientError();
      return copyStatus(result.status);
    },
    async updateJobStatus(jobId, status, _nowMs) {
      const result = await post("update_job_status", { job_id: jobId, status }, true);
      if (!hasExactOwnKeys(result, ["updated"]) || result.updated !== true) {
        throw new PaperSlideDurableCoordinatorClientError();
      }
    },
    async updateClaimedJobStatus(jobId, status, claimantToken, leaseGeneration) {
      if (!isPaperSlideDurableJobId(jobId) || !isPaperSlideClaimantToken(claimantToken) ||
          !Number.isInteger(leaseGeneration) || leaseGeneration < 1 || leaseGeneration > 2) {
        throw new TypeError("Paper Slide claim status input is invalid");
      }
      const claimantHash = await sha256Hex(claimantToken);
      const result = await post("update_claimed_job_status", {
        claimant_hash: claimantHash,
        job_id: jobId,
        lease_generation: leaseGeneration,
        status,
      }, true);
      if (!hasExactOwnKeys(result, ["updated"]) || result.updated !== true) {
        throw new PaperSlideDurableCoordinatorClientError();
      }
    },
    async claimJob(jobId, claimantToken, options = { leaseGeneration: 0, reclaim: false }) {
      if (!isPaperSlideDurableJobId(jobId) || !isPaperSlideClaimantToken(claimantToken) ||
          !hasExactOwnKeys(options, ["leaseGeneration", "reclaim"]) ||
          !Number.isInteger(options.leaseGeneration) || options.leaseGeneration < 0 ||
          options.leaseGeneration > 2 || typeof options.reclaim !== "boolean") {
        throw new TypeError("Paper Slide claim input is invalid");
      }
      const claimantHash = await sha256Hex(claimantToken);
      const result = await post("claim_job", {
        claimant_hash: claimantHash,
        job_id: jobId,
        lease_generation: options.leaseGeneration,
        reclaim: options.reclaim,
      }, true);
      if (!hasExactOwnKeys(result, [
        "claimed", "lease_expires_at", "lease_generation", "reclaimed",
      ]) || typeof result.claimed !== "boolean" || typeof result.reclaimed !== "boolean") {
        throw new PaperSlideDurableCoordinatorClientError();
      }
      if (!result.claimed) {
        if (result.reclaimed || result.lease_generation !== null ||
            result.lease_expires_at !== null) {
          throw new PaperSlideDurableCoordinatorClientError();
        }
        return {
          claimed: false,
          reclaimed: false,
          leaseGeneration: null,
          leaseExpiresAt: null,
        };
      }
      if (!Number.isInteger(result.lease_generation) || result.lease_generation < 1 ||
          result.lease_generation > 2 || typeof result.lease_expires_at !== "string" ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z(?![\s\S])/.test(
            result.lease_expires_at,
          ) || !Number.isFinite(Date.parse(result.lease_expires_at))) {
        throw new PaperSlideDurableCoordinatorClientError();
      }
      return {
        claimed: true,
        reclaimed: result.reclaimed,
        leaseGeneration: result.lease_generation,
        leaseExpiresAt: result.lease_expires_at,
      };
    },
    async revokeRequest(requestId) {
      const result = await post("revoke_request", { request_id: requestId }, true);
      if (!hasExactOwnKeys(result, ["revoked"]) || typeof result.revoked !== "boolean") {
        throw new PaperSlideDurableCoordinatorClientError();
      }
      return result.revoked;
    },
  });
}
