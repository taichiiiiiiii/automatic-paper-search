/**
 * Stage 1: pure rule-based filtering (no scoring) — TS port of
 * `paperpilot/pipeline/stage_rule_filter.py`.
 *
 * Filters applied, in order:
 *   1. category — keep only papers with >= 1 configured category (papers
 *      with no categories at all, e.g. from S2/OpenAlex, always pass)
 *   2. date     — keep only papers with publishedDate >= sinceDate
 *   3. exclude  — drop if any exclude word appears in title/abstract/comment
 *   4. seenIds  — drop papers already seen in prior runs (incremental mode)
 */

import type { Paper } from "../model/paper.js";
import { filterUnseen } from "../state/seenIds.js";

export interface RuleFilterParams {
  excludeWords: readonly string[];
  categories: readonly string[];
  /** ISO `YYYY-MM-DD`, or omit/null to skip the date filter. */
  sinceDate?: string | null;
  seenIds?: Readonly<Record<string, string>> | null;
}

export function ruleFilter(papers: readonly Paper[], params: RuleFilterParams): Paper[] {
  const excludesLower = params.excludeWords
    .map((w) => w.toLowerCase().trim())
    .filter((w) => w.length > 0);
  const catSet = new Set(params.categories.map((c) => c.trim()).filter((c) => c.length > 0));

  const passes = (p: Paper): boolean => {
    if (catSet.size > 0 && p.categories.length > 0) {
      const hit = p.categories.some((c) => catSet.has(c));
      if (!hit) return false;
    }
    if (params.sinceDate != null && p.publishedDate < params.sinceDate) return false;
    const text = `${p.title}\n${p.abstract}\n${p.comment ?? ""}`.toLowerCase();
    return !excludesLower.some((w) => text.includes(w));
  };

  let kept = papers.filter(passes);

  if (params.seenIds) {
    kept = filterUnseen(kept, params.seenIds);
  }

  return kept;
}
