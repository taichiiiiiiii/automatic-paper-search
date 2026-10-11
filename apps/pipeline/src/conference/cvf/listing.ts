/**
 * CVF Open Access year-listing parsing — TS port of
 * `paperpilot/scripts/collect_cvf.py::detail_paths`, plus the listing-only
 * parser {@link parseListingEntries}.
 */

import { stripTagsUnescapeCollapse } from "../shared/pyText.js";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Ordered, de-duplicated detail-page paths for a CVF year listing. */
export function detailPaths(listingHtml: string, cvfId: string): string[] {
  const re = new RegExp(`href="(/content/${escapeRegExp(cvfId)}/html/[^"]+?\\.html)"`, "g");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of listingHtml.matchAll(re)) {
    const path = m[1];
    if (path === undefined || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

/** One paper as shown on the year listing (no detail-page fetch). */
export interface CvfListingEntry {
  path: string;
  title: string;
  authors: string[];
  pdfPath: string;
}

/**
 * Parse every `<dt class="ptitle">` entry of a CVF year listing into title,
 * authors and links — the listing-only mode (design 51 B5 / D5=A: CVF grants
 * no licence, so CVF catalogs carry titles, authors and links but no
 * abstracts, and one listing request replaces thousands of detail fetches).
 * Entries without a title or author are counted in `malformed`.
 */
export function parseListingEntries(
  listingHtml: string,
  cvfId: string,
): { entries: CvfListingEntry[]; blockCount: number; malformed: number } {
  const id = escapeRegExp(cvfId);
  const titleRe = new RegExp(`<a href="(/content/${id}/html/[^"]+?\\.html)">([\\s\\S]*?)</a>`);
  const authorRe = /<input type="hidden" name="query_author" value="([^"]*)">/g;
  const pdfRe = new RegExp(`href="(/content/${id}/papers/[^"]+?\\.pdf)"`);
  const blocks = listingHtml.split('<dt class="ptitle">').slice(1);
  const entries: CvfListingEntry[] = [];
  const seen = new Set<string>();
  let malformed = 0;
  for (const raw of blocks) {
    const block = raw.split("<dt")[0] ?? raw;
    const t = titleRe.exec(block);
    const authors = [...block.matchAll(authorRe)]
      .map((m) => stripTagsUnescapeCollapse(m[1] ?? ""))
      .filter((a) => a.length > 0);
    const title = t ? stripTagsUnescapeCollapse(t[2] ?? "") : "";
    if (!t || !title || authors.length === 0) {
      malformed++;
      continue;
    }
    const path = t[1] as string;
    if (seen.has(path)) continue;
    seen.add(path);
    entries.push({ path, title, authors, pdfPath: pdfRe.exec(block)?.[1] ?? "" });
  }
  return { entries, blockCount: blocks.length, malformed };
}
