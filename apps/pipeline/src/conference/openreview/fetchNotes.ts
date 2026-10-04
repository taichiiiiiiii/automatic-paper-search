/**
 * OpenReview api2 `/notes` paging — TS port of
 * `paperpilot/scripts/collect_openreview.py::fetch_notes` (CNF-01 of
 * docs/migration/safety-contracts.md).
 */

import {
  type RequestWithRetryDeps,
  requestWithRetry,
} from "../../collect/http/requestWithRetry.js";

export const OPENREVIEW_API = "https://api2.openreview.net/notes";

/** OpenReview v2 max page size (mirrors the Python default). */
const PAGE_SIZE_DEFAULT = 1000;
/** 25k-paper ceiling — guards against an unbounded loop. */
const MAX_PAGES_DEFAULT = 25;
const TIMEOUT_MS_DEFAULT = 20000;

export interface OpenReviewNote {
  id?: unknown;
  content?: unknown;
  [key: string]: unknown;
}

export interface FetchNotesOptions {
  pageSize?: number;
  maxPages?: number;
  timeoutMs?: number;
}

/**
 * Page through every accepted note for `venueid`. Returns `(notes, complete)`.
 *
 * `complete` is only `true` when pagination ended because a page came back
 * short of `pageSize` — the natural end-of-results signal. Hitting
 * `maxPages` is treated as incomplete too (a pure runaway guard — reaching
 * it means we cannot tell whether page `maxPages + 1` still exists). A
 * non-200/failed request, a non-JSON body, and a 200 with a
 * malformed-but-valid-JSON shape (missing/null/non-array `notes`, or a
 * non-object body) are ALL incomplete — none of them is a legitimate
 * short/empty page.
 */
export async function fetchNotes(
  venueid: string,
  deps: RequestWithRetryDeps,
  options: FetchNotesOptions = {},
): Promise<{ notes: OpenReviewNote[]; complete: boolean }> {
  const pageSize = options.pageSize ?? PAGE_SIZE_DEFAULT;
  const maxPages = options.maxPages ?? MAX_PAGES_DEFAULT;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS_DEFAULT;

  const notes: OpenReviewNote[] = [];
  for (let page = 0; page < maxPages; page++) {
    const resp = await requestWithRetry(
      {
        method: "GET",
        url: OPENREVIEW_API,
        params: {
          "content.venueid": venueid,
          limit: pageSize,
          offset: page * pageSize,
        },
        timeoutMs,
      },
      deps,
    );
    if (resp === null || resp.status !== 200) {
      return { notes, complete: false };
    }
    let body: unknown;
    try {
      body = await resp.json();
    } catch {
      // 200 with a non-JSON body (maintenance page / proxy error): a
      // genuine mid-run failure, not end-of-results.
      return { notes, complete: false };
    }
    const bodyObj = body as { notes?: unknown } | null;
    if (
      bodyObj === null ||
      typeof bodyObj !== "object" ||
      Array.isArray(bodyObj) ||
      !Array.isArray(bodyObj.notes)
    ) {
      return { notes, complete: false };
    }
    const batch = bodyObj.notes as OpenReviewNote[];
    notes.push(...batch);
    if (batch.length < pageSize) {
      return { notes, complete: true };
    }
  }
  // Ran out of maxPages iterations without a short final page.
  return { notes, complete: false };
}
