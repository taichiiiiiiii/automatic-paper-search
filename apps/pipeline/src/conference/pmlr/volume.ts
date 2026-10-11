/**
 * PMLR (Proceedings of Machine Learning Research) volume adapter — design 52
 * §4.1 案 A / user decision D5=A: build ICML (and other PMLR-published)
 * catalogs from the official proceedings instead of OpenReview `/notes`,
 * which refuses scripts with 403 `ChallengeRequiredError`.
 *
 * Two files per volume, both static (GitHub Pages; no robots.txt
 * restrictions, checked 2026-10-11):
 *
 * - `https://proceedings.mlr.press/v<N>/` — one HTML page listing every
 *   paper: title, authors, PMLR landing (`abs`), PDF and, for ICML, the
 *   OpenReview forum link.
 * - `https://proceedings.mlr.press/v<N>/assets/bib/bibliography.bib` — the
 *   volume BibTeX, which carries each paper's abstract.
 *
 * Identity: rows are keyed by the OpenReview forum id from the volume page
 * (`url = https://openreview.net/forum?id=<id>`), so ICML 2026 rows share
 * the `openreview:<forum>` identity every earlier ICML/NeurIPS/ICLR catalog
 * uses (no new identity namespace; nothing in the lineage code changes).
 * A volume where any paper lacks an OpenReview link is refused rather than
 * published with holes.
 *
 * Licence (design 51): the PMLR publication agreement grants the public a
 * CC BY 4.0 licence in each article and asks that attribution cite the
 * proceedings and link the PMLR page. Abstracts are therefore kept, and
 * `source_license.json` records CC BY 4.0, the attribution text and every
 * paper's PMLR landing URL. `--no-abstract` drops them if that changes.
 */

import { venueTier } from "../../collect/signals/venue.js";
import type { ConferenceRow } from "../shared/csvColumns.js";
import { htmlUnescape, pyWhitespaceCollapse } from "../shared/pyText.js";

export const PMLR_BASE = "https://proceedings.mlr.press";
export const OPENREVIEW_FORUM = "https://openreview.net/forum?id=";
export const PMLR_LICENSE = "CC-BY-4.0";
export const PMLR_LICENSE_URL = "https://creativecommons.org/licenses/by/4.0/";
export const PMLR_AGREEMENT_URL = "https://proceedings.mlr.press/pmlr-license-agreement.html";

export interface PmlrVolumeEntry {
  /** PMLR paper key, e.g. `abas26a`. */
  key: string;
  title: string;
  authors: string[];
  /** `https://proceedings.mlr.press/v306/abas26a.html` */
  landingUrl: string;
  pdfUrl: string;
  /** OpenReview forum id, or `null` when the page links none. */
  openreviewId: string | null;
  /** e.g. `PMLR 306:1-21`. */
  citation: string;
}

export interface PmlrVolumeParse {
  entries: PmlrVolumeEntry[];
  /** `<div class="paper">` blocks seen (parsed or not). */
  blockCount: number;
  /** Blocks that could not be parsed into an entry (missing title/authors/abs link). */
  malformed: number;
}

const PAPER_BLOCK_RE = /<div class="paper">([\s\S]*?)<p class="links">([\s\S]*?)<\/p>/g;
const TITLE_RE = /<p class="title">([\s\S]*?)<\/p>/;
const AUTHORS_RE = /<span class="authors">([\s\S]*?)<\/span>/;
const INFO_RE = /<span class="info">[\s\S]*?<\/i>,\s*([^<]*?)<\/span>/;
const ABS_RE = /href="(https:\/\/proceedings\.mlr\.press\/v(\d+)\/([A-Za-z0-9_-]+)\.html)"/;
const PDF_RE = /href="([^"]+\.pdf)"/;
const OPENREVIEW_RE = /href="https:\/\/openreview\.net\/forum\?id=([A-Za-z0-9_-]{1,256})"/;

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, "");
}

function cleanText(s: string): string {
  return pyWhitespaceCollapse(htmlUnescape(stripTags(s)));
}

