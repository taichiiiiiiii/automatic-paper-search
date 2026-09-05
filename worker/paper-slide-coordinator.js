// Atomic in-memory implementation of the Paper Slide coordinator contract.
// It is a deterministic fixture, not a production persistence layer. A live
// adapter must provide the same atomic operations with strongly consistent
// storage (Workers KV get/put is not sufficient for this contract).

import {
  PAPER_ID_PATTERN,
  isCapabilityHash,
  isPaperSlideRequestId,
  projectPaperSlideStatus,
} from "./paper-slide-contract.js";

const ACTIVE_DEDUP_STATES = new Set([
  "queued",
  "running",
  "validating",
  "awaiting_review",
  "publishing",
  "published",
]);
const IMMUTABLE_SAME_STATUS = new Set([
  "awaiting_review",
  "published",
  "failed",
  "rejected",
  "expired",
]);
const TERMINAL_CLEANUP_STATUSES = new Set(["failed", "rejected", "expired"]);

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

const VALIDATION_REQUEST_ID = `paper-slide-${"A".repeat(22)}`;
const JOB_KEY_PATTERN = /^[0-9a-f]{64}(?![\s\S])/;
const DUMMY_CAPABILITY_HASH = "0".repeat(64);
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
const MAX_DATE_MS = 8_640_000_000_000_000;

export class PaperSlideCoordinatorError extends Error {
  constructor(message) {
    super(message);
    this.name = "PaperSlideCoordinatorError";
  }
}

function requireBoundedInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new TypeError(`${label} must be a bounded non-negative integer`);
  }
  return value;
}

function requireNow(nowMs) {
  if (!Number.isFinite(nowMs) || nowMs < 0 || nowMs > MAX_DATE_MS) {
    throw new PaperSlideCoordinatorError("nowMs is invalid");
  }
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
    throw new PaperSlideCoordinatorError("IP rate-limit key is invalid");
  }
}

function consumeWindow(map, key, limit, retryAfterSeconds) {
  const count = map.get(key) ?? 0;
  if (count >= limit) return { allowed: false, retryAfterSeconds };
  map.set(key, count + 1);
  return { allowed: true, retryAfterSeconds: null };
}

