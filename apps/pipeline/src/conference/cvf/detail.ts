/**
 * CVF Open Access detail-page parsing — TS port of
 * `paperpilot/scripts/collect_cvf.py::parse_detail` (+ `_reformat_author`).
 */

import { venueTier } from "../../collect/signals/venue.js";
import type { ConferenceRow } from "../shared/csvColumns.js";
import { htmlUnescape, stripTagsUnescapeCollapse } from "../shared/pyText.js";

const ABSTRACT_OPEN_RE = /<div id="abstract"[^>]*>/;
/** Opening `<div …>` / `<div>` or closing `</div>` tags, in document order. */
// `[^<>]*` (not `[^>]*`): a malformed `<div` with no `>` must not swallow the
// following `</div>` (keeps the old first-`</div>` result) nor make each
// unterminated `<div` rescan to the end of the page (quadratic time).
const DIV_TAG_RE = /<div(?=[\s>/])[^<>]*>|<\/div>/g;
const TITLE_RE = /<meta\s+name="citation_title"\s+content="(.*?)"/i;
const AUTHOR_RE = /<meta\s+name="citation_author"\s+content="(.*?)"/gi;
const PDF_RE = /<meta\s+name="citation_pdf_url"\s+content="(.*?)"/i;

/**
 * Inner HTML of `<div id="abstract">` up to its MATCHING `</div>` (#345 item
 * 1): nested `<div>…</div>` inside the abstract are counted, so the text no
 * longer stops at the first inner close tag. Returns `null` when the abstract
 * div is missing or never closes — the caller records an empty abstract
 * rather than guessing where it ends. With no nested div this is exactly the
 * old lazy match up to the first `</div>`.
 */
export function extractAbstractHtml(detailHtml: string): string | null {
  const open = ABSTRACT_OPEN_RE.exec(detailHtml);
  if (!open) return null;
  const start = open.index + open[0].length;
  const tags = new RegExp(DIV_TAG_RE.source, "g");
  tags.lastIndex = start;
  let depth = 1;
  for (let m = tags.exec(detailHtml); m !== null; m = tags.exec(detailHtml)) {
    depth += m[0] === "</div>" ? -1 : 1;
    if (depth === 0) return detailHtml.slice(start, m.index);
  }
  return null;
}

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
  const absHtml = extractAbstractHtml(detailHtml);

  return {
    title,
    authors,
    venue: venue.toUpperCase(),
    venue_tier: venueTier(venue),
    citation_count: 0,
    github_stars: 0,
    arxiv_id: "",
    abstract: absHtml === null ? "" : stripTagsUnescapeCollapse(absHtml),
    url: detailUrl,
    pdf_url: pdfM ? htmlUnescape(pdfM[1] ?? "") : "",
    comment: "",
  };
}
