/**
 * Groq LLM provider — TS port of `paperpilot/llm/groq_provider.py`.
 *
 * OpenAI-compatible Chat Completions API. Covers both LLM use-cases:
 * Stage 4 reranking (`evaluateBatch`) and per-edge lineage relation
 * classification (`classifyRelation`) — Groq's free tier + native JSON
 * mode make it the default lineage-classification backend.
 *
 * Built-in rate limiter (LLM-16/17) + circuit breaker (LLM-18/19) — see
 * `throttleForRateLimit`/`recordFailure` below.
 */

import type { FetchLike, HttpResponseLike } from "../../collect/http/requestWithRetry.js";
import { requestWithRetry } from "../../collect/http/requestWithRetry.js";
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
// After this many consecutive Groq failures, treat the daily/TPM quota as
// exhausted and short-circuit further calls instead of burning a workflow's
// timeout budget rotating through 429-after-retries on every edge.
const QUOTA_EXHAUSTED_THRESHOLD = 3;

export interface GroqConfig {
  enabled?: boolean;
  batchSize?: number;
  model?: string;
  temperature?: number;
  timeoutSeconds?: number;
  rateLimitRpm?: number;
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
  private lastCallTs: number | null = null;
  private consecutiveFailures = 0;
  private quotaExhausted = false;
  private readonly deps: GroqDeps;

  constructor(config: GroqConfig, apiKey: string | null, deps: GroqDeps) {
    this._enabledFlag = config.enabled ?? true;
    this.apiKey = apiKey;
    this.batchSize = config.batchSize ?? 5;
    this.model = config.model ?? DEFAULT_MODEL;
    this.temperature = config.temperature ?? 0.2;
    this.timeoutSeconds = config.timeoutSeconds ?? 60;
    const rpm = config.rateLimitRpm ?? DEFAULT_RATE_LIMIT_RPM;
    // Guard against pathological config values (0 or negative would divide
    // by zero / sleep forever) — LLM-17.
    this.minCallIntervalMs = (rpm > 0 ? 60 / rpm : 60 / DEFAULT_RATE_LIMIT_RPM) * 1000;
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
  private async throttleForRateLimit(): Promise<void> {
    const now = this.deps.now ?? defaultNow;
    const sleep = this.deps.sleep ?? defaultSleep;
    if (this.lastCallTs === null) {
      this.lastCallTs = now();
      return;
    }
    const elapsed = now() - this.lastCallTs;
    const wait = this.minCallIntervalMs - elapsed;
    if (wait > 0) await sleep(wait);
    this.lastCallTs = now();
  }

  /**
   * Increment the consecutive-failure counter and latch the
   * quota-exhausted circuit breaker once it crosses the threshold. Every
   * failure branch in `chatRaw` (non-200, non-JSON/wrong-shape body, empty
   * `choices`, empty/unusable `content`) routes through here.
   */
  private recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= QUOTA_EXHAUSTED_THRESHOLD) {
      this.quotaExhausted = true;
      this.deps.logger?.warn(
        `groq: ${this.consecutiveFailures} consecutive unusable responses (non-200, non-JSON ` +
          "or empty) — latching; quota may be exhausted, short-circuiting further LLM calls " +
          "to heuristic-only for the rest of this run",
      );
    }
  }

  private async chatRaw(system: string, user: string, jsonMode: boolean): Promise<string | null> {
    // Circuit-breaker short-circuit: once the quota-exhausted threshold is
    // hit, every further call returns null without touching the API or
    // sleeping for the RPM throttle.
    if (this.quotaExhausted) return null;
    await this.throttleForRateLimit();

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
      },
      {
        fetchImpl: this.deps.fetchImpl,
        sleep: this.deps.sleep,
        now: this.deps.now,
        logger: this.deps.logger,
      },
    );
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
    // Success — reset the failure counter so a transient blip doesn't latch
    // the circuit breaker open.
    this.consecutiveFailures = 0;
    return content;
  }
}
