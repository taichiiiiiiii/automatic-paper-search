"use client";

import { useId, useState } from "react";
import type { CatalogCopy } from "../../lib/catalog-copy";
import { BASE_PATH } from "../../lib/config";

/**
 * Hero banner (breadcrumb, title, stats, collapsible details), ported
 * from docs/<conf>/index.html's `.hero`/`.hero--compact` markup and
 * docs/assets/app.js's hero-toggle wiring. The "詳細を開閉" toggle keeps
 * the same `aria-expanded`/`aria-controls` contract as the original.
 */
export function CatalogHero({
  copy,
  generated,
  total,
  oralCount,
  tagCount,
  abstractCount = null,
  conf = "",
  conferences = [],
}: {
  copy: CatalogCopy;
  generated: string;
  total: number | null;
  oralCount: number | null;
  tagCount: number | null;
  /** Rows with an abstract; shown only when some rows lack one. */
  abstractCount?: number | null;
  conf?: string;
  /** Every published catalog, for the "他の学会" switcher. */
  conferences?: readonly { slug: string; display: string }[];
}) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();

  const stat = (value: number | null) => (value === null ? "—" : value.toLocaleString("ja-JP"));

  return (
    <header className="border-b border-rule bg-surface px-4 py-6 sm:px-6">
      <nav aria-label="breadcrumb" className="flex items-center gap-2 text-sm text-ink-muted">
        <a href={`${BASE_PATH}/`} className="hover:text-accent">
          PaperPilot
        </a>
        <span aria-hidden="true">/</span>
        <span aria-current="page">{copy.display}</span>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={detailsId}
          aria-label="この学会の説明を開閉"
          title="学会の説明を開閉"
          onClick={() => setOpen((prev) => !prev)}
          className="ml-auto rounded-full border border-rule px-3 py-1 text-xs text-ink-muted hover:border-rule-strong hover:text-ink"
        >
          詳細
        </button>
      </nav>
      <h1 className="mt-3 font-serif text-3xl font-bold tracking-tight text-ink sm:text-4xl">
        {copy.display} <em className="font-normal italic text-accent-strong">採択論文</em>
      </h1>
      <p className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm text-ink-muted">
        <span className="font-mono text-base text-ink">{stat(total)}</span> 論文
        {/* A conference without any Oral row (ICML 2026, every published
            row is a Poster) used to read "0 Oral" -- looks like missing
            data. Hidden once loaded and zero (design doc 53). */}
        {oralCount !== 0 && (
          <>
            <span aria-hidden="true">·</span>
            <span className="font-mono text-base text-oral-ink">{stat(oralCount)}</span> Oral
          </>
        )}
        {abstractCount !== null && total !== null && abstractCount < total && (
          <>
            <span aria-hidden="true">·</span>
            <span title="要旨（アブストラクト）が収録されている論文の数。残りはタイトル・著者・リンクのみです">
              要旨あり
            </span>{" "}
            <span className="font-mono text-base text-ink">{stat(abstractCount)}</span>
          </>
        )}
        <span aria-hidden="true">·</span>
        <span className="font-mono text-base text-ink">{stat(tagCount)}</span> タグ
        <span aria-hidden="true">·</span>
        <span title="一覧を取得した日（スナップショット）。この日より後の変更は入っていません">
          データの日付
        </span>{" "}
        <span className="font-mono text-base text-ink" data-data-date={generated || ""}>
          {generated || "—"}
        </span>
      </p>
      {copy.tagline && <p className="mt-2 text-sm text-ink-muted">{copy.tagline}</p>}
      <div id={detailsId} hidden={!open} className="mt-3">
        {copy.lede && <p className="text-sm text-ink-muted">{copy.lede}</p>}
      </div>
      {conferences.length > 1 && (
        // Design doc 53: the catalog page had no way to reach another
        // conference except going back to the landing page. A <details>
        // works without JavaScript too (the HTML is prerendered).
        <details className="mt-3 text-sm" data-conference-switcher>
          <summary className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-rule px-3 py-1 text-xs text-ink-muted hover:border-rule-strong hover:text-ink">
            他の学会を見る
          </summary>
          <nav aria-label="学会を切り替え" className="mt-2">
            <ul className="flex flex-wrap gap-2">
              {conferences.map((c) => (
                <li key={c.slug}>
                  {c.slug === conf ? (
                    <span
                      aria-current="page"
                      className="inline-block rounded-full border border-accent bg-accent/10 px-3 py-1 text-xs text-accent-strong"
                    >
                      {c.display}
                    </span>
                  ) : (
                    <a
                      href={`${BASE_PATH}/${c.slug}/`}
                      className="inline-block rounded-full border border-rule px-3 py-1 text-xs text-ink-muted hover:border-rule-strong hover:text-ink"
                    >
                      {c.display}
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </nav>
        </details>
      )}
    </header>
  );
}
