// Dependency-injected HTTP boundary for the Paper Slide API. It has no global
// fetch calls; workflow dispatch is possible only through an explicitly
// injected adapter. Production routing remains an independently dormant seam.

import {
  PAPER_SLIDE_ERROR_SCHEMA_VERSION,
  createPaperSlideCredentials,
  isPaperSlideFailureCode,
  isPaperSlideHttpErrorCode,
  isStatusCapability,
  projectPaperSlideStatus,
  sha256Hex,
  validatePaperSlideRequest,
  validatePaperSlideStatusRequest,
} from "./paper-slide-contract.js";

export const PAPER_SLIDE_MAX_BODY_BYTES = 512;

const REQUEST_PATH = "/api/paper-slides";
const STATUS_PATH = "/api/paper-slides/status";
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i;
const CONTENT_LENGTH = /^(?:0|[1-9][0-9]*)(?![\s\S])/;
const CATALOG_BASE_KEYS = Object.freeze([
  "eligible",
  "job_key",
  "paper_id",
  "snapshot_version",
]);
const CATALOG_UNAVAILABLE_KEYS = Object.freeze([
  ...CATALOG_BASE_KEYS,
  "failure_code",
].sort());
const DISPATCH_FAILURE_KEYS = Object.freeze(["error_code", "outcome"]);
const DISPATCH_ERROR_CODE = "PAPER_SLIDE_DISPATCH_FAILED";

function errorBody(errorCode, extra = {}) {
  if (!isPaperSlideHttpErrorCode(errorCode)) {
    throw new TypeError("Paper Slide HTTP error code is invalid");
  }
  return {
    schema_version: PAPER_SLIDE_ERROR_SCHEMA_VERSION,
    error_code: errorCode,
    ...extra,
  };
}

function responseHeaders(origin, { retryAfterSeconds = null } = {}) {
  const headers = new Headers({
    "cache-control": "private, no-store",
    "content-type": "application/json; charset=utf-8",
    "vary": "Origin",
    "x-content-type-options": "nosniff",
  });
  if (origin !== null) headers.set("access-control-allow-origin", origin);
  if (retryAfterSeconds !== null) headers.set("retry-after", String(retryAfterSeconds));
  return headers;
}

export function paperSlideJson(body, { status = 200, origin = null, retryAfterSeconds = null } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: responseHeaders(origin, { retryAfterSeconds }),
  });
}

function normalizeAllowedOrigins(origins) {
  if (!Array.isArray(origins) || origins.length === 0) {
    throw new TypeError("at least one Paper Slide origin is required");
  }
  const result = new Set();
  for (const candidate of origins) {
    if (typeof candidate !== "string" || candidate.length === 0 || candidate.includes(",")) {
      throw new TypeError("Paper Slide origin is invalid");
    }
    let parsed;
    try {
      parsed = new URL(candidate);
    } catch {
      throw new TypeError("Paper Slide origin is invalid");
    }
    const protocolAllowed = parsed.protocol === "https:" || (
      parsed.protocol === "http:" && parsed.hostname === "localhost"
    );
    if (parsed.origin !== candidate || !protocolAllowed) {
      throw new TypeError("Paper Slide origin must be an exact secure origin");
    }
    result.add(candidate);
  }
  return result;
}

function allowedOrigin(request, origins) {
  const origin = request.headers.get("origin");
  return origin !== null && origins.has(origin) ? origin : null;
}

function edgeIp(request) {
  const value = request.headers.get("cf-connecting-ip");
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 128 ? trimmed : null;
}

function mediaTypeAllowed(request) {
  const contentType = request.headers.get("content-type");
  return contentType !== null && JSON_CONTENT_TYPE.test(contentType);
}

function contentEncodingAllowed(request) {
  const encoding = request.headers.get("content-encoding");
  return encoding === null || encoding.toLowerCase().trim() === "identity";
}

