/**
 * HTTP helper with retry + exponential backoff — TS port of
 * `paperpilot/utils/http.py::request_with_retry`.
 *
 * Retry policy (design doc §6.2 / CLAUDE.md "エラーハンドリング"):
 *   - HTTP 429 : exponential backoff (2s, 4s, 8s, ... cap 30s), max 3 retries
 *   - HTTP 5xx : fixed 3s wait, max 2 retries
 *   - Timeout  : retry once
 *   - Other    : return the response without retry (caller handles)
 *
 * `fetchImpl`/`sleep`/`now` are injected (never real network / real
 * timers) so every caller's tests stay fast and deterministic — same
 * contract as the Python tests' `monkeypatch.setattr(http_mod.time, ...)`.
 *
 * Returns `null` only when the request ultimately fails after retries or
 * the overall deadline elapses.
 */

export interface HttpResponseLike {
  status: number;
  json(): Promise<unknown>;
}

export interface FetchInit {
  method: string;
  headers?: Record<string, string>;
  body?: string;
  /** The per-attempt timeout this call was clamped to, in ms (informational — a real fetchImpl may also use it for an AbortSignal). */
  timeoutMs: number;
}

export type FetchLike = (url: string, init: FetchInit) => Promise<HttpResponseLike>;

/** Thrown by a test `fetchImpl` to simulate a socket timeout. */
export class TimeoutError extends Error {
  constructor(message = "timeout") {
    super(message);
    this.name = "TimeoutError";
  }
}

export interface RequestWithRetryOptions {
  method: string;
  url: string;
  params?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  jsonBody?: unknown;
  /** Per-attempt socket timeout, ms. Default 10_000 (mirrors Python's `timeout=10.0`). */
  timeoutMs?: number;
  /** Total wall-clock budget across all retries, ms. Default `timeoutMs * 3`. */
  overallDeadlineMs?: number;
}

export interface RequestWithRetryDeps {
  fetchImpl: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  /** Monotonic clock in ms (like `performance.now()` / Python's `time.monotonic() * 1000`). */
  now?: () => number;
  logger?: { warn: (msg: string) => void };
}

const BACKOFF_429_INITIAL_MS = 2000;
const BACKOFF_429_MAX_MS = 30000;
const MAX_RETRIES_429 = 3;

const BACKOFF_5XX_MS = 3000;
const MAX_RETRIES_5XX = 2;

const MAX_RETRIES_TIMEOUT = 1;

const DEFAULT_DEADLINE_MULTIPLIER = 3;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Redact a URL down to `scheme://host[:port]` for logging — never the path,
 * query, or userinfo, which may embed a secret (e.g. a Slack webhook
 * token). Tolerates unparseable input instead of throwing. TS port of
 * `_safe_url_for_log`.
 *
 * `URL` is stricter than Python's `urlsplit` (which never raises): a string
 * with no `"//"` that fails to parse is reported as a generic `<url>`
 * (nothing host-shaped to leak), while one that looks like it was trying to
 * be a URL (contains `"//"`, e.g. a bad port or malformed bracket) but still
 * fails to parse is `<unparseable-url>`.
 */
export function safeUrlForLog(url: string): string {
  try {
    const u = new URL(url);
    if (!u.hostname) return "<url>";
    const host = u.port ? `${u.hostname}:${u.port}` : u.hostname;
    return `${u.protocol}//${host}`;
  } catch {
    return url.includes("//") ? "<unparseable-url>" : "<url>";
  }
}

function buildUrl(
  url: string,
  params?: Record<string, string | number | boolean | undefined>,
): string {
  if (!params) return url;
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) usp.set(k, String(v));
  }
  const qs = usp.toString();
  if (!qs) return url;
  return url.includes("?") ? `${url}&${qs}` : `${url}?${qs}`;
}

function isTimeoutError(e: unknown): boolean {
  if (e instanceof TimeoutError) return true;
  if (e instanceof Error) {
    return e.name === "TimeoutError" || e.name === "AbortError";
  }
  return false;
}

export async function requestWithRetry(
  opts: RequestWithRetryOptions,
  deps: RequestWithRetryDeps,
): Promise<HttpResponseLike | null> {
  const timeoutMs = opts.timeoutMs ?? 10000;
  const overallDeadlineMs = opts.overallDeadlineMs ?? timeoutMs * DEFAULT_DEADLINE_MULTIPLIER;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? (() => performance.now());
  const logger = deps.logger ?? { warn: () => {} };

  const fullUrl = buildUrl(opts.url, opts.params);
  const safeUrl = safeUrlForLog(opts.url);
  const start = now();

  let attempts429 = 0;
  let attempts5xx = 0;
  let attemptsTimeout = 0;
  let backoff429 = BACKOFF_429_INITIAL_MS;

  const body = opts.jsonBody !== undefined ? JSON.stringify(opts.jsonBody) : undefined;
  const headers =
    opts.jsonBody !== undefined
      ? { "content-type": "application/json", ...(opts.headers ?? {}) }
      : opts.headers;

  for (;;) {
    const remaining = overallDeadlineMs - (now() - start);
    if (remaining <= 0) {
      logger.warn(
        `http: overall deadline ${(overallDeadlineMs / 1000).toFixed(1)}s exceeded: ${safeUrl}`,
      );
      return null;
    }

    let resp: HttpResponseLike;
    try {
      resp = await deps.fetchImpl(fullUrl, {
        method: opts.method,
        headers,
        body,
        timeoutMs: Math.min(timeoutMs, remaining),
      });
    } catch (e) {
      if (isTimeoutError(e)) {
        if (attemptsTimeout >= MAX_RETRIES_TIMEOUT) {
          logger.warn(`http: timeout after ${attemptsTimeout} retries: ${safeUrl}`);
          return null;
        }
        attemptsTimeout += 1;
        logger.warn(`http: timeout, retry ${attemptsTimeout}: ${safeUrl}`);
        continue;
      }
      // Only the exception's class name is safe to log — its message may
      // itself embed the raw URL (e.g. urllib3-style "Max retries exceeded
      // with url: ..."), which would re-leak what safeUrl was built to hide.
      const name = e instanceof Error ? e.name : "Error";
      logger.warn(`http: request failed: ${safeUrl} (${name})`);
      return null;
    }

    if (resp.status === 429) {
      if (attempts429 >= MAX_RETRIES_429) {
        logger.warn(`http: 429 after ${attempts429} retries: ${safeUrl}`);
        return resp;
      }
      const sleepFor = Math.max(0, Math.min(backoff429, overallDeadlineMs - (now() - start)));
      logger.warn(
        `http: 429 throttled, sleeping ${(sleepFor / 1000).toFixed(1)}s (retry ${attempts429 + 1}): ${safeUrl}`,
      );
      await sleep(sleepFor);
      attempts429 += 1;
      backoff429 = Math.min(backoff429 * 2, BACKOFF_429_MAX_MS);
      continue;
    }

    if (resp.status >= 500 && resp.status < 600) {
      if (attempts5xx >= MAX_RETRIES_5XX) {
        logger.warn(`http: ${resp.status} after ${attempts5xx} retries: ${safeUrl}`);
        return resp;
      }
      const sleepFor = Math.max(0, Math.min(BACKOFF_5XX_MS, overallDeadlineMs - (now() - start)));
      logger.warn(
        `http: ${resp.status}, sleeping ${(sleepFor / 1000).toFixed(1)}s (retry ${attempts5xx + 1}): ${safeUrl}`,
      );
      await sleep(sleepFor);
      attempts5xx += 1;
      continue;
    }

    return resp;
  }
}
