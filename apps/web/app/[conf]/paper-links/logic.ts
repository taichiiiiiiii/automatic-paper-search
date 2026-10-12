/**
 * Pure logic for the `/[conf]/paper-links/` no-JS fallback route, ported
 * from `paperpilot/scripts/build_pages.py`'s `render_paper_links_page`
 * (`_safe_http_url`, `_paper_title_sort_key`, the `paper_id` validation
 * and dedup loop). Kept separate from page.tsx so it is unit-testable
 * without rendering JSX (design doc §8 P2 / CLAUDE.md "TypeScript 移行中
 * の開発ルール": TDD + Vitest coverage for ported pure logic).
 *
 * This produces the exact same (title, href) rows, in the exact same
 * order, as `docs/<conf>/paper-links.html` -- see
 * `test/catalog/paper-links-parity.test.ts`.
 */
import { upgradeKnownHttps } from "../../../lib/https-upgrade";

const PAPER_ID_RE = /^[0-9a-f]{40}$/;

/**
 * Safety contract CAT-18 (docs/migration/safety-contracts.md): the no-JS
 * fallback must reject an unbounded row count or rendered byte size
 * instead of silently publishing (or building) something pathological.
 *
 * R3-2 (design doc 52 §8): the fallback is split into pages of at most
 * `NOJS_ROWS_PER_PAGE` rows -- page 1 stays at `/<conf>/paper-links/`,
 * page n >= 2 is `/<conf>/paper-links/<n>/` -- so a conference above the
 * old single-page ceiling of 6,000 rows (ICML 2026: 6,552; NeurIPS 2026:
 * ~9,200) can still be published. `NOJS_MAX_RENDERED_BYTES` is now a
 * PER-PAGE budget, and `NOJS_MAX_PAPERS` (= pages x rows) is the total
 * ceiling that still refuses a run-away conference. The pipeline gate
 * (`apps/pipeline/src/catalog/paperLinksGate.ts`) mirrors these numbers --
 * the budget is a property of the *data*, so the two must not drift.
 */
export const NOJS_ROWS_PER_PAGE = 3_000;
export const NOJS_MAX_PAGES = 20;
export const NOJS_MAX_PAPERS = NOJS_ROWS_PER_PAGE * NOJS_MAX_PAGES;
export const NOJS_MAX_RENDERED_BYTES = 3 * 1024 * 1024;

/** Fixed per-row markup this page emits around a row's title/href (the
 * `<li>`/`<h2>`/`<a>` tags, `id`/`data-paper-id` attributes -- each
 * carrying the 40-hex paper_id twice -- and the no-link status
 * fallback). Not byte-identical to the JSX output; close enough to
 * enforce the same order-of-magnitude budget `render_paper_links_page`
 * does, so the same pathological inputs (a run-away conference, a
 * title full of garbage) are caught before publish. */
const ROW_OVERHEAD_BYTES = 200;
/** The page chrome around the list (heading, tagline, description) --
 * small in this app since header/nav/footer come from the shared
 * `app/layout.tsx`, unlike the original's fully self-contained page. */
const PAGE_SHELL_BYTES = 1024;

function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Estimated rendered size of the no-JS page for `rows`, for the
 * NOJS_MAX_RENDERED_BYTES budget check. */
export function estimateRenderedBytes(rows: readonly PaperLinkRow[]): number {
  let total = PAGE_SHELL_BYTES;
  for (const row of rows) {
    total += ROW_OVERHEAD_BYTES + utf8ByteLength(row.title) + utf8ByteLength(row.href ?? "");
  }
  return total;
}

export interface PaperLinksSourcePaper {
  readonly title?: unknown;
  readonly paper_id?: unknown;
  readonly arxiv_url?: unknown;
  readonly pdf_url?: unknown;
}

export interface PaperLinkRow {
  readonly paperId: string;
  readonly title: string;
  /** `null` when neither `arxiv_url` nor `pdf_url` is a safe http(s) URL --
   * the row then renders plain text + the "リンクを利用できません" status. */
  readonly href: string | null;
}

/**
 * Mirrors `_safe_http_url`: an absolute http(s) URL, no embedded
 * credentials, no control characters, a real hostname, and (if present) a
 * valid port. Anything else -- `javascript:`, `data:`, a bare path, a
 * non-string -- is rejected.
 */
export function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  if (!candidate) return null;
  for (let i = 0; i < candidate.length; i++) {
    const code = candidate.charCodeAt(i);
    if (code < 33 || code === 127) return null;
  }
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname) return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.port !== "") {
    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  }
  return candidate;
}

function httpsHref(href: string | null): string | null {
  return href === null ? null : upgradeKnownHttps(href);
}

function paperTitle(paper: PaperLinksSourcePaper): string {
  return typeof paper.title === "string" && paper.title.length > 0 ? paper.title : "Untitled paper";
}

