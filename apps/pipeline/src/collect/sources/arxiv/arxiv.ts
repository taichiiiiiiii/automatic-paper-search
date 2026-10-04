/**
 * arXiv source — TS port of `paperpilot/sources/arxiv_source.py`.
 *
 * No Node arXiv client exists (design doc §6.1), so this fetches and parses
 * the Atom API response itself via `feed.ts`, instead of wrapping the
 * Python `arxiv` package's `Client`. Pagination, the per-keyword
 * malformed/skipped-entry handling (COL-01..04/06), the `since_date`
 * DESC-sort early break, and the truncated-window accounting (COL-09) are
 * all reimplemented directly against `feed.ts`'s per-page result.
 *
 * INTENTIONAL DIFFERENCE from the Python client's own (buggy) pagination:
 * `arxiv` 4.0.1 advances its page offset by the count of entries it could
 * successfully BUILD (`len(feed.results)`), not the count of `<entry>`
 * elements the page actually contained — so a page with one skipped entry
 * makes the next page's `start=` request re-fetch one already-seen entry
 * (documented in `paperpilot/utils/arxiv_feed.py`'s module docstring as
 * "Probe C" / "offset drift"). This port advances by the RAW entry count
 * (good + skipped) instead, which avoids the duplication. This is
 * unobservable from `ArxivSource.fetch()`'s own contract: a keyword with
 * any skipped entry is withdrawn and degraded regardless of how many times
 * a duplicate entry would have been seen, so no test (Python or TS)
 * depends on the buggy offset.
 */

import { RateLimiter } from "../../http/rateLimiter.js";
import { createPaper, type Paper } from "../../model/paper.js";
import { isoDateLess } from "../../pyish.js";
import {
  AllKeywordsFailedError,
  type DegradedKeyword,
  type FetchParams,
  type FetchResult,
  type Source,
} from "../source.js";
import { type ArxivFeedEntry, parseArxivFeed } from "./feed.js";

const ARXIV_QUERY_BASE = "https://export.arxiv.org/api/query";

export interface ArxivTextResponse {
  status: number;
  text(): Promise<string>;
}

export type ArxivFetchText = (url: string) => Promise<ArxivTextResponse>;

export interface ArxivSourceConfig {
  enabled?: boolean;
  /** Seconds between requests (polite pacing). Default 3, matching the Python client's default. */
  delaySeconds?: number;
  /** Results per page. Default 100. Exposed mainly so tests can force multi-page fetches without 100 fixture entries. */
  pageSize?: number;
  /** Retries per page request on a non-200 status or thrown fetch error. Default 3. */
  numRetries?: number;
}

export interface ArxivSourceDeps {
  fetchText: ArxivFetchText;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

class PageFetchError extends Error {}

export class ArxivSource implements Source {
  readonly name = "arxiv";
  private readonly limiter: RateLimiter;
  private readonly pageSize: number;
  private readonly numRetries: number;
  private readonly fetchText: ArxivFetchText;

  constructor(config: ArxivSourceConfig, deps: ArxivSourceDeps) {
    const delay = config.delaySeconds ?? 3;
    this.limiter = new RateLimiter(delay, { now: deps.now, sleep: deps.sleep });
    this.pageSize = config.pageSize ?? 100;
    this.numRetries = config.numRetries ?? 3;
    this.fetchText = deps.fetchText;
  }

  static buildCategoryClause(categories: string[]): string {
    if (categories.length === 0) return "";
    return categories.map((c) => `cat:${c}`).join(" OR ");
  }

  static buildQuery(keyword: string, catClause: string): string {
    const kw = keyword.trim();
    const kwClause = kw.includes(" ") ? `all:"${kw}"` : `all:${kw}`;
    if (catClause) return `(${kwClause}) AND (${catClause})`;
    return kwClause;
  }

  private buildPageUrl(query: string, start: number): string {
    const params = new URLSearchParams({
      search_query: query,
      start: String(start),
      max_results: String(this.pageSize),
      sortBy: "submittedDate",
      sortOrder: "descending",
    });
    return `${ARXIV_QUERY_BASE}?${params.toString()}`;
  }

