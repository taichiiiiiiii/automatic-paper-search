import { readFileSync } from "node:fs";
import { join } from "node:path";
import Link from "next/link";
import { notFound } from "next/navigation";
import { buildPaperLinkRows, type PaperLinksSourcePaper } from "./logic";
import styles from "./paper-links.module.css";

/**
 * Server Component port of `docs/<conf>/paper-links.html`
 * (`paperpilot/scripts/build_pages.py::render_paper_links_page`). Pure
 * HTML: no client component anywhere in this tree, so the list (and its
 * links) renders and works with JavaScript disabled -- that is this
 * route's entire reason to exist (the `/<conf>/` catalog needs JS for
 * search/filter; this is its no-JS fallback, linked from that page's
 * `<noscript>` notice and error state).
 *
 * Reads `public/<conf>/papers.json` directly with `node:fs` at build
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

function readPapers(conf: string): PaperLinksSourcePaper[] {
  const path = join(process.cwd(), "public", conf, "papers.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    notFound();
  }
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`${conf}/papers.json: expected an array`);
  }
  return parsed as PaperLinksSourcePaper[];
}

export default async function PaperLinksPage({ params }: { params: Promise<{ conf: string }> }) {
  const { conf } = await params;
  const papers = readPapers(conf);
  const rows = buildPaperLinkRows(papers);

  return (
    <main id="main-content">
      <header className="border-b border-rule px-4 py-6 sm:px-6">
        <h1 className="text-2xl font-semibold text-ink">
          {conf} <em className="font-normal italic">論文リンク一覧</em>
        </h1>
        <p className="mt-2 text-sm text-ink-muted">
          JavaScript なしで利用できる簡易一覧です。検索と絞り込みは
          <Link href={`/${conf}/`} className="text-accent hover:text-accent-strong">
            通常版
          </Link>
          で利用できます。
        </p>
      </header>
      <p id="paper-links-description" className="px-4 py-3 text-sm text-ink-muted sm:px-6">
        論文タイトルから原論文を開けます。
      </p>
      <ul aria-describedby="paper-links-description" className={styles.list}>
        {rows.length === 0 ? (
          <li className={styles.empty}>掲載できる論文はありません。</li>
        ) : (
          // No className on the row/heading/link elements themselves --
          // see paper-links.module.css's doc comment: this list can be
          // thousands of rows long, and a static-export Server
          // Component's output is serialized twice (real HTML + Next's
          // RSC hydration payload), so a repeated per-row className
          // string would count twice against the CAT-18 byte budget.
          rows.map((row) => (
            <li key={row.paperId} id={`paper-${row.paperId}`} data-paper-id={row.paperId}>
              <h2>
                {row.href ? (
                  <a href={row.href} target="_blank" rel="noopener noreferrer">
                    {row.title}
                  </a>
                ) : (
                  row.title
                )}
              </h2>
              {!row.href && <p className={styles.status}>原論文リンクを利用できません。</p>}
            </li>
          ))
        )}
      </ul>
    </main>
  );
}
