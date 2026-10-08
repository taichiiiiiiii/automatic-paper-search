/**
 * Follow signal — highlights papers by specific authors or organizations.
 * TS port of `paperpilot/signals/follow_signal.py`.
 *
 * Scoring: any followed author in `paper.authors` -> 100
 * ("followed_author"); no author match but a followed org substring-matches
 * `paper.affiliations` -> 50 ("followed_org"); otherwise 0.
 */

import type { Paper } from "../model/paper.js";
import { BaseSignal } from "./signal.js";

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

export class FollowSignal extends BaseSignal {
  readonly name = "follow";
  private readonly authorSet: Set<string>;
  private readonly orgsLower: string[];

  constructor(
    config: { enabled?: boolean } = {},
    followAuthors: readonly string[] = [],
    followOrgs: readonly string[] = [],
  ) {
    super(config);
    this.authorSet = new Set(followAuthors.filter(Boolean).map(normalizeName));
    this.orgsLower = followOrgs.map((o) => o.trim().toLowerCase()).filter((o) => o.length > 0);
  }

  enrichOne(paper: Paper): Paper {
    if (this.authorSet.size === 0 && this.orgsLower.length === 0) return paper;

    if (this.authorSet.size > 0) {
      for (const author of paper.authors) {
        if (this.authorSet.has(normalizeName(author))) {
          paper.followScore = 100.0;
          paper.followReason = "followed_author";
          return paper;
        }
      }
    }

    if (this.orgsLower.length > 0 && paper.affiliations.length > 0) {
      for (const aff of paper.affiliations) {
        const affLower = aff.toLowerCase();
        for (const org of this.orgsLower) {
          if (affLower.includes(org)) {
            paper.followScore = 50.0;
            paper.followReason = "followed_org";
            return paper;
          }
        }
      }
    }

    return paper;
  }
}
