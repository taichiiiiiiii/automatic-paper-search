/**
 * Stage 4: LLM rerank + Japanese summary — TS port of
 * `paperpilot/pipeline/stage_llm_rank.py` (COL-31 of
 * docs/migration/safety-contracts.md).
 *
 * Input: top-N papers from Stage 2/3. If the provider is null or disabled,
 * this stage is a no-op pass-through (still truncated to `topN` — real
 * providers are P4d; the interface is defined in `llm/provider.ts`).
 */

import type { LLMProvider, PaperEvaluation } from "../llm/provider.js";
import type { Paper } from "../model/paper.js";

export interface LlmRerankParams {
  provider: LLMProvider | null;
  profile: string;
  topN: number;
  logger?: { info: (msg: string) => void; warn: (msg: string) => void };
}

function apply(paper: Paper, evaluation: PaperEvaluation | null): void {
  if (evaluation === null) return;
  paper.llmRelevance = evaluation.relevance;
  paper.llmSummaryJa = evaluation.summaryJa || null;
  paper.llmReason = evaluation.reason || null;
  paper.llmTags = evaluation.tags;
}

export async function llmRerank(papers: Paper[], params: LlmRerankParams): Promise<Paper[]> {
  if (papers.length === 0) return [];
  const provider = params.provider;
  if (provider === null || !provider.enabled) {
    params.logger?.info("stage4: LLM provider disabled — pass-through");
    return params.topN > 0 ? papers.slice(0, params.topN) : papers;
  }

  const batchSize = Math.max(1, provider.batchSize);
  for (let start = 0; start < papers.length; start += batchSize) {
    const chunk = papers.slice(start, start + batchSize);
    let results: (PaperEvaluation | null)[];
    try {
      results = await provider.evaluateBatch(chunk, params.profile);
    } catch (e) {
      params.logger?.warn(`stage4: provider '${provider.name}' raised: ${(e as Error).message}`);
      results = chunk.map(() => null);
    }
    for (let i = 0; i < chunk.length; i++) {
      apply(chunk[i] as Paper, results[i] ?? null);
    }
  }

  // Sort: evaluated (relevance high -> low) first, then total_score.
  const key = (p: Paper): [number, number, number] => {
    const hasRel = p.llmRelevance !== null;
    const rel = hasRel ? (p.llmRelevance as number) : 0;
    return [hasRel ? 1 : 0, rel, p.totalScore];
  };
  const sorted = [...papers].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) {
      const diff = (kb[i] as number) - (ka[i] as number);
      if (diff !== 0) return diff;
    }
    return 0;
  });
  const out = params.topN > 0 ? sorted.slice(0, params.topN) : sorted;
  params.logger?.info(`stage4: kept top ${out.length} papers`);
  return out;
}
