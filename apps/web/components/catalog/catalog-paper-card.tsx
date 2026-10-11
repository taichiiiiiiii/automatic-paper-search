"use client";

import { useId, useState } from "react";
import { abstractAttribution, catalogLinks } from "../../lib/catalog-attribution";
import type { CatalogPaper } from "../../lib/catalog-core";
import type { PilotLineageStatus } from "../../lib/catalog-pilot-lineage";
import {
  buildAbstractDek,
  highlightSegments,
  safeHref,
  type TextSegment,
} from "../../lib/catalog-text";
import type { ThemePosition } from "../../lib/lineage/theme-position";
import styles from "./catalog.module.css";
import { ThemePositionSection } from "./catalog-theme-position";

export interface FullAbstractState {
  status: "loading" | "ready" | "failed";
  text: string | null;
}

/**
 * Renders text segments with every `mark` run wrapped in `<mark>`. Keys
 * are each segment's starting character offset, not the array index --
 * segments are a derived, position-stable render of one fixed string
 * per render, so there is no other identity to key them by, and an
 * offset-based key reads as "this run of text", not "whichever element
 * happened to be nth".
 */
function Highlighted({ segments }: { segments: TextSegment[] }) {
  let offset = 0;
  const nodes = segments.map((segment) => {
    const key = offset;
    offset += segment.text.length;
    return segment.mark ? (
      <mark key={key} className="rounded-sm bg-mark-bg px-0.5">
        {segment.text}
      </mark>
    ) : (
      <span key={key}>{segment.text}</span>
    );
  });
  return <>{nodes}</>;
}

/**
 * One catalog row, ported from docs/assets/app.js `renderPaper`. Title,
 * abstract and tags all go through React's default text escaping
 * (SCR-12/SCR-13) -- there is no `dangerouslySetInnerHTML` anywhere in
 * this component, so shard/query text can never become markup. Links
 * only ever point at an http(s) URL (`safeHref`, SCR-14).
 */
