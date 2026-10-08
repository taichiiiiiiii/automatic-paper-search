"use client";

import type { ChangeEvent } from "react";
import type { TagChip, TypeChip } from "../../lib/catalog-chips";
import type { AcceptanceType } from "../../lib/catalog-constants";
import styles from "./catalog.module.css";

/**
 * The filter bar: search input, acceptance-type chips, topic-tag chips
 * (top 18: head 8 always shown, the rest behind "+N タグ") -- ported
 * from docs/<conf>/index.html's `.filter-bar` and docs/assets/app.js's
 * `buildTypeChips`/`buildTagChips`.
 */
export function CatalogFilters({
  search,
  onSearchChange,
  typeChips,
  activeType,
  onTypeChange,
  tagHead,
  tagTail,
  tagTailExpanded,
  onExpandTags,
  activeTags,
  onToggleTag,
}: {
  search: string;
  onSearchChange: (value: string) => void;
  typeChips: TypeChip[];
  activeType: AcceptanceType;
  onTypeChange: (value: AcceptanceType) => void;
  tagHead: TagChip[];
  tagTail: TagChip[];
  tagTailExpanded: boolean;
  onExpandTags: () => void;
  activeTags: ReadonlySet<string>;
  onToggleTag: (tag: string) => void;
}) {
  const chipClass = (active: boolean) =>
    `inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors ${
      active
        ? "border-accent bg-accent/10 text-accent-strong"
        : "border-rule text-ink-muted hover:border-rule-strong hover:text-ink"
    }`;

  function handleSearchInput(event: ChangeEvent<HTMLInputElement>) {
    onSearchChange(event.target.value);
  }

  return (
    <section
      aria-label="絞り込み"
      className="sticky top-0 z-10 flex flex-col gap-3 border-b border-rule bg-paper/95 px-4 py-3 backdrop-blur sm:px-6"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative max-w-md flex-1">
          <input
            id="search"
            type="search"
            value={search}
            onChange={handleSearchInput}
            aria-label="論文をタイトル・著者・要旨で検索"
            placeholder="論文を検索（タイトル・著者・要旨）…"
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded-full border border-rule bg-surface-elevated px-4 py-2 text-base text-ink placeholder:text-ink-subtle focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
        </div>
        <fieldset className="flex flex-wrap gap-2 border-0 p-0 m-0">
          <legend className="sr-only">採択形式で絞り込み</legend>
          {typeChips.map((chip) => (
            <button
              key={chip.value}
              type="button"
              data-type={chip.value}
              aria-pressed={activeType === chip.value}
              onClick={() => onTypeChange(chip.value)}
              className={chipClass(activeType === chip.value)}
            >
              {chip.label}
              <span className="font-mono text-xs text-ink-subtle">{chip.count}</span>
            </button>
          ))}
        </fieldset>
      </div>
      <fieldset className={`border-0 p-0 m-0 ${styles.tagChipsRow}`}>
        <legend className="sr-only">トピックタグで絞り込み</legend>
        {tagHead.map((chip) => (
          <button
            key={chip.tag}
            type="button"
            data-tag={chip.tag}
            aria-pressed={activeTags.has(chip.tag)}
            onClick={() => onToggleTag(chip.tag)}
            className={chipClass(activeTags.has(chip.tag))}
          >
            {chip.tag}
            <span className="font-mono text-xs text-ink-subtle">{chip.count}</span>
          </button>
        ))}
        {tagTail.length > 0 &&
          tagTailExpanded &&
          tagTail.map((chip) => (
            <button
              key={chip.tag}
              type="button"
              data-tag={chip.tag}
              aria-pressed={activeTags.has(chip.tag)}
              onClick={() => onToggleTag(chip.tag)}
              className={chipClass(activeTags.has(chip.tag))}
            >
              {chip.tag}
              <span className="font-mono text-xs text-ink-subtle">{chip.count}</span>
            </button>
          ))}
        {tagTail.length > 0 && !tagTailExpanded && (
          <button
            type="button"
            aria-expanded={false}
            aria-controls="tag-chips-tail"
            onClick={onExpandTags}
            className={chipClass(false)}
          >
            +{tagTail.length} タグ
          </button>
        )}
      </fieldset>
    </section>
  );
}
