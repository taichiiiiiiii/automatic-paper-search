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

const PAPER_ID_RE = /^[0-9a-f]{40}$/;

/**
 * Safety contract CAT-18 (docs/migration/safety-contracts.md): the no-JS
 * fallback must reject an unbounded row count or rendered byte size
 * instead of silently publishing (or building) something pathological.
 * Same numbers as `build_pages.py`'s `NOJS_MAX_PAPERS` /
 * `NOJS_MAX_RENDERED_BYTES` -- the budget is a property of the *data*,
 * not of this renderer, so it must not drift between the two.
 */
export const NOJS_MAX_PAPERS = 6_000;
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
 * Validates + sorts `papers` into the rows the no-JS fallback renders.
 * Throws on a malformed/duplicate `paper_id`, an unbounded row count, or
 * an unbounded estimated byte size (safety contract CAT-18), matching
 * `build_pages.py`'s fail-closed `IdentityError`/`ValueError` -- a build
 * must never silently publish (or produce) a corrupt or run-away
 * projection.
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
  const rows = keyed.map(({ paper, paperId }) => ({
    paperId,
    title: paperTitle(paper),
    href: safeHttpUrl(paper.arxiv_url) ?? safeHttpUrl(paper.pdf_url),
  }));
  const estimatedBytes = estimateRenderedBytes(rows);
  if (estimatedBytes > NOJS_MAX_RENDERED_BYTES) {
    throw new Error(
      `no-JS projection exceeds rendered byte estimate: ${estimatedBytes} > ${NOJS_MAX_RENDERED_BYTES}`,
    );
  }
  return rows;
}
