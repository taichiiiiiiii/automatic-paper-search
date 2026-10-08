/**
 * Filter/sort pure logic, ported from docs/assets/app.js (`getFiltered`,
 * `getSorted`, `byNewest`, `applySortAvailability`).
 */

import type { AcceptanceType } from "./catalog-constants";
import { NEWEST_LABEL, NEWEST_UNAVAILABLE_LABEL, type SortValue } from "./catalog-constants";
import type { CatalogPaper } from "./catalog-core";

export interface CatalogFilterState {
  search: string;
  type: AcceptanceType;
  activeTags: ReadonlySet<string>;
}

export function getFiltered<T extends CatalogPaper>(papers: T[], filters: CatalogFilterState): T[] {
  const q = filters.search.toLowerCase().trim();
  return papers.filter((p) => {
    if (filters.type !== "all" && p.type !== filters.type) return false;
    if (filters.activeTags.size > 0 && !p.tags.some((t) => filters.activeTags.has(t))) return false;
    if (q) {
      const hay = `${p.title} ${p.authors.join(" ")} ${p.abstract}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/**
 * citation_count / venue_tier / github_stars are ~0 for fresh-from-arXiv
 * papers, so sorting on them would be misleading; the meaningful axes
 * are recency (arXiv id), Oral-first, and title. `Array.prototype.sort`
 * is stable, so "oral" preserves the collection order within each group.
 * A missing arXiv id is "unknown", not "oldest": id-less rows go after
 * the dated ones and keep their collection order among themselves.
 */
export function byNewest(a: CatalogPaper, b: CatalogPaper): number {
  const aId = a.arxiv_id || "";
  const bId = b.arxiv_id || "";
  if (!aId && !bId) return 0;
  if (!aId) return 1;
  if (!bId) return -1;
  return bId.localeCompare(aId, undefined, { numeric: true });
}

export function getSorted<T extends CatalogPaper>(papers: T[], sort: SortValue): T[] {
  const arr = [...papers];
  switch (sort) {
    case "newest":
      return arr.sort(byNewest);
    case "oral":
      return arr.sort((a, b) => (a.type === "Oral" ? 0 : 1) - (b.type === "Oral" ? 0 : 1));
    case "title":
      return arr.sort((a, b) => (a.title || "").localeCompare(b.title || ""));
    default:
      return arr;
  }
}

export interface NewestAvailability {
  usable: boolean;
  label: string;
}

/**
 * Whether "新着順" is usable for the LOADED rows (not the conference):
 * some collections (CVF, OpenReview) publish without an arXiv id at
 * all. When unusable, the caller must fall the sort back to "default"
 * and rewrite the URL so the stale `sort=newest` cannot come back on
 * reload (docs/assets/app.js `applySortAvailability`).
 */
export function newestAvailability(papers: readonly CatalogPaper[]): NewestAvailability {
  const usable = papers.some((p) => Boolean(p.arxiv_id));
  return { usable, label: usable ? NEWEST_LABEL : NEWEST_UNAVAILABLE_LABEL };
}

export function hasActiveFilters(filters: CatalogFilterState): boolean {
  return filters.search.trim() !== "" || filters.type !== "all" || filters.activeTags.size > 0;
}
