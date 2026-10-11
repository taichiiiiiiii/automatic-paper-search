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

/**
 * Why a fetch stopped. `source_blocked` is OpenReview refusing automated
 * clients outright (403, typically `ChallengeRequiredError` — observed for
 * every `/notes` call since 2026-10, design 52 §2): it is NOT an empty
 * venue and NOT a short page, so callers must surface it as its own
 * status and never write (or shrink) a catalog from it.
 */
export type FetchNotesOutcome = "complete" | "incomplete" | "source_blocked";

export interface SourceBlocked {
  status: number;
  /** The OpenReview error `name` when the body carried one (e.g. `ChallengeRequiredError`). */
  errorName: string | null;
}

export interface FetchNotesResult {
  notes: OpenReviewNote[];
  complete: boolean;
  outcome: FetchNotesOutcome;
  blocked: SourceBlocked | null;
}

/** Extract the OpenReview error `name` from a 403 body, tolerating any shape. */
export async function blockedErrorName(resp: { json(): Promise<unknown> }): Promise<string | null> {
  try {
    const body = (await resp.json()) as Record<string, unknown> | null;
    if (body && typeof body === "object" && typeof body.name === "string") return body.name;
  } catch {
    // non-JSON 403 (a CDN challenge page): still blocked, just unnamed
  }
  return null;
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
): Promise<FetchNotesResult> {
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
    if (resp !== null && resp.status === 403) {
      // Never a partial catalog: drop whatever earlier pages returned.
      return {
        notes: [],
        complete: false,
        outcome: "source_blocked",
        blocked: { status: 403, errorName: await blockedErrorName(resp) },
      };
    }
    if (resp === null || resp.status !== 200) {
      return incomplete(notes);
    }
    let body: unknown;
    try {
      body = await resp.json();
    } catch {
      // 200 with a non-JSON body (maintenance page / proxy error): a
      // genuine mid-run failure, not end-of-results.
      return incomplete(notes);
    }
    const bodyObj = body as { notes?: unknown } | null;
    if (
      bodyObj === null ||
      typeof bodyObj !== "object" ||
      Array.isArray(bodyObj) ||
      !Array.isArray(bodyObj.notes)
    ) {
      return incomplete(notes);
    }
    const batch = bodyObj.notes as OpenReviewNote[];
    notes.push(...batch);
    if (batch.length < pageSize) {
      return { notes, complete: true, outcome: "complete", blocked: null };
    }
  }
  // Ran out of maxPages iterations without a short final page.
  return incomplete(notes);
}

function incomplete(notes: OpenReviewNote[]): FetchNotesResult {
  return { notes, complete: false, outcome: "incomplete", blocked: null };
}