async function readBoundedBody(request, maximumBytes) {
  const declaredRaw = request.headers.get("content-length");
  let declared = null;
  if (declaredRaw !== null) {
    if (!CONTENT_LENGTH.test(declaredRaw)) {
      return { ok: false, status: 400, errorCode: "INVALID_BODY" };
    }
    declared = Number(declaredRaw);
    if (!Number.isSafeInteger(declared)) {
      return { ok: false, status: 400, errorCode: "INVALID_BODY" };
    }
    if (declared > maximumBytes) {
      return { ok: false, status: 413, errorCode: "BODY_TOO_LARGE" };
    }
  }
  if (request.body === null) {
    return { ok: false, status: 400, errorCode: "INVALID_BODY" };
  }

  let reader;
  try {
    reader = request.body.getReader();
  } catch {
    return { ok: false, status: 400, errorCode: "INVALID_BODY" };
  }
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        try {
          await reader.cancel();
        } catch {
          // Preserve the closed body error even when a hostile stream refuses cancellation.
        }
        return { ok: false, status: 400, errorCode: "INVALID_BODY" };
      }
      total += value.byteLength;
      if (total > maximumBytes) {
        try {
          await reader.cancel();
        } catch {
          // The byte ceiling, not cancellation behavior, determines this response.
        }
        return { ok: false, status: 413, errorCode: "BODY_TOO_LARGE" };
      }
      chunks.push(value);
    }
  } catch {
    try {
      await reader.cancel();
    } catch {
      // Ignore cancellation failure and keep the parsing boundary closed.
    }
    return { ok: false, status: 400, errorCode: "INVALID_BODY" };
  }
  if (declared !== null && declared !== total) {
    return { ok: false, status: 400, errorCode: "INVALID_BODY" };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return {
      ok: true,
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    };
  } catch {
    return { ok: false, status: 400, errorCode: "INVALID_BODY" };
  }
}

function parseStatusAuthorization(request) {
  const authorization = request.headers.get("authorization");
  if (authorization === null || !authorization.startsWith("PaperSlide ")) return null;
  const capability = authorization.slice("PaperSlide ".length);
  if (!isStatusCapability(capability)) return null;
  return capability;
}

function rateLimited(origin, retryAfterSeconds) {
  const retry = Number.isInteger(retryAfterSeconds)
    ? Math.max(1, Math.min(86_400, retryAfterSeconds))
    : 60;
  return paperSlideJson(
    errorBody("RATE_LIMITED", { retry_after_seconds: retry }),
    { status: 429, origin, retryAfterSeconds: retry },
  );
}

function serviceUnavailable(origin) {
  return paperSlideJson(errorBody("SERVICE_UNAVAILABLE"), { status: 503, origin });
}

function projectCatalogRecord(record, paperId) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) return null;
  const prototype = Object.getPrototypeOf(record);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const descriptors = Object.getOwnPropertyDescriptors(record);
  const ownKeys = Reflect.ownKeys(record);
  if (ownKeys.some((key) => typeof key !== "string")) return null;
  const eligibleDescriptor = descriptors.eligible;
  if (!eligibleDescriptor || !("value" in eligibleDescriptor) ||
      typeof eligibleDescriptor.value !== "boolean") return null;
  const expectedKeys = eligibleDescriptor.value ? CATALOG_BASE_KEYS : CATALOG_UNAVAILABLE_KEYS;
  const keys = ownKeys.sort();
  if (keys.length !== expectedKeys.length ||
      !keys.every((key, index) => key === expectedKeys[index])) return null;
  for (const key of expectedKeys) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) return null;
  }
  const projected = {
    paper_id: descriptors.paper_id.value,
    eligible: descriptors.eligible.value,
    snapshot_version: descriptors.snapshot_version.value,
    job_key: descriptors.job_key.value,
  };
  if (
    projected.paper_id !== paperId ||
    typeof projected.snapshot_version !== "string" ||
    !/^[A-Za-z0-9._:-]{1,128}(?![\s\S])/.test(projected.snapshot_version) ||
    typeof projected.job_key !== "string" ||
    !/^[0-9a-f]{64}(?![\s\S])/.test(projected.job_key)
  ) return null;
  if (!projected.eligible) projected.failure_code = descriptors.failure_code.value;
  return Object.freeze(projected);
}