/** Parse the volume listing page. Pure; never throws on odd markup (counts it as malformed). */
export function parseVolumeHtml(html: string, volume: number): PmlrVolumeParse {
  const entries: PmlrVolumeEntry[] = [];
  let blockCount = 0;
  let malformed = 0;
  for (const m of html.matchAll(PAPER_BLOCK_RE)) {
    blockCount++;
    const body = m[1] ?? "";
    const links = m[2] ?? "";
    const title = cleanText(TITLE_RE.exec(body)?.[1] ?? "");
    const authorsRaw = AUTHORS_RE.exec(body)?.[1] ?? "";
    const authors = htmlUnescape(authorsRaw)
      .split(",")
      .map((a) => pyWhitespaceCollapse(stripTags(a)))
      .filter((a) => a.length > 0);
    const abs = ABS_RE.exec(links);
    if (!title || authors.length === 0 || !abs || Number(abs[2]) !== volume) {
      malformed++;
      continue;
    }
    entries.push({
      key: abs[3] as string,
      title,
      authors,
      landingUrl: abs[1] as string,
      pdfUrl: htmlUnescape(PDF_RE.exec(links)?.[1] ?? ""),
      openreviewId: OPENREVIEW_RE.exec(links)?.[1] ?? null,
      citation: cleanText(INFO_RE.exec(body)?.[1] ?? ""),
    });
  }
  return { entries, blockCount, malformed };
}

// ---------------------------------------------------------------------------
// BibTeX (abstracts only)
// ---------------------------------------------------------------------------

/** Read one brace- or quote-delimited BibTeX value starting at `start` (at `{` or `"`). */
function readBibValue(text: string, start: number): { value: string; end: number } | null {
  const open = text[start];
  if (open === "{") {
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) return { value: text.slice(start + 1, i), end: i + 1 };
      }
    }
    return null;
  }
  if (open === '"') {
    const close = text.indexOf('"', start + 1);
    return close < 0 ? null : { value: text.slice(start + 1, close), end: close + 1 };
  }
  return null;
}

/**
 * Light LaTeX-to-text for abstracts: drop the BibTeX case-protection braces
 * and collapse whitespace. Math (`$…$`) and commands are kept verbatim —
 * rewriting them would change the author's text.
 */
export function cleanBibText(s: string): string {
  return pyWhitespaceCollapse(s.replace(/(?<!\\)[{}]/g, ""));
}

const ENTRY_HEAD_RE = /@InProceedings\{pmlr-v(\d+)-([A-Za-z0-9_-]+),/g;

/** Map PMLR paper key -> abstract (cleaned), for every `@InProceedings` of `volume`. */
export function parseBibAbstracts(bib: string, volume: number): Map<string, string> {
  const out = new Map<string, string>();
  const heads = [...bib.matchAll(ENTRY_HEAD_RE)];
  for (let i = 0; i < heads.length; i++) {
    const head = heads[i] as RegExpMatchArray;
    if (Number(head[1]) !== volume) continue;
    const start = (head.index ?? 0) + head[0].length;
    const end = i + 1 < heads.length ? (heads[i + 1]?.index ?? bib.length) : bib.length;
    const body = bib.slice(start, end);
    const field = /(^|\n)\s*abstract\s*=\s*/i.exec(body);
    if (!field) continue;
    const valueStart = field.index + field[0].length;
    const parsed = readBibValue(body, valueStart);
    if (parsed) out.set(head[2] as string, cleanBibText(parsed.value));
  }
  return out;
}

/** Catalog rows (shared CSV schema) for a parsed volume. */
export function buildPmlrRows(
  entries: readonly PmlrVolumeEntry[],
  abstracts: ReadonlyMap<string, string>,
  venue: string,
  options: { includeAbstracts: boolean },
): ConferenceRow[] {
  const tier = venueTier(venue);
  return entries.map((e) => ({
    title: e.title,
    authors: e.authors.join("; "),
    venue: venue.toUpperCase(),
    venue_tier: tier,
    citation_count: 0,
    github_stars: 0,
    arxiv_id: "",
    abstract: options.includeAbstracts ? (abstracts.get(e.key) ?? "") : "",
    url: `${OPENREVIEW_FORUM}${e.openreviewId}`,
    pdf_url: e.pdfUrl,
    comment: e.citation,
  }));
}
