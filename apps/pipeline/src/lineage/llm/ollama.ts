/**
 * Ollama LLM provider — TS port of `paperpilot/llm/ollama_provider.py`.
 *
 * Local, free, spec-mentioned fallback. Uses Ollama's `/api/chat` endpoint
 * with `format=json`. No API key — `enabled` is a plain config flag
 * (matches Python: `OllamaProvider` never overrides `enabled`).
 *
 * Does not support lineage classification (Python never overrides
 * `classify_relation`/`complete_json` on this provider either).
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

const DEFAULT_HOST = "http://localhost:11434";
const DEFAULT_MODEL = "qwen2.5:7b";

export interface OllamaConfig {
  enabled?: boolean;
  batchSize?: number;
  host?: string;
  model?: string;
  temperature?: number;
  timeoutSeconds?: number;
}

export interface OllamaDeps {
  fetchImpl: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  logger?: { warn: (msg: string) => void };
  /** Test seam matching Python's `patch("paperpilot.llm.ollama_provider.request_with_retry", ...)`. */
  requestWithRetryFn?: typeof requestWithRetry;
}

export class OllamaProvider implements LLMProvider {
  readonly name = "ollama";
  enabled: boolean;
  batchSize: number;
  readonly model: string;
  private readonly host: string;
  private readonly temperature: number;
  private readonly timeoutSeconds: number;
  private readonly deps: OllamaDeps;

  constructor(config: OllamaConfig, deps: OllamaDeps) {
    this.enabled = config.enabled ?? true;
    this.batchSize = config.batchSize ?? 5;
    this.host = (config.host ?? DEFAULT_HOST).replace(/\/+$/, "");
    this.model = config.model ?? DEFAULT_MODEL;
    this.temperature = config.temperature ?? 0.2;
    this.timeoutSeconds = config.timeoutSeconds ?? 60;
    this.deps = deps;
  }

  async evaluateBatch(
    papers: readonly Paper[],
    profile: string,
  ): Promise<(PaperEvaluation | null)[]> {
    if (papers.length === 0) return [];
    const [system, user] = buildEvaluationPrompt(papers, profile);
    const text = await this.chatRaw(system, user);
    if (text === null) return new Array(papers.length).fill(null);
    const parsed = parseLlmResponse(text);
    if (!Array.isArray(parsed)) {
      this.deps.logger?.warn(
        `ollama: response was not a JSON array (type=${parsed === null ? "null" : typeof parsed})`,
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
      "OllamaProvider has no JSON-mode completion; it cannot be used for deep lineage classification.",
    );
  }

  async chat(system: string, user: string): Promise<string | null> {
    return this.chatRaw(system, user);
  }

  // ---- helpers ----

  private async chatRaw(system: string, user: string): Promise<string | null> {
    const url = `${this.host}/api/chat`;
    const body = {
      model: this.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      stream: false,
      format: "json",
      options: { temperature: this.temperature },
    };
    const resp: HttpResponseLike | null = await (this.deps.requestWithRetryFn ?? requestWithRetry)(
      { method: "POST", url, jsonBody: body, timeoutMs: this.timeoutSeconds * 1000 },
      {
        fetchImpl: this.deps.fetchImpl,
        sleep: this.deps.sleep,
        now: this.deps.now,
        logger: this.deps.logger,
      },
    );
    if (resp === null || resp.status !== 200) {
      this.deps.logger?.warn(`ollama: /api/chat failed (status=${resp?.status ?? "null"})`);
      return null;
    }
    const data = await safeJsonResponse(resp);
    if (data === null) {
      this.deps.logger?.warn("ollama: /api/chat response was not valid JSON");
      return null;
    }
    const message = data.message;
    const content =
      message !== null && typeof message === "object"
        ? (message as Record<string, unknown>).content
        : null;
    if (!(typeof content === "string" && content.trim())) {
      this.deps.logger?.warn("ollama: empty response body");
      return null;
    }
    return content;
  }
}
