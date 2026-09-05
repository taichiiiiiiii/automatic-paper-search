// Authenticated, dependency-injected callback boundary for Paper Slide jobs.
// This module is deliberately not wired into the production entrypoint. A
// workflow must claim its job through this boundary before making provider
// calls; status timestamps are owned by this server boundary.

import { projectPaperSlideStatus } from "./paper-slide-contract.js";
import {
  isPaperSlideClaimantToken,
  isPaperSlideDurableJobId,
} from "./paper-slide-durable-coordinator.js";

export const PAPER_SLIDE_WORKFLOW_API_SCHEMA = "paper-slide-workflow-api-v1";
export const PAPER_SLIDE_WORKFLOW_API_MAX_BODY_BYTES = 4096;

const CLAIM_PATH = "/api/paper-slides/internal/claim";
const STATUS_PATH = "/api/paper-slides/internal/status";
// Status timestamps use the contract's four-digit UTC year grammar. Keep the
// trusted clock within that same representable domain so a server-clock fault
// cannot be misreported as a caller validation error.
const MAX_DATE_MS = 253_402_300_799_999;
const JSON_CONTENT_TYPE =
  /^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i;
const CONTENT_LENGTH = /^(?:0|[1-9][0-9]*)(?![\s\S])/;
const SECRET_PATTERN = /^[\x21-\x7e]{32,256}(?![\s\S])/;
const MAX_AUTHORIZATION_LENGTH = "Bearer ".length + 256;
const CONFIG_KEYS = Object.freeze(["authorizationSecret", "coordinator", "now"]);
const CLAIM_KEYS = Object.freeze(["claimant_token", "job_id", "lease_generation", "reclaim"]);
const STATUS_ENVELOPE_KEYS = Object.freeze([
  "claimant_token", "job_id", "lease_generation", "status",
]);
const STATUS_KEYS = Object.freeze([
  "coverage",
  "deck_id",
  "message_code",
  "phase",
  "preview_available",
  "preview_expires_at",
  "public_url",
  "retryable",
  "status",
]);
const VALIDATION_PAPER_ID = "a".repeat(40);
const VALIDATION_REQUEST_ID = `paper-slide-${"A".repeat(22)}`;

class InvalidRequestError extends Error {}
class BodyTooLargeError extends Error {}

function ownDataProjection(value, expectedKeys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) return null;
  const sorted = ownKeys.slice().sort();
  if (sorted.length !== expectedKeys.length ||
      !sorted.every((key, index) => key === expectedKeys[index])) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const projected = {};
  for (const key of expectedKeys) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) return null;
    projected[key] = descriptor.value;
  }
  return projected;
}

function timingSafeEqual(left, right) {
  const safeLeft = typeof left === "string" ? left : "";
  const safeRight = typeof right === "string" ? right : "";
  let difference = safeLeft.length ^ safeRight.length;
  // Authorization values have already been rejected above the fixed bound.
  // Always perform the same number of comparisons below it so token length
  // does not control the loop count.
  for (let index = 0; index < MAX_AUTHORIZATION_LENGTH; index++) {
    difference |= (safeLeft.charCodeAt(index) || 0) ^
      (safeRight.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "private, no-store",
      "content-type": "application/json; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

function success(fields) {
  return jsonResponse({ schema_version: PAPER_SLIDE_WORKFLOW_API_SCHEMA, ok: true, ...fields });
}

function closedError(errorCode, status) {
  return jsonResponse({
    schema_version: PAPER_SLIDE_WORKFLOW_API_SCHEMA,
    ok: false,
    error_code: errorCode,
  }, status);
}

async function readBoundedJson(request) {
  const declaredRaw = request.headers.get("content-length");
  let declared = null;
  if (declaredRaw !== null) {
    if (!CONTENT_LENGTH.test(declaredRaw)) throw new InvalidRequestError();
    declared = Number(declaredRaw);
    if (!Number.isSafeInteger(declared)) throw new InvalidRequestError();
    if (declared > PAPER_SLIDE_WORKFLOW_API_MAX_BODY_BYTES) {
      throw new BodyTooLargeError();
    }
  }
  if (request.body === null) throw new InvalidRequestError();
  let reader;
  try {
    reader = request.body.getReader();
  } catch {
    throw new InvalidRequestError();
  }
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new InvalidRequestError();
      total += value.byteLength;
      if (total > PAPER_SLIDE_WORKFLOW_API_MAX_BODY_BYTES) {
        try { await reader.cancel(); } catch {}
        throw new BodyTooLargeError();
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof InvalidRequestError || error instanceof BodyTooLargeError) throw error;
    try { await reader.cancel(); } catch {}
    throw new InvalidRequestError();
  }
  if (declared !== null && declared !== total) throw new InvalidRequestError();
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text);
  } catch {
    throw new InvalidRequestError();
  }
}

function readTrustedNow(now) {
  const value = now();
  if (!Number.isFinite(value) || value < 0 || value > MAX_DATE_MS) {
    throw new Error("Paper Slide workflow clock is unavailable");
  }
  return Math.floor(value);
}

function projectClaimResult(value) {
  const projected = ownDataProjection(value, [
    "claimed", "leaseExpiresAt", "leaseGeneration", "reclaimed",
  ]);
  if (projected === null || typeof projected.claimed !== "boolean" ||
      typeof projected.reclaimed !== "boolean") return null;
  if (!projected.claimed) {
    return !projected.reclaimed && projected.leaseGeneration === null &&
        projected.leaseExpiresAt === null
      ? projected
      : null;
  }
  if (!Number.isInteger(projected.leaseGeneration) || projected.leaseGeneration < 1 ||
      projected.leaseGeneration > 2 || typeof projected.leaseExpiresAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z(?![\s\S])/.test(
        projected.leaseExpiresAt,
      ) || !Number.isFinite(Date.parse(projected.leaseExpiresAt))) return null;
  return projected;
}

