/**
 * NeurIPS proceedings (`papers.nips.cc`) listing adapter — design 52 §3.2
 * stage (d) / user decision D5=A.
 *
 * Scope is deliberately narrow:
 *
 * - Titles, authors, track and the proceedings landing URL only. NeurIPS
 *   authors keep copyright and grant NeurIPS (not the public) a licence
 *   (`nips.cc/FAQ/Copyright`), so abstracts are never collected.
 * - One request per year: the `/paper_files/paper/<year>` listing. No
 *   per-paper fetches.
 * - Output is a reconciliation report against an already-published catalog
 *   (state `published → reconciled` in design 52 §4.2), NOT a catalog:
 *   the listing exposes only content hashes, not the OpenReview forum id the
 *   NeurIPS catalogs are keyed by, and adding a new identity namespace would
 *   touch the lineage code. Publishing a NeurIPS edition still needs an
 *   identity source (OpenReview /groups + an accepted list; design 52 D1/D2).
 *
 * Observed 2026-10-11: the 2025 listing carries only the Creative AI track
 * (64 papers); the main track is not yet on papers.nips.cc. 2024 has 4,034
 * main-track + 459 datasets-and-benchmarks papers.
 */

import { pyWhitespaceCollapse, stripTagsUnescapeCollapse } from "../shared/pyText.js";

export const NEURIPS_PROCEEDINGS_BASE = "https://papers.nips.cc";

export interface NeuripsListingEntry {
  title: string;
  authors: string[];
  /** `data-track` value, e.g. `conference`, `datasets_and_benchmarks_track`, `creative_ai_track`. */
  track: string;
  /** 32-hex content hash from the abstract-page URL. */
  hash: string;
  landingUrl: string;
}

export function listingUrl(year: number): string {
  return `${NEURIPS_PROCEEDINGS_BASE}/paper_files/paper/${year}`;
}

const ITEM_RE = /<li class="[a-z_]+" data-track="([a-z_]+)">([\s\S]*?)<\/li>/g;
const LINK_RE =
  /<a title="paper title" href="(\/paper_files\/paper\/(\d{4})\/hash\/([0-9a-f]{32})-Abstract-[A-Za-z_]+\.html)">([\s\S]*?)<\/a>/;
const AUTHORS_RE = /<span class="paper-authors">([\s\S]*?)<\/span>/;

/** Parse a year listing. Entries without a title link are counted as malformed. */
export function parseNeuripsListing(
  html: string,
  year: number,
): { entries: NeuripsListingEntry[]; malformed: number } {
  return parseProceedingsListing(html, year, NEURIPS_PROCEEDINGS_BASE);
}

/**
 * Same parser for any site running the NeurIPS proceedings software
 * (`papers.nips.cc`, `proceedings.iclr.cc`, R3-4): the listing markup and
 * the `/paper_files/paper/<year>/hash/<hash>-Abstract-<Track>.html` URLs are
 * identical; only the origin differs.
 */
export function parseProceedingsListing(
  html: string,
  year: number,
  base: string,
): { entries: NeuripsListingEntry[]; malformed: number } {
  const entries: NeuripsListingEntry[] = [];
  let malformed = 0;
  for (const m of html.matchAll(ITEM_RE)) {
    const body = m[2] ?? "";
    const link = LINK_RE.exec(body);
    if (!link || Number(link[2]) !== year) {
      malformed++;
      continue;
    }
    const title = stripTagsUnescapeCollapse(link[4] ?? "");
    // Some author names are double-escaped on the live page (`&amp;quot;`);
    // one unescape pass yields exactly what the page displays.
    const authors = stripTagsUnescapeCollapse(AUTHORS_RE.exec(body)?.[1] ?? "")
      .split(",")
      .map((a) => pyWhitespaceCollapse(a))
      .filter((a) => a.length > 0);
    if (!title) {
      malformed++;
      continue;
    }
    entries.push({
      title,
      authors,
      track: m[1] as string,
      hash: link[3] as string,
      landingUrl: `${base}${link[1]}`,
    });
  }
  return { entries, malformed };
}

/** Lower-case, alphanumeric-only title key for cross-source matching. */
export function titleKey(title: string): string {
  return title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

export interface ReconcileReport {
  schema_version: "conference-proceedings-reconcile-v1";
  source: "neurips_proceedings";
  year: number;
  listing_url: string;
  tracks: Record<string, number>;
  proceedings_count: number;
  catalog_count: number;
  matched: number;
  only_in_proceedings: number;
  only_in_catalog: number;
  /** Up to 20 examples each way, for a human to eyeball. */
  examples: { only_in_proceedings: string[]; only_in_catalog: string[] };
}

/** Compare listing titles (filtered to `tracks`) with a published catalog's titles. */
export function reconcileWithCatalog(
  entries: readonly NeuripsListingEntry[],
  catalogTitles: readonly string[],
  year: number,
  tracks: ReadonlySet<string>,
): ReconcileReport {
  const trackCounts: Record<string, number> = {};
  for (const e of entries) trackCounts[e.track] = (trackCounts[e.track] ?? 0) + 1;
  const proc = entries.filter((e) => tracks.has(e.track));
  const procKeys = new Map(proc.map((e) => [titleKey(e.title), e.title]));
  const catKeys = new Map(catalogTitles.map((t) => [titleKey(t), t]));
  const onlyProc = [...procKeys.entries()].filter(([k]) => !catKeys.has(k)).map(([, t]) => t);
  const onlyCat = [...catKeys.entries()].filter(([k]) => !procKeys.has(k)).map(([, t]) => t);
  return {
    schema_version: "conference-proceedings-reconcile-v1",
    source: "neurips_proceedings",
    year,
    listing_url: listingUrl(year),
    tracks: Object.fromEntries(Object.entries(trackCounts).sort()),
    proceedings_count: proc.length,
    catalog_count: catalogTitles.length,
    matched: [...procKeys.keys()].filter((k) => catKeys.has(k)).length,
    only_in_proceedings: onlyProc.length,
    only_in_catalog: onlyCat.length,
    examples: { only_in_proceedings: onlyProc.slice(0, 20), only_in_catalog: onlyCat.slice(0, 20) },
  };
}
