/**
 * arXiv "oral/highlight" overlay — TS port of the arXiv-query half of
 * `paperpilot/scripts/collect_conference.py` (`fetch_results_checked`,
 * `build_rows`, `oral_titles_from_arxiv`; CNF-14 of
 * docs/migration/safety-contracts.md).
 *
 * This is the piece `collect_cvf.py`'s `--oral-arxiv-query` and (per the
 * task brief) the TS arXiv collector both depend on, so it lives in
 * `conference/shared/` rather than under `conference/cvf/` or
 * `conference/arxiv/`: a confirmed Oral/Highlight set restores the Oral
 * filter on catalogs whose primary source (CVF Open Access, ACL
 * Anthology) carries no such label of its own.
 *
 * DOCUMENTED SIMPLIFICATION vs. the Python original: `fetch_results_checked`
 * wraps the REAL `arxiv` PyPI package's `Client`, whose own HTTP retry /
 * empty-page / `HTTPError` semantics this port does not reproduce (no
 * Node equivalent exists — design doc §6.1). What IS ported exactly is the
 * one completeness signal `collect_conference.py` actually depends on:
 * whether the fetched pages parsed as a well-formed Atom feed with every
 * `<entry>` buildable (`parseArxivFeed`, COL-01..03). A non-200 response or
 * a page that fails to parse as Atom at all ends the scan immediately
 * (`complete: false`, whatever was collected on earlier pages is kept) —
 * this is the TS equivalent of the Python "body hook" case
 * (`test_fetch_results_checked_catches_a_silently_empty_page_via_the_body_hook`).
 * A page that DOES parse but has to skip some `<entry>` elements
 * (missing `<id>`/`<updated>`/`<published>`) behaves like the Python
 * library's own lenient parser: entries are still collected and pagination
 * continues, but the whole fetch is reported `complete: false`.
 */

import { ARXIV_MODERN_PATTERN, IdentityError, identityFromUrl } from "@paperpilot/core/identity";
import { VenueSignal } from "../../collect/signals/venue.js";
import { parseArxivFeed } from "../../collect/sources/arxiv/feed.js";
import type { ConferenceRow } from "./csvColumns.js";
import { pyWhitespaceCollapse } from "./pyText.js";

const ARXIV_QUERY_BASE = "https://export.arxiv.org/api/query";
const ARXIV_MODERN_RE = new RegExp(`^${ARXIV_MODERN_PATTERN}$`);
const ORAL_RE = /\b(oral|highlight)\b/i;

/** Shared by the overlay itself and each collector's `--oral-max` default. */
export const ORAL_MAX_RESULTS_DEFAULT = 1600;

export const ORAL_WINDOW_FILLED = "window-filled";
export const ORAL_MALFORMED_FEED = "malformed-feed";

export interface OralOverlay {
  titles: string[] | null;
  reason: typeof ORAL_WINDOW_FILLED | typeof ORAL_MALFORMED_FEED | null;
}

/** One accepted arXiv result, shaped like the fields `build_rows` / the oral overlay need. */
export interface ArxivAcceptedResult {
  title: string;
  comment: string;
  entryId: string;
  summary: string;
  authorNames: string[];
  pdfUrl: string | null;
}

export interface ArxivTextResponse {
  status: number;
  text(): Promise<string>;
}

export interface ArxivFetchDeps {
  fetchText: (url: string) => Promise<ArxivTextResponse>;
}

function buildPageUrl(query: string, start: number, maxResults: number): string {
  const params = new URLSearchParams({
    search_query: query,
    start: String(start),
    max_results: String(maxResults),
    sortBy: "submittedDate",
    sortOrder: "descending",
  });
  return `${ARXIV_QUERY_BASE}?${params.toString()}`;
}

/**
 * Page through the arXiv Atom API for `query`, newest-first, up to
 * `maxResults`. Returns `{results, complete}` — see the module doc for
 * exactly what `complete` means here.
 */