function projectStatus(value, nowMs) {
  const projected = ownDataProjection(value, STATUS_KEYS);
  if (projected === null) return null;
  const withTimestamp = { ...projected, updated_at: new Date(nowMs).toISOString() };
  if (projectPaperSlideStatus(
    { paper_id: VALIDATION_PAPER_ID, ...withTimestamp },
    VALIDATION_REQUEST_ID,
    nowMs,
  ) === null) return null;
  return Object.freeze(withTimestamp);
}

export function createPaperSlideWorkflowApi(config) {
  const projectedConfig = ownDataProjection(config, CONFIG_KEYS);
  if (projectedConfig === null) throw new TypeError("Paper Slide workflow API config is invalid");
  const { authorizationSecret, coordinator, now } = projectedConfig;
  if (typeof authorizationSecret !== "string" || !SECRET_PATTERN.test(authorizationSecret)) {
    throw new TypeError("Paper Slide workflow authorization is invalid");
  }
  if (typeof now !== "function") throw new TypeError("Paper Slide workflow clock is invalid");
  if (coordinator === null || typeof coordinator !== "object" || Array.isArray(coordinator)) {
    throw new TypeError("Paper Slide workflow coordinator is invalid");
  }
  const coordinatorPrototype = Object.getPrototypeOf(coordinator);
  if (coordinatorPrototype !== Object.prototype && coordinatorPrototype !== null) {
    throw new TypeError("Paper Slide workflow coordinator is invalid");
  }
  const coordinatorDescriptors = Object.getOwnPropertyDescriptors(coordinator);
  const claimDescriptor = coordinatorDescriptors.claimJob;
  const updateDescriptor = coordinatorDescriptors.updateClaimedJobStatus;
  if (!claimDescriptor || !("value" in claimDescriptor) || typeof claimDescriptor.value !== "function" ||
      !updateDescriptor || !("value" in updateDescriptor) || typeof updateDescriptor.value !== "function") {
    throw new TypeError("Paper Slide workflow coordinator is invalid");
  }
  const claimJob = claimDescriptor.value;
  const updateClaimedJobStatus = updateDescriptor.value;
  const expectedAuthorization = `Bearer ${authorizationSecret}`;

  return Object.freeze({
    async fetch(request) {
      try {
        if (request === null || typeof request !== "object") {
          return closedError("NOT_FOUND", 404);
        }
        let url;
        let authorization;
        try {
          url = new URL(request.url);
          authorization = request.headers.get("authorization");
        } catch {
          return closedError("NOT_FOUND", 404);
        }
        const knownPath = url.pathname === CLAIM_PATH || url.pathname === STATUS_PATH;
        if (!knownPath || url.search !== "" || typeof authorization !== "string" ||
            authorization.length > MAX_AUTHORIZATION_LENGTH ||
            !timingSafeEqual(authorization, expectedAuthorization)) {
          return closedError("NOT_FOUND", 404);
        }
        if (request.method !== "POST") return closedError("METHOD_NOT_ALLOWED", 405);
        const contentType = request.headers.get("content-type") ?? "";
        const encoding = request.headers.get("content-encoding");
        if (!JSON_CONTENT_TYPE.test(contentType) ||
            ![null, "identity"].includes(encoding?.trim().toLowerCase() ?? null)) {
          return closedError("INVALID_REQUEST", 400);
        }
        const body = await readBoundedJson(request);
        if (url.pathname === CLAIM_PATH) {
          const claim = ownDataProjection(body, CLAIM_KEYS);
          if (claim === null || !isPaperSlideDurableJobId(claim.job_id) ||
              !isPaperSlideClaimantToken(claim.claimant_token) ||
              !Number.isInteger(claim.lease_generation) || claim.lease_generation < 0 ||
              claim.lease_generation > 2 || typeof claim.reclaim !== "boolean") {
            return closedError("INVALID_REQUEST", 400);
          }
          const result = projectClaimResult(await claimJob.call(
            coordinator,
            claim.job_id,
            claim.claimant_token,
            { leaseGeneration: claim.lease_generation, reclaim: claim.reclaim },
          ));
          if (result === null) return closedError("SERVICE_UNAVAILABLE", 503);
          return success({
            claimed: result.claimed,
            reclaimed: result.reclaimed,
            lease_generation: result.leaseGeneration,
            lease_expires_at: result.leaseExpiresAt,
          });
        }
        const envelope = ownDataProjection(body, STATUS_ENVELOPE_KEYS);
        if (envelope === null || !isPaperSlideDurableJobId(envelope.job_id) ||
            !isPaperSlideClaimantToken(envelope.claimant_token) ||
            !Number.isInteger(envelope.lease_generation) || envelope.lease_generation < 1 ||
            envelope.lease_generation > 2) {
          return closedError("INVALID_REQUEST", 400);
        }
        const nowMs = readTrustedNow(now);
        const status = projectStatus(envelope.status, nowMs);
        if (status === null) return closedError("INVALID_REQUEST", 400);
        const result = await updateClaimedJobStatus.call(
          coordinator,
          envelope.job_id,
          status,
          envelope.claimant_token,
          envelope.lease_generation,
        );
        if (result !== undefined) return closedError("SERVICE_UNAVAILABLE", 503);
        return success({ updated: true });
      } catch (error) {
        if (error instanceof BodyTooLargeError) return closedError("BODY_TOO_LARGE", 413);
        if (error instanceof InvalidRequestError) return closedError("INVALID_REQUEST", 400);
        return closedError("SERVICE_UNAVAILABLE", 503);
      }
    },
  });
}
