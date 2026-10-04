/**
 * Build-time helper for `app/[conf]/page.tsx`'s `generateStaticParams`:
 * decides which rows of conferences.json become a `/<conf>/` catalog
 * route. Pure (no `node:fs` here -- the page component does the file
 * read; see its own doc comment for why).
 */

import { RESERVED_CATALOG_SLUGS } from "./catalog-constants";
import { type ConferenceSummary, ConferenceSummarySchema } from "./data";

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/** A slug may become a `/<conf>/` catalog route only if it looks like a
 * conference slug AND is not one of the reserved top-level site
 * sections (design doc §8 P2: "keep reserved slugs like `daily`,
 * `themes`, `lineage`, `how-it-works` out"). None of today's
 * conferences.json rows collide with those, but a future row must not
 * be able to silently shadow (or be shadowed by) one of those routes. */
export function isCatalogSlug(slug: string): boolean {
  return SLUG_RE.test(slug) && !RESERVED_CATALOG_SLUGS.has(slug);
}

/**
 * Validates + filters a parsed conferences.json array down to the rows
 * that may become a catalog route. Throws if `raw` is not an array of
 * well-formed `ConferenceSummary` rows -- a build must fail loudly on a
 * corrupt conferences.json, never silently produce a site with zero (or
 * partial) catalog routes.
 */
export function selectCatalogConferences(raw: unknown): ConferenceSummary[] {
  const parsed = ConferenceSummarySchema.array().parse(raw);
  return parsed.filter((row) => isCatalogSlug(row.name));
}
