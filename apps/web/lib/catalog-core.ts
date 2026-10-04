/**
 * Catalog contracts ported from docs/assets/catalog-core.js (the catalog
 * subset only -- the paper-slides contracts in that file are a dormant
 * scaffold with a hard-coded null API base / trust root and no live
 * production surface; CLAUDE.md calls `paper-slides-on-demand.yml` a
 * "休眠scaffold", and design doc §12-1's default is to delete it at P5.
 * Not ported here; see the P2 page-port report for the full rationale).
 *
 * Safety contracts (docs/migration/safety-contracts.md):
 *   SCR-16 validateCatalog / readPaperParam / detailShardUrl /
 *           readDetailAbstract
 *   SCR-17 setPaperParam (and lib/catalog-history.ts for the history
 *           restore contract)
 */
import { BASE_PATH } from "@paperpilot/core/site";

export const PAPER_ID_RE = /^[0-9a-f]{40}$/;

export function isPaperId(value: unknown): value is string {
  return typeof value === "string" && PAPER_ID_RE.test(value);
}

/** The shape every catalog row must have for the viewer to trust it.
 * Mirrors papers.json's actual fields (lib/data.ts's `PaperSchema`) plus
 * whatever else a given conference's row carries. */
export interface CatalogPaper {
  paper_id: string;
  title: string;
  authors: string[];
  tags: string[];
  abstract: string;
  type: string;
  arxiv_id?: string;
  arxiv_url?: string;
  pdf_url?: string;
  [key: string]: unknown;
}

/**
 * Validates a fetched papers.json array and indexes it by paper_id.
 * Throws (never returns an empty/partial map) on the first invalid row,
 * matching docs/assets/catalog-core.js `validateCatalog` -- an array that
 * fails validation must not fall back to "catalog is empty" so the
 * caller can offer the same distinct error state as HTTP failure (SCR-16
 * / SCR-15, app.js `fetchCatalog`).
 */
export function validateCatalog(papers: unknown): Map<string, CatalogPaper> {
  if (!Array.isArray(papers)) throw new Error("catalog must be an array");
  const byId = new Map<string, CatalogPaper>();
  papers.forEach((paper: unknown, ordinal: number) => {
    if (!paper || typeof paper !== "object" || Array.isArray(paper)) {
      throw new Error(`catalog row ${ordinal} must be an object`);
    }
    const row = paper as Record<string, unknown>;
    if (!isPaperId(row.paper_id)) {
      throw new Error(`catalog row ${ordinal} has invalid paper_id`);
    }
    if (byId.has(row.paper_id)) {
      throw new Error(`duplicate paper_id: ${row.paper_id}`);
    }
    if (typeof row.title !== "string" || !row.title.trim()) {
      throw new Error(`catalog row ${ordinal} has invalid title`);
    }
    if (!Array.isArray(row.authors) || !row.authors.every((item) => typeof item === "string")) {
      throw new Error(`catalog row ${ordinal} has invalid authors`);
    }
    if (!Array.isArray(row.tags) || !row.tags.every((item) => typeof item === "string")) {
      throw new Error(`catalog row ${ordinal} has invalid tags`);
    }
    if (typeof row.abstract !== "string") {
      throw new Error(`catalog row ${ordinal} has invalid abstract`);
    }
    byId.set(row.paper_id, row as unknown as CatalogPaper);
  });
  return byId;
}

/** Reads `?paper=` from a query string. `raw` is the unvalidated value (or
 * null if absent); `paperId` is `raw` only when it is a well-formed
 * 40-hex paper_id -- never a value a caller can mistake for validated.
 */
export function readPaperParam(search: string): { raw: string | null; paperId: string | null } {
  const raw = new URLSearchParams(search).get("paper");
  return { raw, paperId: isPaperId(raw) ? raw : null };
}

/** Moves the selected paper (if any) to the front, preserving the order
 * of everything else -- so the selected card is never scrolled away by
 * its own filter/sort position. */
export function pinSelected<T extends { paper_id: string }>(papers: T[], selected: T | null): T[] {
  if (!selected) return [...papers];
  return [selected, ...papers.filter((paper) => paper.paper_id !== selected.paper_id)];
}

/** Absolute, site-root-relative path to the paper-details-v1 shard that
 * holds `paperId`'s full abstract (256 shards, keyed by the first two hex
 * chars of the id). BASE_PATH is "" on the current (Cloudflare Pages)
 * origin; kept here (not hard-coded "/") so a future non-root deployment
 * only has to change packages/core/src/site/config.ts. */
export function detailShardUrl(paperId: string): string {
  if (!isPaperId(paperId)) throw new Error("invalid paper_id for detail shard");
  return `${BASE_PATH}/paper-details-v1/${paperId.slice(0, 2)}.json`;
}

/**
 * Validates one paper-details-v1 shard (exact keys, schema_version,
 * prefix match, strictly sorted paper_id rows) and binary-searches it for
 * `paperId`'s full abstract text. Throws on any shape mismatch or a
 * missing id -- a malformed/foreign shard must never be read as "no
 * abstract" (that is a valid `""` row, distinct from "the shard is
 * broken").
 */
export function readDetailAbstract(data: unknown, paperId: string): string {
  if (!isPaperId(paperId)) throw new Error("invalid paper_id for detail lookup");
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("detail shard must be an object");
  }
  const record = data as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expectedKeys = ["papers", "prefix", "schema_version"];
  if (keys.length !== expectedKeys.length || keys.some((key, i) => key !== expectedKeys[i])) {
    throw new Error("detail shard has unexpected fields");
  }
  if (record.schema_version !== "paper-details-v1") {
    throw new Error("detail shard schema_version is invalid");
  }
  const prefix = paperId.slice(0, 2);
  if (record.prefix !== prefix) throw new Error("detail shard prefix does not match paper_id");
  if (!Array.isArray(record.papers)) throw new Error("detail shard papers must be an array");

  let previous: string | null = null;
  const rows = record.papers as unknown[];
  rows.forEach((row: unknown, ordinal: number) => {
    if (
      !Array.isArray(row) ||
      row.length !== 2 ||
      !isPaperId(row[0]) ||
      !(row[0] as string).startsWith(prefix) ||
      typeof row[1] !== "string"
    ) {
      throw new Error(`detail shard row ${ordinal} is invalid`);
    }
    if (previous !== null && previous >= (row[0] as string)) {
      throw new Error("detail shard paper IDs must be strictly sorted");
    }
    previous = row[0] as string;
  });

  const sorted = rows as [string, string][];
  let low = 0;
  let high = sorted.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const row = sorted[mid];
    if (!row) break;
    if (row[0] === paperId) return row[1];
    if (row[0] < paperId) low = mid + 1;
    else high = mid - 1;
  }
  throw new Error(`paper_id not found in detail shard: ${paperId}`);
}

/** Sets or clears `?paper=` on a URL, leaving every other query param
 * untouched. Throws if asked to set a malformed id -- a caller must
 * never be able to put an unvalidated value in the address bar. */
export function setPaperParam(urlValue: string, paperId: string | null): string {
  const url = new URL(urlValue);
  if (paperId === null) {
    url.searchParams.delete("paper");
  } else {
    if (!isPaperId(paperId)) throw new Error("invalid paper_id for URL");
    url.searchParams.set("paper", paperId);
  }
  return url.toString();
}
