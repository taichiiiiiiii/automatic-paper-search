"use client";

import { useId, useState } from "react";
import type { CatalogPaper } from "../../lib/catalog-core";
import type { PilotLineageStatus } from "../../lib/catalog-pilot-lineage";
import {
  buildAbstractDek,
  highlightSegments,
  safeHref,
  type TextSegment,
} from "../../lib/catalog-text";
import styles from "./catalog.module.css";

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

  const dataReveal = revealIndex === null ? undefined : Math.min(revealIndex, 8);

  return (
    <li
      data-paper-id={paper.paper_id}
      data-reveal={dataReveal}
      id={`paper-${paper.paper_id}`}
      className={`flex gap-3 border-b border-rule px-4 py-4 sm:px-6 ${isSelected ? "bg-surface-2" : ""} ${
        dataReveal === undefined ? "" : styles.revealRow
      }`}
    >
      <span
        className={`mt-1 shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium ${
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
          <a href={titleHref} target="_blank" rel="noopener" className="hover:text-accent">
            <Highlighted segments={highlightSegments(paper.title, q)} />
          </a>
        </h2>
        <p className="mt-1 truncate text-sm text-ink-muted">{authorPreview || "—"}</p>

        {isSelected ? (
          <div className="mt-2 flex items-center gap-3">
            <span className="text-xs font-medium text-accent-strong">選択中</span>
            <button
              type="button"
              data-close-paper={paper.paper_id}
              onClick={onClose}
              className="rounded-full border border-rule px-3 py-1 text-xs text-ink-muted hover:border-rule-strong hover:text-ink"
            >
              詳細を閉じる
            </button>
          </div>
        ) : (
          <button
            type="button"
            data-select-paper={paper.paper_id}
            aria-expanded={false}
            onClick={() => onSelect(paper.paper_id)}
            className="mt-2 rounded-full border border-rule px-3 py-1 text-xs text-ink-muted hover:border-rule-strong hover:text-ink"
          >
            内容を見る
          </button>
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
          {dek?.needsToggle && (
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls={abstractId}
              onClick={() => setExpanded((prev) => !prev)}
              className="mt-1 text-xs font-medium text-accent hover:text-accent-strong"
            >
              {expanded ? "閉じる" : "続きを読む"}
            </button>
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
          {isSelected && fullAbstract?.status === "ready" && fullAbstract.text === "" && (
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

        {(arxivUrl || pdfUrl) && (
          <div className="mt-2 flex gap-3 text-xs">
            {arxivUrl && (
              <a
                href={safeHref(arxivUrl)}
                target="_blank"
                rel="noopener"
                className="text-accent hover:text-accent-strong"
              >
                arXiv
              </a>
            )}
            {pdfUrl && (
              <a
                href={safeHref(pdfUrl)}
                target="_blank"
                rel="noopener"
                className="text-accent hover:text-accent-strong"
              >
                PDF
              </a>
            )}
          </div>
        )}

        {isSelected && (
          <div className="mt-2 text-xs text-ink-subtle" data-pilot-lineage>
            {pilotLineage === "ready" ? (
              <a href={pilotLineageHref} className="text-accent hover:text-accent-strong">
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
