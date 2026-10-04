/**
 * LLM provider abstraction — TS interface stub for
 * `paperpilot/llm/base.py::AbstractLLMProvider`/`PaperEvaluation`.
 *
 * INTENTIONAL SCOPE NARROWING: concrete providers (Ollama/Gemini/Claude/
 * Groq) and `PaperEvaluation.from_dict`/`map_batch_evaluations` validation
 * (used only inside concrete providers' `evaluate_batch`) are P4d, per the
 * task brief ("real providers are P4d; define the interface"). Only the
 * interface shape Stage 4 and `keywordExpand.ts` need is ported here.
 *
 * `chat()` REPLACES Python's `_chat`/`_messages`/`_generate` duck-typed
 * probe (`keyword_expand.py::_call_provider`) with a single named method —
 * documented adaptation, not a parity gap: every current/future provider
 * implements one common interface instead of being duck-typed by whichever
 * private method name it happens to expose.
 */

import type { Paper } from "../model/paper.js";

export interface PaperEvaluation {
  /** 1 (irrelevant) .. 5 (must-read). */
  relevance: number;
  summaryJa: string;
  reason: string;
  tags: string[];
}

export interface LLMProvider {
  readonly name: string;
  enabled: boolean;
  batchSize: number;
  evaluateBatch(papers: readonly Paper[], profile: string): Promise<(PaperEvaluation | null)[]>;
  /** Used by `keywordExpand.ts`'s synonym-expansion call. */
  chat(system: string, user: string): Promise<string | null>;
}
