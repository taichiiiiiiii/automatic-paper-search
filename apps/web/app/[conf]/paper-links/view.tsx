import Link from "next/link";
import { BASE_PATH } from "../../../lib/config";
import { type PaperLinksPage, paperLinksPagePath } from "./logic";
import styles from "./paper-links.module.css";

/**
 * Shared markup of one no-JS paper-links page (R3-2: the fallback is split
 * into pages of at most `NOJS_ROWS_PER_PAGE` rows). Pure server-rendered
 * HTML, no client component: the page and its pager work with JavaScript
 * disabled. A single-page conference renders exactly the pre-split markup
 * (no pager), so its rows stay byte-for-byte comparable with the legacy
 * `docs/<conf>/paper-links.html` (test/catalog/paper-links-parity.test.ts).
 */

const NUMBER = new Intl.NumberFormat("en-US");

function Pager({
  conf,
  current,
  pages,
  total,
}: {
  conf: string;
  current: PaperLinksPage;
  pages: readonly PaperLinksPage[];
  total: number;
}) {
  return (
    <nav aria-label="ページ" className={styles.pager}>
      <p>
        全 {NUMBER.format(total)} 本中 {NUMBER.format(current.firstRow)}–
        {NUMBER.format(current.lastRow)} 本目（{current.page} / {pages.length} ページ、タイトル順）
      </p>
      <ol>
        {pages.map((p) => (
          <li key={p.page}>
            {p.page === current.page ? (
              <span aria-current="page">{p.page}</span>
            ) : (
              <a href={`${BASE_PATH}${paperLinksPagePath(conf, p.page)}`}>{p.page}</a>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function PaperLinksView({
  conf,
  pages,
  pageNumber,
  total,
}: {
  conf: string;
  pages: readonly PaperLinksPage[];
  pageNumber: number;
  total: number;
}) {
  const current = pages[pageNumber - 1];
  if (current === undefined) {
    // generateStaticParams only emits existing page numbers, so this is a
    // build-time bug: fail loudly instead of shipping an empty 200 page.
    throw new Error(`/${conf}/paper-links/: page ${pageNumber} does not exist`);
  }
  const rows = current.rows;
  const paged = pages.length > 1;
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
      {paged && <Pager conf={conf} current={current} pages={pages} total={total} />}
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
      {paged && <Pager conf={conf} current={current} pages={pages} total={total} />}
    </main>
  );
}
