/**
 * HTTP helper with retry + exponential backoff — TS port of
 * `paperpilot/utils/http.py::request_with_retry`.
 *
 * Retry policy (design doc §6.2 / CLAUDE.md "エラーハンドリング"):
 *   - HTTP 429 : wait for the server's hint when it sends one (`Retry-After`,
 *                else `x-ratelimit-reset-{requests,tokens}`), otherwise
 *                exponential backoff (2s, 4s, 8s, ... cap 30s); max 3
 *                retries. Callers with a strict rate-limited quota (Groq)
 *                tune the count / per-wait cap / give-up threshold via
 *                `opts.retry429`.
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

/** The subset of `Headers` this module reads (case-insensitive `get`). */
export interface HeadersLike {
  get(name: string): string | null;
}

export interface HttpResponseLike {
  status: number;
  /** Optional: adapters that expose response headers let 429 handling honour `Retry-After` / `x-ratelimit-reset-*`. */
  headers?: HeadersLike;
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
  /** 429-specific retry tuning (defaults keep the historical policy). */
  retry429?: Retry429Options;
}

export interface Retry429Options {
  /** Max retries after a 429. Default 3. */
  maxRetries?: number;
  /** Cap for a single 429 wait (server hint or backoff), ms. Default 30_000. */
  maxWaitMs?: number;
  /**
   * When the server's hint exceeds this, stop retrying and return the 429
   * immediately (e.g. a daily quota that resets in hours — waiting the
   * capped interval would only burn the budget). Default: never give up early.
   */
  giveUpIfHintAboveMs?: number;
  /** Added to a server hint before sleeping (clock skew / rounding). Default 0. */
  hintMarginMs?: number;
  /**
   * Inspect a 429's parsed JSON body (`undefined` when unreadable) and
   * return `true` to stop retrying (e.g. the message names a DAILY quota).
   * When set, the body is read here once and the returned response's
   * `json()` replays it, so the caller can still read it.
   */
  giveUpOnBody?: (body: unknown) => boolean;
}

/** Reported once per retry sleep (429 or 5xx) through `deps.onRetry`. */
export interface RetryEvent {
  status: number;
  /** 1-based retry number for this status class. */
  attempt: number;
  /** How long the helper is about to sleep, ms. */
  waitMs: number;
  /** The server's wait hint (429 only), ms, or `null` when none was sent. */
  hintMs: number | null;
}

export interface RequestWithRetryDeps {
  fetchImpl: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  /** Monotonic clock in ms (like `performance.now()` / Python's `time.monotonic() * 1000`). */
  now?: () => number;
  logger?: { warn: (msg: string) => void };
  /** Observability hook — called right before every retry sleep. */
  onRetry?: (ev: RetryEvent) => void;
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

const DURATION_RE =
  /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?$/;

/**
 * Parse a rate-limit duration into ms: Go-style `"2s"`, `"1m30s"`,
 * `"7m12.5s"`, `"250ms"`, `"1h2m"` (what Groq/OpenAI send in
 * `x-ratelimit-reset-*` and error messages), or a bare number of SECONDS
 * (`Retry-After: 2`, `"2.5"`). Returns `null` for anything else.
 */
export function parseDurationMs(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const v = value.trim().toLowerCase();
  if (v === "") return null;
  if (/^\d+(?:\.\d+)?$/.test(v)) return Number(v) * 1000;
  const m = DURATION_RE.exec(v);
  if (!m || m.slice(1).every((g) => g === undefined)) return null;
  const n = (g: string | undefined): number => (g === undefined ? 0 : Number(g));
  return n(m[1]) * 3_600_000 + n(m[2]) * 60_000 + n(m[3]) * 1000 + n(m[4]);
}

/**
 * The server's "retry after" hint for a throttled response, ms, or `null`.
 * `Retry-After` (seconds or HTTP-date) wins; otherwise the
 * `x-ratelimit-reset-{requests,tokens}` whose matching `remaining` is
 * exhausted (or unknown), largest first; failing that, the smallest reset
 * present (the bucket that will let one more request through soonest).
 */
export function rateLimitHintMs(
  headers: HeadersLike | undefined,
  wallNowMs: () => number = Date.now,
): number | null {
  if (!headers) return null;
  const ra = headers.get("retry-after");
  if (ra !== null) {
    const secs = parseDurationMs(ra);
    if (secs !== null) return secs;
    const at = Date.parse(ra);
    if (!Number.isNaN(at)) return Math.max(0, at - wallNowMs());
  }
  const exhausted: number[] = [];
  const present: number[] = [];
  for (const kind of ["requests", "tokens"]) {
    const reset = parseDurationMs(headers.get(`x-ratelimit-reset-${kind}`));
    if (reset === null) continue;
    present.push(reset);
    const remaining = headers.get(`x-ratelimit-remaining-${kind}`);
    if (remaining === null || !(Number(remaining) > 0)) exhausted.push(reset);
  }
  if (exhausted.length > 0) return Math.max(...exhausted);
  if (present.length > 0) return Math.min(...present);
  return null;
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
  const maxRetries429 = opts.retry429?.maxRetries ?? MAX_RETRIES_429;
  const maxWait429 = opts.retry429?.maxWaitMs ?? BACKOFF_429_MAX_MS;
  const giveUpAbove = opts.retry429?.giveUpIfHintAboveMs ?? Number.POSITIVE_INFINITY;
  const hintMargin = opts.retry429?.hintMarginMs ?? 0;

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
      if (attempts429 >= maxRetries429) {
        logger.warn(`http: 429 after ${attempts429} retries: ${safeUrl}`);
        return resp;
      }
      const giveUpOnBody = opts.retry429?.giveUpOnBody;
      if (giveUpOnBody) {
        let parsed: unknown;
        try {
          parsed = await resp.json();
        } catch {
          parsed = undefined;
        }
        resp = { status: resp.status, headers: resp.headers, json: async () => parsed };
        if (giveUpOnBody(parsed)) {
          logger.warn(`http: 429 body says not to retry: ${safeUrl}`);
          return resp;
        }
      }
      const hint = rateLimitHintMs(resp.headers);
      if (hint !== null && hint > giveUpAbove) {
        logger.warn(
          `http: 429 with retry hint ${(hint / 1000).toFixed(1)}s > ${(giveUpAbove / 1000).toFixed(0)}s, not retrying: ${safeUrl}`,
        );
        return resp;
      }
      const wanted = hint !== null ? hint + hintMargin : backoff429;
      const sleepFor = Math.max(
        0,
        Math.min(wanted, maxWait429, overallDeadlineMs - (now() - start)),
      );
      logger.warn(
        `http: 429 throttled, sleeping ${(sleepFor / 1000).toFixed(1)}s (retry ${attempts429 + 1}${hint !== null ? ", server hint" : ""}): ${safeUrl}`,
      );
      deps.onRetry?.({ status: 429, attempt: attempts429 + 1, waitMs: sleepFor, hintMs: hint });
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
      deps.onRetry?.({
        status: resp.status,
        attempt: attempts5xx + 1,
        waitMs: sleepFor,
        hintMs: null,
      });
      await sleep(sleepFor);
      attempts5xx += 1;
      continue;
    }

    return resp;
  }
}
