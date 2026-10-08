/**
 * Gemini LLM provider — TS port of `paperpilot/llm/gemini_provider.py`.
 *
 * Uses the REST `generateContent` endpoint with
 * `responseMimeType=application/json` so the model returns parseable JSON
 * (the 3-step `parse_llm_response` fallback still runs for resilience).
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

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_MODEL = "gemini-1.5-flash";

export interface GeminiConfig {
  enabled?: boolean;
  batchSize?: number;
  model?: string;
  temperature?: number;
  timeoutSeconds?: number;
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

  constructor(config: GeminiConfig, apiKey: string | null, deps: GeminiDeps) {
    this._enabledFlag = config.enabled ?? true;
    this.apiKey = apiKey;
    this.batchSize = config.batchSize ?? 5;
    this.model = config.model ?? DEFAULT_MODEL;
    this.temperature = config.temperature ?? 0.2;
    this.timeoutSeconds = config.timeoutSeconds ?? 60;
    this.deps = deps;
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
      },
      {
        fetchImpl: this.deps.fetchImpl,
        sleep: this.deps.sleep,
        now: this.deps.now,
        logger: this.deps.logger,
      },
    );
    if (resp === null || resp.status !== 200) {
      this.deps.logger?.warn(`gemini: generateContent failed (status=${resp?.status ?? "null"})`);
      return null;
    }
    const data = await safeJsonResponse(resp);
    if (data === null) {
      this.deps.logger?.warn("gemini: generateContent response was not valid JSON");
      return null;
    }
    const candidates = data.candidates;
    if (!Array.isArray(candidates) || candidates.length === 0) {
      this.deps.logger?.warn("gemini: empty/invalid candidates in response");
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
    if (!Array.isArray(parts) || parts.length === 0) return null;
    const firstPart = parts[0];
    const text =
      firstPart !== null && typeof firstPart === "object"
        ? (firstPart as Record<string, unknown>).text
        : null;
    return typeof text === "string" && text.trim() ? text : null;
  }
}
