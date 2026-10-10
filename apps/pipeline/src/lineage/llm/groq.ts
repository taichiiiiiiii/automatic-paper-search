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
 *
 * R2-20 (Groq token budget):
 *  - a DAILY (TPD/RPD) 429 whose reset is short (<= 10 min) is waited out
 *    instead of latching: the daily window is rolling, so tokens free up
 *    gradually and "reset in 10s" really means 10s. It only latches when
 *    the reset is longer, there is no reset hint, or the per-run 429
 *    back-off budget would be exceeded;
 *  - gpt-oss models get `reasoning_effort` (default `low`) and a
 *    `max_completion_tokens` cap sized to the JSON answer plus a small
 *    reasoning allowance (grown per extra answer of a batched prompt). A
 *    response cut off by the cap (`finish_reason: "length"`) is a failed
 *    call, never parsed;
 *  - an optional per-run token budget latches the provider once spent, so
 *    one theme cannot eat the whole day's quota;
 *  - tokens are counted per prompt kind for the usage summary.
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
  CompletionOptions,
  LLMProvider,
  LlmUsageStats,
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
  // Same free-tier row as the 120b (30 RPM / 8K TPM / 200K TPD), own quota.
  "openai/gpt-oss-20b": { rpm: 20, tpm: 6000 },
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
/** Short-reset daily 429s waited out per call before giving up (R2-20). */
const MAX_DAILY_SHORT_WAITS = 3;

/**
 * R2-20: models that take `reasoning_effort` low/medium/high on Groq
 * (https://console.groq.com/docs/reasoning, checked 2026-10-10: GPT-OSS
 * 20B/120B and Qwen 3.8 27B). Other models get neither the effort nor a
 * default completion cap (a non-reasoning model answers in ~250 tokens).
 */
const REASONING_MODEL_RE = /^openai\/gpt-oss-|^qwen\/qwen3/;
const REASONING_EFFORTS: ReadonlySet<string> = new Set(["low", "medium", "high"]);
export const DEFAULT_REASONING_EFFORT = "low";
/**
 * Completion cap for ONE JSON answer: the answer itself (~60 tokens of
 * keys + a <=150-character Japanese rationale, ~250 tokens) plus a
 * low-effort reasoning allowance (~500). The measured average before R2-20
 * was ~1,450 tokens per call in total, prompt included.
 */
export const DEFAULT_MAX_COMPLETION_TOKENS = 768;
/** Added to the cap for every extra answer of a batched prompt. */
export const COMPLETION_TOKENS_PER_EXTRA_ANSWER = 256;

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
  /**
   * R2-20: `reasoning_effort` sent to reasoning models (`low`|`medium`|
   * `high`). Default `low` for gpt-oss; `null`/`""`/`"off"` omits it.
   * Ignored for models without the parameter.
   */
  reasoningEffort?: string | null;
  /**
   * R2-20: `max_completion_tokens` for a single-answer JSON call (batched
   * prompts add {@link COMPLETION_TOKENS_PER_EXTRA_ANSWER} per extra
   * answer). Default {@link DEFAULT_MAX_COMPLETION_TOKENS} for reasoning
   * models, none otherwise; `0` disables the cap. Not applied to
   * `evaluateBatch`/`chat` (free-form, longer answers).
   */
  maxCompletionTokens?: number | null;
  /** R2-20: tokens this provider may spend in one run; then it latches. 0/absent = no budget. */
  runTokenBudget?: number;
}

/** Per prompt kind: calls and tokens (R2-20 summary). */
export interface KindUsage {
  calls: number;
  tokens: number;
}

