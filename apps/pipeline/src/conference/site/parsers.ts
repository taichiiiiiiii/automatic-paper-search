/**
 * Official conference listings without a shared paper id (R3-4, design 52
 * §8.6). Every parser here yields titles, authors and links only — none of
 * these sources licenses its abstracts to the public, so abstracts are never
 * read (design 51 B5, the same rule as CVF `--listing-only`). Rows are keyed
 * by the `conference_site` identity namespace (`@paperpilot/core/identity`).
 *
 * - {@link parseProceedingsSiteListing}: NeurIPS / ICLR proceedings
 *   (`papers.nips.cc`, `proceedings.iclr.cc`), one year listing request.
 * - {@link parseEcvaListing}: ECVA open access `papers.php` (all ECCV years
 *   on one page; one request), section `ECCV <year> Papers`.
 * - {@link parseVirtualSiteExport}: the CSV a conference virtual site's
 *   `/Downloads/<year>` page exports (gated, design 52 D6).
 */

import { parseCsvRows, stripBom } from "../../catalog/csv.js";
import { venueTier } from "../../collect/signals/venue.js";
import { parseProceedingsListing } from "../neurips/listing.js";
import type { ConferenceRow } from "../shared/csvColumns.js";
import { htmlUnescape, pyWhitespaceCollapse, stripTagsUnescapeCollapse } from "../shared/pyText.js";

export interface SiteEntry {
  title: string;
  authors: string[];
  /** Landing page; must parse with `identityFromUrl` as `conference_site`. */
  url: string;
  pdfUrl: string;
}

export interface SiteParseResult {
  entries: SiteEntry[];
  /** Entries seen on the page (parsed + malformed), before track filtering. */
  seen: number;
  malformed: number;
  /**
   * Entries skipped on purpose (other tracks, non-poster events), by
   * reason; also `repaired_affiliation_parens` (kept rows whose author
   * field needed the tolerant split).
   */
  skipped: Record<string, number>;
}

/** Proceedings sites running the NeurIPS proceedings software. */
export const PROCEEDINGS_SITES = {
  neurips: "https://papers.nips.cc",
  iclr: "https://proceedings.iclr.cc",
} as const;
export type ProceedingsSite = keyof typeof PROCEEDINGS_SITES;

export function proceedingsListingUrl(site: ProceedingsSite, year: number): string {
  return `${PROCEEDINGS_SITES[site]}/paper_files/paper/${year}`;
}

/** `…/hash/<h>-Abstract-<Track>.html` -> `…/file/<h>-Paper-<Track>.pdf` (the site's own PDF link). */
export function proceedingsPdfUrl(landingUrl: string): string {
  const m = /^(.*)\/hash\/([0-9a-f]{32})-Abstract-([A-Za-z_]+)\.html$/.exec(landingUrl);
  return m ? `${m[1]}/file/${m[2]}-Paper-${m[3]}.pdf` : "";
}

export function parseProceedingsSiteListing(
  html: string,
  site: ProceedingsSite,
  year: number,
  tracks: ReadonlySet<string>,
): SiteParseResult {
  const { entries, malformed } = parseProceedingsListing(html, year, PROCEEDINGS_SITES[site]);
  const skipped: Record<string, number> = {};
  const kept: SiteEntry[] = [];
  for (const e of entries) {
    if (!tracks.has(e.track)) {
      skipped[`track:${e.track}`] = (skipped[`track:${e.track}`] ?? 0) + 1;
      continue;
    }
    kept.push({
      title: e.title,
      authors: e.authors,
      url: e.landingUrl,
      pdfUrl: proceedingsPdfUrl(e.landingUrl),
    });
  }
  return { entries: kept, seen: entries.length + malformed, malformed, skipped };
}

export const ECVA_BASE = "https://www.ecva.net";
export const ECVA_PAPERS_URL = `${ECVA_BASE}/papers.php`;

/**
 * Parse the `ECCV <year> Papers` section of ECVA's `papers.php`. Returns
 * `null` when the page has no section for that year yet (not published).
 * Only the `<n>_ECCV_<year>_paper.php` form (ECCV 2022 and 2024 use it) is
 * accepted; anything else counts as malformed (the run then writes nothing).
 */
export function parseEcvaListing(html: string, year: number): SiteParseResult | null {
  const sections = html.split(/<button class="accordion"[^>]*>/);
  const section = sections.find((s) => new RegExp(`^\\s*ECCV ${year} Papers\\s*<`).test(s));
  if (section === undefined) return null;
  const blocks = section.split(/<dt class="ptitle">/).slice(1);
  const titleRe = new RegExp(
    `<a href=['"]?(papers/eccv_${year}/papers_ECCV/html/[1-9][0-9]*_ECCV_${year}_paper\\.php)['"]?>([\\s\\S]*?)</a>`,
  );
  const authorsRe = /<\/dt>\s*<dd>([\s\S]*?)<\/dd>/;
  const pdfRe = new RegExp(
    `href=['"](papers/eccv_${year}/papers_ECCV/papers/[^'"]+?\\.pdf)['"]>pdf<`,
  );
  const entries: SiteEntry[] = [];
  const seenUrls = new Set<string>();
  let malformed = 0;
  for (const block of blocks) {
    const t = titleRe.exec(block);
    const title = t ? stripTagsUnescapeCollapse(t[2] ?? "") : "";
    const authors = stripTagsUnescapeCollapse(authorsRe.exec(block)?.[1] ?? "")
      .split(",")
      .map((a) => pyWhitespaceCollapse(a.replace(/\*/g, "")))
      .filter((a) => a.length > 0);
    if (!t || !title || authors.length === 0) {
      malformed++;
      continue;
    }
    const url = `${ECVA_BASE}/${t[1]}`;
    if (seenUrls.has(url)) continue;
    seenUrls.add(url);
    const pdf = pdfRe.exec(block)?.[1];
    entries.push({ title, authors, url, pdfUrl: pdf ? `${ECVA_BASE}/${pdf}` : "" });
  }
  return { entries, seen: blocks.length, malformed, skipped: {} };
}

