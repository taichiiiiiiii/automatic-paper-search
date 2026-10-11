/**
 * R2-28 (design 41, research 47 §2.1): citation contexts from the arXiv
 * HTML rendering of a citing paper (`https://arxiv.org/html/<id>`, LaTeXML).
 *
 * Pure parsing, no network (the fetching / caching side is
 * `./arxivHtmlSource.ts`):
 *  - the bibliography: `<li id="bib.bibN" class="ltx_bibitem">` entries,
 *    as plain text plus the arXiv ids and DOIs they mention;
 *  - the body: every `<p class="ltx_p">` outside figures, tables,
 *    captions, footnotes and headings, rendered to text with the visible
 *    citation marker kept ("[22]", "Lepikhin et al. (2020)") and an
 *    invisible sentinel at each `href="#bib.bibN"` anchor, then split into
 *    sentences; a sentence is a context of every bib entry it links to.
 *  - {@link matchBibEntry} finds the cited paper's bib entry by arXiv id,
 *    DOI, or title (exact normalised substring, else >= 85 % title-token
 *    coverage with the first author's surname present).
 *
 * Contexts are capped like the Semantic Scholar cache (12 x 400 chars):
 * the rules (`../classify/apiRelations.ts`) read them exactly like S2
 * contexts. The HTML itself is never stored or shown; only single
 * sentences are quoted (design 44 §5 / 47 §2.1 citation rules).
 */

import { normTitle } from "./s2Citations.js";

/** One bibliography entry. */
export interface BibEntry {
  /** Anchor id, e.g. `bib.bib22`. */
  key: string;
  /** Plain text of the entry (tag stripped, whitespace collapsed). */
  text: string;
  /** arXiv ids it mentions (no version suffix). */
  arxiv: string[];
  /** DOIs it mentions (lower case). */
  dois: string[];
}

export interface ParsedArxivHtml {
  /** `vN` of the rendered version when the page states it, else null. */
  version: string | null;
  bibs: BibEntry[];
  /** Context sentences per bib key (deduplicated, document order). */
  contexts: Map<string, string[]>;
}

export const HTML_MAX_CONTEXTS = 12;
export const HTML_MAX_CONTEXT_CHARS = 400;
const MIN_SENTENCE_CHARS = 20;

const OPEN = "\uE000";
const CLOSE = "\uE001";
const SENTINEL_RE = /\uE000([^\uE001]*)\uE001/g;

const VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);
/** Elements whose content is never a body sentence. */
const SKIP_TAGS = new Set([
  "figure",
  "figcaption",
  "table",
  "script",
  "style",
  "nav",
  "header",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "svg",
  "button",
]);
/** LaTeXML classes whose content is never a body sentence (footnotes,
 * inline tables, captions, the bibliography itself). */
const SKIP_CLASS =
  /\b(ltx_note|ltx_tabular|ltx_caption|ltx_bibliography|ltx_authors|ltx_dates|ltx_page_footer|ltx_page_header|ltx_TOC|ltx_tag_section|ltx_tag_subsection)\b/;

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, body: string) => {
    if (body[0] === "#") {
      const cp =
        body[1] === "x" || body[1] === "X"
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[body] ?? m;
  });
}

function collapse(s: string): string {
  return s.replace(/[\s\u00a0]+/g, " ").trim();
}

function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(attrs);
  if (!m) return null;
  return decodeEntities(m[2] ?? m[3] ?? "");
}

/** Short inline rendering of a `<math>` element (its LaTeX alttext). */
function mathText(alt: string | null): string {
  if (!alt) return "";
  const t = alt
    .replace(/\\(?:text|mathrm|mathbf|mathit|operatorname)\{([^}]*)\}/g, "$1")
    .replace(/\\[a-zA-Z]+/g, "")
    .replace(/[{}]/g, "")
    .trim();
  return t.length <= 40 ? t : "…";
}

/** arXiv ids in a string (new style `2101.03961`, old style `cs/0601001`). */
export function arxivIdsIn(text: string): string[] {
  const out = new Set<string>();
  if (!/arxiv/i.test(text)) return [];
  for (const m of text.matchAll(/(?<![\d.])(\d{4}\.\d{4,5})(?:v\d+)?(?![\d])/g)) {
    out.add(m[1] as string);
  }
  for (const m of text.matchAll(/\b([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?\b/g)) {
    out.add(m[1] as string);
  }
  return [...out];
}

export function doisIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b10\.\d{4,9}\/[^\s"<>,;]+/g)) {
    out.add((m[0] as string).replace(/[.)\]]+$/, "").toLowerCase());
  }
  return [...out];
}

