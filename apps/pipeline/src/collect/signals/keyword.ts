/**
 * Keyword match signal — TS port of `paperpilot/signals/keyword_signal.py`.
 *
 * Normalization: `score = min(matchCount / 3, 1) * 100`, where `matchCount`
 * is the number of distinct keywords appearing in the title or abstract (a
 * keyword found in both counts once). Matching is case-insensitive and
 * hyphen-insensitive.
 */

import { pySortedStrings } from "@paperpilot/core/pycompat";
import type { Paper } from "../model/paper.js";
import { BaseSignal } from "./signal.js";

const SATURATION = 3;

/** Lowercase + collapse hyphens/underscores/slashes to spaces. */
export function normalize(text: string): string {
  return text.toLowerCase().replace(/[-_/]+/g, " ");
}

export class KeywordSignal extends BaseSignal {
  readonly name = "keyword";
  private readonly keywords: string[];

  constructor(config: { enabled?: boolean } = {}, keywords: readonly string[] = []) {
    super(config);
    this.keywords = keywords
      .map((k) => k.trim())
      .filter((k) => k.length > 0)
      .map(normalize);
  }

  enrichOne(paper: Paper): Paper {
    if (this.keywords.length === 0) return paper;

    const haystack = normalize(`${paper.title}\n${paper.abstract}`);
    const matched = new Set(paper.matchedKeywords);
    let matchCount = 0;
    for (const kw of this.keywords) {
      if (haystack.includes(kw)) {
        matchCount += 1;
        matched.add(kw);
      }
    }

    paper.keywordMatchCount = matchCount;
    paper.keywordScore = Math.min(matchCount / SATURATION, 1.0) * 100.0;
    paper.matchedKeywords = pySortedStrings([...matched]);
    return paper;
  }
}
