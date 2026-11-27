/**
 * CVF Open Access year-listing parsing — TS port of
 * `paperpilot/scripts/collect_cvf.py::detail_paths`, plus the listing-only
 * parser {@link parseListingEntries}.
 */

import { stripTagsUnescapeCollapse } from "../shared/pyText.js";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Optional `https://openaccess.thecvf.com` (or `http:` / protocol-relative)
 * prefix of a listing href. Only this host is accepted: an absolute link to
 * any other host never matches, because the path must follow immediately.
 */
const CVF_HOST_PREFIX = "(?:(?:https?:)?//openaccess\\.thecvf\\.com)?";
/** Optional `?query` and/or `#fragment` after the path, up to the closing quote. */
const QUERY_FRAGMENT = '(?:[?#][^"]*)?';

/**
 * Pattern for one href value pointing at `/content/<cvfId>/<kind>/….<ext>`,
 * capturing only the relative path (#345 item 3: links may be absolute or
 * carry a query/fragment; all forms normalise to the relative path that
 * today's relative links produce, so de-duplication and URLs stay the same).
 */
function hrefPathPattern(cvfId: string, kind: "html" | "papers", ext: "html" | "pdf"): string {
  return `${CVF_HOST_PREFIX}(/content/${escapeRegExp(cvfId)}/${kind}/[^"?#]+?\\.${ext})${QUERY_FRAGMENT}"`;
}

/** Ordered, de-duplicated detail-page paths for a CVF year listing. */
export function detailPaths(listingHtml: string, cvfId: string): string[] {
  const re = new RegExp(`href="${hrefPathPattern(cvfId, "html", "html")}`, "g");
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
  const titleRe = new RegExp(`<a href="${hrefPathPattern(cvfId, "html", "html")}>([\\s\\S]*?)</a>`);
  const authorRe = /<input type="hidden" name="query_author" value="([^"]*)">/g;
  const pdfRe = new RegExp(`href="${hrefPathPattern(cvfId, "papers", "pdf")}`);
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
