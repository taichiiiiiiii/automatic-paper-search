/**
 * Quality-signal plugin contract — TS port of `paperpilot/signals/base.py`.
 *
 * All signals output values normalized to [0, 100]. The pipeline applies
 * configured weights to combine them into total_score.
 *
 * Every signal carries a per-run failure channel (`runFailures`, COL-26). A
 * score of 0.0 is only meaningful if the lookups that would have produced
 * it actually answered, so the signal records the batches/lookups it lost
 * instead of letting an outage look identical to a quiet day. The runner
 * reads the channel after Stage 2 and copies it into `result.errors` and
 * run_history — Stage input/output types stay `Paper[]` (CLAUDE.md absolute
 * rule §4).
 */

import type { Paper } from "../model/paper.js";

export interface Signal {
  readonly name: string;
  enabled: boolean;
  /** One short summary per failed batch/lookup of the most recent run. */
  runFailures: string[];
  resetRunFailures(): void;
  enrichOne(paper: Paper): Paper;
  /** Default: enrich one-by-one. Signals with batch APIs override this. */
  enrichBatch(papers: Paper[]): Paper[] | Promise<Paper[]>;
}

export abstract class BaseSignal implements Signal {
  abstract readonly name: string;
  enabled: boolean;
  runFailures: string[] = [];

  constructor(config: { enabled?: boolean } = {}) {
    this.enabled = config.enabled ?? true;
  }

  /** Opens a fresh failure channel for a new run. */
  resetRunFailures(): void {
    this.runFailures = [];
  }

  enrichBatch(papers: Paper[]): Paper[] | Promise<Paper[]> {
    this.resetRunFailures();
    return papers.map((p) => this.enrichOne(p));
  }

  abstract enrichOne(paper: Paper): Paper;
}
