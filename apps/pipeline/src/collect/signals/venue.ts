/**
 * Venue signal: detects conference acceptance from the arXiv comment field
 * — TS port of `paperpilot/signals/venue_signal.py`.
 *
 * Tier system (CLAUDE.md "スコアリング" table):
 *   Tier 1 (NeurIPS/ICML/ICLR)         -> 100 pts
 *   Tier 2 (AAAI/CVPR/ACL/EMNLP)       ->  80 pts
 *   Tier 3 (AISTATS/NAACL/ECCV/ICCV)   ->  60 pts
 *   Workshop                            ->  30 pts (tier=4)
 *   Unreviewed                          ->   0 pts (tier=0)
 */

import type { Paper } from "../model/paper.js";
import { BaseSignal } from "./signal.js";

const TIER_1 = new Set(["NEURIPS", "NIPS", "ICML", "ICLR"]);
const TIER_2 = new Set(["AAAI", "CVPR", "ACL", "EMNLP"]);
const TIER_3 = new Set(["AISTATS", "NAACL", "ECCV", "ICCV", "IJCAI", "KDD", "WWW"]);

const VENUE_PATTERN =
  /\b(?:accepted (?:at|to|by)|to appear (?:at|in)|published (?:at|in))\s+(?:the\s+)?([A-Za-z]+)/i;
const WORKSHOP_PATTERN = /\bworkshop\b/i;

export type VenueClassification = readonly [venue: string | null, tier: number, score: number];

export class VenueSignal extends BaseSignal {
  readonly name = "venue";

  enrichOne(paper: Paper): Paper {
    const comment = (paper.comment ?? "").trim();
    if (!comment) return paper;

    const [venue, tier, score] = VenueSignal.classify(comment);
    if (venue) {
      paper.venue = venue;
      paper.venueTier = tier;
      paper.venueScore = score;
    }
    return paper;
  }

  static classify(text: string): VenueClassification {
    const isWorkshop = WORKSHOP_PATTERN.test(text);

    const match = VENUE_PATTERN.exec(text);
    let venueName: string | null = null;
    if (match?.[1]) {
      const candidate = match[1].toUpperCase();
      const tiers: readonly [Set<string>, number, number][] = [
        [TIER_1, 1, 100],
        [TIER_2, 2, 80],
        [TIER_3, 3, 60],
      ];
      for (const [tierSet, tier, score] of tiers) {
        if (tierSet.has(candidate)) {
          venueName = candidate;
          if (isWorkshop) return [`${candidate} Workshop`, 4, 30];
          return [candidate, tier, score];
        }
      }
    }

    if (isWorkshop) return ["Workshop", 4, 30];

    return [venueName, 0, 0];
  }
}
