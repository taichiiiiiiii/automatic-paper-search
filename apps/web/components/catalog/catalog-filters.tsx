"use client";

import { type ChangeEvent, useId } from "react";
import type { TagChip, TypeChip } from "../../lib/catalog-chips";
import type { AcceptanceType } from "../../lib/catalog-constants";
import { formatCount } from "../../lib/catalog-status";
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
  onToggleTagTail,
  activeTags,
  onToggleTag,
  abstractToggle = null,
}: {
  search: string;
  onSearchChange: (value: string) => void;
  typeChips: TypeChip[];
  activeType: AcceptanceType;
  onTypeChange: (value: AcceptanceType) => void;
  tagHead: TagChip[];
  tagTail: TagChip[];
  tagTailExpanded: boolean;
  onToggleTagTail: () => void;
  activeTags: ReadonlySet<string>;
  onToggleTag: (tag: string) => void;
  /** "要旨あり" toggle (design doc 53); null hides it (every row has an
   * abstract, so it could not narrow anything). */
  abstractToggle?: { active: boolean; count: number; onToggle: () => void } | null;
}) {
  const tailId = useId();
  const hiddenTailCount = tagTail.filter((chip) => !activeTags.has(chip.tag)).length;
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
      // Sticky only from `sm` up: on a 375px phone the bar (search + type
      // chips + tag row) took 163px -- a fifth of the screen -- on every
      // scroll position. The back-to-top button returns focus to the
      // search box instead (design doc 53).
      className="flex flex-col gap-3 border-b border-rule bg-paper/95 px-4 py-3 backdrop-blur sm:sticky sm:top-0 sm:z-10 sm:px-6"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative max-w-xl flex-1">
          <input
            id="search"
            type="search"
            value={search}
            onChange={handleSearchInput}
            aria-label="論文をタイトル・著者・要旨で検索（英語、複数語はすべて含むものを表示）"
            placeholder="英語で検索（例: diffusion video）"
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded-full border border-rule bg-surface-elevated px-4 py-2 text-base text-ink placeholder:text-ink-subtle focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
        </div>
        {(typeChips.length > 0 || abstractToggle) && (
          <fieldset className="m-0 flex min-w-0 flex-wrap gap-2 border-0 p-0">
            <legend className="sr-only">採択形式と要旨の有無で絞り込み</legend>
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
                <span className="font-mono text-xs text-ink-subtle">{formatCount(chip.count)}</span>
              </button>
            ))}
            {abstractToggle && (
              <button
                type="button"
                data-has-abstract
                aria-pressed={abstractToggle.active}
                onClick={abstractToggle.onToggle}
                title="要旨（アブストラクト）が収録されている論文だけを表示"
                className={chipClass(abstractToggle.active)}
              >
                要旨あり
                <span className="font-mono text-xs text-ink-subtle">
                  {formatCount(abstractToggle.count)}
                </span>
              </button>
            )}
          </fieldset>
        )}
      </div>
      <fieldset className={`m-0 min-w-0 border-0 p-0 ${styles.tagChipsRow}`}>
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
            <span className="font-mono text-xs text-ink-subtle">{formatCount(chip.count)}</span>
          </button>
        ))}
        {tagTail.length > 0 && (
          // Collapsed, the tail still shows every ACTIVE tag (a filter
          // restored from the URL is never invisibly on); expanded, every
          // tag. One toggle opens and closes it (design doc 53).
          <span id={tailId} className="contents">
            {tagTail
              .filter((chip) => tagTailExpanded || activeTags.has(chip.tag))
              .map((chip) => (
                <button
                  key={chip.tag}
                  type="button"
                  data-tag={chip.tag}
                  aria-pressed={activeTags.has(chip.tag)}
                  onClick={() => onToggleTag(chip.tag)}
                  className={chipClass(activeTags.has(chip.tag))}
                >
                  {chip.tag}
                  <span className="font-mono text-xs text-ink-subtle">
                    {formatCount(chip.count)}
                  </span>
                </button>
              ))}
          </span>
        )}
        {tagTail.length > 0 && (tagTailExpanded || hiddenTailCount > 0) && (
          <button
            type="button"
            aria-expanded={tagTailExpanded}
            aria-controls={tailId}
            onClick={onToggleTagTail}
            className={chipClass(false)}
          >
            {tagTailExpanded ? "タグをたたむ" : `+${hiddenTailCount} タグ`}
          </button>
        )}
      </fieldset>
    </section>
  );
}