/** Counters behind `usageSummary()`. */
export interface GroqUsageStats extends LlmUsageStats {
  /** 429 responses seen (retried ones + calls that ended in 429). */
  rateLimited: number;
  /** Calls whose final response was still 429. */
  finalRateLimited: number;
  throttleWaitMs: number;
  pacingWaitMs: number;
  tokens: number;
  /** R2-20: short-reset daily 429s waited out instead of latching. */
  dailyShortWaits: number;
  /** R2-20: answers cut off by `max_completion_tokens` (failed calls). */
  truncated: number;
  /** R2-20: calls and tokens by prompt kind (`completeJson` opts.kind). */
  byKind: Record<string, KindUsage>;
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
  private readonly reasoningEffort: string | null;
  private readonly maxCompletionTokens: number | null;
  private readonly runTokenBudget: number;
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
    dailyShortWaits: 0,
    truncated: 0,
    byKind: {},
    latched: false,
    latchReason: null,
    dailyLimitHit: false,
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
    const reasoningModel = REASONING_MODEL_RE.test(this.model);
    const effort =
      config.reasoningEffort === undefined ? DEFAULT_REASONING_EFFORT : config.reasoningEffort;
    const effortNorm = typeof effort === "string" ? effort.trim().toLowerCase() : "";
    this.reasoningEffort = reasoningModel && REASONING_EFFORTS.has(effortNorm) ? effortNorm : null;
    const cap = config.maxCompletionTokens;
    this.maxCompletionTokens =
      cap === undefined || cap === null
        ? reasoningModel
          ? DEFAULT_MAX_COMPLETION_TOKENS
          : null
        : Number.isFinite(cap) && cap > 0
          ? Math.floor(cap)
          : null;
    const budget = config.runTokenBudget;
    this.runTokenBudget =
      budget !== undefined && Number.isFinite(budget) && budget > 0 ? budget : 0;
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
    const text = await this.chatRaw(system, user, false, { kind: "evaluate" }, false);
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
    const text = await this.chatRaw(system, user, true, { kind: "abstract" });
    if (text === null) return null;
    const parsed = parseLlmResponse(text);
    return relationClassificationFromDict(parsed);
  }

  async completeJson(
    system: string,
    user: string,
    opts: CompletionOptions = {},
  ): Promise<string | null> {
    return this.chatRaw(system, user, true, opts);
  }

  async chat(system: string, user: string): Promise<string | null> {
    return this.chatRaw(system, user, false, { kind: "chat" }, false);
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

  /**
   * Concise end-of-run usage line (calls, 429s, waits, latch state), then
   * (R2-20) tokens/calls per prompt kind, short daily waits, truncated
   * answers and the run budget. The part up to `latched=` is unchanged so
   * existing log greps keep working.
   */
  usageSummary(): string {
    const st = this.stats;
    const secs = (ms: number) => (ms / 1000).toFixed(1);
    const kinds = Object.keys(st.byKind)
      .sort()
      .map((k) => `${k}=${st.byKind[k]?.tokens ?? 0}/${st.byKind[k]?.calls ?? 0}`)
      .join(" ");
    return (
      `groq summary: model=${this.model}, calls=${st.calls} (ok=${st.ok}, failed=${st.failed}), ` +
      `429s=${st.rateLimited} (final=${st.finalRateLimited}), throttle_wait=${secs(st.throttleWaitMs)}s, ` +
      `pacing_wait=${secs(st.pacingWaitMs)}s, tokens=${st.tokens}, ` +
      `latched=${st.latched ? `yes (${st.latchReason})` : "no"}; ` +
      `tokens/calls by kind: ${kinds || "none"}; daily_short_waits=${st.dailyShortWaits}, ` +
      `truncated=${st.truncated}, run_budget=${this.runTokenBudget > 0 ? `${st.tokens}/${this.runTokenBudget}` : "off"}`
    );
  }

  /** Snapshot of the counters behind `usageSummary()`. */
  usageStats(): GroqUsageStats {
    const byKind: Record<string, KindUsage> = {};
    for (const [k, v] of Object.entries(this.stats.byKind)) byKind[k] = { ...v };
    return { ...this.stats, byKind };
  }

  /** Book the tokens of one API response under its prompt kind. */
  private account(kind: string, tokens: number): void {
    this.stats.tokens += tokens;
    const k = this.kindUsage(kind);
    k.tokens += tokens;
  }

  private kindUsage(kind: string): KindUsage {
    let k = this.stats.byKind[kind];
    if (k === undefined) {
      k = { calls: 0, tokens: 0 };
      this.stats.byKind[kind] = k;
    }
    return k;
  }

  /** True once the breaker latched: every further call returns null without an API call. */
  isExhausted(): boolean {
    return this.quotaExhausted;
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

  /** The error message and reset hint (header or "try again in", larger) of a 429. */
  private static async inspect429(
    resp: HttpResponseLike,
  ): Promise<{ message: string; hint: number | null }> {
    let message = "";
    try {
      message = errorText(await resp.json());
    } catch {
      // body unreadable: rely on headers alone
    }
    // "Please try again in 4m12.5s." — drop the sentence's full stop.
    const tryAgain = parseDurationMs(
      /try again in ([0-9hms.]+)/i.exec(message)?.[1]?.replace(/\.+$/, "") ?? null,
    );
    const header = rateLimitHintMs(resp.headers);
    const hint =
      header !== null && tryAgain !== null ? Math.max(header, tryAgain) : (header ?? tryAgain);
    return { message, hint };
  }

  /**
   * R2-20: wait out a DAILY-quota 429 whose reset is short instead of
   * latching. Groq's TPD/RPD windows are rolling, so a reset of a few
   * seconds/minutes frees enough tokens for the next call. Only when the
   * reset is known, <= 10 min, this call has not already waited
   * {@link MAX_DAILY_SHORT_WAITS} times, and the wait fits the per-run 429
   * back-off budget. Returns whether it waited (the caller retries).
   */
  private async waitShortDaily429(
    info: { message: string; hint: number | null },
    waitsSoFar: number,
  ): Promise<boolean> {
    const { message, hint } = info;
    if (!DAILY_LIMIT_RE.test(message) || hint === null || hint > DAILY_LIMIT_HINT_MS) return false;
    if (waitsSoFar >= MAX_DAILY_SHORT_WAITS) return false;
    const wait = hint + RETRY_429_HINT_MARGIN_MS;
    if (this.stats.throttleWaitMs + wait > this.maxThrottleWaitMs) return false;
    this.deps.logger?.warn(
      `groq: daily-quota 429 with a short reset (${(hint / 1000).toFixed(0)}s; rolling window) — waiting instead of latching`,
    );
    await (this.deps.sleep ?? defaultSleep)(wait);
    this.stats.rateLimited += 1;
    this.stats.throttleWaitMs += wait;
    this.stats.dailyShortWaits += 1;
    return true;
  }

  /**
   * A call whose FINAL response is 429 (requestWithRetry already waited
   * out every hinted reset it was allowed to, and a short daily reset was
   * waited out by {@link waitShortDaily429}). Latches immediately on a
   * daily-limit 429 (long or unknown reset, or the wait budget is spent),
   * after `PERSISTENT_429_THRESHOLD` such calls in a row otherwise. Does
   * not touch the non-429 failure counter: a throttled call says nothing
   * about whether the API returns usable answers.
   */
  private record429(info: { message: string; hint: number | null }): void {
    this.stats.failed += 1;
    this.stats.finalRateLimited += 1;
    this.stats.rateLimited += 1;
    const { message, hint } = info;
    const hintTxt = hint !== null ? `, reset in ${(hint / 1000).toFixed(0)}s` : "";
    this.deps.logger?.warn(
      `groq: chat/completions failed (status=429${hintTxt}${message ? `: ${message.slice(0, 200)}` : ""})`,
    );
    if (isDailyLimit429(message, hint)) {
      this.stats.dailyLimitHit = true;
      this.latch(`daily rate limit exhausted (429${hintTxt})`);
      return;
    }
    this.consecutive429 += 1;
    if (this.consecutive429 >= PERSISTENT_429_THRESHOLD) {
      this.latch(`${this.consecutive429} consecutive calls still 429 after header-paced retries`);
    }
  }

  /**
   * One chat completion. `opts.kind` books the tokens; `opts.answers`
   * grows the completion cap for batched prompts; `capped=false` sends no
   * `max_completion_tokens` (free-form `evaluateBatch`/`chat`).
   */
  private async chatRaw(
    system: string,
    user: string,
    jsonMode: boolean,
    opts: CompletionOptions = {},
    capped = true,
  ): Promise<string | null> {
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
    if (this.runTokenBudget > 0 && this.stats.tokens >= this.runTokenBudget) {
      this.latch(
        `run token budget exhausted (${this.stats.tokens} >= ${this.runTokenBudget} tokens)`,
      );
      return null;
    }
    const kind = opts.kind ?? (jsonMode ? "json" : "chat");
    const answers = Math.max(1, Math.floor(opts.answers ?? 1));
    const cap =
      capped && this.maxCompletionTokens !== null
        ? this.maxCompletionTokens + COMPLETION_TOKENS_PER_EXTRA_ANSWER * (answers - 1)
        : null;
    const completionEst =
      cap === null
        ? COMPLETION_TOKEN_ESTIMATE * answers
        : Math.min(cap, COMPLETION_TOKEN_ESTIMATE * answers);
    const estTokens = Math.ceil((system.length + user.length) / 4) + completionEst;
    const reservation = await this.throttleForRateLimit(estTokens);
    this.stats.calls += 1;
    this.kindUsage(kind).calls += 1;

    const body: Record<string, unknown> = {
      model: this.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: this.temperature,
    };
    if (jsonMode) body.response_format = { type: "json_object" };
    if (this.reasoningEffort !== null) body.reasoning_effort = this.reasoningEffort;
    if (cap !== null) body.max_completion_tokens = cap;

    let resp: HttpResponseLike | null = null;
    for (let dailyWaits = 0; ; dailyWaits++) {
      resp = await this.send(body);
      if (resp === null || resp.status !== 429) break;
      const info = await GroqProvider.inspect429(resp);
      if (await this.waitShortDaily429(info, dailyWaits)) continue;
      this.record429(info);
      // A 429 consumes no tokens: release the estimate from the TPM window.
      reservation.tokens = 0;
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
    const usage = (data as { usage?: { total_tokens?: unknown } }).usage;
    if (typeof usage?.total_tokens === "number" && usage.total_tokens > 0) {
      reservation.tokens = usage.total_tokens;
    }
    const choices = data.choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      this.deps.logger?.warn("groq: empty/invalid choices in response");
      this.recordFailure();
      return null;
    }
    // Every 200 is billed, usable or not.
    this.account(kind, reservation.tokens);
    const firstChoice = choices[0];
    const choice =
      firstChoice !== null && typeof firstChoice === "object"
        ? (firstChoice as Record<string, unknown>)
        : null;
    if (choice?.finish_reason === "length") {
      // Cut off by max_completion_tokens (possibly mid-reasoning): the JSON
      // may be incomplete or parse into something partial — never use it.
      this.stats.truncated += 1;
      this.deps.logger?.warn(
        `groq: answer truncated by max_completion_tokens=${cap ?? "none"} (finish_reason=length, kind=${kind}); treated as a failed call`,
      );
      this.recordFailure();
      return null;
    }
    const message = choice?.message ?? null;
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
    return content;
  }

  private send(body: Record<string, unknown>): Promise<HttpResponseLike | null> {
    return (this.deps.requestWithRetryFn ?? requestWithRetry)(
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
          // A daily (RPD/TPD) 429 goes back to chatRaw, which waits out a
          // short rolling-window reset itself or latches.
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
  }
}