/** The bibliography of a LaTeXML page. */
export function parseBibliography(html: string): BibEntry[] {
  const out: BibEntry[] = [];
  const re = /<li\b[^>]*\bid="(bib\.bib\d+)"[^>]*>([\s\S]*?)<\/li>/g;
  for (const m of html.matchAll(re)) {
    const inner = m[2] as string;
    const text = collapse(
      decodeEntities(inner.replace(/<[^>]*>/g, " ")).replace(/^\s*\[[^\]]{1,12}\]\s*/, ""),
    );
    const hrefs = [...inner.matchAll(/href="([^"]+)"/g)].map((h) => decodeEntities(h[1] as string));
    const raw = `${text} ${hrefs.join(" ")}`;
    out.push({ key: m[1] as string, text, arxiv: arxivIdsIn(raw), dois: doisIn(raw) });
  }
  return out;
}

/** The rendered version (`v3`) of `arxivId` stated on the page, if any. */
export function versionOf(html: string, arxivId: string): string | null {
  const esc = arxivId.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const m = new RegExp(`${esc}(v\\d+)`).exec(html);
  return m ? (m[1] as string) : null;
}

/** Body paragraphs as text with bib sentinels (`\uE000bib.bibN\uE001`). */
export function bodyParagraphs(html: string): string[] {
  // Everything from the bibliography section on is not body text.
  const bibAt = html.search(/<section\b[^>]*\bclass="[^"]*\bltx_bibliography\b/);
  const body = bibAt >= 0 ? html.slice(0, bibAt) : html;
  const stack: { tag: string; skip: boolean }[] = [];
  const paras: string[] = [];
  let buf: string[] | null = null;
  let pDepth = -1;
  const skipping = () => stack.some((e) => e.skip);
  const tokenRe = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w:-]*)([^>]*)>|([^<]+)/g;
  for (const m of body.matchAll(tokenRe)) {
    const [, slash, rawTag, attrs = "", text] = m;
    if (text !== undefined) {
      if (buf !== null && !skipping()) buf.push(decodeEntities(text));
      continue;
    }
    if (rawTag === undefined) continue; // comment
    const tag = rawTag.toLowerCase();
    if (slash) {
      // Pop to the matching open tag (tolerates unclosed inline tags).
      let i = stack.length - 1;
      while (i >= 0 && stack[i]?.tag !== tag) i--;
      if (i < 0) continue;
      stack.length = i;
      if (buf !== null && stack.length <= pDepth) {
        const t = collapse(buf.join(""));
        if (t) paras.push(t);
        buf = null;
        pDepth = -1;
      }
      continue;
    }
    const selfClosing = /\/\s*$/.test(attrs) || VOID.has(tag);
    if (tag === "math") {
      if (buf !== null && !skipping()) buf.push(` ${mathText(attr(attrs, "alttext"))} `);
      if (!selfClosing) stack.push({ tag, skip: true });
      continue;
    }
    if (tag === "a" && buf !== null && !skipping()) {
      const href = attr(attrs, "href") ?? "";
      const bm = /^#(bib\.bib\d+)$/.exec(href);
      if (bm) buf.push(`${OPEN}${bm[1]}${CLOSE}`);
    }
    if (tag === "br" && buf !== null) buf.push(" ");
    if (selfClosing) continue;
    const cls = attr(attrs, "class") ?? "";
    const skip = SKIP_TAGS.has(tag) || SKIP_CLASS.test(cls);
    stack.push({ tag, skip });
    if (tag === "p" && buf === null && !skipping()) {
      buf = [];
      pDepth = stack.length - 1;
    } else if (tag === "p" && buf !== null) {
      buf.push(" ");
    }
  }
  return paras;
}

/** Abbreviations after which a period does not end a sentence. */
const ABBREV_TAIL =
  /(?:\bet\s+al|\be\.g|\bi\.e|\bcf|\bvs|\betc|\bfigs?|\beqs?|\bsecs?|\btabs?|\brefs?|\bno|\bvol|\bpp|\bapprox|\bresp|\bappx?|\bthm|\balg|\bch|\bdef|\bincl|\bjr|\bdr|\bmr|\bms|\bst|\b[A-Z])\.$/i;

