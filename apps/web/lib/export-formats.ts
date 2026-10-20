/**
 * BibTeX / CSV export and share-URL helpers (design doc 48 P0-3).
 *
 * Everything here is client-side and pure except `downloadText` and
 * `copyText`, which touch the DOM. BibTeX entries are built statically from
 * the ids the data already carries (arXiv id, DOI, OpenReview/S2 URL) — no
 * lookup service. CSV cells that a spreadsheet would read as a formula are
 * prefixed with `'` (CSV injection guard).
 */
import { edgeMethodLabelJa, paperLink } from "./lineage/evidence";
import { relationLabelFor } from "./lineage/relations";

// ---- CSV -------------------------------------------------------------------

const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** RFC 4180 CSV with CRLF line ends and a UTF-8 BOM (so Excel opens
 * Japanese text correctly). */
export function toCsv(header: readonly string[], rows: readonly (readonly unknown[])[]): string {
  const lines = [header, ...rows].map((r) => r.map(csvCell).join(","));
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

// ---- BibTeX ----------------------------------------------------------------

/** Escapes LaTeX specials and drops control characters. */
export function bibtexEscape(value: string): string {
  return (
    value
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point.
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .replace(/\\/g, "\\textbackslash{}")
      .replace(/([{}&%$#_])/g, "\\$1")
      .replace(/~/g, "\\textasciitilde{}")
      .replace(/\^/g, "\\textasciicircum{}")
      .replace(/\\textbackslash\\\{\\\}/g, "\\textbackslash{}")
      .replace(/\\textasciitilde\\\{\\\}/g, "\\textasciitilde{}")
      .replace(/\\textasciicircum\\\{\\\}/g, "\\textasciicircum{}")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function asciiWord(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]/g, "")
    .toLowerCase();
}

const TITLE_STOPWORDS = new Set(["a", "an", "the", "on", "of", "for", "to", "in", "and", "with"]);

/** `<lastname><year><firstword>`, ASCII only; uniqueness is handled by
 * `uniqueKeys`. */
export function bibtexKeyBase(
  authors: readonly string[] | null | undefined,
  year: number | null | undefined,
  title: string | null | undefined,
): string {
  const first = (authors ?? []).find((a) => typeof a === "string" && a.trim()) ?? "";
  const parts = first.trim().split(/\s+/);
  const last = asciiWord(parts[parts.length - 1] ?? "") || "anon";
  const word =
    (title ?? "")
      .split(/\s+/)
      .map(asciiWord)
      .find((w) => w && !TITLE_STOPWORDS.has(w)) ?? "paper";
  const y = typeof year === "number" && Number.isFinite(year) ? String(year) : "";
  return `${last}${y}${word}`;
}

function makeKeyUniquer(): (base: string) => string {
  const used = new Map<string, number>();
  return (base) => {
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    if (n === 0) return base;
    // a, b, … z, then numbers.
    return n <= 26 ? `${base}${String.fromCharCode(96 + n)}` : `${base}${n}`;
  };
}

export interface BibEntry {
  type: "misc" | "inproceedings" | "article";
  key: string;
  fields: ReadonlyArray<[string, string | null | undefined]>;
}

export function formatBibEntry(entry: BibEntry): string {
  const lines = entry.fields
    .filter((f): f is [string, string] => typeof f[1] === "string" && f[1].trim() !== "")
    .map(([k, v]) => `  ${k} = {${v}}`);
  return `@${entry.type}{${entry.key},\n${lines.join(",\n")}\n}\n`;
}

function bibTitle(title: string): string {
  // Double braces keep the capitalisation (BERT, ViT, …).
  return `{${bibtexEscape(title)}}`;
}

function bibAuthors(authors: readonly string[] | null | undefined): string | null {
  const list = (authors ?? []).filter((a) => typeof a === "string" && a.trim());
  return list.length ? list.map(bibtexEscape).join(" and ") : null;
}

// ---- Theme lineage nodes / edges ------------------------------------------

export interface ExportNode {
  id: string;
  title?: string;
  year?: number | null;
  authors?: string[] | null;
  venue?: string;
  arxiv_id?: string;
  doi?: string;
  citation_count?: number | null;
  [key: string]: unknown;
}

export interface ExportEdge {
  src: string;
  dst: string;
  relation: string;
  confidence: number;
  rationale: string;
  provenance?: { classification?: { method?: string | null } | null } | null;
}

const ARXIV_ID = /^\d{4}\.\d{4,5}(v\d+)?$|^[a-z-]+(\.[A-Z]{2})?\/\d{7}(v\d+)?$/;
const DOI_ID = /^10\.\d{4,9}\/\S+$/;

export function themeNodesToBibtex(nodes: readonly ExportNode[]): string {
  const unique = makeKeyUniquer();
  return nodes
    .map((n) => {
      const title = n.title || n.id;
      const arxiv = typeof n.arxiv_id === "string" && ARXIV_ID.test(n.arxiv_id) ? n.arxiv_id : null;
      const doi = typeof n.doi === "string" && DOI_ID.test(n.doi) ? n.doi : null;
      const year = typeof n.year === "number" ? String(n.year) : null;
      return formatBibEntry({
        type: "misc",
        key: unique(bibtexKeyBase(n.authors, n.year, title)),
        fields: [
          ["title", bibTitle(title)],
          ["author", bibAuthors(n.authors)],
          ["year", year],
          ["howpublished", n.venue ? bibtexEscape(n.venue) : null],
          ["eprint", arxiv],
          ["archiveprefix", arxiv ? "arXiv" : null],
          ["doi", doi ? bibtexEscape(doi) : null],
          ["url", paperLink(n).url],
        ],
      });
    })
    .join("\n");
}

export const THEME_NODE_CSV_HEADER = [
  "id",
  "title",
  "year",
  "venue",
  "authors",
  "citation_count",
  "arxiv_id",
  "doi",
  "url",
  "main_path",
] as const;

export function themeNodesToCsv(
  nodes: readonly ExportNode[],
  mainPathNodeIds: ReadonlySet<string> = new Set(),
): string {
  return toCsv(
    THEME_NODE_CSV_HEADER,
    nodes.map((n) => [
      n.id,
      n.title ?? "",
      typeof n.year === "number" ? n.year : "",
      n.venue ?? "",
      (n.authors ?? []).join("; "),
      typeof n.citation_count === "number" ? n.citation_count : "",
      n.arxiv_id ?? "",
      n.doi ?? "",
      paperLink(n).url,
      mainPathNodeIds.has(n.id) ? "yes" : "",
    ]),
  );
}

export const THEME_EDGE_CSV_HEADER = [
  "older_id",
  "older_title",
  "newer_id",
  "newer_title",
  "relation",
  "relation_ja",
  "confidence",
  "method",
  "rationale",
  "main_path",
] as const;

export function themeEdgesToCsv<E extends ExportEdge>(
  edges: readonly E[],
  nodeById: ReadonlyMap<string, ExportNode>,
  isMainPath: (e: E) => boolean = () => false,
  /** Audited collection: plain labels; otherwise strong ones are 候補 (D-R2-40). */
  audited = false,
): string {
  return toCsv(
    THEME_EDGE_CSV_HEADER,
    edges.map((e) => [
      e.src,
      nodeById.get(e.src)?.title ?? "",
      e.dst,
      nodeById.get(e.dst)?.title ?? "",
      e.relation,
      relationLabelFor(e.relation, audited, ""),
      Number.isFinite(e.confidence) ? e.confidence.toFixed(2) : "",
      edgeMethodLabelJa(e.provenance?.classification?.method ?? null, e.rationale),
      e.rationale,
      isMainPath(e) ? "yes" : "",
    ]),
  );
}

// ---- Conference catalog ----------------------------------------------------

export interface ExportCatalogPaper {
  paper_id: string;
  title: string;
  authors: string[];
  tags: string[];
  type: string;
  arxiv_id?: string;
  arxiv_url?: string;
  pdf_url?: string;
  [key: string]: unknown;
}

/** `iclr-2026` → 2026; `null` when the slug carries no year. */
export function conferenceYear(conf: string): number | null {
  const m = /-(\d{4})$/.exec(conf);
  return m ? Number(m[1]) : null;
}

function catalogPaperUrl(p: ExportCatalogPaper): string | null {
  if (typeof p.arxiv_id === "string" && ARXIV_ID.test(p.arxiv_id)) {
    return `https://arxiv.org/abs/${p.arxiv_id}`;
  }
  for (const u of [p.arxiv_url, p.pdf_url]) {
    if (typeof u === "string" && /^https:\/\//.test(u)) return u;
  }
  return null;
}

export function catalogPapersToBibtex(
  papers: readonly ExportCatalogPaper[],
  conf: { slug: string; display: string },
): string {
  const unique = makeKeyUniquer();
  const year = conferenceYear(conf.slug);
  return papers
    .map((p) => {
      const arxiv = typeof p.arxiv_id === "string" && ARXIV_ID.test(p.arxiv_id) ? p.arxiv_id : null;
      return formatBibEntry({
        type: "inproceedings",
        key: unique(bibtexKeyBase(p.authors, year, p.title)),
        fields: [
          ["title", bibTitle(p.title)],
          ["author", bibAuthors(p.authors)],
          ["booktitle", bibtexEscape(conf.display)],
          ["year", year === null ? null : String(year)],
          ["eprint", arxiv],
          ["archiveprefix", arxiv ? "arXiv" : null],
          ["url", catalogPaperUrl(p)],
        ],
      });
    })
    .join("\n");
}

export const CATALOG_CSV_HEADER = [
  "paper_id",
  "title",
  "authors",
  "type",
  "tags",
  "arxiv_id",
  "url",
  "pdf_url",
] as const;

export function catalogPapersToCsv(papers: readonly ExportCatalogPaper[]): string {
  return toCsv(
    CATALOG_CSV_HEADER,
    papers.map((p) => [
      p.paper_id,
      p.title,
      p.authors.join("; "),
      p.type,
      p.tags.join("; "),
      p.arxiv_id ?? "",
      catalogPaperUrl(p) ?? "",
      p.pdf_url ?? "",
    ]),
  );
}

// ---- DOM helpers -----------------------------------------------------------

/** `<base>-<yyyy-mm-dd>.<ext>`, with the slug reduced to safe characters. */
export function exportFilename(base: string, ext: string, now: Date = new Date()): string {
  const safe = base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "export";
  return `${safe}-${now.toISOString().slice(0, 10)}.${ext}`;
}

export function downloadText(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Copies `text`; resolves `false` when the browser refuses. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the textarea fallback */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.className = "sr-only";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
