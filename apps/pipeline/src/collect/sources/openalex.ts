/**
 * OpenAlex source — TS port of `paperpilot/sources/openalex_source.py`.
 * Covers COL-10..14 (docs/migration/safety-contracts.md).
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

const OPENALEX_BASE = "https://api.openalex.org";
const DOI_PREFIX = "https://doi.org/";

/** Same D-1 contract as `s2.ts`'s `UnusableRecordError`. */
export class UnusableRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnusableRecordError";
  }
}

export interface OpenAlexSourceConfig {
  enabled?: boolean;
  delaySeconds?: number;
}

export interface OpenAlexSourceDeps {
  fetchImpl: FetchLike;
  email?: string | null;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  logger?: { warn: (msg: string) => void };
}

export interface SearchOutcome {
  papers: Paper[];
  pageIsFull: boolean;
  unreadable: string | null;
}

export class OpenAlexSource implements Source {
  readonly name = "openalex";
  private readonly limiter: RateLimiter;
  private readonly email: string | null;
  private readonly httpDeps: OpenAlexSourceDeps;

  constructor(config: OpenAlexSourceConfig, deps: OpenAlexSourceDeps) {
    const delay = config.delaySeconds ?? 1.0;
    this.limiter = new RateLimiter(delay, { now: deps.now, sleep: deps.sleep });
    this.email = deps.email ?? null;
    this.httpDeps = deps;
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
        failures.push(kw);
        degraded.push([kw, describeError(e)]);
        continue;
      }
      if (outcome.unreadable) degraded.push([kw, outcome.unreadable]);
      if (outcome.pageIsFull) truncated.push(kw);
      papers.push(...outcome.papers);
    }

    if (keywords.length > 0 && failures.length === keywords.length) {
      throw new AllKeywordsFailedError(
        `openalex fetch failed for all ${keywords.length} keyword(s)`,
        {
          truncatedKeywords: truncated,
          degradedKeywords: degraded,
        },
      );
    }

    return { papers, truncatedKeywords: truncated, degradedKeywords: degraded };
  }

  async search(keyword: string, sinceDate: string, maxResults: number): Promise<SearchOutcome> {
    const perPage = Math.min(maxResults, 200);
    const params: Record<string, string | number | boolean | undefined> = {
      search: keyword,
      "per-page": perPage,
      filter: `from_publication_date:${sinceDate}`,
      sort: "publication_date:desc",
    };
    if (this.email) params["mailto"] = this.email;

    const resp = await requestWithRetry(
      { method: "GET", url: `${OPENALEX_BASE}/works`, params },
      this.httpDeps,
    );
    if (!resp || resp.status !== 200) {
      const status = resp ? String(resp.status) : "None";
      throw new PyRuntimeError(`openalex search failed for '${keyword}' (status=${status})`);
    }
    let data: unknown = await resp.json();
    if (!truthy(data)) data = {};
    if (typeof data !== "object" || Array.isArray(data)) {
      throw new PyRuntimeError(
        `openalex search for '${keyword}' returned ${pyTypeName(data)} instead of an object`,
      );
    }
    const results = pyGet(data, "results");
    if (!Array.isArray(results)) {
      throw new PyRuntimeError(
        `openalex search for '${keyword}' has no 'results' list (got ${pyTypeName(results)})`,
      );
    }

    const papers: Paper[] = [];
    let dropped = 0;
    let skipped = 0;
    for (const work of results) {
      let paper: Paper | null;
      try {
        paper = this.toPaper(work, keyword, sinceDate);
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
      unreadable = `${dropped} of ${total} works unreadable`;
      if (skipped) unreadable += ` (${skipped} further skipped: blank title/unparseable date)`;
    } else if (papers.length === 0 && unusable > 0) {
      unreadable = `${skipped} of ${total} works skipped (blank title or unparseable date); no paper survived this page`;
    } else {
      unreadable = null;
    }
    const pageIsFull = dropped === 0 && maxResults > 0 && results.length >= perPage;
    return { papers, pageIsFull, unreadable };
  }

  toPaper(work: unknown, matchedKeyword: string, sinceDate: string): Paper | null {
    const pub = OpenAlexSource.parsePubDate(work);
    if (pub === null)
      throw new UnusableRecordError("openalex work item has no parseable publication date");
    if (isoDateLess(pub, sinceDate)) return null;

    const titleRaw = pyGet(work, "title");
    const displayNameRaw = pyGet(work, "display_name");
    const title = pyStrip(truthy(titleRaw) ? titleRaw : displayNameRaw);
    if (!title) throw new UnusableRecordError("openalex work item has no title");

    const abstract = OpenAlexSource.rehydrateAbstract(pyGet(work, "abstract_inverted_index"));

    const doiFieldRaw = pyGet(work, "doi");
    const idsRaw = orElse(pyGet(work, "ids"), {});
    const idsDoiRaw = pyGet(idsRaw, "doi"); // throws if `ids` was present but not dict-shaped, matching Python's `.get`
    const doiRaw = orElse(doiFieldRaw, idsDoiRaw);
    let doi: string | null;
    if (typeof doiRaw === "string" && doiRaw.startsWith(DOI_PREFIX)) {
      doi = doiRaw.slice(DOI_PREFIX.length);
    } else if (doiRaw === undefined || doiRaw === null) {
      doi = null;
    } else {
      doi = String(doiRaw);
    }

    const authorshipsRaw = orElse(pyGet(work, "authorships"), []);
    const authorships = Array.isArray(authorshipsRaw) ? authorshipsRaw : [];
    const authors: string[] = [];
    const affiliations: string[] = [];
    const seenAff = new Set<string>();
    for (const a of authorships) {
      const author = orElse(pyGet(a, "author"), {});
      const displayName = pyGet(author, "display_name");
      if (truthy(displayName)) authors.push(String(displayName));
      const institutions = orElse(pyGet(a, "institutions"), []);
      if (Array.isArray(institutions)) {
        for (const inst of institutions) {
          const name =
            typeof inst === "object" && inst !== null && !Array.isArray(inst)
              ? pyGet(inst, "display_name")
              : undefined;
          if (typeof name === "string" && name && !seenAff.has(name)) {
            seenAff.add(name);
            affiliations.push(name);
          }
        }
      }
    }

    // OpenAlex deprecated `host_venue` in 2023 in favor of
    // `primary_location.source.display_name`. Try the new field first.
    const primary = orElse(pyGet(work, "primary_location"), {});
    const primarySource =
      typeof primary === "object" && !Array.isArray(primary)
        ? orElse(pyGet(primary, "source"), {})
        : {};
    let venue =
      typeof primarySource === "object" && !Array.isArray(primarySource)
        ? (pyGet(primarySource, "display_name") as string | undefined)
        : undefined;
    if (!truthy(venue)) {
      const hostVenue = orElse(pyGet(work, "host_venue"), {});
      venue =
        typeof hostVenue === "object" && !Array.isArray(hostVenue)
          ? (pyGet(hostVenue, "display_name") as string | undefined)
          : undefined;
    }

    const openAccess = orElse(pyGet(work, "open_access"), {});
    const pdfUrl =
      typeof openAccess === "object" && !Array.isArray(openAccess)
        ? ((): string | null => {
            const u = pyGet(openAccess, "oa_url");
            return typeof u === "string" ? u : null;
          })()
        : null;

    const urlRaw = pyGet(work, "id");
    const url = typeof urlRaw === "string" ? urlRaw : "";

    return createPaper({
      title,
      authors,
      abstract,
      url,
      publishedDate: pub,
      source: "openalex",
      doi,
      pdfUrl,
      categories: [],
      comment: null,
      affiliations,
      venue: truthy(venue) ? (venue as string) : null,
      matchedKeywords: [matchedKeyword],
    });
  }

  static parsePubDate(work: unknown): string | null {
    const pubRaw = pyGet(work, "publication_date");
    if (truthy(pubRaw) && typeof pubRaw === "string") {
      const parsed = pyStrptimeYMD(pubRaw);
      if (parsed) return parsed;
    }
    const yearRaw = pyGet(work, "publication_year");
    if (truthy(yearRaw)) {
      const y = pyIntOrNull(yearRaw);
      if (y !== null) return yearToIsoDate(y);
      return null;
    }
    return null;
  }

  /**
   * Rehydrate OpenAlex's inverted abstract index to plain text — COL-14.
   * ANY malformed element (non-string token, non-list positions,
   * non-integer/negative/bool position) discards the WHOLE abstract to ""
   * rather than silently dropping just that token; last-writer-wins on a
   * position collision.
   */
  static rehydrateAbstract(inverted: unknown): string {
    if (!truthy(inverted) || typeof inverted !== "object" || Array.isArray(inverted)) return "";
    const invertedObj = inverted as Record<string, unknown>;
    const posToToken = new Map<number, string>();
    for (const [token, indices] of Object.entries(invertedObj)) {
      if (typeof token !== "string") return "";
      if (!Array.isArray(indices)) return "";
      for (const idx of indices) {
        // bool is a subclass of int in Python; exclude it explicitly.
        if (
          typeof idx === "boolean" ||
          typeof idx !== "number" ||
          !Number.isInteger(idx) ||
          idx < 0
        ) {
          return "";
        }
        posToToken.set(idx, token);
      }
    }
    const positions = [...posToToken.keys()].sort((a, b) => a - b);
    return positions.map((p) => posToToken.get(p)).join(" ");
  }
}
