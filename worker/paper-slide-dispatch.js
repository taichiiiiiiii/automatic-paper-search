// GitHub Actions workflow-dispatch boundary for Paper Slide jobs.
//
// This module is deliberately narrower than the public request API. Its input
// must already have been resolved from an approved catalog record and reserved
// as a *new* underlying job by the atomic coordinator. In particular, callers
// must not call dispatch() for a deduplicated request alias or after a budget
// gate has failed. The adapter accepts only the catalog's opaque snapshot/cache
// identity plus closed request options and the coordinator's job ID. It accepts
// no title, URL, abstract, prompt, provider, budget, request capability, or
// other caller-controlled workflow input.

export const PAPER_SLIDE_WORKFLOW_FILE = "paper-slides-on-demand.yml";
export const PAPER_SLIDE_DISPATCH_ERROR_CODE = "PAPER_SLIDE_DISPATCH_FAILED";
export const PAPER_SLIDE_DISPATCH_TIMEOUT_MS = 10_000;
export const PAPER_SLIDE_DISPATCH_MAX_BODY_BYTES = 4_096;
export const PAPER_SLIDE_DISPATCH_OUTCOMES = Object.freeze({
  ACCEPTED: "accepted",
  REJECTED: "rejected",
  UNCERTAIN: "uncertain",
});

const GITHUB_API_ORIGIN = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const CONFIG_KEYS = new Set([
  "fetch",
  "maximumResponseBodyBytes",
  "owner",
  "ref",
  "repo",
  "timeoutMs",
  "token",
  "validateJobId",
  "workflow",
]);
const INPUT_KEYS = Object.freeze([
  "coverage_preference",
  "job_id",
  "job_key",
  "language",
  "paper_id",
  "snapshot_version",
]);
const PAPER_ID_PATTERN = /^[0-9a-f]{40}(?![\s\S])/;
const DEFAULT_JOB_ID_PATTERN = /^paper-slide-job-[A-Za-z0-9_-]{22}(?![\s\S])/;
const JOB_KEY_PATTERN = /^[0-9a-f]{64}(?![\s\S])/;
const SNAPSHOT_VERSION_PATTERN = /^[A-Za-z0-9._:-]{1,128}(?![\s\S])/;
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?(?![\s\S])/;
const REPO_PATTERN = /^[A-Za-z0-9_](?:[A-Za-z0-9_.-]{0,98}[A-Za-z0-9_-])?(?![\s\S])/;
const REF_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,253}[A-Za-z0-9_-])?(?![\s\S])/;
const TOKEN_PATTERN = /^[!-~]{20,512}(?![\s\S])/;

function hasExactOwnKeys(value, expected) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function isClosedConfig(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.keys(value).every((key) => CONFIG_KEYS.has(key));
}

function defaultValidateJobId(value) {
  return typeof value === "string" && DEFAULT_JOB_ID_PATTERN.test(value);
}

export function validatePaperSlideDispatchRequest(value, validateJobId = defaultValidateJobId) {
  if (!hasExactOwnKeys(value, INPUT_KEYS)) return false;
  if (typeof value.paper_id !== "string" || !PAPER_ID_PATTERN.test(value.paper_id)) return false;
  if (typeof value.job_key !== "string" || !JOB_KEY_PATTERN.test(value.job_key)) return false;
  if (
    typeof value.snapshot_version !== "string" ||
    !SNAPSHOT_VERSION_PATTERN.test(value.snapshot_version)
  ) return false;
  if (value.language !== "ja" && value.language !== "en") return false;
  if (value.coverage_preference !== "auto") return false;
  try {
    return validateJobId(value.job_id) === true;
  } catch {
    return false;
  }
}

function configString(value, pattern, message) {
  if (typeof value !== "string" || !pattern.test(value)) throw new TypeError(message);
  return value;
}

function validateRef(value) {
  configString(value, REF_PATTERN, "Paper Slide GitHub ref is invalid");
  if (
    value.includes("..") ||
    value.includes("//") ||
    value.includes("@{") ||
    value.endsWith(".") ||
    value.endsWith(".lock") ||
    value.startsWith("refs/")
  ) {
    throw new TypeError("Paper Slide GitHub ref is invalid");
  }
  return value;
}

function validatePositiveInteger(value, minimum, maximum, message) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(message);
  }
  return value;
}

async function consumeBoundedBody(response, maximumBytes) {
  if (response.body === null || response.body === undefined) return;
  if (typeof response.body.getReader !== "function") {
    throw new Error(PAPER_SLIDE_DISPATCH_ERROR_CODE);
  }
  const reader = response.body.getReader();
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (!(value instanceof Uint8Array)) throw new Error(PAPER_SLIDE_DISPATCH_ERROR_CODE);
      total += value.byteLength;
      if (total > maximumBytes) throw new Error(PAPER_SLIDE_DISPATCH_ERROR_CODE);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Body cancellation is best-effort; callers receive only the generic error.
    }
  }
}

