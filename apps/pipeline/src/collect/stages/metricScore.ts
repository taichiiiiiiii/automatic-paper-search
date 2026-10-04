/**
 * Stage 2: enrich with signals, compute total_score, keep top N — TS port
 * of `paperpilot/pipeline/stage_metric_score.py` (COL-27 of
 * docs/migration/safety-contracts.md).
 *
 * `total_score = sum(signal_score * weight)` for each enabled signal. All
 * signal scores are normalized to [0, 100]. Signal degradation never
 * changes the return value: it is reported through each signal's
 * `runFailures` channel, which the runner reads after this stage returns.
 */

import type { Paper } from "../model/paper.js";
import type { Signal } from "../signals/signal.js";

export interface MetricScoreWeights {
  venue?: number;
  github?: number;
  citation?: number;
  author?: number;
  keyword?: number;
  follow?: number;
}

export interface MetricScoreParams {
  signals: readonly Signal[];
  weights: MetricScoreWeights;
  topN: number;
  requireFollowMatch?: boolean;
  logger?: { info: (msg: string) => void; warn: (msg: string) => void };
}

export async function metricScore(papers: Paper[], params: MetricScoreParams): Promise<Paper[]> {
  if (papers.length === 0) return [];
  let working = papers;

  for (const sig of params.signals) {
    if (!sig.enabled) continue;
    try {
      working = await sig.enrichBatch(working);
      params.logger?.info(`stage2: signal '${sig.name}' enriched ${working.length} papers`);
    } catch (e) {
      const err = e as Error;
      params.logger?.warn(`stage2: signal '${sig.name}' failed: ${err.message}`);
      // The crash is itself a degraded run: record it on the signal's
      // per-run channel so the runner can surface it in run_history
      // without Stage 2 gaining a second return type.
      sig.runFailures.push(`enrich_batch raised ${err.name}: ${err.message}`);
    }
  }

  const w = params.weights;
  for (const p of working) {
    p.totalScore =
      p.venueScore * (w.venue ?? 0.0) +
      p.githubScore * (w.github ?? 0.0) +
      p.citationScore * (w.citation ?? 0.0) +
      p.authorScore * (w.author ?? 0.0) +
      p.keywordScore * (w.keyword ?? 0.0) +
      p.followScore * (w.follow ?? 0.0);
  }

  if (params.requireFollowMatch) {
    const before = working.length;
    working = working.filter((p) => p.followScore > 0);
    params.logger?.info(`stage2: require_follow_match kept ${working.length}/${before} papers`);
  }

  working = [...working].sort((a, b) => b.totalScore - a.totalScore);
  const top = params.topN > 0 ? working.slice(0, params.topN) : working;
  params.logger?.info(`stage2: kept top ${top.length} papers`);
  return top;
}
