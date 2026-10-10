/**
 * Gemini LLM provider — TS port of `paperpilot/llm/gemini_provider.py`.
 *
 * Uses the REST `generateContent` endpoint with
 * `responseMimeType=application/json` so the model returns parseable JSON
 * (the 3-step `parse_llm_response` fallback still runs for resilience).
 *
 * R2-6 (design 41 D2): Gemini's free tier is the lineage classifier's
 * secondary provider behind Groq. Like `groq.ts` it now has
 *  - optional RPM pacing (`rateLimitRpm`; the provider factory sets the
 *    free-tier default, the bare class keeps the old unpaced behaviour),
 *  - a 429 policy: per-minute 429s are retried with back-off, a DAILY
 *    quota 429 (`RESOURCE_EXHAUSTED` naming a per-day quota) stops at once,
 *  - a circuit breaker (daily quota, or 3 consecutive unusable/final-429
 *    responses) after which every call returns `null` without an API call,
 *  - `usageStats()` / `usageSummary()` / `isExhausted()` for the fallback
 *    chain and the CLI's classification-rate gate.
 */

import type { FetchLike, HttpResponseLike } from "../../collect/http/requestWithRetry.js";
import { requestWithRetry } from "../../collect/http/requestWithRetry.js";
import { parseLlmResponse } from "../../collect/jsonParser.js";
import type {
  ClassifyPaperLike,
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

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
/**
 * gemini-1.5-flash was shut down in 2025. gemini-2.5-flash is GA, on the
 * free tier, and has no announced shutdown date (Gemini API
 * deprecations page, checked 2026-10-10); it is also what the provider
 * factory already defaulted to.
 */
export const GEMINI_DEFAULT_MODEL = "gemini-2.5-flash";
/** After this many consecutive unusable (non-429) responses, latch. */
const FAILURE_LATCH_THRESHOLD = 3;
/** Calls that still end in 429 after the retries, in a row, before latching. */
const PERSISTENT_429_THRESHOLD = 3;
const RETRY_429_MAX = 4;
const RETRY_429_MAX_WAIT_MS = 60_000;
/**
 * A 429 whose body names a per-day quota (`quotaId` like
 * `GenerateRequestsPerDayPerProjectPerModel-FreeTier`) or says "per day".
 */
const DAILY_QUOTA_RE = /PerDay|per day|daily/i;

/** True when a Gemini 429 body says the DAILY quota is exhausted. */
export function isGeminiDailyQuota429(body: unknown): boolean {
  if (body === null || typeof body !== "object") return false;
  const err = (body as { error?: unknown }).error;
  if (err === null || typeof err !== "object") return false;
  const { message, details } = err as { message?: unknown; details?: unknown };
  if (typeof message === "string" && DAILY_QUOTA_RE.test(message)) return true;
  if (!Array.isArray(details)) return false;
  for (const d of details) {
    if (d === null || typeof d !== "object") continue;
    const violations = (d as { violations?: unknown }).violations;
    if (!Array.isArray(violations)) continue;
    for (const v of violations) {
      if (v === null || typeof v !== "object") continue;
      const { quotaId, quotaMetric } = v as { quotaId?: unknown; quotaMetric?: unknown };
      if (typeof quotaId === "string" && DAILY_QUOTA_RE.test(quotaId)) return true;
      if (typeof quotaMetric === "string" && DAILY_QUOTA_RE.test(quotaMetric)) return true;
    }
  }
  return false;
}

export interface GeminiConfig {
  enabled?: boolean;
  batchSize?: number;
  model?: string;
  temperature?: number;
  timeoutSeconds?: number;
  /** Requests per minute to pace to; unset/0 = no pacing (the class default). */
  rateLimitRpm?: number;
}

export interface GeminiDeps {
  fetchImpl: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  logger?: { warn: (msg: string) => void };
  /** Test seam matching Python's `patch("paperpilot.llm.gemini_provider.request_with_retry", ...)`. */
  requestWithRetryFn?: typeof requestWithRetry;
}

export class GeminiProvider implements LLMProvider {
  readonly name = "gemini";
  batchSize: number;
  readonly model: string;
  private readonly temperature: number;
  private readonly timeoutSeconds: number;
  private readonly apiKey: string | null;
  private _enabledFlag: boolean;
  private readonly deps: GeminiDeps;
  private readonly minCallIntervalMs: number;
  private lastCallTs: number | null = null;
  private consecutiveFailures = 0;
  private consecutive429 = 0;
  private readonly stats: LlmUsageStats & { rateLimited: number; pacingWaitMs: number } = {
    calls: 0,
    ok: 0,
    failed: 0,
    latched: false,
    latchReason: null,
    dailyLimitHit: false,
    rateLimited: 0,
    pacingWaitMs: 0,
  };

  constructor(config: GeminiConfig, apiKey: string | null, deps: GeminiDeps) {
    this._enabledFlag = config.enabled ?? true;
    this.apiKey = apiKey;
    this.batchSize = config.batchSize ?? 5;
    this.model = config.model ?? GEMINI_DEFAULT_MODEL;
    this.temperature = config.temperature ?? 0.2;
    this.timeoutSeconds = config.timeoutSeconds ?? 60;
    const rpm = config.rateLimitRpm;
    this.minCallIntervalMs =
      rpm !== undefined && Number.isFinite(rpm) && rpm > 0 ? (60 / rpm) * 1000 : 0;
    this.deps = deps;
  }

  /** Snapshot of the call counters (see `LlmUsageStats`). */
  usageStats(): LlmUsageStats & { rateLimited: number; pacingWaitMs: number } {
    return { ...this.stats };
  }

  /** True once the breaker latched: every further call returns null without an API call. */
  isExhausted(): boolean {
    return this.stats.latched;
  }

  /** Concise end-of-run usage line, same shape as Groq's. */
  usageSummary(): string {
    const st = this.stats;
    return (
      `gemini summary: model=${this.model}, calls=${st.calls} (ok=${st.ok}, failed=${st.failed}), ` +
      `429s=${st.rateLimited}, pacing_wait=${(st.pacingWaitMs / 1000).toFixed(1)}s, ` +
      `latched=${st.latched ? `yes (${st.latchReason})` : "no"}`
    );
  }

  private latch(reason: string): void {
    if (this.stats.latched) return;
    this.stats.latched = true;
    this.stats.latchReason = reason;
    this.deps.logger?.warn(
      `gemini: ${reason} — latching; no further Gemini calls for the rest of this run`,
    );
  }

  private recordFailure(): void {
    this.stats.failed += 1;
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= FAILURE_LATCH_THRESHOLD) {
      this.latch(
        `${this.consecutiveFailures} consecutive unusable responses (non-200, non-JSON or empty)`,
      );
    }
  }

  private async record429(resp: HttpResponseLike): Promise<void> {
    this.stats.failed += 1;
    this.stats.rateLimited += 1;
    let body: unknown;
    try {
      body = await resp.json();
    } catch {
      body = undefined;
    }
    if (isGeminiDailyQuota429(body)) {
      this.stats.dailyLimitHit = true;
      this.latch("daily rate limit exhausted (429 RESOURCE_EXHAUSTED, per-day quota)");
      return;
    }
    this.consecutive429 += 1;
    if (this.consecutive429 >= PERSISTENT_429_THRESHOLD) {
      this.latch(`${this.consecutive429} consecutive calls still 429 after retries`);
    }
  }

  /** Keep consecutive calls at least `60/rpm` seconds apart (no-op when unpaced). */
  private async pace(): Promise<void> {
    if (this.minCallIntervalMs <= 0) return;
    const now = this.deps.now ?? (() => performance.now());
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    if (this.lastCallTs !== null) {
      const wait = this.minCallIntervalMs - (now() - this.lastCallTs);
      if (wait > 0) {
        await sleep(wait);
        this.stats.pacingWaitMs += wait;
      }
    }
    this.lastCallTs = now();
  }

  /** Disabled automatically when the API key is missing. */
  get enabled(): boolean {
    return this._enabledFlag && !!this.apiKey;
  }
  set enabled(value: boolean) {
    this._enabledFlag = value;
  }

  async evaluateBatch(
    papers: readonly Paper[],
    profile: string,
  ): Promise<(PaperEvaluation | null)[]> {
    if (papers.length === 0) return [];
    const [system, user] = buildEvaluationPrompt(papers, profile);
    const text = await this.generate(system, user);
    if (text === null) return new Array(papers.length).fill(null);
    const parsed = parseLlmResponse(text);
    if (!Array.isArray(parsed)) {
      this.deps.logger?.warn(
        `gemini: response was not a JSON array (type=${parsed === null ? "null" : typeof parsed})`,
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
    // `responseMimeType: application/json` already forces valid JSON;
    // buildClassifyPrompt asks for a single object, which parseLlmResponse
    // handles via its object-extraction fallback.
    const text = await this.generate(system, user);
    if (text === null) return null;
    const parsed = parseLlmResponse(text);
    return relationClassificationFromDict(parsed);
  }

  async completeJson(system: string, user: string): Promise<string | null> {
    // `responseMimeType: application/json` is always set by `generate`, so
    // there is no separate json-mode flag to pass here.
    return this.generate(system, user);
  }

  async chat(system: string, user: string): Promise<string | null> {
    return this.generate(system, user);
  }

  // ---- helpers ----

  private async generate(system: string, user: string): Promise<string | null> {
    if (this.stats.latched) return null;
    await this.pace();
    this.stats.calls += 1;
    const url = `${GEMINI_BASE}/${this.model}:generateContent`;
    const body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: {
        temperature: this.temperature,
        responseMimeType: "application/json",
      },
    };
    // API key goes in the x-goog-api-key header, not a query param, so it
    // never lands in proxy / server access logs.
    const resp: HttpResponseLike | null = await (this.deps.requestWithRetryFn ?? requestWithRetry)(
      {
        method: "POST",
        url,
        headers: { "x-goog-api-key": this.apiKey ?? "" },
        jsonBody: body,
        timeoutMs: this.timeoutSeconds * 1000,
        overallDeadlineMs:
          this.timeoutSeconds * 1000 * (RETRY_429_MAX + 1) + RETRY_429_MAX_WAIT_MS * RETRY_429_MAX,
        retry429: {
          maxRetries: RETRY_429_MAX,
          maxWaitMs: RETRY_429_MAX_WAIT_MS,
          // A per-day quota will not clear within the run: stop now.
          giveUpOnBody: isGeminiDailyQuota429,
        },
      },
      {
        fetchImpl: this.deps.fetchImpl,
        sleep: this.deps.sleep,
        now: this.deps.now,
        logger: this.deps.logger,
        onRetry: (ev) => {
          if (ev.status === 429) this.stats.rateLimited += 1;
        },
      },
    );
    if (resp !== null && resp.status === 429) {
      this.deps.logger?.warn("gemini: generateContent failed (status=429)");
      await this.record429(resp);
      return null;
    }
    if (resp === null || resp.status !== 200) {
      this.deps.logger?.warn(`gemini: generateContent failed (status=${resp?.status ?? "null"})`);
      this.recordFailure();
      return null;
    }
    const data = await safeJsonResponse(resp);
    if (data === null) {
      this.deps.logger?.warn("gemini: generateContent response was not valid JSON");
      this.recordFailure();
      return null;
    }
    const candidates = data.candidates;
    if (!Array.isArray(candidates) || candidates.length === 0) {
      this.deps.logger?.warn("gemini: empty/invalid candidates in response");
      this.recordFailure();
      return null;
    }
    const firstCandidate = candidates[0];
    const contentObj =
      firstCandidate !== null && typeof firstCandidate === "object"
        ? (firstCandidate as Record<string, unknown>).content
        : null;
    const parts =
      contentObj !== null && typeof contentObj === "object"
        ? (contentObj as Record<string, unknown>).parts
        : null;
    const firstPart = Array.isArray(parts) && parts.length > 0 ? parts[0] : null;
    const text =
      firstPart !== null && typeof firstPart === "object"
        ? (firstPart as Record<string, unknown>).text
        : null;
    if (!(typeof text === "string" && text.trim())) {
      this.recordFailure();
      return null;
    }
    this.consecutiveFailures = 0;
    this.consecutive429 = 0;
    this.stats.ok += 1;
    return text;
  }
}
