/**
 * Real-network `fetch` adapters that actually enforce a timeout — M6 of
 * the P4 review.
 *
 * `requestWithRetry`'s `FetchInit.timeoutMs` is documented as
 * "informational — a real fetchImpl may also use it for an AbortSignal",
 * but the openreview/cvf CLI entry points (`openreview/cli.ts`,
 * `cvf/cli.ts`) were passing `init` straight to the global `fetch()`,
 * which does not understand a `timeoutMs` property — it is silently
 * dropped, so a stalled real request (OpenReview down, a half-open TCP
 * connection to CVF Open Access, …) never times out at all, no matter
 * what `timeoutMs` `fetchNotes`/`fetchListing`/`fetchOne` computed.
 *
 * This module exists in `conference/shared/` (not `collect/http/`,
 * which owns `requestWithRetry` itself but not this port's CLI entry
 * points) so it is reusable by every conference collector's real-network
 * entry point without duplicating the `AbortSignal.timeout` wiring in
 * each one.
 */

import type { FetchLike } from "../../collect/http/requestWithRetry.js";

/**
 * Wraps `fetchFn` (the real global `fetch` by default) as a
 * `requestWithRetry`-compatible `FetchLike` that actually aborts the
 * request after `init.timeoutMs` milliseconds, via `AbortSignal.timeout`
 * — the one piece of `init` the raw `(url, init) => fetch(url, init)`
 * pass-through silently ignored.
 */
export function fetchImplWithTimeout(fetchFn: typeof fetch = fetch): FetchLike {
  return async (url, init) =>
    fetchFn(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal: AbortSignal.timeout(init.timeoutMs),
    });
}

export interface TextResponse {
  status: number;
  text(): Promise<string>;
}

/**
 * Wraps `fetchFn` as a `(url: string) => Promise<TextResponse>` fetcher —
 * the shape `ArxivFetchDeps.fetchText` / `AclFetchText` take — that
 * aborts after `timeoutMs`. Unlike {@link fetchImplWithTimeout}, these
 * callers' interfaces carry no `timeoutMs` of their own (the arXiv Atom
 * API fetch and the ACL Anthology XML fetch both reimplement their own
 * retry loop rather than going through `requestWithRetry`), so the
 * timeout here is a fixed, defensive addition — not a Python parity
 * requirement (the real `arxiv` PyPI client this port's oral-overlay
 * fetch stands in for issues its HTTP request with no timeout at all).
 */
export function fetchTextWithTimeout(
  timeoutMs: number,
  fetchFn: typeof fetch = fetch,
): (url: string) => Promise<TextResponse> {
  return async (url) => fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
}