export async function fetchArxivResultsChecked(
  query: string,
  maxResults: number,
  deps: ArxivFetchDeps,
  pageSize = 100,
): Promise<{ results: ArxivAcceptedResult[]; complete: boolean }> {
  const results: ArxivAcceptedResult[] = [];
  let offset = 0;
  let sawMalformed = false;
  // TS port of the real `arxiv` package's `Client._results`: it reads
  // `total_results` from page 1 ONLY (`feed.header.total_results`) and
  // reuses that same value for every later page's "have we covered the
  // whole result set" check — it never re-reads the field from a later
  // page (H3). A later page reporting a *different* total (a torn or
  // concurrently-edited index) can no longer be trusted, so that fetch is
  // reported incomplete instead of silently paging against a stale bound.
  let firstPageTotal: number | null = null;

  for (;;) {
    const isFirstPage = offset === 0;
    const url = buildPageUrl(query, offset, pageSize);
    const resp = await deps.fetchText(url);
    if (resp.status !== 200) {
      return { results, complete: false };
    }
    const body = await resp.text();
    const page = parseArxivFeed(body);
    if (!page.ok) {
      return { results, complete: false };
    }
    if (firstPageTotal === null) {
      firstPageTotal = page.totalResults;
    } else if (page.totalResults !== firstPageTotal) {
      return { results, complete: false };
    }
    if (page.skipped.length > 0) {
      sawMalformed = true;
    }

    for (const entry of page.entries) {
      results.push({
        title: entry.title,
        comment: entry.comment ?? "",
        entryId: entry.entryId,
        summary: entry.summary,
        authorNames: entry.authors.map((a) => a.name),
        pdfUrl: entry.pdfUrl,
      });
      if (results.length >= maxResults) {
        return { results, complete: !sawMalformed };
      }
    }

    const rawOnPage = page.entries.length + page.skipped.length;
    if (rawOnPage === 0) {
      // `parseArxivFeed` lets `ok:true` through with zero raw entries
      // whenever THIS page's own `startIndex`/`totalResults` agree we are
      // past the end (or `totalResults` is 0) — but that is the page
      // trusting its OWN self-reported position, not proof that it is
      // consistent with how much we have actually paged through so far.
      // On the first page there is nothing to be inconsistent with, so an
      // empty-but-`ok` page there is a genuine "zero results" venue. On any
      // LATER page, though, we only ever requested it because our own
      // running `offset` was still short of `firstPageTotal` — i.e. the
      // index on page 1 promised more entries than we have collected. A
      // later page nonetheless coming back with zero raw entries is
      // exactly the real `arxiv` package's `UnexpectedEmptyPageError`
      // condition (an unexpectedly empty page despite the total implying
      // more remain), ported here as "incomplete" rather than trusting the
      // page's own end-of-results claim (P4 review round 2, LOW).
      return { results, complete: isFirstPage && !sawMalformed };
    }
    offset += rawOnPage;
    if (offset >= firstPageTotal) {
      return { results, complete: !sawMalformed };
    }
  }
}

/** The bare, versionless arXiv id for an entry URL, or `""` if unparseable / not modern-form. */
function arxivIdFromEntryUrl(entryId: string): string {
  try {
    const identity = identityFromUrl(entryId || "");
    if (identity.source !== "arxiv" || !ARXIV_MODERN_RE.test(identity.sourceId)) return "";
    return identity.sourceId;
  } catch (e) {
    if (e instanceof IdentityError) return "";
    throw e;
  }
}

/**
 * Filter arXiv results to genuine acceptances of `targetVenue`. Returns
 * `{rows, oralTitles}`. Dedups by arXiv id. Reuses the production
 * `VenueSignal.classify` so the acceptance test is identical to the
 * pipeline's (a "<venue> Workshop" classification is excluded).
 */
export function buildArxivRows(
  results: readonly ArxivAcceptedResult[],
  targetVenue: string,
): { rows: ConferenceRow[]; oralTitles: string[] } {
  const target = targetVenue.toUpperCase();
  const papers = new Map<string, ConferenceRow>();
  const oralTitles: string[] = [];

  for (const r of results) {
    const comment = pyWhitespaceCollapse(r.comment ?? "");
    const [venue, tier] = VenueSignal.classify(comment);
    if (venue !== target) continue;
    const aid = arxivIdFromEntryUrl(r.entryId);
    if (!aid || papers.has(aid)) continue;
    const title = pyWhitespaceCollapse(r.title ?? "");
    papers.set(aid, {
      title,
      authors: r.authorNames.join("; "),
      venue: target,
      venue_tier: tier,
      citation_count: 0,
      github_stars: 0,
      arxiv_id: aid,
      abstract: pyWhitespaceCollapse(r.summary ?? ""),
      url: r.entryId,
      pdf_url: r.pdfUrl ?? "",
      comment,
    });
    if (ORAL_RE.test(comment)) oralTitles.push(title);
  }

  return { rows: [...papers.values()], oralTitles };
}

/**
 * Oral / Highlight titles for `venue`, harvested from arXiv comments —
 * used by collectors (CVF, ACL) whose primary source carries no
 * oral/highlight label of its own.
 *
 * Returns `titles: null` (with the matching `reason`) when the fetch is
 * incomplete: either it filled the whole `maxResults` window, or the feed
 * could not be confirmed complete. A caller that gets `titles: null` must
 * NOT treat that as "pass an empty list" without first checking — an
 * empty list and an unknown list have different authorization semantics
 * for `--clear-oral` (CNF-16); `writeOutputs` only treats a literal `[]`
 * as "no evidence found", so the caller is responsible for keeping those
 * two cases apart (see `collect_cvf.py` / the TS cvf CLI).
 */
export async function oralTitlesFromArxiv(
  query: string,
  venue: string,
  maxResults: number,
  deps: ArxivFetchDeps,
): Promise<OralOverlay> {
  const { results, complete } = await fetchArxivResultsChecked(query, maxResults, deps);
  if (!complete) {
    console.log(
      "⚠️  oral overlay incomplete: a malformed, skipped-entry or non-feed " +
        "page was detected and the client kept going, so the fetched set is " +
        "missing entries and the oral list would be partial",
    );
    return { titles: null, reason: ORAL_MALFORMED_FEED };
  }
  if (results.length >= maxResults) {
    console.log(
      `⚠️  oral overlay truncated: the arXiv fetch returned the full ` +
        `${maxResults}-result --oral-max window (newest first), so older ` +
        "Oral/Highlight acceptances are outside the scan and the list would " +
        "be incomplete",
    );
    return { titles: null, reason: ORAL_WINDOW_FILLED };
  }
  const { oralTitles } = buildArxivRows(results, venue);
  return { titles: oralTitles, reason: null };
}
