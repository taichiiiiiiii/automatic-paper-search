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
  return normalizeSearchText(search)
    .split(" ")
    .filter((t) => t.length > 0);
}

/** Lowercases and folds hyphens/dashes/slashes and every kind of
 * whitespace to one space, applied to both the query and the row text:
 * "self-supervised" and "self supervised" then find each other. */
export function normalizeSearchText(text: string): string {
  return text.toLowerCase().replace(/[\s\u3000\-\u2010-\u2015/]+/g, " ");
}

/** A query term written in the plural ("transformers", "diffusions")
 * also matches the singular in the text; a singular query already
 * substring-matches the plural. Only simple "-s" / "-es" endings on
 * terms of 5+ letters are folded, so short words ("gas", "loss") and
 * acronyms stay exact. */
export function termVariants(term: string): string[] {
  if (term.length < 5 || !term.endsWith("s") || term.endsWith("ss")) return [term];
  const out = [term, term.slice(0, -1)];
  if (term.endsWith("es")) out.push(term.slice(0, -2));
  return out;
}

// The lowercased title/authors/abstract string per row, built once per
// row object (not once per keystroke): with 6-9k rows the old per-filter
// rebuild dominated the cost of every debounced search.
const HAYSTACKS = new WeakMap<CatalogPaper, string>();

function haystack(p: CatalogPaper): string {
  let hay = HAYSTACKS.get(p);
  if (hay === undefined) {
    hay = normalizeSearchText(`${p.title} ${p.authors.join(" ")} ${p.abstract}`);
    HAYSTACKS.set(p, hay);
  }
  return hay;
}

export function paperHasAbstract(p: CatalogPaper): boolean {
  return typeof p.abstract === "string" && p.abstract.trim().length > 0;
}

export function getFiltered<T extends CatalogPaper>(papers: T[], filters: CatalogFilterState): T[] {
  const terms = searchTerms(filters.search).map(termVariants);
  return papers.filter((p) => {
    if (filters.type !== "all" && p.type !== filters.type) return false;
    if (filters.activeTags.size > 0 && !p.tags.some((t) => filters.activeTags.has(t))) return false;
    if (filters.hasAbstract && !paperHasAbstract(p)) return false;
    if (terms.length > 0) {
      const hay = haystack(p);
      for (const variants of terms) {
        if (!variants.some((v) => hay.includes(v))) return false;
      }
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
      return arr.sort((a, b) => titleSortKey(a.title).localeCompare(titleSortKey(b.title)));
    default:
      return arr;
  }
}

/** "タイトル A→Z" ignores leading LaTeX/punctuation ("$\\texttt{Multi}^2$",
 * '"Do Diffusion…"'), which used to put ~200 such titles before "A"
 * (design doc 53). */
export function titleSortKey(title: string | undefined): string {
  return (title || "").replace(/^(?:[^\p{L}\p{N}\\]|\\[a-zA-Z]+\{?)+/u, "");
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