  /**
   * Fetches one page's body, retrying on failure. The pacing wait happens
   * HERE — once per actual HTTP attempt (first try AND every retry, for
   * every page) — matching the installed `arxiv` package's own
   * `Client.__try_parse_feed`, which enforces `delay_seconds` immediately
   * before every `session.get(...)` call it makes, page or retry alike
   * (M6: a per-keyword wait only throttles the FIRST request of a
   * multi-page or retried fetch, letting every later request on the same
   * keyword go out back-to-back).
   */
  private async fetchPageText(url: string): Promise<string> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.numRetries; attempt++) {
      await this.limiter.wait();
      try {
        const resp = await this.fetchText(url);
        if (resp.status !== 200) {
          throw new PageFetchError(`arxiv page request failed with status ${resp.status}`);
        }
        return await resp.text();
      } catch (e) {
        lastError = e;
      }
    }
    throw lastError instanceof Error ? lastError : new PageFetchError(String(lastError));
  }

  private toPaper(entry: ArxivFeedEntry, matchedKeyword: string): Paper {
    const shortId = entry.entryId.split("arxiv.org/abs/").pop() ?? entry.entryId;
    const arxivId = shortId.split("v")[0] ?? shortId;
    return createPaper({
      title: entry.title,
      authors: entry.authors.map((a) => a.name),
      abstract: entry.summary.trim(),
      url: entry.entryId,
      publishedDate: entry.publishedDate,
      source: "arxiv",
      arxivId,
      doi: entry.doi,
      pdfUrl: entry.pdfUrl,
      categories: entry.categories,
      comment: entry.comment,
      matchedKeywords: [matchedKeyword],
    });
  }

  async fetch(params: FetchParams): Promise<FetchResult> {
    const { keywords, categories, sinceDate, maxResults } = params;
    const papers: Paper[] = [];
    const truncated: string[] = [];
    const degraded: DegradedKeyword[] = [];
    const failures: string[] = [];
    const catClause = ArxivSource.buildCategoryClause(categories);

    for (const kw of keywords) {
      const query = ArxivSource.buildQuery(kw, catClause);
      const startIndexInPapers = papers.length;
      let fetchedCount = 0;
      let reachedSinceBoundary = false;
      let degradedReason: string | null = null;
      let offset = 0;
      // H3: the total this keyword's PAGE 1 reported. The real `arxiv`
      // package's `Client._results` reads `total_results` once, from the
      // first page, and keeps paging against that same number for the
      // whole fetch (`arxiv/__init__.py::Client._results`) — it never
      // re-reads totalResults from a later page. Re-reading it per page (as
      // this port used to) silently accepts an inconsistent later page
      // (e.g. a throttled/cached response reporting a different total) as
      // just a smaller-or-larger result set instead of the sign of a bad
      // response that it is.
      let pageOneTotal: number | null = null;

      try {
        pageLoop: for (;;) {
          const url = this.buildPageUrl(query, offset);
          const bodyText = await this.fetchPageText(url);
          const parsed = parseArxivFeed(bodyText);

          if (!parsed.ok) {
            degradedReason = parsed.reason;
            break;
          }

          if (offset === 0) {
            pageOneTotal = parsed.totalResults;
          } else if (pageOneTotal !== null && parsed.totalResults !== pageOneTotal) {
            // A later page disagrees with page 1 about how many results
            // exist at all — not a count this fetch can keep paging
            // against, and not distinguishable from a throttled/cached
            // response splicing two different result sets together.
            degradedReason =
              `arxiv feed totalResults changed mid-fetch: page 1 reported ${pageOneTotal}, ` +
              `a later page (offset=${offset}) reported ${parsed.totalResults}`;
            break;
          }

          if (parsed.skipped.length > 0 && degradedReason === null) {
            degradedReason =
              `${parsed.skipped.length} malformed feed entrie(s) within a well-formed page, ` +
              `first: ${parsed.skipped[0]}`;
          }

          if (offset === 0 && parsed.entries.length === 0 && parsed.skipped.length === 0) {
            // A clean, genuinely empty first page: a complete 0-paper answer.
            break;
          }

          for (const entry of parsed.entries) {
            fetchedCount += 1;
            if (isoDateLess(entry.publishedDate, sinceDate)) {
              // Results are sorted DESC; older ones won't qualify either.
              reachedSinceBoundary = true;
              break pageLoop;
            }
            papers.push(this.toPaper(entry, kw));
            if (maxResults > 0 && fetchedCount >= maxResults) {
              break pageLoop;
            }
          }

          const rawOnPage = parsed.entries.length + parsed.skipped.length;
          if (rawOnPage === 0) {
            // Only reachable for a NON-first page here (the offset===0 clean-
            // empty-first-page case above already returned). We only ever
            // request this page because our OWN offset tracking still had
            // `offset < pageOneTotal` — i.e. by our own accounting there
            // should be more results. A page that answers zero entries
            // anyway is exactly the real `arxiv` package's
            // `UnexpectedEmptyPageError` (`len(feed.results) == 0 and not
            // first_page`, raised unconditionally regardless of what the
            // response body's OWN `startIndex` metadata claims — H3
            // sharpen): treat it as a lost page, not a quiet end-of-results,
            // since `feed.ts`'s COL-03 check trusts the body's self-reported
            // `startIndex`/`totalResults`, which a forged or buggy response
            // could claim is already past the end even though it is not.
            degradedReason = `arxiv feed page at offset=${offset} answered zero entries unexpectedly (not the first page)`;
            break;
          }
          offset += rawOnPage;
          if (offset >= (pageOneTotal as number)) break; // covered the whole result set
        }
      } catch (e) {
        papers.length = startIndexInPapers; // withdraw: a mid-stream failure taints this keyword's whole set
        failures.push(kw);
        const name = e instanceof Error ? e.name : "Error";
        const message = e instanceof Error ? e.message : String(e);
        degraded.push([kw, `${name}: ${message}`]);
        continue;
      }

      if (degradedReason !== null) {
        // A malformed page (or a skipped entry within an otherwise well-formed
        // one) makes this keyword's set known-incomplete — withdraw it rather
        // than ship a set known to be missing entries (COL-06).
        papers.length = startIndexInPapers;
        failures.push(kw);
        degraded.push([kw, degradedReason]);
        continue;
      }

      if (maxResults > 0 && fetchedCount >= maxResults && !reachedSinceBoundary) {
        truncated.push(kw);
      }
    }

    if (keywords.length > 0 && failures.length === keywords.length) {
      throw new AllKeywordsFailedError(`arxiv fetch failed for all ${keywords.length} keyword(s)`, {
        truncatedKeywords: truncated,
        degradedKeywords: degraded,
      });
    }

    return { papers, truncatedKeywords: truncated, degradedKeywords: degraded };
  }
}
