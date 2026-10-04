/**
 * Semantic Scholar source — TS port of `paperpilot/sources/s2_source.py`.
 * Covers COL-10..13 (docs/migration/safety-contracts.md).
 */

import { RateLimiter } from "../http/rateLimiter.js";
import { type FetchLike, requestWithRetry } from "../http/requestWithRetry.js";
import { createPaper, type Paper } from "../model/paper.js";
import {
  describeError,
  isoDateLess,
  orElse,
  PyRuntimeError,
  pyGet,
  pyIntOrNull,
  pyStrip,
  pyStrptimeYMD,
  pyTypeName,
  truthy,
  yearToIsoDate,
} from "../pyish.js";
import {
  AllKeywordsFailedError,
  type DegradedKeyword,
  type FetchParams,
  type FetchResult,
  type Source,
} from "./source.js";

const S2_BASE = "https://api.semanticscholar.org/graph/v1";
const SEARCH_FIELDS =
  "paperId,title,abstract,authors.name,authors.authorId," +
  "year,publicationDate,externalIds,openAccessPdf,venue,url";

/**
 * A paper item that is well-formed JSON but carries no usable content — a
 * blank/missing title or no parseable publication date (D-1). An upstream
 * DATA-QUALITY artifact, not a shape error — counted as `skipped`, never
 * `dropped`, by `search()`'s dedicated catch.
 */
export class UnusableRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnusableRecordError";
  }
}

export interface S2SourceConfig {
  enabled?: boolean;
  delaySeconds?: number;
}

export interface S2SourceDeps {
  fetchImpl: FetchLike;
  apiKey?: string | null;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  logger?: { warn: (msg: string) => void };
}

export interface SearchOutcome {
  papers: Paper[];
  pageIsFull: boolean;
  unreadable: string | null;
}

export class S2Source implements Source {
  readonly name = "s2";
  private readonly limiter: RateLimiter;
  private readonly apiKey: string | null;
  private readonly httpDeps: S2SourceDeps;

  constructor(config: S2SourceConfig, deps: S2SourceDeps) {
    const delay = config.delaySeconds ?? 1.0;
    this.limiter = new RateLimiter(delay, { now: deps.now, sleep: deps.sleep });
    this.apiKey = deps.apiKey ?? null;
    this.httpDeps = deps;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { Accept: "application/json" };
    if (this.apiKey) h["x-api-key"] = this.apiKey;
    return h;
  }

  async fetch(params: FetchParams): Promise<FetchResult> {
    const { keywords, sinceDate, maxResults } = params;
    const papers: Paper[] = [];
    const failures: string[] = [];
    const truncated: string[] = [];
    const degraded: DegradedKeyword[] = [];

    for (const kw of keywords) {
      await this.limiter.wait();
      let outcome: SearchOutcome;
      try {
        outcome = await this.search(kw, sinceDate, maxResults);
      } catch (e) {
        // Fail-safe: one keyword failing (S2's free tier throttles aggressively,
        // so a single 429 is routine) must not discard the papers other
        // keywords already returned.
        failures.push(kw);
        degraded.push([kw, describeError(e)]);
        continue;
      }
      if (outcome.unreadable) degraded.push([kw, outcome.unreadable]);
      if (outcome.pageIsFull) truncated.push(kw);
      papers.push(...outcome.papers);
    }

    if (keywords.length > 0 && failures.length === keywords.length) {
      throw new AllKeywordsFailedError(`s2 fetch failed for all ${keywords.length} keyword(s)`, {
        truncatedKeywords: truncated,
        degradedKeywords: degraded,
      });
    }

    return { papers, truncatedKeywords: truncated, degradedKeywords: degraded };
  }

  /**
   * Returns `{papers, pageIsFull, unreadable}` — see `s2_source.py::_search`'s
   * docstring (reproduced here) for the exact degrade-vs-stay-clean rules.
   */
  async search(keyword: string, sinceDate: string, maxResults: number): Promise<SearchOutcome> {
    const limit = Math.min(maxResults, 100);
    const resp = await requestWithRetry(
      {
        method: "GET",
        url: `${S2_BASE}/paper/search`,
        params: {
          query: keyword,
          limit,
          fields: SEARCH_FIELDS,
          // Open-ended range so the relevance-ranked pool is restricted to the
          // window in the first place (see the Python module's docstring).
          publicationDateOrYear: `${sinceDate}:`,
        },
        headers: this.headers(),
      },
      this.httpDeps,
    );
    if (!resp || resp.status !== 200) {
      const status = resp ? String(resp.status) : "None";
      throw new PyRuntimeError(`s2 search failed for '${keyword}' (status=${status})`);
    }
    let data: unknown = await resp.json();
    if (!truthy(data)) data = {};
    if (typeof data !== "object" || Array.isArray(data)) {
      throw new PyRuntimeError(
        `s2 search for '${keyword}' returned ${pyTypeName(data)} instead of an object`,
      );
    }
    const results = pyGet(data, "data");
    if (!Array.isArray(results)) {
      throw new PyRuntimeError(
        `s2 search for '${keyword}' has no 'data' list (got ${pyTypeName(results)})`,
      );
    }

    const papers: Paper[] = [];
    let dropped = 0;
    let skipped = 0;
    for (const item of results) {
      let paper: Paper | null;
      try {
        paper = this.toPaper(item, keyword, sinceDate);
      } catch (e) {
        if (e instanceof UnusableRecordError) {
          skipped += 1;
          continue;
        }
        dropped += 1;
        continue;
      }
      if (paper !== null) papers.push(paper);
    }

    const total = results.length;
    const unusable = dropped + skipped;
    let unreadable: string | null;
    if (dropped) {
      unreadable = `${dropped} of ${total} papers unreadable`;
      if (skipped) unreadable += ` (${skipped} further skipped: blank title/unparseable date)`;
    } else if (papers.length === 0 && unusable > 0) {
      unreadable = `${skipped} of ${total} papers skipped (blank title or unparseable date); no paper survived this page`;
    } else {
      unreadable = null;
    }
    const pageIsFull = dropped === 0 && maxResults > 0 && results.length >= limit;
    return { papers, pageIsFull, unreadable };
  }