/**
 * Mirrors `_paper_title_sort_key`: NFKC-normalize the title, collapse
 * whitespace runs to single spaces, casefold, and break ties by
 * `paper_id` (the ordinal/codepoint comparison Python's tuple `<` does,
 * which plain `<`/`>` on JS strings also does for these titles).
 */
function titleSortKey(paper: PaperLinksSourcePaper, paperId: string): [string, string] {
  const normalized = paperTitle(paper).normalize("NFKC");
  const collapsed = normalized.trim().split(/\s+/).join(" ");
  return [collapsed.toLowerCase(), paperId];
}

function compareSortKeys(a: [string, string], b: [string, string]): number {
  if (a[0] < b[0]) return -1;
  if (a[0] > b[0]) return 1;
  if (a[1] < b[1]) return -1;
  if (a[1] > b[1]) return 1;
  return 0;
}

/**
 * Validates + sorts `papers` into the rows the no-JS fallback renders
 * (all pages, in order). Throws on a malformed/duplicate `paper_id` or an
 * unbounded total row count (safety contract CAT-18), matching
 * `build_pages.py`'s fail-closed `IdentityError`/`ValueError` -- a build
 * must never silently publish (or produce) a corrupt or run-away
 * projection. The per-page byte budget is enforced by
 * {@link paginatePaperLinkRows}.
 */
export function buildPaperLinkRows(papers: readonly PaperLinksSourcePaper[]): PaperLinkRow[] {
  if (papers.length > NOJS_MAX_PAPERS) {
    throw new Error(`no-JS projection exceeds row limit: ${papers.length} > ${NOJS_MAX_PAPERS}`);
  }
  const seen = new Set<string>();
  const keyed: { paper: PaperLinksSourcePaper; paperId: string; key: [string, string] }[] = [];
  for (const [index, paper] of papers.entries()) {
    const paperId = paper.paper_id;
    if (typeof paperId !== "string" || !PAPER_ID_RE.test(paperId)) {
      throw new Error(`invalid paper_id in no-JS projection at row ${index}`);
    }
    if (seen.has(paperId)) {
      throw new Error(`duplicate paper_id in no-JS projection: ${paperId}`);
    }
    seen.add(paperId);
    keyed.push({ paper, paperId, key: titleSortKey(paper, paperId) });
  }
  keyed.sort((a, b) => compareSortKeys(a.key, b.key));
  return keyed.map(({ paper, paperId }) => ({
    paperId,
    title: paperTitle(paper),
    href: httpsHref(safeHttpUrl(paper.arxiv_url) ?? safeHttpUrl(paper.pdf_url)),
  }));
}

/** One page of the split no-JS fallback. */
export interface PaperLinksPage {
  /** 1-based page number. */
  readonly page: number;
  /** 1-based index of this page's first row in the whole list (0 when empty). */
  readonly firstRow: number;
  /** 1-based index of this page's last row (0 when empty). */
  readonly lastRow: number;
  readonly rows: readonly PaperLinkRow[];
}

/**
 * Splits the sorted rows into pages of at most `NOJS_ROWS_PER_PAGE` rows.
 * Always returns at least one page (an empty conference renders page 1
 * with the empty-state copy). Throws when any page's estimated rendered
 * size exceeds `NOJS_MAX_RENDERED_BYTES` (CAT-18, now per page).
 */
export function paginatePaperLinkRows(rows: readonly PaperLinkRow[]): PaperLinksPage[] {
  const pages: PaperLinksPage[] = [];
  for (let start = 0; start === 0 || start < rows.length; start += NOJS_ROWS_PER_PAGE) {
    const chunk = rows.slice(start, start + NOJS_ROWS_PER_PAGE);
    const page = pages.length + 1;
    const estimatedBytes = estimateRenderedBytes(chunk);
    if (estimatedBytes > NOJS_MAX_RENDERED_BYTES) {
      throw new Error(
        `no-JS projection page ${page} exceeds rendered byte estimate: ${estimatedBytes} > ${NOJS_MAX_RENDERED_BYTES}`,
      );
    }
    pages.push({
      page,
      firstRow: chunk.length === 0 ? 0 : start + 1,
      lastRow: start + chunk.length,
      rows: chunk,
    });
  }
  return pages;
}

/** Validate + sort + split in one step (what the routes render). */
export function buildPaperLinkPages(papers: readonly PaperLinksSourcePaper[]): PaperLinksPage[] {
  return paginatePaperLinkRows(buildPaperLinkRows(papers));
}

/** Number of no-JS pages a conference with `paperCount` rows gets. */
export function paperLinksPageCount(paperCount: number): number {
  return Math.max(1, Math.ceil(paperCount / NOJS_ROWS_PER_PAGE));
}

/** URL path of page `page` (page 1 keeps the pre-split URL). */
export function paperLinksPagePath(conf: string, page: number): string {
  return page <= 1 ? `/${conf}/paper-links/` : `/${conf}/paper-links/${page}/`;
}