const ACCEPTED = Object.freeze({ outcome: PAPER_SLIDE_DISPATCH_OUTCOMES.ACCEPTED });
const REJECTED = Object.freeze({
  outcome: PAPER_SLIDE_DISPATCH_OUTCOMES.REJECTED,
  error_code: PAPER_SLIDE_DISPATCH_ERROR_CODE,
});
const UNCERTAIN = Object.freeze({
  outcome: PAPER_SLIDE_DISPATCH_OUTCOMES.UNCERTAIN,
  error_code: PAPER_SLIDE_DISPATCH_ERROR_CODE,
});

function classifyHttpFailure(status) {
  if (
    Number.isInteger(status) &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 409 &&
    status !== 425 &&
    status !== 429
  ) {
    return REJECTED;
  }
  return UNCERTAIN;
}

// Create a dependency-injected adapter. No global fetch fallback exists: tests
// and production wiring must explicitly supply the only network capability.
export function createPaperSlideDispatchAdapter(config = {}) {
  if (!isClosedConfig(config)) throw new TypeError("Paper Slide dispatch config is invalid");
  const {
    fetch: fetchImpl,
    token,
    owner,
    repo,
    ref,
    workflow = PAPER_SLIDE_WORKFLOW_FILE,
    validateJobId = defaultValidateJobId,
    timeoutMs = PAPER_SLIDE_DISPATCH_TIMEOUT_MS,
    maximumResponseBodyBytes = PAPER_SLIDE_DISPATCH_MAX_BODY_BYTES,
  } = config;
  if (typeof fetchImpl !== "function") {
    throw new TypeError("Paper Slide fetch dependency is required");
  }
  if (typeof validateJobId !== "function") {
    throw new TypeError("Paper Slide job ID validator is invalid");
  }
  configString(token, TOKEN_PATTERN, "Paper Slide GitHub token is invalid");
  configString(owner, OWNER_PATTERN, "Paper Slide GitHub owner is invalid");
  if (owner.includes("--")) throw new TypeError("Paper Slide GitHub owner is invalid");
  configString(repo, REPO_PATTERN, "Paper Slide GitHub repository is invalid");
  const validatedRef = validateRef(ref);
  if (workflow !== PAPER_SLIDE_WORKFLOW_FILE) {
    throw new TypeError("Paper Slide GitHub workflow is invalid");
  }
  const validatedTimeout = validatePositiveInteger(
    timeoutMs,
    1,
    30_000,
    "Paper Slide dispatch timeout is invalid",
  );
  const validatedMaximumBodyBytes = validatePositiveInteger(
    maximumResponseBodyBytes,
    0,
    65_536,
    "Paper Slide dispatch body limit is invalid",
  );
  const endpoint = `${GITHUB_API_ORIGIN}/repos/${owner}/${repo}/actions/workflows/${workflow}/dispatches`;

  return Object.freeze({
    async dispatch(value) {
      if (!validatePaperSlideDispatchRequest(value, validateJobId)) return REJECTED;
      const inputs = Object.freeze({
        paper_id: value.paper_id,
        job_id: value.job_id,
        language: value.language,
        coverage_preference: value.coverage_preference,
        snapshot_version: value.snapshot_version,
        job_key: value.job_key,
      });
      const controller = new AbortController();
      let timeoutId;
      const timeout = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          controller.abort();
          reject(new Error(PAPER_SLIDE_DISPATCH_ERROR_CODE));
        }, validatedTimeout);
      });
      const operation = (async () => {
        const response = await fetchImpl(endpoint, {
          method: "POST",
          redirect: "error",
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/vnd.github+json",
            "x-github-api-version": GITHUB_API_VERSION,
            "user-agent": "paperpilot-paper-slide-dispatcher",
            "content-type": "application/json",
          },
          body: JSON.stringify({ ref: validatedRef, inputs }),
        });
        if (
          response === null ||
          typeof response !== "object" ||
          response.redirected === true ||
          (typeof response.url === "string" && response.url !== "" && response.url !== endpoint)
        ) {
          throw new Error(PAPER_SLIDE_DISPATCH_ERROR_CODE);
        }
        if (response.status !== 204) {
          const outcome = classifyHttpFailure(response.status);
          await consumeBoundedBody(response, validatedMaximumBodyBytes);
          return outcome;
        }
        return ACCEPTED;
      })();
      try {
        return await Promise.race([operation, timeout]);
      } catch {
        // A thrown fetch, redirect rejection, timeout, malformed response, or
        // interrupted body read cannot prove that GitHub did not accept the
        // workflow. The caller must keep the existing queued job and must not
        // automatically redispatch it.
        return UNCERTAIN;
      } finally {
        clearTimeout(timeoutId);
      }
    },
  });
}
