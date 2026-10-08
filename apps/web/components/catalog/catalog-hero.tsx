"use client";

import { useId, useState } from "react";
import type { CatalogCopy } from "../../lib/catalog-copy";

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
}: {
  copy: CatalogCopy;
  generated: string;
  total: number | null;
  oralCount: number | null;
  tagCount: number | null;
}) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();

  const stat = (value: number | null) => (value === null ? "—" : value.toLocaleString("ja-JP"));

  return (
    <header className="border-b border-rule bg-surface px-4 py-6 sm:px-6">
      <nav aria-label="breadcrumb" className="flex items-center gap-2 text-sm text-ink-muted">
        <a href="/" className="hover:text-accent">
          PaperPilot
        </a>
        <span aria-hidden="true">/</span>
        <span>{copy.display}</span>
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
        <span aria-hidden="true">·</span>
        <span className="font-mono text-base text-oral-ink">{stat(oralCount)}</span> Oral
        <span aria-hidden="true">·</span>
        <span className="font-mono text-base text-ink">{stat(tagCount)}</span> タグ
        <span aria-hidden="true">·</span>
        更新 <span className="font-mono text-base text-ink">{generated || "—"}</span>
      </p>
      {copy.tagline && <p className="mt-2 text-sm text-ink-muted">{copy.tagline}</p>}
      <div id={detailsId} hidden={!open} className="mt-3">
        {copy.lede && <p className="text-sm text-ink-muted">{copy.lede}</p>}
      </div>
    </header>
  );
}