function utcDay(nowMs) {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function secondsUntilNextUtcDay(nowMs) {
  const date = new Date(nowMs);
  const next = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
  return Math.max(1, Math.min(86_400, Math.ceil((next - nowMs) / 1000)));
}

function timingSafeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
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

export class InMemoryPaperSlideCoordinator {
  constructor({
    requestLimitPerHour = 2,
    statusLimitPerMinute = 12,
    statusGlobalLimitPerMinute = 60,
    dailyJobLimit = 20,
    requestTtlSeconds = 86_400,
    candidateTtlSeconds = 86_400,
  } = {}) {
    this.requestLimitPerHour = requireBoundedInteger(requestLimitPerHour, "requestLimitPerHour");
    this.statusLimitPerMinute = requireBoundedInteger(statusLimitPerMinute, "statusLimitPerMinute");
    this.statusGlobalLimitPerMinute = requireBoundedInteger(
      statusGlobalLimitPerMinute,
      "statusGlobalLimitPerMinute",
    );
    this.dailyJobLimit = requireBoundedInteger(dailyJobLimit, "dailyJobLimit");
    this.requestTtlSeconds = requireBoundedInteger(requestTtlSeconds, "requestTtlSeconds", 86_400);
    this.candidateTtlSeconds = requireBoundedInteger(
      candidateTtlSeconds,
      "candidateTtlSeconds",
      86_400,
    );

    this.requestAttempts = new Map();
    this.statusAttempts = new Map();
    this.statusGlobalAttempts = new Map();
    this.dailyJobs = new Map();
    this.jobsByCacheKey = new Map();
    this.jobs = new Map();
    this.requests = new Map();
    this.capabilityHashes = new Set();
    this.nextJobNumber = 1;
    this.jobsCreated = 0;
  }

  get requestCount() {
    return this.requests.size;
  }

  async consumeRequestAttempt(ip, nowMs) {
    requireIp(ip);
    requireNow(nowMs);
    this.sweep(nowMs);
    const hour = Math.floor(nowMs / 3_600_000);
    return consumeWindow(
      this.requestAttempts,
      `${hour}:${ip}`,
      this.requestLimitPerHour,
      3600,
    );
  }

  async consumeStatusAttempt(ip, nowMs) {
    requireIp(ip);
    requireNow(nowMs);
    this.sweep(nowMs);
    const minute = Math.floor(nowMs / 60_000);
    const perIp = consumeWindow(
      this.statusAttempts,
      `${minute}:${ip}`,
      this.statusLimitPerMinute,
      60,
    );
    if (!perIp.allowed) return perIp;
    return consumeWindow(
      this.statusGlobalAttempts,
      String(minute),
      this.statusGlobalLimitPerMinute,
      60,
    );
  }

  async reserveOrJoin({
    paperId,
    language,
    coveragePreference,
    jobKey,
    requestId,
    capabilityHash,
    nowMs,
  }) {
    requireNow(nowMs);
    if (
      typeof paperId !== "string" ||
      !PAPER_ID_PATTERN.test(paperId) ||
      (language !== "ja" && language !== "en") ||
      coveragePreference !== "auto" ||
      typeof jobKey !== "string" ||
      !JOB_KEY_PATTERN.test(jobKey) ||
      !isPaperSlideRequestId(requestId) ||
      !isCapabilityHash(capabilityHash)
    ) {
      throw new PaperSlideCoordinatorError("reservation violates the coordinator contract");
    }
    this.sweep(nowMs);
    if (this.requests.has(requestId) || this.capabilityHashes.has(capabilityHash)) {
      throw new PaperSlideCoordinatorError("request credential collision");
    }

    const cacheKey = jobKey;
    const existingJobId = this.jobsByCacheKey.get(cacheKey);
    const existingJob = existingJobId === undefined ? null : this.jobs.get(existingJobId);
    if (
      existingJob &&
      (
        existingJob.paperId !== paperId ||
        existingJob.language !== language ||
        existingJob.coveragePreference !== coveragePreference
      )
    ) {
      throw new PaperSlideCoordinatorError("canonical job key collision");
    }
    if (existingJob) this.expireStaleCandidate(existingJob, nowMs);
    let job = existingJob;
    let deduplicated = Boolean(job && ACTIVE_DEDUP_STATES.has(job.status.status));

    if (!deduplicated) {
      const day = utcDay(nowMs);
      const jobsToday = this.dailyJobs.get(day) ?? 0;
      if (jobsToday >= this.dailyJobLimit) {
        return {
          ok: false,
          reason: "daily_job_limited",
          retryAfterSeconds: secondsUntilNextUtcDay(nowMs),
        };
      }
      const jobId = `fixture-job-${this.nextJobNumber++}`;
      job = {
        jobId,
        cacheKey,
        paperId,
        language,
        coveragePreference,
        candidateExpiresAtMs: null,
        status: {
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
        },
      };
      this.jobs.set(jobId, job);
      this.jobsByCacheKey.set(cacheKey, jobId);
      this.dailyJobs.set(day, jobsToday + 1);
      this.jobsCreated++;
      deduplicated = false;
    }

    this.requests.set(requestId, {
      capabilityHash,
      jobId: job.jobId,
      expiresAtMs: nowMs + this.requestTtlSeconds * 1000,
    });
    this.capabilityHashes.add(capabilityHash);
    return {
      ok: true,
      deduplicated,
      jobId: job.jobId,
    };
  }

  async readAuthorizedStatus({ requestId, capabilityHash, nowMs }) {
    requireNow(nowMs);
    if (!isPaperSlideRequestId(requestId) || !isCapabilityHash(capabilityHash)) return null;
    this.sweep(nowMs);
    const request = this.requests.get(requestId);
    const capabilityMatches = timingSafeEqual(
      request?.capabilityHash ?? DUMMY_CAPABILITY_HASH,
      capabilityHash,
    );
    if (!request) return null;
    if (!capabilityMatches) return null;
    const job = this.jobs.get(request.jobId);
    if (job) this.expireStaleCandidate(job, nowMs);
    return job ? copyStatus(job.status) : null;
  }

  async updateJobStatus(jobId, status, nowMs) {
    requireNow(nowMs);
    this.sweep(nowMs);
    const job = this.jobs.get(jobId);
    if (!job) throw new PaperSlideCoordinatorError("unknown job");
    this.expireStaleCandidate(job, nowMs);
    if (!hasExactOwnKeys(status, STATUS_UPDATE_KEYS)) {
      throw new PaperSlideCoordinatorError("invalid job status");
    }
    const nextStatus = copyStatus({ paper_id: job.status.paper_id, ...status });
    const validated = projectPaperSlideStatus(nextStatus, VALIDATION_REQUEST_ID);
    if (!validated) throw new PaperSlideCoordinatorError("invalid job status");
    if (Date.parse(nextStatus.updated_at) > nowMs) {
      throw new PaperSlideCoordinatorError("job status timestamp is in the future");
    }
    const transitions = ALLOWED_TRANSITIONS[job.status.status];
    if (!transitions || !transitions.has(status.status)) {
      throw new PaperSlideCoordinatorError("invalid job status transition");
    }
    if (Date.parse(nextStatus.updated_at) < Date.parse(job.status.updated_at)) {
      throw new PaperSlideCoordinatorError("job status timestamp regression is not allowed");
    }
    const phaseRanks = PHASE_RANKS[status.status];
    if (
      status.status === job.status.status &&
      phaseRanks &&
      phaseRanks.get(status.phase) < phaseRanks.get(job.status.phase)
    ) {
      throw new PaperSlideCoordinatorError("job status phase regression is not allowed");
    }
    if (
      status.status === job.status.status &&
      IMMUTABLE_SAME_STATUS.has(status.status) &&
      JSON.stringify(nextStatus) !== JSON.stringify(job.status)
    ) {
      throw new PaperSlideCoordinatorError("terminal status mutation is not allowed");
    }
    let nextCandidateExpiresAtMs = null;
    if (nextStatus.status === "awaiting_review") {
      const statusExpiry = nextStatus.preview_expires_at === null
        ? null
        : Date.parse(nextStatus.preview_expires_at);
      const maximumCandidateExpiry = Date.parse(nextStatus.updated_at) + this.candidateTtlSeconds * 1000;
      if (statusExpiry !== null && statusExpiry > maximumCandidateExpiry) {
        throw new PaperSlideCoordinatorError("candidate expiry exceeds the configured TTL");
      }
      nextCandidateExpiresAtMs = statusExpiry ?? maximumCandidateExpiry;
    }
    job.status = nextStatus;
    job.candidateExpiresAtMs = nextCandidateExpiresAtMs;
  }

  revokeRequest(requestId) {
    if (!isPaperSlideRequestId(requestId)) return false;
    const request = this.requests.get(requestId);
    if (!request) return false;
    this.requests.delete(requestId);
    this.capabilityHashes.delete(request.capabilityHash);
    return true;
  }

  expireStaleCandidate(job, nowMs) {
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
    return true;
  }

  sweep(nowMs) {
    requireNow(nowMs);
    const currentHour = Math.floor(nowMs / 3_600_000);
    const currentMinute = Math.floor(nowMs / 60_000);
    const currentDay = utcDay(nowMs);
    for (const key of this.requestAttempts.keys()) {
      if (!key.startsWith(`${currentHour}:`)) this.requestAttempts.delete(key);
    }
    for (const key of this.statusAttempts.keys()) {
      if (!key.startsWith(`${currentMinute}:`)) this.statusAttempts.delete(key);
    }
    for (const key of this.statusGlobalAttempts.keys()) {
      if (key !== String(currentMinute)) this.statusGlobalAttempts.delete(key);
    }
    for (const key of this.dailyJobs.keys()) {
      if (key !== currentDay) this.dailyJobs.delete(key);
    }
    for (const [requestId, request] of this.requests) {
      if (nowMs >= request.expiresAtMs) {
        this.requests.delete(requestId);
        this.capabilityHashes.delete(request.capabilityHash);
      }
    }
    const referencedJobs = new Set(Array.from(this.requests.values(), (request) => request.jobId));
    for (const [jobId, job] of this.jobs) {
      if (TERMINAL_CLEANUP_STATUSES.has(job.status.status) && !referencedJobs.has(jobId)) {
        this.jobs.delete(jobId);
        if (this.jobsByCacheKey.get(job.cacheKey) === jobId) {
          this.jobsByCacheKey.delete(job.cacheKey);
        }
      }
    }
  }
}