export function CatalogPaperCard({
  paper,
  isSelected,
  searchQuery,
  activeTags,
  onAddTagFromCard,
  onSelect,
  onClose,
  fullAbstract,
  pilotLineage,
  pilotLineageHref,
  themePositions,
  revealIndex,
}: {
  paper: CatalogPaper;
  isSelected: boolean;
  searchQuery: string;
  activeTags: ReadonlySet<string>;
  onAddTagFromCard: (tag: string) => void;
  onSelect: (paperId: string) => void;
  onClose: () => void;
  fullAbstract: FullAbstractState | undefined;
  pilotLineage: PilotLineageStatus | undefined;
  pilotLineageHref: string;
  /** Design doc 48 P1-3: where this paper sits in published theme
   * lineages (selected card only; `undefined` while unknown). */
  themePositions?: readonly ThemePosition[];
  revealIndex: number | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const abstractId = useId();
  const headingId = `paper-heading-${paper.paper_id}`;

  const q = searchQuery.toLowerCase().trim();
  const isOral = paper.type === "Oral";
  const authorPreview =
    paper.authors.slice(0, 4).join(", ") +
    (paper.authors.length > 4 ? `, +${paper.authors.length - 4}` : "");

  const fullText = isSelected && fullAbstract?.status === "ready" ? fullAbstract.text : null;
  const displayedAbstract = fullText === null ? paper.abstract : fullText;
  const hasAbstract = Boolean(displayedAbstract && displayedAbstract.length > 0);
  const dek = hasAbstract
    ? buildAbstractDek(displayedAbstract, q, { isFull: fullText !== null, isSelected })
    : null;
  const clamped = Boolean(dek?.needsToggle && !expanded);

  const arxivUrl = typeof paper.arxiv_url === "string" ? paper.arxiv_url : "";
  const pdfUrl = typeof paper.pdf_url === "string" ? paper.pdf_url : "";
  const titleHref = safeHref(arxivUrl || pdfUrl);
  const links = catalogLinks(paper);
  const attribution = abstractAttribution(paper);

  const dataReveal = revealIndex === null ? undefined : Math.min(revealIndex, 8);

  return (
    <li
      data-paper-id={paper.paper_id}
      data-reveal={dataReveal}
      id={`paper-${paper.paper_id}`}
      // Design doc 53: on a phone the type badge sits above the title
      // instead of in its own ~60px column, and it no longer stretches to
      // the card's full height (flex items default to align-self:
      // stretch, which drew a tall empty pill next to every card).
      className={`flex flex-col gap-1 border-b border-rule px-4 py-4 sm:scroll-mt-48 sm:flex-row sm:gap-3 sm:px-6 ${isSelected ? "bg-surface-2" : ""} ${
        dataReveal === undefined ? "" : styles.revealRow
      }`}
    >
      <span
        className={`shrink-0 self-start rounded-full border px-2 py-0.5 text-xs font-medium sm:mt-1 ${
          isOral ? "border-oral-border bg-oral-bg text-oral-ink" : "border-rule text-ink-subtle"
        }`}
      >
        {paper.type}
      </span>
      <div className="min-w-0 flex-1">
        <h2
          id={headingId}
          tabIndex={isSelected ? -1 : undefined}
          className="text-base font-semibold leading-snug text-ink"
        >
          {/* Titles are ink, not accent: 30 red headings per screen read
              as a wall of warnings (design doc 53). */}
          <a href={titleHref} target="_blank" rel="noopener" className={styles.titleLink}>
            <Highlighted segments={highlightSegments(paper.title, q)} />
          </a>
        </h2>
        {/* The selected (detail) card lists every author; the list view
            keeps the one-line preview. */}
        <p className={`mt-1 text-sm text-ink-muted ${isSelected ? "" : "truncate"}`}>
          {(isSelected ? paper.authors.join(", ") : authorPreview) || "—"}
        </p>

        {isSelected && (
          <div className="mt-2 flex items-center gap-3">
            <span className="text-xs font-medium text-accent-strong">選択中</span>
            <button
              type="button"
              data-close-paper={paper.paper_id}
              aria-keyshortcuts="Escape"
              title="詳細を閉じる（Esc）"
              onClick={onClose}
              className="rounded-full border border-rule px-3 py-1 text-xs text-ink-muted hover:border-rule-strong hover:text-ink"
            >
              詳細を閉じる
            </button>
          </div>
        )}

        <div className="mt-2" data-detail-body={paper.paper_id}>
          {dek && (
            <p
              id={abstractId}
              className={`text-sm text-ink-muted ${clamped ? "line-clamp-2" : ""}`}
            >
              {dek.leadEllipsis && <span aria-hidden="true">… </span>}
              <Highlighted segments={dek.segments} />
            </p>
          )}
          {/* Design doc 53: the two reading actions sit together under
              the preview, with distinct names -- "要旨をもっと見る" widens the
              preview in place; "詳細を開く" loads the full abstract and the
              lineage links (and gets its own URL). */}
          {!isSelected && (
            <div className="mt-1 flex flex-wrap items-center gap-3">
              {dek?.needsToggle && (
                <button
                  type="button"
                  aria-expanded={expanded}
                  aria-controls={abstractId}
                  onClick={() => setExpanded((prev) => !prev)}
                  className="text-xs font-medium text-accent-strong underline-offset-2 hover:underline"
                >
                  {expanded ? "要旨をたたむ" : "要旨をもっと見る"}
                </button>
              )}
              <button
                type="button"
                data-select-paper={paper.paper_id}
                aria-describedby={headingId}
                title="全文の要旨と系譜へのリンクを表示"
                onClick={() => onSelect(paper.paper_id)}
                className="rounded-full border border-rule px-3 py-1 text-xs text-ink-muted hover:border-rule-strong hover:text-ink"
              >
                詳細を開く
              </button>
            </div>
          )}
          {dek && attribution && !attribution.withheld && (
            <p
              className="mt-1 text-xs text-ink-subtle"
              data-abstract-source={paper.abstract_source}
            >
              {attribution.kind}の{attribution.source} ·{" "}
              <a
                href={safeHref(attribution.licenseUrl)}
                target="_blank"
                rel="noopener license"
                className={styles.strongLink}
              >
                {attribution.licenseLabel}
              </a>
              {attribution.note}
            </p>
          )}
          {attribution?.withheld && (
            <p className="text-xs text-ink-subtle" data-abstract-source="none">
              {attribution.text}
            </p>
          )}
          {isSelected && fullAbstract?.status === "loading" && (
            <p role="status" className="mt-1 text-xs text-ink-subtle">
              全文要旨を読み込み中…
            </p>
          )}
          {isSelected && fullAbstract?.status === "failed" && (
            <p role="status" className="mt-1 text-xs text-accent-strong">
              全文要旨を読み込めませんでした。プレビューと原文リンクを表示しています。
            </p>
          )}
          {isSelected &&
            !attribution?.withheld &&
            fullAbstract?.status === "ready" &&
            fullAbstract.text === "" && (
              <p role="status" className="mt-1 text-xs text-ink-subtle">
                全文要旨は収録されていません。
              </p>
            )}
        </div>

        {paper.tags.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {paper.tags.map((tag) => (
              <button
                key={tag}
                type="button"
                data-tag={tag}
                title={`タグ「${tag}」で絞り込む`}
                onClick={() => onAddTagFromCard(tag)}
                className={`rounded-full border px-2 py-0.5 text-xs ${
                  activeTags.has(tag)
                    ? "border-accent bg-accent/10 text-accent-strong"
                    : "border-rule text-ink-subtle hover:border-rule-strong"
                }`}
              >
                {tag}
              </button>
            ))}
          </div>
        )}

        {links.length > 0 && (
          <div className="mt-2 flex gap-3 text-xs">
            {links.map((link) => (
              <a
                key={`${link.label}:${link.url}`}
                href={safeHref(link.url)}
                target="_blank"
                rel="noopener"
                // accent on the selected card's surface-2 background is
                // 4.17:1 (< 4.5:1 for this 12px text); accent-strong is 7:1+.
                className={isSelected ? styles.strongLink : undefined}
              >
                {link.label}
              </a>
            ))}
          </div>
        )}

        {isSelected && themePositions && themePositions.length > 0 && (
          <ThemePositionSection positions={themePositions} />
        )}
        {isSelected && (
          <div className="mt-2 text-xs text-ink-subtle" data-pilot-lineage>
            {pilotLineage === "ready" ? (
              <a href={pilotLineageHref} className={styles.strongLink}>
                監査済みの研究系譜を開く →
              </a>
            ) : pilotLineage === "loading" ? (
              <p role="status">監査済み系譜の公開状況を確認しています…</p>
            ) : (
              <p>監査済みの研究系譜はまだ公開されていません。</p>
            )}
          </div>
        )}
      </div>
    </li>
  );
}
