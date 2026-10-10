/**
 * LLM provider abstraction — TS interface for
 * `paperpilot/llm/base.py::AbstractLLMProvider`/`PaperEvaluation`/
 * `RelationClassification`.
 *
 * Concrete providers (Ollama/Gemini/Claude/Groq) and the validation helpers
 * (`PaperEvaluation.from_dict`/`map_batch_evaluations`/
 * `RelationClassification.from_dict`) live under `apps/pipeline/src/lineage/
 * llm/` (P4d) — this file stays the thin, stable interface every one of them
 * implements, plus the `RelationClassification` shape, so lineage code never
 * has to import from `apps/pipeline/src/lineage/**` (no cycle: lineage/*
 * imports from collect/llm, never the reverse).
 *
 * `chat()` REPLACES Python's `_chat`/`_messages`/`_generate` duck-typed
 * probe (`keyword_expand.py::_call_provider`) with a single named method —
 * documented adaptation, not a parity gap: every current/future provider
 * implements one common interface instead of being duck-typed by whichever
 * private method name it happens to expose.
 *
 * `classifyRelation`/`completeJson` are REQUIRED members (not optional) —
 * the TS analogue of LLM-01 (ABC forces `evaluate_batch`): every provider
 * must be total over the interface. Providers that don't support lineage
 * classification (Claude/Ollama, matching Python's `ClaudeProvider`/
 * `OllamaProvider`, which don't override the base class) implement
 * `classifyRelation` as a trivial `async () => null` (LLM-04) and inherit-
 * equivalent `completeJson` by throwing the same "no JSON-mode completion"
 * message `AbstractLLMProvider.complete_json` raises (LLM-02) — there is no
 * TS abstract-base-class default here because this codebase's Source/Signal
 * ports already favor "small interface + concrete classes", not inheritance
 * (see `collect/sources/source.ts`).
 */

import type { Paper } from "../model/paper.js";

export interface PaperEvaluation {
  /** 1 (irrelevant) .. 5 (must-read). */
  relevance: number;
  summaryJa: string;
  reason: string;
  tags: string[];
}

/**
 * Closed enum of valid lineage relations (design doc §5.5 / `llm/base.py`
 * `_VALID_RELATIONS`). `"unrelated"` is a valid classification value but is
 * always filtered out of the final edge set by the caller.
 */
export type Relation =
  | "supersedes"
  | "successor"
  | "extends"
  | "ablation"
  | "baseline_only"
  | "contrasts"
  | "unrelated";

/** TS port of `paperpilot/llm/base.py::RelationClassification`. */
export interface RelationClassification {
  relation: Relation;
  /** 0.0 .. 1.0. */
  confidence: number;
  /** One short Japanese sentence (never empty — see `RelationClassification.from_dict`). */
  rationale: string;
}

/**
 * Loose, dict-shaped paper representation `classifyRelation` compares —
 * mirrors Python's `classify_relation(a: dict, b: dict)`, which is called
 * with plain S2/OpenAlex-shaped dicts, never a full `Paper`. `year`/
 * `abstract` are read with "absent -> '?'/''" vs "present-but-null ->
 * literal 'None'" Python `dict.get(key, default)` semantics — see
 * `lineage/llm/base.ts`'s `buildClassifyPrompt`.
 */
export type ClassifyPaperLike = Record<string, unknown>;

export interface LLMProvider {
  readonly name: string;
  enabled: boolean;
  batchSize: number;
  /** Absent on the abstract base / providers with no concrete model (e.g. a future provider). */
  readonly model?: string;
  evaluateBatch(papers: readonly Paper[], profile: string): Promise<(PaperEvaluation | null)[]>;
  /** Used by `keywordExpand.ts`'s synonym-expansion call. */
  chat(system: string, user: string): Promise<string | null>;
  /**
   * Classify how paper `b` relates to paper `a`. Providers that don't
   * support lineage classification return `null` (LLM-04) — the caller
   * then falls back to the heuristic / drops the edge, never fabricates one.
   */
  classifyRelation(
    a: ClassifyPaperLike,
    b: ClassifyPaperLike,
  ): Promise<RelationClassification | null>;
  /**
   * Return the model's RAW response text for a single-JSON-object prompt,
   * or `null` on failure. Providers without a JSON-mode single-shot
   * completion throw (LLM-02) — mirrors `AbstractLLMProvider.complete_json`'s
   * `NotImplementedError`, which exists so a deep-lineage builder reaching a
   * provider without this capability fails loudly instead of silently
   * classifying nothing.
   */
  completeJson(system: string, user: string): Promise<string | null>;
  /**
   * Optional one-line end-of-run usage summary (calls, rate-limit waits,
   * breaker state) for CI logs. Providers without counters omit it.
   */
  usageSummary?(): string;
}
