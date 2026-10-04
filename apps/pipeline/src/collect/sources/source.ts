/**
 * Source plugin contract — TS port of `paperpilot/sources/base.py::AbstractSource`.
 *
 * Per the migration design doc §6 COL-08 suggestion, `fetch()` returns its
 * completeness report (`truncatedKeywords` / `degradedKeywords`) IN the
 * result rather than as mutable instance attributes a caller reads
 * afterward — this removes the whole "stale entry from the previous run"
 * failure mode COL-08 exists to prevent by construction (there is no
 * instance state to go stale). `CompletenessAdapter` below is a thin
 * stateful wrapper for any call site that still wants the Python shape
 * (e.g. a future runner port copied mechanically from `runner.py`).
 */

import type { Paper } from "../model/paper.js";

/** `(keyword, reason)` — same shape as the Python `degraded_keywords` list of tuples. */
export type DegradedKeyword = readonly [keyword: string, reason: string];

export interface FetchResult {
  papers: Paper[];
  /** Keywords whose fetch filled the whole requested window/page — more matches may exist beyond it. Not an error. */
  truncatedKeywords: string[];
  /** Keywords whose fetch is known INCOMPLETE (request failed, body unreadable, or some items unreadable). */
  degradedKeywords: DegradedKeyword[];
}

/**
 * Raised when every keyword failed — an outage, not "genuinely 0 new papers
 * today" (COL-07). Carries the completeness report so a catcher does not
 * lose `degradedKeywords`' reasons the way a bare `Error` would.
 */
export class AllKeywordsFailedError extends Error {
  readonly truncatedKeywords: string[];
  readonly degradedKeywords: DegradedKeyword[];

  constructor(
    message: string,
    report: { truncatedKeywords: string[]; degradedKeywords: DegradedKeyword[] },
  ) {
    super(message);
    this.name = "AllKeywordsFailedError";
    this.truncatedKeywords = report.truncatedKeywords;
    this.degradedKeywords = report.degradedKeywords;
  }
}

export interface FetchParams {
  keywords: string[];
  categories: string[];
  /** ISO date string `YYYY-MM-DD`. */
  sinceDate: string;
  maxResults: number;
}

export interface Source {
  readonly name: string;
  fetch(params: FetchParams): Promise<FetchResult>;
}

/**
 * Optional adapter back to the Python shape (mutable `truncatedKeywords`/
 * `degradedKeywords` read after `fetch()` returns or throws), for any
 * future caller ported mechanically from `pipeline/runner.py`'s attribute
 * reads. Prefer reading `FetchResult` / `AllKeywordsFailedError` directly
 * in new code.
 */
export class CompletenessAdapter {
  truncatedKeywords: string[] = [];
  degradedKeywords: DegradedKeyword[] = [];

  constructor(private readonly source: Source) {}

  get name(): string {
    return this.source.name;
  }

  async fetch(params: FetchParams): Promise<Paper[]> {
    try {
      const result = await this.source.fetch(params);
      this.truncatedKeywords = result.truncatedKeywords;
      this.degradedKeywords = result.degradedKeywords;
      return result.papers;
    } catch (e) {
      if (e instanceof AllKeywordsFailedError) {
        this.truncatedKeywords = e.truncatedKeywords;
        this.degradedKeywords = e.degradedKeywords;
      }
      throw e;
    }
  }
}