  /**
   * Returns `null` for a legitimate date-window exclusion; THROWS
   * `UnusableRecordError` for an unreadable record (no parseable publication
   * date, or no title); throws any other error for a genuine shape error
   * (counted as `dropped` by `search()`).
   */
  toPaper(item: unknown, matchedKeyword: string, sinceDate: string): Paper | null {
    const pub = S2Source.parsePubDate(item);
    if (pub === null) throw new UnusableRecordError("s2 item has no parseable publication date");
    if (isoDateLess(pub, sinceDate)) return null;

    const title = pyStrip(pyGet(item, "title"));
    if (!title) throw new UnusableRecordError("s2 item has no title");

    const externalRaw = pyGet(item, "externalIds");
    const external = truthy(externalRaw) ? externalRaw : {};
    const arxivIdRaw = pyGet(external, "ArXiv");
    const docIdRaw = pyGet(external, "DOI");
    const arxivId = typeof arxivIdRaw === "string" ? arxivIdRaw : null;
    const doi = typeof docIdRaw === "string" ? docIdRaw : null;

    const openAccessRaw = pyGet(item, "openAccessPdf");
    const openAccess = truthy(openAccessRaw) ? openAccessRaw : {};
    // Python guards this one with `isinstance(open_access, dict)`, so a
    // non-dict value here yields None rather than raising.
    const pdfUrl =
      typeof openAccess === "object" && !Array.isArray(openAccess)
        ? (() => {
            const u = pyGet(openAccess, "url");
            return typeof u === "string" ? u : null;
          })()
        : null;

    const authorsCandidate = orElse(pyGet(item, "authors"), []);
    if (!Array.isArray(authorsCandidate)) {
      // Python would iterate this (dict keys / string chars) and then call
      // `.get` on each element, which raises for anything but a dict — so in
      // every realistic malformed case this item ends up dropped anyway.
      throw new Error(`'${pyTypeName(authorsCandidate)}' object has no attribute 'get'`);
    }
    const authorsRaw = authorsCandidate;
    const authors: string[] = [];
    for (const a of authorsRaw) {
      if (!truthy(a)) continue;
      const name = pyGet(a, "name");
      if (truthy(name)) authors.push(String(name));
    }
    let firstAuthorId: string | null = null;
    if (authorsRaw.length > 0) {
      const a0 = orElse(authorsRaw[0], {});
      const aid = pyGet(a0, "authorId");
      firstAuthorId = typeof aid === "string" ? aid : null;
    }

    const urlRaw = pyGet(item, "url");
    const paperIdRaw = pyGet(item, "paperId");
    const paperIdStr =
      paperIdRaw === undefined || paperIdRaw === null ? "None" : String(paperIdRaw);
    const url = truthy(urlRaw)
      ? (urlRaw as string)
      : `https://www.semanticscholar.org/paper/${paperIdStr}`;

    const venueRaw = pyGet(item, "venue");
    const venue = truthy(venueRaw) ? (venueRaw as string) : null;

    const abstractRaw = pyGet(item, "abstract");
    const abstract = pyStrip(orElse(abstractRaw, ""));

    return createPaper({
      title,
      authors,
      abstract,
      url,
      publishedDate: pub,
      source: "s2",
      arxivId,
      doi,
      pdfUrl,
      categories: [],
      comment: null,
      venue,
      matchedKeywords: [matchedKeyword],
      firstAuthorId,
    });
  }

  static parsePubDate(item: unknown): string | null {
    const pubRaw = pyGet(item, "publicationDate");
    if (truthy(pubRaw) && typeof pubRaw === "string") {
      const parsed = pyStrptimeYMD(pubRaw);
      if (parsed) return parsed;
    }
    const yearRaw = pyGet(item, "year");
    if (truthy(yearRaw)) {
      const y = pyIntOrNull(yearRaw);
      if (y !== null) return yearToIsoDate(y);
      return null;
    }
    return null;
  }
}
