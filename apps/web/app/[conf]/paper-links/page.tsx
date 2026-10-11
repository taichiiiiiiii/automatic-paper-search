import { buildPaperLinkPages } from "./logic";
import { readPapers } from "./read-papers";
import { PaperLinksView } from "./view";

/**
 * Server Component port of `docs/<conf>/paper-links.html`
 * (`paperpilot/scripts/build_pages.py::render_paper_links_page`). Pure
 * HTML: no client component anywhere in this tree, so the list (and its
 * links) renders and works with JavaScript disabled -- that is this
 * route's entire reason to exist (the `/<conf>/` catalog needs JS for
 * search/filter; this is its no-JS fallback, linked from that page's
 * `<noscript>` notice and error state).
 *
 * Page 1 of the split fallback (R3-2): `/<conf>/paper-links/` keeps its
 * pre-split URL; pages 2..n live in `[page]/page.tsx`; the markup is
 * shared in `view.tsx`.
 *
 * Reads `public/<conf>/papers.json` (via `read-papers.ts`) directly with `node:fs` at build
 * time -- same "exactly one reader of docs/" shape as
 * `app/[conf]/page.tsx` (`scripts/copy-data.ts` already copied it into
 * `public/` by the time `next build` runs this). This is deliberately
 * NOT `lib/data.ts`'s `fetchConferencePapers`: that helper does a
 * runtime `fetch()` for client code, and this page has no client-side
 * data path at all -- the full list is baked into the static HTML.
 *
 * Header/footer/skip-link come from `app/layout.tsx` (ported-page
 * convention); the original's own `<nav>`/`<footer>` markup is not
 * duplicated here.
 */

export default async function PaperLinksPage({ params }: { params: Promise<{ conf: string }> }) {
  const { conf } = await params;
  const papers = readPapers(conf);
  const pages = buildPaperLinkPages(papers);
  return <PaperLinksView conf={conf} pages={pages} pageNumber={1} total={papers.length} />;
}
