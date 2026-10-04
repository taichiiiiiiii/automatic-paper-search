/**
 * CVF Open Access network layer — TS port of
 * `paperpilot/scripts/collect_cvf.py::fetch_listing` / `collect`
 * (CNF-03, CNF-04 of docs/migration/safety-contracts.md).
 */

import { RateLimiter } from "../../collect/http/rateLimiter.js";
import {
  type HttpResponseLike,
  type RequestWithRetryDeps,
  requestWithRetry,
} from "../../collect/http/requestWithRetry.js";
import type { ConferenceRow } from "../shared/csvColumns.js";
import { mapConcurrent, SerializedRateLimiter } from "./concurrency.js";
import { parseDetail } from "./detail.js";
import { detailPaths } from "./listing.js";

export const CVF_BASE = "https://openaccess.thecvf.com";

/** A `requestWithRetry` response that also exposes the HTML body as text. */
export type CvfResponse = HttpResponseLike & { text(): Promise<string> };

export interface CvfFetchDeps extends RequestWithRetryDeps {}

export interface CvfLogger {
  warn: (message: string) => void;
}

/**
 * Fetch the year listing and return `(detailPaths, ok)`.
 *
 * `ok` is `false` when the listing could not be read (vs. a genuinely
 * empty conference id, which also produces zero paths) so the caller can
 * tell the two apart.
 */
export async function fetchListing(
  cvfId: string,
  deps: CvfFetchDeps,
  options: { timeoutMs?: number; logger?: CvfLogger } = {},
): Promise<{ paths: string[]; ok: boolean }> {
  const resp = (await requestWithRetry(
    { method: "GET", url: `${CVF_BASE}/${cvfId}?day=all`, timeoutMs: options.timeoutMs ?? 30000 },
    deps,
  )) as CvfResponse | null;
  if (resp === null || resp.status !== 200) {
    const logger: CvfLogger = options.logger ?? console;
    logger.warn(`cvf: listing fetch failed for ${cvfId} (status=${resp?.status ?? "None"})`);
    return { paths: [], ok: false };
  }
  const html = await resp.text();
  return { paths: detailPaths(html, cvfId), ok: true };
}

async function fetchOne(
  path: string,
  venue: string,
  limiter: SerializedRateLimiter,
  deps: CvfFetchDeps,
  timeoutMs: number,
): Promise<ConferenceRow | null> {
  // Fail-Safe: any error on a single page returns null (the row is
  // dropped), so one bad page never aborts the whole concurrent
  // collection.
  await limiter.wait();
  try {
    const resp = (await requestWithRetry(
      { method: "GET", url: `${CVF_BASE}${path}`, timeoutMs },
      deps,
    )) as CvfResponse | null;
    if (resp === null || resp.status !== 200) return null;
    const html = await resp.text();
    return parseDetail(html, `${CVF_BASE}${path}`, venue);
  } catch {
    return null;
  }
}

export interface CollectOptions {
  maxWorkers?: number;
  delaySeconds?: number;
  timeoutMs?: number;
  logger?: CvfLogger;
}

/**
 * Full collection: listing -> concurrent detail fetch -> rows (deduped by
 * url). Returns `(rows, complete)`.
 *
 * `complete` requires both that the listing itself was read AND that
 * every detail page parsed; a dropped detail page is a silently missing
 * accepted paper.
 */
export async function collect(
  cvfId: string,
  venue: string,
  deps: CvfFetchDeps,
  options: CollectOptions = {},
): Promise<{ rows: ConferenceRow[]; complete: boolean }> {
  const maxWorkers = options.maxWorkers ?? 8;
  const delaySeconds = options.delaySeconds ?? 0.25;
  const timeoutMs = options.timeoutMs ?? 30000;
  const logger: CvfLogger = options.logger ?? console;

  const { paths, ok: listingOk } = await fetchListing(cvfId, deps, { logger });
  // LOW: `concurrent.futures.ThreadPoolExecutor(max_workers=0)` raises
  // `ValueError: max_workers must be greater than 0` — `mapConcurrent`'s
  // own `Math.max(1, ...)` clamp instead silently ran a single worker,
  // masking an operator typo (`--max-workers 0`) as "it worked, just
  // slowly" rather than failing loudly like the Python original.
  if (maxWorkers <= 0) {
    throw new RangeError(`max_workers must be greater than 0 (got ${maxWorkers})`);
  }
  const limiter = new SerializedRateLimiter(new RateLimiter(delaySeconds));

  const fetched = await mapConcurrent(paths, maxWorkers, (path) =>
    fetchOne(path, venue, limiter, deps, timeoutMs),
  );

  const rows = new Map<string, ConferenceRow>();
  let failed = 0;
  for (const row of fetched) {
    if (row && !rows.has(String(row.url))) {
      rows.set(String(row.url), row);
    } else if (row === null) {
      failed++;
    }
  }
  if (failed > 0) {
    logger.warn(`cvf: ${failed}/${paths.length} detail pages failed to fetch/parse (dropped)`);
  }
  return { rows: [...rows.values()], complete: listingOk && failed === 0 };
}
