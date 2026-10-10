/**
 * Groq LLM provider — TS port of `paperpilot/llm/groq_provider.py`.
 *
 * OpenAI-compatible Chat Completions API. Covers both LLM use-cases:
 * Stage 4 reranking (`evaluateBatch`) and per-edge lineage relation
 * classification (`classifyRelation`) — Groq's free tier + native JSON
 * mode make it the default lineage-classification backend.
 *
 * Built-in rate limiter (LLM-16/17, RPM + estimated-TPM pacing) + circuit
 * breaker (LLM-18/19) — see `throttleForRateLimit`/`recordFailure`/
 * `record429` below. 429s are retried by `requestWithRetry` on the
 * server's `Retry-After` / `x-ratelimit-reset-*` hint and only latch the
 * breaker on a daily-limit 429 or a run of calls that stay 429.
 */

import type {
  FetchLike,
  HttpResponseLike,
  RetryEvent,
} from "../../collect/http/requestWithRetry.js";
import {
  parseDurationMs,
  rateLimitHintMs,
  requestWithRetry,
} from "../../collect/http/requestWithRetry.js";
import { parseLlmResponse } from "../../collect/jsonParser.js";
import type {
  ClassifyPaperLike,
  LLMProvider,
  PaperEvaluation,
  RelationClassification,
} from "../../collect/llm/provider.js";
import type { Paper } from "../../collect/model/paper.js";
import {
  buildClassifyPrompt,
  buildEvaluationPrompt,
  mapBatchEvaluations,
  relationClassificationFromDict,
  safeJsonResponse,
} from "./base.js";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
// llama-3.3-70b-versatile was shut down on 2026-08-16 (Groq deprecations);
// openai/gpt-oss-120b is the recommended replacement.
const DEFAULT_MODEL = "openai/gpt-oss-120b";
// Conservative default below the 30 RPM free tier so a burst of
// classifyRelation calls doesn't silently 429 the back half of the burst.
const DEFAULT_RATE_LIMIT_RPM = 25;
/**
 * Per-model free-tier pacing. gpt-oss-120b's free tier is 30 RPM / 8K TPM
 * (plus 1K RPD / 200K TPD); TPM is the binding limit for classify prompts
 * (~1-2K tokens each incl. reasoning), so pace on an estimated token
 * window as well as on RPM, both with headroom.
 */
const MODEL_PACING: Readonly<Record<string, { rpm: number; tpm: number }>> = {
  "openai/gpt-oss-120b": { rpm: 20, tpm: 6000 },
};
const TOKEN_WINDOW_MS = 60_000;
/** Completion allowance added to the prompt estimate (gpt-oss spends reasoning tokens). */
const COMPLETION_TOKEN_ESTIMATE = 600;
// After this many consecutive NON-429 failures (5xx-after-retries, non-JSON
// / wrong-shape / empty bodies, transport errors) latch the breaker and
// short-circuit to heuristic-only. 429s are handled separately below.
const QUOTA_EXHAUSTED_THRESHOLD = 3;
// Calls that still end in 429 after every header-paced retry, in a row.
// Each such call already waited minutes, so a short run of them means the
// limit is not clearing — latch rather than burn the CI timeout.
const PERSISTENT_429_THRESHOLD = 3;
/** 429 retry policy: honour the server hint, up to 90s per wait, 6 retries. */
const RETRY_429_MAX = 6;
const RETRY_429_MAX_WAIT_MS = 90_000;
const RETRY_429_HINT_MARGIN_MS = 250;
/** A reset further away than this is a daily (RPD/TPD) limit: latch, don't wait. */
const DAILY_LIMIT_HINT_MS = 10 * 60_000;
/** Total 429 back-off budget per provider instance (one theme per process in CI). */
const DEFAULT_MAX_THROTTLE_WAIT_MS = 20 * 60_000;
const DAILY_LIMIT_RE = /per day|\bRPD\b|\bTPD\b|daily/i;

