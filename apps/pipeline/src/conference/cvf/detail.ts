/**
 * CVF Open Access detail-page parsing — TS port of
 * `paperpilot/scripts/collect_cvf.py::parse_detail` (+ `_reformat_author`).
 */

import { venueTier } from "../../collect/signals/venue.js";
import type { ConferenceRow } from "../shared/csvColumns.js";
import { htmlUnescape, stripTagsUnescapeCollapse } from "../shared/pyText.js";

const ABSTRACT_RE = /<div id="abstract"[^>]*>([\s\S]*?)<\/div>/;
const TITLE_RE = /<meta\s+name="citation_title"\s+content="(.*?)"/i;
const AUTHOR_RE = /<meta\s+name="citation_author"\s+content="(.*?)"/gi;
const PDF_RE = /<meta\s+name="citation_pdf_url"\s+content="(.*?)"/i;

/** Highwire gives "Last, First"; render "First Last" to match other catalogs. */
export function reformatAuthor(name: string): string {
  const trimmed = name.trim();
  const idx = trimmed.indexOf(", ");
  if (idx >= 0) {
    const last = trimmed.slice(0, idx).trim();
    const first = trimmed.slice(idx + 2).trim();
    return `${first} ${last}`;
  }
  return trimmed;
}

/** Map one CVF detail page to a catalog row. Returns `null` if no title. */
export function parseDetail(
  detailHtml: string,
  detailUrl: string,
  venue: string,
): ConferenceRow | null {
  const titleM = TITLE_RE.exec(detailHtml);
  const title = titleM ? stripTagsUnescapeCollapse(titleM[1] ?? "") : "";
  if (!title) return null;

  const authorNames: string[] = [];
  for (const m of detailHtml.matchAll(AUTHOR_RE)) {
    authorNames.push(reformatAuthor(htmlUnescape(m[1] ?? "")));
  }
  const authors = authorNames.join("; ");

  const pdfM = PDF_RE.exec(detailHtml);
  const absM = ABSTRACT_RE.exec(detailHtml);

  return {
    title,
    authors,
    venue: venue.toUpperCase(),
    venue_tier: venueTier(venue),
    citation_count: 0,
    github_stars: 0,
    arxiv_id: "",
    abstract: absM ? stripTagsUnescapeCollapse(absM[1] ?? "") : "",
    url: detailUrl,
    pdf_url: pdfM ? htmlUnescape(pdfM[1] ?? "") : "",
    comment: "",
  };
}
