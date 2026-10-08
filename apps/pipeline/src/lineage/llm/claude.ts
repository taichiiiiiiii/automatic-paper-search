/**
 * Claude LLM provider — TS port of `paperpilot/llm/claude_provider.py`.
 *
 * Uses the direct `/v1/messages` HTTP endpoint. Claude exposes no JSON-only
 * output mode, so this relies on the structured system prompt plus the
 * 3-step `parse_llm_response` fallback.
 *
 * Does not support lineage classification (matches Python: `ClaudeProvider`
 * never overrides `classify_relation`/`complete_json`) — `classifyRelation`
 * returns `null` (LLM-04) and `completeJson` throws (LLM-02).
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
import { buildEvaluationPrompt, mapBatchEvaluations, safeJsonResponse } from "./base.js";

const CLAUDE_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MODEL = "claude-sonnet-4-20250514";

export interface ClaudeConfig {
  enabled?: boolean;
  batchSize?: number;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutSeconds?: number;
}

export interface ClaudeDeps {
  fetchImpl: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  logger?: { warn: (msg: string) => void };
  /** Test seam matching Python's `patch("paperpilot.llm.claude_provider.request_with_retry", ...)`. */
  requestWithRetryFn?: typeof requestWithRetry;
}

export class ClaudeProvider implements LLMProvider {
  readonly name = "claude";
  batchSize: number;
  readonly model: string;
  private readonly temperature: number;
  private readonly maxTokens: number;
  private readonly timeoutSeconds: number;
  private readonly apiKey: string | null;
  private _enabledFlag: boolean;
  private readonly deps: ClaudeDeps;

  constructor(config: ClaudeConfig, apiKey: string | null, deps: ClaudeDeps) {
    this._enabledFlag = config.enabled ?? true;
    this.apiKey = apiKey;
    this.batchSize = config.batchSize ?? 5;
    this.model = config.model ?? DEFAULT_MODEL;
    this.temperature = config.temperature ?? 0.2;
    this.maxTokens = config.maxTokens ?? 2048;
    this.timeoutSeconds = config.timeoutSeconds ?? 60;
    this.deps = deps;
  }

  /** Auto-disable when the API key is missing. */
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
    const text = await this.messages(system, user);
    if (text === null) return new Array(papers.length).fill(null);
    const parsed = parseLlmResponse(text);
    if (!Array.isArray(parsed)) {
      this.deps.logger?.warn(
        `claude: response was not a JSON array (type=${parsed === null ? "null" : typeof parsed})`,
      );
      return new Array(papers.length).fill(null);
    }
    return mapBatchEvaluations(papers.length, parsed);
  }

  async classifyRelation(
    _a: ClassifyPaperLike,
    _b: ClassifyPaperLike,
  ): Promise<RelationClassification | null> {
    return null;
  }

  async completeJson(_system: string, _user: string): Promise<string | null> {
    throw new Error(
      "ClaudeProvider has no JSON-mode completion; it cannot be used for deep lineage classification.",
    );
  }

  async chat(system: string, user: string): Promise<string | null> {
    return this.messages(system, user);
  }

  // ---- helpers ----

  private async messages(system: string, user: string): Promise<string | null> {
    const body = {
      model: this.model,
      max_tokens: this.maxTokens,
      temperature: this.temperature,
      system,
      messages: [{ role: "user", content: user }],
    };
    // API key goes in the x-api-key header, never the URL / query params.
    const resp: HttpResponseLike | null = await (this.deps.requestWithRetryFn ?? requestWithRetry)(
      {
        method: "POST",
        url: CLAUDE_URL,
        headers: { "x-api-key": this.apiKey ?? "", "anthropic-version": ANTHROPIC_VERSION },
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
      this.deps.logger?.warn(`claude: /v1/messages failed (status=${resp?.status ?? "null"})`);
      return null;
    }
    const data = await safeJsonResponse(resp);
    if (data === null) {
      this.deps.logger?.warn("claude: /v1/messages response was not valid JSON");
      return null;
    }
    const content = data.content;
    if (!Array.isArray(content) || content.length === 0) {
      this.deps.logger?.warn("claude: empty/invalid content array");
      return null;
    }
    // Find the first text block; ignore tool_use / other types.
    for (const part of content) {
      if (
        part !== null &&
        typeof part === "object" &&
        (part as Record<string, unknown>).type === "text"
      ) {
        const text = (part as Record<string, unknown>).text;
        if (typeof text === "string" && text.trim()) return text;
      }
    }
    this.deps.logger?.warn("claude: no text part found in content array");
    return null;
  }
}
