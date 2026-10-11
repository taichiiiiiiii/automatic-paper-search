/**
 * Pre-publish validation gate for the no-JS "paper links" fallback —
 * TS port of the VALIDATION half of `render_paper_links_page` in
 * `paperpilot/scripts/build_pages.py` (CAT-18/CAT-19 of
 * docs/migration/safety-contracts.md).
 *
 * Scope note (confirmed by reading `apps/web`): the HTML itself is no
 * longer built here. `apps/web/app/[conf]/paper-links/page.tsx` renders
 * the no-JS fallback directly from the published `papers.json` at Next
 * build time (its pure logic lives in
 * `apps/web/app/[conf]/paper-links/logic.ts`'s `buildPaperLinkRows`, and
 * `apps/web/test/catalog/paper-links-parity.test.ts` already pins it
 * against the legacy `docs/<conf>/paper-links.html` byte-for-byte on
 * content). So "emit only the data the web route reads" means: emit
 * `papers.json` (already produced by `buildPages.ts`) and nothing else —
 * there is no separate `paper-links.json`/`.html` artifact to write.
 *
 * What this module keeps is the GATE: Python's `render_paper_links_page`
 * was also where CAT-18 got enforced (duplicate/malformed `paper_id`, the
 * `NOJS_MAX_PAPERS` row ceiling, the `NOJS_MAX_RENDERED_BYTES` byte
 * ceiling) — a build that would produce an unpublishable no-JS page
 * refused to publish `papers.json` at all. That invariant still needs to
 * hold even though this port writes no HTML, so `prepareConference` in
 * `buildPages.ts` still calls {@link assertPaperLinksGate} before
 * declaring a conference ready to publish.
 *
 * The byte estimate duplicates `apps/web/app/[conf]/paper-links/logic.ts`'s
 * `ROW_OVERHEAD_BYTES`/`PAGE_SHELL_BYTES` constants (not imported — no
 * shared package location is in this task's edit scope; see the identity.ts
 * scope note) so the pipeline-side gate and the web route's own runtime
 * check use the same budget rather than silently drifting apart.
 */

import { IdentityError } from "@paperpilot/core/identity";

/**
 * R3-2 (design doc 52 §8): the web route splits the fallback into pages of
 * at most `NOJS_ROWS_PER_PAGE` rows (`/<conf>/paper-links/` = page 1,
 * `/<conf>/paper-links/<n>/` = page n), so `NOJS_MAX_RENDERED_BYTES` is a
 * per-page budget and `NOJS_MAX_PAPERS` (pages x rows) the total ceiling.
 * Same numbers as apps/web's `paper-links/logic.ts`.
 */
export const NOJS_ROWS_PER_PAGE = 3_000;
export const NOJS_MAX_PAGES = 20;
export const NOJS_MAX_PAPERS = NOJS_ROWS_PER_PAGE * NOJS_MAX_PAGES;
export const NOJS_MAX_RENDERED_BYTES = 3 * 1024 * 1024;

/** Mirrors apps/web's logic.ts estimate — see the module doc comment. */
const ROW_OVERHEAD_BYTES = 200;
const PAGE_SHELL_BYTES = 1024;

const PAPER_ID_RE = /^[0-9a-f]{40}$/;

export interface PaperLinksSourcePaper {
  readonly paper_id?: unknown;
  readonly title?: unknown;
  readonly arxiv_url?: unknown;
  readonly pdf_url?: unknown;
}

function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * Validate that `papers` could still produce a legal no-JS fallback:
 * no duplicate/malformed `paper_id`, row count within `NOJS_MAX_PAPERS`,
 * and an estimated rendered size within `NOJS_MAX_RENDERED_BYTES` for
 * every page. The web route pages the rows in title order; this gate does
 * not re-implement that sort and instead bounds the worst case -- the
 * `NOJS_ROWS_PER_PAGE` largest rows on one page -- so whatever order the
 * web uses, no page can exceed the budget if this passes. Throws
 * {@link IdentityError} for an identity problem (matching Python's
 * `IdentityError` for a bad/duplicate `paper_id`) or `Error` for the two
 * size ceilings (matching Python's `ValueError`). Never mutates or
 * returns anything — this is a gate, not a renderer.
 */
export function assertPaperLinksGate(papers: ReadonlyArray<PaperLinksSourcePaper>): void {
  if (papers.length > NOJS_MAX_PAPERS) {
    throw new Error(`no-JS projection exceeds row limit: ${papers.length} > ${NOJS_MAX_PAPERS}`);
  }
  const seen = new Set<string>();
  const rowBytes: number[] = [];
  papers.forEach((paper, ordinal) => {
    const paperId = paper.paper_id;
    if (typeof paperId !== "string" || !PAPER_ID_RE.test(paperId)) {
      throw new IdentityError(`invalid paper_id in no-JS projection at row ${ordinal}`);
    }
    if (seen.has(paperId)) {
      throw new IdentityError(`duplicate paper_id in no-JS projection: ${paperId}`);
    }
    seen.add(paperId);
    const title =
      typeof paper.title === "string" && paper.title.length > 0 ? paper.title : "Untitled paper";
    const href =
      (typeof paper.arxiv_url === "string" ? paper.arxiv_url : "") ||
      (typeof paper.pdf_url === "string" ? paper.pdf_url : "");
    rowBytes.push(ROW_OVERHEAD_BYTES + utf8ByteLength(title) + utf8ByteLength(href));
  });
  rowBytes.sort((a, b) => b - a);
  let estimatedBytes = PAGE_SHELL_BYTES;
  for (const bytes of rowBytes.slice(0, NOJS_ROWS_PER_PAGE)) estimatedBytes += bytes;
  if (estimatedBytes > NOJS_MAX_RENDERED_BYTES) {
    throw new Error(
      `no-JS projection page exceeds rendered byte limit: ${estimatedBytes} > ${NOJS_MAX_RENDERED_BYTES}`,
    );
  }
}