/** Split a paragraph (with sentinels) into sentences. */
export function splitSentences(para: string): string[] {
  const out: string[] = [];
  let start = 0;
  const re = /[.!?](?=["”’)\]]?\s+["“([\uE000]?[A-Z0-9\uE000])/g;
  for (const m of para.matchAll(re)) {
    const end = (m.index as number) + 1;
    const head = para.slice(start, end);
    // "et al." / "Fig." / initials: not a boundary. A sentinel right before
    // the period ("… [22].") is a boundary.
    if (ABBREV_TAIL.test(head.replace(SENTINEL_RE, "").trimEnd())) continue;
    out.push(head.trim());
    start = end;
  }
  const tail = para.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

function stripSentinels(s: string): string {
  return collapse(s.replace(SENTINEL_RE, ""));
}

/** At most {@link HTML_MAX_CONTEXT_CHARS} code points around the first
 * marker of `key` (the sentence start when it fits). */
function window(sentence: string, key: string): string {
  const plain = stripSentinels(sentence);
  const cps = Array.from(plain);
  if (cps.length <= HTML_MAX_CONTEXT_CHARS) return plain;
  const at = sentence.indexOf(`${OPEN}${key}${CLOSE}`);
  const before = at < 0 ? 0 : Array.from(stripSentinels(sentence.slice(0, at))).length;
  const from = Math.max(
    0,
    Math.min(before - Math.floor(HTML_MAX_CONTEXT_CHARS / 2), cps.length - HTML_MAX_CONTEXT_CHARS),
  );
  return cps
    .slice(from, from + HTML_MAX_CONTEXT_CHARS)
    .join("")
    .trim();
}

/** Parse one LaTeXML page. */
export function parseArxivHtml(html: string, arxivId: string | null = null): ParsedArxivHtml {
  const bibs = parseBibliography(html);
  const contexts = new Map<string, string[]>();
  for (const para of bodyParagraphs(html)) {
    for (const s of splitSentences(para)) {
      const keys = new Set([...s.matchAll(SENTINEL_RE)].map((k) => k[1] as string));
      if (keys.size === 0) continue;
      if (stripSentinels(s).length < MIN_SENTENCE_CHARS) continue;
      for (const key of keys) {
        const list = contexts.get(key) ?? [];
        const text = window(s, key);
        if (list.length < HTML_MAX_CONTEXTS && !list.includes(text)) list.push(text);
        contexts.set(key, list);
      }
    }
  }
  return { version: arxivId ? versionOf(html, arxivId) : null, bibs, contexts };
}

/** What identifies the cited paper. */
export interface CitedRef {
  title?: unknown;
  authors?: unknown;
  year?: unknown;
  arxiv?: string | null;
  doi?: string | null;
}

export type BibMatch = { key: string; how: "arxiv" | "doi" | "title" | "title_fuzzy" };

function surnameOf(author: unknown): string | null {
  const name =
    typeof author === "string"
      ? author
      : author &&
          typeof author === "object" &&
          typeof (author as { name?: unknown }).name === "string"
        ? (author as { name: string }).name
        : null;
  if (!name) return null;
  const parts = normTitle(name).split(" ").filter(Boolean);
  const last = parts[parts.length - 1];
  return last && last.length >= 2 ? last : null;
}

/**
 * The bib entry of the cited paper, or null. Identifier matches first;
 * then the normalised title as a substring of the entry; then token
 * coverage >= 0.85 of a >= 4-token title with the first author's surname
 * in the entry, unique among the entries.
 */
export function matchBibEntry(bibs: readonly BibEntry[], cited: CitedRef): BibMatch | null {
  const arxiv = cited.arxiv?.replace(/v\d+$/, "") ?? null;
  if (arxiv) {
    const hit = bibs.filter((b) => b.arxiv.includes(arxiv));
    if (hit.length === 1) return { key: (hit[0] as BibEntry).key, how: "arxiv" };
  }
  const doi = cited.doi?.toLowerCase() ?? null;
  if (doi) {
    const hit = bibs.filter((b) => b.dois.includes(doi));
    if (hit.length === 1) return { key: (hit[0] as BibEntry).key, how: "doi" };
  }
  const title = normTitle(cited.title);
  const tokens = title.split(" ").filter(Boolean);
  if (tokens.length === 0) return null;
  const authors = Array.isArray(cited.authors) ? cited.authors : [];
  const surname = surnameOf(authors[0]);
  const norm = bibs.map((b) => ` ${normTitle(b.text)} `);
  const exact = bibs.filter((_, i) => (norm[i] as string).includes(` ${title} `));
  if (
    exact.length === 1 &&
    (tokens.length >= 3 ||
      (surname !== null &&
        (norm[bibs.indexOf(exact[0] as BibEntry)] as string).includes(` ${surname} `)))
  ) {
    return { key: (exact[0] as BibEntry).key, how: "title" };
  }
  if (exact.length > 1 || tokens.length < 4 || surname === null) return null;
  const scored = bibs
    .map((b, i) => {
      const words = new Set((norm[i] as string).split(" "));
      const cov = tokens.filter((t) => words.has(t)).length / tokens.length;
      return { b, cov, author: words.has(surname) };
    })
    .filter((x) => x.cov >= 0.85 && x.author)
    .sort((a, b) => b.cov - a.cov);
  if (scored.length === 0) return null;
  if (
    scored.length > 1 &&
    (scored[1] as { cov: number }).cov === (scored[0] as { cov: number }).cov
  )
    return null;
  return { key: (scored[0] as { b: BibEntry }).b.key, how: "title_fuzzy" };
}
