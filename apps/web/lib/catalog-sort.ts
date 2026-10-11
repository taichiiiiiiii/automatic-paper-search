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
  /** UX audit (design doc 53): keep only rows whose papers.json row
   * carries an abstract preview (`abs=1`). Optional so existing callers
   * keep the unfiltered behaviour. */
  hasAbstract?: boolean;
}

/**
 * Splits a search query into lowercase terms (ASCII and full-width
 * whitespace both separate terms). A row matches when EVERY term occurs
 * somewhere in its title/authors/abstract -- "video diffusion" finds
 * "diffusion models for video", which the old single-substring match
 * missed. A one-word query behaves exactly as before.
 */
export function searchTerms(search: string): string[] {
  return search
    .toLowerCase()
    .split(/[\s\u3000]+/)
    .filter((t) => t.length > 0);
}

// The lowercased title/authors/abstract string per row, built once per
// row object (not once per keystroke): with 6-9k rows the old per-filter
// rebuild dominated the cost of every debounced search.
const HAYSTACKS = new WeakMap<CatalogPaper, string>();

function haystack(p: CatalogPaper): string {
  let hay = HAYSTACKS.get(p);
  if (hay === undefined) {
    hay = `${p.title} ${p.authors.join(" ")} ${p.abstract}`.toLowerCase();
    HAYSTACKS.set(p, hay);
  }
  return hay;
}

export function paperHasAbstract(p: CatalogPaper): boolean {
  return typeof p.abstract === "string" && p.abstract.trim().length > 0;
}

export function getFiltered<T extends CatalogPaper>(papers: T[], filters: CatalogFilterState): T[] {
  const terms = searchTerms(filters.search);
  return papers.filter((p) => {
    if (filters.type !== "all" && p.type !== filters.type) return false;
    if (filters.activeTags.size > 0 && !p.tags.some((t) => filters.activeTags.has(t))) return false;
    if (filters.hasAbstract && !paperHasAbstract(p)) return false;
    if (terms.length > 0) {
      const hay = haystack(p);
      for (const term of terms) if (!hay.includes(term)) return false;
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
  return (
    filters.search.trim() !== "" ||
    filters.type !== "all" ||
    filters.activeTags.size > 0 ||
    Boolean(filters.hasAbstract)
  );
}

/** True when the query contains Japanese (kana/kanji) characters. Every
 * catalog's titles and abstracts are English, so such a query can only
 * match author names -- the empty state uses this to say so. */
export function hasJapaneseText(search: string): boolean {
  return /[\u3040-\u30ff\u3400-\u9fff\uff66-\uff9f]/.test(search);
}