/** `error.message` + `error.code` of a Groq/OpenAI error body ("" when absent). */
function errorText(body: unknown): string {
  const err =
    body !== null && typeof body === "object"
      ? (body as { error?: { message?: unknown; code?: unknown } }).error
      : undefined;
  if (err === null || typeof err !== "object") return "";
  return [err.message, err.code].filter((x) => typeof x === "string").join(" ");
}

/** True when a 429 says the DAILY quota is exhausted (message/code or a reset > 10 min). */
export function isDailyLimit429(message: string, hintMs: number | null): boolean {
  if (DAILY_LIMIT_RE.test(message)) return true;
  return hintMs !== null && hintMs > DAILY_LIMIT_HINT_MS;
}

export interface GroqConfig {
  enabled?: boolean;
  batchSize?: number;
  model?: string;
  temperature?: number;
  timeoutSeconds?: number;
  rateLimitRpm?: number;
  /** Estimated tokens-per-minute budget; 0 disables token pacing. Default per model (`MODEL_PACING`). */
  rateLimitTpm?: number;
  /** Total 429 back-off budget before latching, seconds. Default 1200. */
  maxThrottleWaitSeconds?: number;
}

/** Counters behind `usageSummary()`. */
export interface GroqUsageStats {
  calls: number;
  ok: number;
  failed: number;
  /** 429 responses seen (retried ones + calls that ended in 429). */
  rateLimited: number;
  /** Calls whose final response was still 429. */
  finalRateLimited: number;
  throttleWaitMs: number;
  pacingWaitMs: number;
  tokens: number;
  latched: boolean;
  latchReason: string | null;
}

export interface GroqDeps {
  fetchImpl: FetchLike;
  /** Monotonic clock in ms — injected for deterministic rate-limiter tests (Python monkeypatches `time.monotonic`). */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  logger?: { warn: (msg: string) => void };
  /**
   * Test seam matching Python's `patch("paperpilot.llm.groq_provider.request_with_retry", ...)`
   * — the Python tests mock the WHOLE retry function (bypassing its
   * internal backoff/retry loop entirely), not the raw transport. Defaults
   * to the real `requestWithRetry`.
   */
  requestWithRetryFn?: typeof requestWithRetry;
}