/** Virtual sites (same conference software) and their `Downloads` origin. */
export const VIRTUAL_SITES = {
  neurips: "https://neurips.cc",
  icml: "https://icml.cc",
  iclr: "https://iclr.cc",
  eccv: "https://eccv.ecva.net",
} as const;
export type VirtualSite = keyof typeof VIRTUAL_SITES;

export function virtualDownloadsUrl(site: VirtualSite, year: number): string {
  return `${VIRTUAL_SITES[site]}/Downloads/${year}`;
}

/**
 * Split `"A (Univ, Dept), B, C (X (Y))"` into names, dropping the
 * parenthesised affiliations. The export's affiliations are free text and
 * are sometimes unbalanced (`"KAIST))"`, a truncated `"(Guangzhou"` at the
 * end; 4 of 9,110 NeurIPS 2026 rows): a stray `)` is ignored and an
 * unclosed `(` at the end only drops that affiliation. `repaired` says
 * whether either happened, so the caller can report it.
 */
export function splitExportAuthors(raw: string): { names: string[]; repaired: boolean } {
  const names: string[] = [];
  let depth = 0;
  let repaired = false;
  let current = "";
  for (const ch of htmlUnescape(raw)) {
    if (ch === "(" || ch === "\uFF08") {
      depth++;
      continue;
    }
    if (ch === ")" || ch === "\uFF09") {
      if (depth === 0) repaired = true;
      else depth--;
      continue;
    }
    if (depth > 0) continue;
    if (ch === ",") {
      names.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (depth !== 0) repaired = true;
  names.push(current);
  return { names: names.map((n) => pyWhitespaceCollapse(n)).filter((n) => n.length > 0), repaired };
}

/**
 * Parse the virtual site's `Downloads/<year>` CSV export (columns `type`,
 * `name`, `virtualsite_url`, `speakers/authors`, `abstract`). Keeps
 * `Poster` rows whose URL is `/virtual/<year>/poster/<n>` on that site;
 * other events (sessions, workshops, talks) are skipped and counted. The
 * `abstract` column is never read.
 */
export function parseVirtualSiteExport(
  csvText: string,
  site: VirtualSite,
  year: number,
): SiteParseResult {
  const rows = parseCsvRows(stripBom(csvText));
  const header = rows[0] ?? [];
  const col = (name: string) => header.indexOf(name);
  const iType = col("type");
  const iName = col("name");
  const iUrl = col("virtualsite_url");
  const iAuthors = col("speakers/authors");
  if (iType < 0 || iName < 0 || iUrl < 0 || iAuthors < 0) {
    throw new Error(
      "virtual site export: expected columns type, name, virtualsite_url, speakers/authors",
    );
  }
  const posterRe = new RegExp(
    `^${VIRTUAL_SITES[site].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/virtual/${year}/poster/[1-9][0-9]*$`,
  );
  const entries: SiteEntry[] = [];
  const skipped: Record<string, number> = {};
  const seenUrls = new Set<string>();
  let malformed = 0;
  let seen = 0;
  for (const row of rows.slice(1)) {
    if (row.length === 0 || (row.length === 1 && row[0] === "")) continue;
    seen++;
    const type = (row[iType] ?? "").trim();
    const url = (row[iUrl] ?? "").trim();
    if (type !== "Poster" || !posterRe.test(url)) {
      const reason = type !== "Poster" ? `type:${type || "?"}` : "non-poster-url";
      skipped[reason] = (skipped[reason] ?? 0) + 1;
      continue;
    }
    const title = pyWhitespaceCollapse(htmlUnescape(row[iName] ?? ""));
    const { names: authors, repaired } = splitExportAuthors(row[iAuthors] ?? "");
    if (!title || authors.length === 0) {
      malformed++;
      continue;
    }
    if (repaired)
      skipped.repaired_affiliation_parens = (skipped.repaired_affiliation_parens ?? 0) + 1;
    if (seenUrls.has(url)) {
      skipped.duplicate = (skipped.duplicate ?? 0) + 1;
      continue;
    }
    seenUrls.add(url);
    entries.push({ title, authors, url, pdfUrl: "" });
  }
  return { entries, seen, malformed, skipped };
}

/** Catalog rows (shared CSV schema) for listing-only entries. */
export function siteRows(entries: readonly SiteEntry[], venue: string): ConferenceRow[] {
  const tier = venueTier(venue);
  return entries.map((e) => ({
    title: e.title,
    authors: e.authors.join("; "),
    venue: venue.toUpperCase(),
    venue_tier: tier,
    citation_count: 0,
    github_stars: 0,
    arxiv_id: "",
    abstract: "",
    url: e.url,
    pdf_url: e.pdfUrl,
    comment: "",
  }));
}