function readNow(now) {
  const nowMs = now();
  if (
    !Number.isFinite(nowMs) ||
    nowMs < 0 ||
    !Number.isFinite(new Date(nowMs).getTime())
  ) {
    throw new Error("invalid clock");
  }
  return nowMs;
}

function projectDispatchOutcome(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "uncertain";
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return "uncertain";
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) return "uncertain";
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const outcome = descriptors.outcome;
  if (!outcome || !("value" in outcome) || outcome.enumerable !== true) return "uncertain";
  if (outcome.value === "accepted") {
    return keys.length === 1 && keys[0] === "outcome" ? "accepted" : "uncertain";
  }
  if (outcome.value !== "rejected" && outcome.value !== "uncertain") return "uncertain";
  if (keys.length !== DISPATCH_FAILURE_KEYS.length) return "uncertain";
  const sorted = keys.slice().sort();
  if (!sorted.every((key, index) => key === DISPATCH_FAILURE_KEYS[index])) return "uncertain";
  const errorCode = descriptors.error_code;
  if (
    !errorCode ||
    !("value" in errorCode) ||
    errorCode.enumerable !== true ||
    errorCode.value !== DISPATCH_ERROR_CODE
  ) return "uncertain";
  return outcome.value;
}

export function createPaperSlideApi({
  allowedOrigins,
  catalog,
  coordinator,
  dispatcher = undefined,
  randomBytes,
  now = () => Date.now(),
  maximumBodyBytes = PAPER_SLIDE_MAX_BODY_BYTES,
}) {
  const origins = normalizeAllowedOrigins(allowedOrigins);
  if (!catalog || typeof catalog.resolve !== "function") {
    throw new TypeError("Paper Slide catalog adapter is required");
  }
  if (!coordinator || typeof coordinator !== "object") {
    throw new TypeError("Paper Slide coordinator adapter is required");
  }
  if (dispatcher !== undefined && (
    dispatcher === null || typeof dispatcher.dispatch !== "function"
  )) {
    throw new TypeError("Paper Slide dispatch adapter is invalid");
  }
  if (dispatcher !== undefined && (
    typeof coordinator.updateJobStatus !== "function" ||
    typeof coordinator.revokeRequest !== "function"
  )) {
    throw new TypeError("dispatch cleanup requires coordinator update and revoke operations");
  }
  if (!Number.isInteger(maximumBodyBytes) || maximumBodyBytes < 128 || maximumBodyBytes > 4096) {
    throw new TypeError("Paper Slide body limit is invalid");
  }

  async function handlePost(request, origin) {
    if (!mediaTypeAllowed(request) || !contentEncodingAllowed(request)) {
      return paperSlideJson(errorBody("UNSUPPORTED_MEDIA_TYPE"), {
        status: 415,
        origin,
      });
    }
    const body = await readBoundedBody(request, maximumBodyBytes);
    if (!body.ok) {
      return paperSlideJson(errorBody(body.errorCode), { status: body.status, origin });
    }
    let parsed;
    try {
      parsed = JSON.parse(body.text);
    } catch {
      return paperSlideJson(errorBody("INVALID_BODY"), { status: 400, origin });
    }
    const validation = validatePaperSlideRequest(parsed);
    if (!validation.ok) {
      return paperSlideJson(errorBody("INVALID_REQUEST"), { status: 400, origin });
    }
    const ip = edgeIp(request);
    if (ip === null) {
      return paperSlideJson(errorBody("EDGE_REQUIRED"), { status: 400, origin });
    }

    let nowMs;
    try {
      nowMs = readNow(now);
    } catch {
      return serviceUnavailable(origin);
    }
    let rate;
    try {
      if (typeof coordinator.consumeRequestAttempt !== "function") throw new Error("missing adapter");
      rate = await coordinator.consumeRequestAttempt(ip, nowMs);
    } catch {
      return serviceUnavailable(origin);
    }
    if (!rate || rate.allowed !== true) {
      if (rate && rate.allowed === false) return rateLimited(origin, rate.retryAfterSeconds);
      return serviceUnavailable(origin);
    }

    let paper;
    try {
      const record = await catalog.resolve(
        validation.value.paper_id,
        validation.value.language,
      );
      if (record === null) {
        return paperSlideJson(errorBody("PAPER_NOT_FOUND"), { status: 404, origin });
      }
      paper = projectCatalogRecord(record, validation.value.paper_id);
    } catch {
      return serviceUnavailable(origin);
    }
    if (paper === null) return serviceUnavailable(origin);
    if (!paper.eligible) {
      const failureCode = paper.failure_code;
      if (!isPaperSlideFailureCode(failureCode)) return serviceUnavailable(origin);
      return paperSlideJson(errorBody("PAPER_UNAVAILABLE", {
        failure_code: failureCode,
      }), { status: 422, origin });
    }

    let credentials;
    let capabilityHash;
    try {
      credentials = createPaperSlideCredentials(randomBytes);
      capabilityHash = await sha256Hex(credentials.statusCapability);
    } catch {
      return serviceUnavailable(origin);
    }
    let reservation;
    try {
      if (typeof coordinator.reserveOrJoin !== "function") throw new Error("missing adapter");
      reservation = await coordinator.reserveOrJoin({
        paperId: validation.value.paper_id,
        language: validation.value.language,
        coveragePreference: validation.value.coverage_preference,
        jobKey: paper.job_key,
        requestId: credentials.requestId,
        capabilityHash,
        nowMs,
      });
    } catch {
      return serviceUnavailable(origin);
    }
    if (!reservation || reservation.ok !== true) {
      if (reservation?.reason === "daily_job_limited") {
        const retry = Number.isInteger(reservation.retryAfterSeconds)
          ? Math.max(1, Math.min(86_400, reservation.retryAfterSeconds))
          : 86_400;
        return paperSlideJson(
          errorBody("BUDGET_EXHAUSTED", { retry_after_seconds: retry }),
          { status: 429, origin, retryAfterSeconds: retry },
        );
      }
      return serviceUnavailable(origin);
    }
    if (typeof reservation.deduplicated !== "boolean") {
      return serviceUnavailable(origin);
    }
    if (!reservation.deduplicated && dispatcher !== undefined) {
      let dispatchOutcome = "uncertain";
      try {
        const result = await dispatcher.dispatch(Object.freeze({
          job_id: reservation.jobId,
          paper_id: validation.value.paper_id,
          language: validation.value.language,
          coverage_preference: validation.value.coverage_preference,
          snapshot_version: paper.snapshot_version,
          job_key: paper.job_key,
        }));
        dispatchOutcome = projectDispatchOutcome(result);
      } catch {
        // The request may have reached GitHub before the exception. Keep this
        // job queued so a retry joins it rather than creating a second run.
        dispatchOutcome = "uncertain";
      }
      if (dispatchOutcome === "rejected") {
        const failedStatus = {
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
        try {
          await coordinator.updateJobStatus(reservation.jobId, failedStatus, nowMs);
        } catch {
          // Preserve the generic dispatch failure even when durable cleanup is degraded.
        }
        try {
          await coordinator.revokeRequest(credentials.requestId);
        } catch {
          // The capability was never returned, so do not expose cleanup details.
        }
        return serviceUnavailable(origin);
      }
      // Both an accepted dispatch and an uncertain delivery retain the same
      // queued job identity. Only a definitive rejection is safe to retry.
    }
    return paperSlideJson({
      ok: true,
      status: "queued",
      request_id: credentials.requestId,
      status_cap: credentials.statusCapability,
      paper_id: validation.value.paper_id,
      deduplicated: reservation.deduplicated,
    }, { status: 202, origin });
  }

  async function handleStatusPost(request, origin) {
    if (!mediaTypeAllowed(request) || !contentEncodingAllowed(request)) {
      return paperSlideJson(errorBody("UNSUPPORTED_MEDIA_TYPE"), {
        status: 415,
        origin,
      });
    }
    const capability = parseStatusAuthorization(request);
    if (capability === null) {
      return paperSlideJson(errorBody("INVALID_REQUEST"), { status: 400, origin });
    }
    const body = await readBoundedBody(request, maximumBodyBytes);
    if (!body.ok) {
      return paperSlideJson(errorBody(body.errorCode), { status: body.status, origin });
    }
    let bodyValue;
    try {
      bodyValue = JSON.parse(body.text);
    } catch {
      return paperSlideJson(errorBody("INVALID_BODY"), { status: 400, origin });
    }
    const validation = validatePaperSlideStatusRequest(bodyValue);
    if (!validation.ok) {
      return paperSlideJson(errorBody("INVALID_REQUEST"), { status: 400, origin });
    }
    const ip = edgeIp(request);
    if (ip === null) {
      return paperSlideJson(errorBody("EDGE_REQUIRED"), { status: 400, origin });
    }
    let nowMs;
    try {
      nowMs = readNow(now);
    } catch {
      return serviceUnavailable(origin);
    }
    let rate;
    try {
      if (typeof coordinator.consumeStatusAttempt !== "function") throw new Error("missing adapter");
      rate = await coordinator.consumeStatusAttempt(ip, nowMs);
    } catch {
      return serviceUnavailable(origin);
    }
    if (!rate || rate.allowed !== true) {
      if (rate && rate.allowed === false) return rateLimited(origin, rate.retryAfterSeconds);
      return serviceUnavailable(origin);
    }

    let capabilityHash;
    let status;
    try {
      capabilityHash = await sha256Hex(capability);
      if (typeof coordinator.readAuthorizedStatus !== "function") throw new Error("missing adapter");
      status = await coordinator.readAuthorizedStatus({
        requestId: validation.value.request_id,
        capabilityHash,
        nowMs,
      });
    } catch {
      return serviceUnavailable(origin);
    }
    if (status === null) {
      return paperSlideJson(errorBody("REQUEST_NOT_FOUND"), { status: 404, origin });
    }
    const projected = projectPaperSlideStatus(status, validation.value.request_id, nowMs);
    if (projected === null) return serviceUnavailable(origin);
    return paperSlideJson(projected, { status: 200, origin });
  }

  function handleOptions(origin) {
    const headers = responseHeaders(origin);
    headers.delete("content-type");
    headers.set(
      "access-control-allow-methods",
      "POST, OPTIONS",
    );
    headers.set("access-control-allow-headers", "authorization, content-type");
    headers.set("access-control-max-age", "600");
    return new Response(null, { status: 204, headers });
  }

  return Object.freeze({
    async handle(request) {
      const url = new URL(request.url);
      const knownPath = url.pathname === REQUEST_PATH || url.pathname === STATUS_PATH;
      if (!knownPath) {
        return paperSlideJson(errorBody("NOT_FOUND"), { status: 404 });
      }
      const origin = allowedOrigin(request, origins);
      if (origin === null) {
        return paperSlideJson(errorBody("ORIGIN_FORBIDDEN"), { status: 403 });
      }
      if (url.search !== "") {
        return paperSlideJson(errorBody("INVALID_REQUEST"), { status: 400, origin });
      }
      if (request.method === "OPTIONS") return handleOptions(origin);
      if (url.pathname === REQUEST_PATH && request.method === "POST") {
        return handlePost(request, origin);
      }
      if (url.pathname === STATUS_PATH && request.method === "POST") {
        return handleStatusPost(request, origin);
      }
      const response = paperSlideJson(errorBody("METHOD_NOT_ALLOWED"), { status: 405, origin });
      response.headers.set(
        "allow",
        "POST, OPTIONS",
      );
      return response;
    },
  });
}