function defaultNow(): number {
  return performance.now();
}
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class GroqProvider implements LLMProvider {
  readonly name = "groq";
  batchSize: number;
  readonly model: string;
  private readonly temperature: number;
  private readonly timeoutSeconds: number;
  private readonly apiKey: string | null;
  private _enabledFlag: boolean;
  private readonly minCallIntervalMs: number;
  private readonly tpm: number;
  private readonly maxThrottleWaitMs: number;
  private lastCallTs: number | null = null;
  private tokenWindow: { ts: number; tokens: number }[] = [];
  private consecutiveFailures = 0;
  private consecutive429 = 0;
  private quotaExhausted = false;
  private readonly stats: GroqUsageStats = {
    calls: 0,
    ok: 0,
    failed: 0,
    rateLimited: 0,
    finalRateLimited: 0,
    throttleWaitMs: 0,
    pacingWaitMs: 0,
    tokens: 0,
    latched: false,
    latchReason: null,
  };
  private readonly deps: GroqDeps;

  constructor(config: GroqConfig, apiKey: string | null, deps: GroqDeps) {
    this._enabledFlag = config.enabled ?? true;
    this.apiKey = apiKey;
    this.batchSize = config.batchSize ?? 5;
    this.model = config.model ?? DEFAULT_MODEL;
    this.temperature = config.temperature ?? 0.2;
    this.timeoutSeconds = config.timeoutSeconds ?? 60;
    const pacing = MODEL_PACING[this.model];
    const rpm = config.rateLimitRpm ?? pacing?.rpm ?? DEFAULT_RATE_LIMIT_RPM;
    // Guard against pathological config values (0 or negative would divide
    // by zero / sleep forever) — LLM-17.
    this.minCallIntervalMs = (rpm > 0 ? 60 / rpm : 60 / DEFAULT_RATE_LIMIT_RPM) * 1000;
    const tpm = config.rateLimitTpm ?? pacing?.tpm ?? 0;
    this.tpm = Number.isFinite(tpm) && tpm > 0 ? tpm : 0;
    const budgetS = config.maxThrottleWaitSeconds;
    this.maxThrottleWaitMs =
      budgetS !== undefined && Number.isFinite(budgetS) && budgetS > 0
        ? budgetS * 1000
        : DEFAULT_MAX_THROTTLE_WAIT_MS;
    this.deps = deps;
  }

  /** Auto-disable when the API key is missing. */
  get enabled(): boolean {
    return this._enabledFlag && !!this.apiKey;
  }
  set enabled(value: boolean) {
    this._enabledFlag = value;
  }

  // ---- Stage 4 ----

  async evaluateBatch(
    papers: readonly Paper[],
    profile: string,
  ): Promise<(PaperEvaluation | null)[]> {
    if (papers.length === 0) return [];
    const [system, user] = buildEvaluationPrompt(papers, profile);
    const text = await this.chatRaw(system, user, false);
    if (text === null) return new Array(papers.length).fill(null);
    const parsed = parseLlmResponse(text);
    if (!Array.isArray(parsed)) {
      this.deps.logger?.warn(
        `groq: response was not a JSON array (type=${parsed === null ? "null" : typeof parsed})`,
      );
      return new Array(papers.length).fill(null);
    }
    return mapBatchEvaluations(papers.length, parsed);
  }

  // ---- Lineage classification ----

  async classifyRelation(
    a: ClassifyPaperLike,
    b: ClassifyPaperLike,
  ): Promise<RelationClassification | null> {
    const [system, user] = buildClassifyPrompt(a, b);
    // Groq's `response_format: json_object` reliably avoids markdown fences
    // or stray prose — critical because hundreds of classifications are
    // issued per lineage build.
    const text = await this.chatRaw(system, user, true);
    if (text === null) return null;
    const parsed = parseLlmResponse(text);
    return relationClassificationFromDict(parsed);
  }

  async completeJson(system: string, user: string): Promise<string | null> {
    return this.chatRaw(system, user, true);
  }

  async chat(system: string, user: string): Promise<string | null> {
    return this.chatRaw(system, user, false);
  }

  // ---- helpers ----

  /**
   * Sleep just enough to keep this call under the RPM budget. Idempotent
   * on first invocation (`lastCallTs === null`). Calls `now()` ONCE on the
   * first invocation (no elapsed check), and TWICE on every subsequent
   * invocation (elapsed check, then re-stamp AFTER sleeping) — this exact
   * call pattern is pinned by the ported rate-limiter tests, which drive a
   * scripted clock sequence.
   */
  private async throttleForRateLimit(estTokens: number): Promise<{ ts: number; tokens: number }> {
    const now = this.deps.now ?? defaultNow;
    const sleep = this.deps.sleep ?? defaultSleep;
    if (this.lastCallTs === null) {
      this.lastCallTs = now();
    } else {
      const elapsed = now() - this.lastCallTs;
      const wait = this.minCallIntervalMs - elapsed;
      if (wait > 0) {
        await sleep(wait);
        this.stats.pacingWaitMs += wait;
      }
      this.lastCallTs = now();
    }
    return this.reserveTokens(estTokens);
  }

  /**
   * Token-aware pacing: keep the estimated tokens of calls started in the
   * last 60s under `tpm`. Reuses the RPM stamp, so it adds a `now()` read
   * only when it actually sleeps. Entries are corrected to the response's
   * `usage.total_tokens` once known.
   */
  private async reserveTokens(estTokens: number): Promise<{ ts: number; tokens: number }> {
    let stamp = this.lastCallTs ?? 0;
    const entry = { ts: stamp, tokens: estTokens };
    if (this.tpm <= 0) return entry;
    const prune = (t: number) => {
      this.tokenWindow = this.tokenWindow.filter((e) => e.ts > t - TOKEN_WINDOW_MS);
    };
    prune(stamp);
    let used = this.tokenWindow.reduce((acc, e) => acc + e.tokens, 0);
    if (used + estTokens > this.tpm && this.tokenWindow.length > 0) {
      // Wait until enough of the oldest entries age out (all of them when a
      // single call alone exceeds the budget).
      let until = this.tokenWindow[this.tokenWindow.length - 1]?.ts ?? stamp;
      for (const e of this.tokenWindow) {
        used -= e.tokens;
        if (used + estTokens <= this.tpm) {
          until = e.ts;
          break;
        }
      }
      const wait = until + TOKEN_WINDOW_MS - stamp;
      if (wait > 0) {
        const sleep = this.deps.sleep ?? defaultSleep;
        await sleep(wait);
        this.stats.pacingWaitMs += wait;
        stamp = (this.deps.now ?? defaultNow)();
        this.lastCallTs = stamp;
        prune(stamp);
      }
    }
    entry.ts = stamp;
    this.tokenWindow.push(entry);
    return entry;
  }

  private latch(reason: string): void {
    if (this.quotaExhausted) return;
    this.quotaExhausted = true;
    this.stats.latched = true;
    this.stats.latchReason = reason;
    this.deps.logger?.warn(
      `groq: ${reason} — latching; short-circuiting further LLM calls to heuristic-only for the rest of this run`,
    );
  }

  /** Concise end-of-run usage line (calls, 429s, waits, latch state). */
  usageSummary(): string {
    const st = this.stats;
    const secs = (ms: number) => (ms / 1000).toFixed(1);
    return (
      `groq summary: model=${this.model}, calls=${st.calls} (ok=${st.ok}, failed=${st.failed}), ` +
      `429s=${st.rateLimited} (final=${st.finalRateLimited}), throttle_wait=${secs(st.throttleWaitMs)}s, ` +
      `pacing_wait=${secs(st.pacingWaitMs)}s, tokens=${st.tokens}, ` +
      `latched=${st.latched ? `yes (${st.latchReason})` : "no"}`
    );
  }

  /** Snapshot of the counters behind `usageSummary()`. */
  usageStats(): GroqUsageStats {
    return { ...this.stats };
  }

  /**
   * Increment the consecutive-failure counter and latch the
   * quota-exhausted circuit breaker once it crosses the threshold. Every
   * failure branch in `chatRaw` (non-200, non-JSON/wrong-shape body, empty
   * `choices`, empty/unusable `content`) routes through here.
   */
  private recordFailure(): void {
    this.stats.failed += 1;
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= QUOTA_EXHAUSTED_THRESHOLD) {
      this.latch(
        `${this.consecutiveFailures} consecutive unusable responses (non-200, non-JSON or empty)`,
      );
    }
  }

  /**
   * A call whose FINAL response is 429 (requestWithRetry already waited
   * out every hinted reset it was allowed to). Latches immediately on a
   * daily-limit 429, after `PERSISTENT_429_THRESHOLD` such calls in a row
   * otherwise. Does not touch the non-429 failure counter: a throttled
   * call says nothing about whether the API returns usable answers.
   */
  private async record429(resp: HttpResponseLike): Promise<void> {
    this.stats.failed += 1;
    this.stats.finalRateLimited += 1;
    this.stats.rateLimited += 1;
    let message = "";
    try {
      message = errorText(await resp.json());
    } catch {
      // body unreadable: rely on headers alone
    }
    const tryAgain = /try again in ([0-9hms.]+)/i.exec(message)?.[1];
    const hint = rateLimitHintMs(resp.headers) ?? parseDurationMs(tryAgain ?? null);
    const hintTxt = hint !== null ? `, reset in ${(hint / 1000).toFixed(0)}s` : "";
    this.deps.logger?.warn(
      `groq: chat/completions failed (status=429${hintTxt}${message ? `: ${message.slice(0, 200)}` : ""})`,
    );
    if (isDailyLimit429(message, hint)) {
      this.latch(`daily rate limit exhausted (429${hintTxt})`);
      return;
    }
    this.consecutive429 += 1;
    if (this.consecutive429 >= PERSISTENT_429_THRESHOLD) {
      this.latch(`${this.consecutive429} consecutive calls still 429 after header-paced retries`);
    }
  }

  private async chatRaw(system: string, user: string, jsonMode: boolean): Promise<string | null> {
    // Circuit-breaker short-circuit: once the quota-exhausted threshold is
    // hit, every further call returns null without touching the API or
    // sleeping for the RPM throttle.
    if (this.quotaExhausted) return null;
    if (this.stats.throttleWaitMs >= this.maxThrottleWaitMs) {
      this.latch(
        `429 back-off budget exhausted (${(this.stats.throttleWaitMs / 1000).toFixed(0)}s >= ${(this.maxThrottleWaitMs / 1000).toFixed(0)}s)`,
      );
      return null;
    }
    const estTokens = Math.ceil((system.length + user.length) / 4) + COMPLETION_TOKEN_ESTIMATE;
    const reservation = await this.throttleForRateLimit(estTokens);
    this.stats.calls += 1;

    const body: Record<string, unknown> = {
      model: this.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: this.temperature,
    };
    if (jsonMode) body.response_format = { type: "json_object" };

    const resp: HttpResponseLike | null = await (this.deps.requestWithRetryFn ?? requestWithRetry)(
      {
        method: "POST",
        url: GROQ_URL,
        headers: { Authorization: `Bearer ${this.apiKey ?? ""}` },
        jsonBody: body,
        timeoutMs: this.timeoutSeconds * 1000,
        // Room for every hinted 429 wait on top of the per-attempt timeouts.
        overallDeadlineMs:
          this.timeoutSeconds * 1000 * (RETRY_429_MAX + 1) + RETRY_429_MAX_WAIT_MS * RETRY_429_MAX,
        retry429: {
          maxRetries: RETRY_429_MAX,
          maxWaitMs: RETRY_429_MAX_WAIT_MS,
          giveUpIfHintAboveMs: DAILY_LIMIT_HINT_MS,
          hintMarginMs: RETRY_429_HINT_MARGIN_MS,
          // A daily (RPD/TPD) 429 will not clear within the run: stop now.
          giveUpOnBody: (b) => isDailyLimit429(errorText(b), null),
        },
      },
      {
        fetchImpl: this.deps.fetchImpl,
        sleep: this.deps.sleep,
        now: this.deps.now,
        logger: this.deps.logger,
        onRetry: (ev: RetryEvent) => {
          if (ev.status !== 429) return;
          this.stats.rateLimited += 1;
          this.stats.throttleWaitMs += ev.waitMs;
        },
      },
    );
    if (resp !== null && resp.status === 429) {
      await this.record429(resp);
      return null;
    }
    if (resp === null || resp.status !== 200) {
      this.deps.logger?.warn(`groq: chat/completions failed (status=${resp?.status ?? "null"})`);
      this.recordFailure();
      return null;
    }
    const data = await safeJsonResponse(resp);
    if (data === null) {
      this.deps.logger?.warn("groq: chat/completions response was not valid JSON");
      this.recordFailure();
      return null;
    }
    const choices = data.choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      this.deps.logger?.warn("groq: empty/invalid choices in response");
      this.recordFailure();
      return null;
    }
    const firstChoice = choices[0];
    const message =
      firstChoice !== null && typeof firstChoice === "object"
        ? (firstChoice as Record<string, unknown>).message
        : null;
    const content =
      message !== null && typeof message === "object"
        ? (message as Record<string, unknown>).content
        : null;
    if (!(typeof content === "string" && content.trim())) {
      this.deps.logger?.warn("groq: empty/unusable content in response");
      this.recordFailure();
      return null;
    }
    // Success — reset the failure counters so a transient blip doesn't latch
    // the circuit breaker open.
    this.consecutiveFailures = 0;
    this.consecutive429 = 0;
    this.stats.ok += 1;
    const usage = (data as { usage?: { total_tokens?: unknown } }).usage;
    if (typeof usage?.total_tokens === "number" && usage.total_tokens > 0) {
      reservation.tokens = usage.total_tokens;
    }
    this.stats.tokens += reservation.tokens;
    return content;
  }
}
