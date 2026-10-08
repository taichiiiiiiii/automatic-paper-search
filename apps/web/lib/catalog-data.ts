/**
 * Catalog-area data fetching, built on top of lib/data.ts's
 * `fetchConferencePapers` (general papers.json shape) plus the
 * catalog's own stricter validation (lib/catalog-core.ts
 * `validateCatalog`, SCR-16) and the two extra fetches the catalog page
 * needs that lib/data.ts does not provide: the paper-details-v1 full
 * abstract shard and the site-wide pilot-lineage index.
 *
 * Kept as a new file per the P2 page-port brief (never edit lib/data.ts
 * directly).
 */

import {
  type CatalogPaper,
  detailShardUrl,
  readDetailAbstract,
  validateCatalog,
} from "./catalog-core";
import { readBoundedJson } from "./catalog-fetch";
import {
  PILOT_LINEAGE_INDEX_MAX_BYTES,
  PILOT_LINEAGE_INDEX_PATH,
  type PilotLineageIndex,
  parsePilotLineageIndex,
} from "./catalog-pilot-lineage";
import { fetchConferencePapers } from "./data";

export type CatalogLoadResult =
  | { status: "ok"; papers: CatalogPaper[]; byId: Map<string, CatalogPaper> }
  | { status: "error"; error: string };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Fetches `/<slug>/papers.json` and applies the catalog's full
 * validation contract: `lib/data.ts`'s zod shape check, then
 * `validateCatalog`'s stricter per-row checks (unique 40-hex
 * `paper_id`, non-empty title, string[] authors/tags, string abstract),
 * then the empty-catalog-is-an-error rule (docs/assets/app.js
 * `fetchCatalog`: a published-but-empty papers.json is, for the reader,
 * indistinguishable from a broken load, so it takes the same "distinct
 * error state" path as an HTTP failure -- never rendered as "0 papers").
 */
export async function fetchCatalogPapers(slug: string): Promise<CatalogLoadResult> {
  const result = await fetchConferencePapers(slug);
  if (result.status === "error") return { status: "error", error: result.error };
  try {
    const byId = validateCatalog(result.data);
    if (result.data.length === 0) throw new Error("papers catalog is empty");
    return { status: "ok", papers: result.data as unknown as CatalogPaper[], byId };
  } catch (err) {
    return { status: "error", error: errorMessage(err) };
  }
}

export type FullAbstractResult = { status: "ready"; text: string } | { status: "failed" };

/** Fetches and validates the paper-details-v1 shard that holds
 * `paperId`'s full abstract (docs/assets/app.js `startFullAbstractLoad`).
 * An `AbortError` on `signal` propagates (the caller distinguishes
 * "cancelled" from "failed"); any other failure (HTTP, shape,
 * not-found-in-shard) resolves to `{ status: "failed" }`. */
export async function fetchFullAbstract(
  paperId: string,
  signal?: AbortSignal,
): Promise<FullAbstractResult> {
  try {
    const response = await fetch(detailShardUrl(paperId), { cache: "no-cache", signal });
    if (!response.ok) throw new Error(`detail shard HTTP ${response.status}`);
    const data = await response.json();
    return { status: "ready", text: readDetailAbstract(data, paperId) };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw err;
    return { status: "failed" };
  }
}

/**
 * Fetches and validates the site-wide pilot-lineage index
 * (SCR-19/SCR-20). Never throws except on an aborted `signal` (so a
 * caller-managed deadline can distinguish "timed out" from "the server
 * said no"); any other failure resolves to `null`, matching
 * docs/assets/app.js `readPilotLineageIndex`'s fail-closed behavior.
 */
export async function fetchPilotLineageIndex(
  signal?: AbortSignal,
): Promise<PilotLineageIndex | null> {
  try {
    const response = await fetch(PILOT_LINEAGE_INDEX_PATH, {
      cache: "no-cache",
      credentials: "same-origin",
      redirect: "error",
      referrerPolicy: "same-origin",
      signal,
      headers: { accept: "application/json" },
    });
    const expectedUrl =
      typeof window !== "undefined"
        ? new URL(PILOT_LINEAGE_INDEX_PATH, window.location.href).href
        : undefined;
    const raw = await readBoundedJson(response, {
      maxBytes: PILOT_LINEAGE_INDEX_MAX_BYTES,
      expectedUrl,
    });
    return parsePilotLineageIndex(raw);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw err;
    return null;
  }
}
