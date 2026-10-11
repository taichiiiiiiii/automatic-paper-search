"use client";

/**
 * Evidence UI for theme lineage edges (R2 UX review P0-2, design doc 41
 * D6): a pinned panel opened by clicking / tapping / pressing Enter on an
 * edge, and a "関係の一覧" list under the graph. Both show the full
 * rationale, the quoted citation sentence as a blockquote (one sentence,
 * ≤ ~300 chars, with its source label "Semantic Scholar"), the
 * classification method in Japanese, the confidence, and links to both
 * papers and to Semantic Scholar.
 *
 * Rendered as ordinary HTML outside the SVG so it reflows on a 375 px
 * screen (the old hover tooltip was a fixed 260x110 box inside the SVG).
 * All text goes through React's escaping; no inline styles (CSP).
 */
import { forwardRef } from "react";
import { BASE_PATH } from "../../lib/config";
import {
  ABSTRACT_SOURCE_LABEL,
  ARXIV_HTML_SOURCE_LABEL,
  arxivHtmlSourceOf,
  edgeMethodLabelJa,
  paperLink,
  parseEdgeEvidence,
  QUOTE_SOURCE_LABEL,
  quoteAuthorCredit,
  semanticScholarUrl,
} from "../../lib/lineage/evidence";
import { lineageFeedbackIssueUrl } from "../../lib/lineage/feedback";
import { RELATION_LABEL_JA } from "../../lib/lineage/relations";
import type { LineageEdge, LineageNode } from "../../lib/themes-quality";

/** Theme identity for the "誤りを報告" link (design doc 48 P0-2). */
export interface FeedbackTheme {
  name: string;
  slug: string;
}

function themePageUrl(slug: string, nodeId: string): string | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams({ theme: slug, node: nodeId });
  return `${window.location.origin}${BASE_PATH}/themes/?${params.toString()}`;
}

/** Opens a prefilled GitHub issue for this one relation. */
export function ReportEdgeLink({
  edge,
  nodeById,
  theme,
}: {
  edge: LineageEdge;
  nodeById: ReadonlyMap<string, LineageNode>;
  theme: FeedbackTheme;
}) {
  const src = nodeById.get(edge.src);
  const dst = nodeById.get(edge.dst);
  const href = lineageFeedbackIssueUrl({
    theme,
    edge,
    older: { id: edge.src, title: src?.title, year: src?.year },
    newer: { id: edge.dst, title: dst?.title, year: dst?.year },
    pageUrl: themePageUrl(theme.slug, edge.dst),
  });
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      data-report-edge
      title="GitHub の Issue を開きます（GitHub のアカウントが必要です）"
      className="text-accent-strong underline"
    >
      誤りを報告
    </a>
  );
}

export function relationLabelJa(relation: string): string {
  return (RELATION_LABEL_JA as Record<string, string>)[relation] ?? "関係";
}

export function edgeKey(e: LineageEdge): string {
  return `${e.src}\u0000${e.dst}\u0000${e.relation}`;
}

function titleOf(node: LineageNode | undefined, fallbackId: string): string {
  return (node?.title as string | undefined) || fallbackId;
}

function PaperLinks({ node, id }: { node: LineageNode | undefined; id: string }) {
  const ref = node ?? { id };
  const primary = paperLink(ref);
  const s2 = semanticScholarUrl(ref);
  return (
    <span className="ml-1 inline-flex flex-wrap gap-2 text-xs">
      <a
        href={primary.url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-accent-strong underline"
      >
        {primary.label}
      </a>
      {primary.label !== "Semantic Scholar" && (
        <a
          href={s2}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent-strong underline"
        >
          Semantic Scholar
        </a>
      )}
    </span>
  );
}

function EvidenceBody({
  edge,
  nodeById,
}: {
  edge: LineageEdge;
  nodeById: ReadonlyMap<string, LineageNode>;
}) {
  const { summary, quote, quoteSource } = parseEdgeEvidence(edge.rationale);
  const src = nodeById.get(edge.src);
  const dst = nodeById.get(edge.dst);
  const method = edge.provenance?.classification?.method;
  // R2-26: the quoted sentence is the citing (newer) paper's text; name its
  // authors next to its title (Japanese copyright act art. 48(2)).
  const credit = quoteAuthorCredit(dst);
  const creditPrefix = credit ? `${credit}「` : "「";
  return (
    <>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-xs">
        <dt className="text-ink-subtle">古い論文</dt>
        <dd className="min-w-0 break-words text-ink">
          {titleOf(src, edge.src)}
          {typeof src?.year === "number" ? ` (${src.year})` : ""}
          <PaperLinks node={src} id={edge.src} />
        </dd>
        <dt className="text-ink-subtle">新しい論文</dt>
        <dd className="min-w-0 break-words text-ink">
          {titleOf(dst, edge.dst)}
          {typeof dst?.year === "number" ? ` (${dst.year})` : ""}
          <PaperLinks node={dst} id={edge.dst} />
        </dd>
        <dt className="text-ink-subtle">判定方法</dt>
        <dd className="text-ink-muted" data-evidence-method={method ?? ""}>
          {edgeMethodLabelJa(method, edge.rationale)}
        </dd>
        <dt className="text-ink-subtle">確信度</dt>
        <dd className="font-mono text-ink-muted">{edge.confidence.toFixed(2)}</dd>
      </dl>
      <p className="mt-2 break-words text-sm text-ink-muted">{summary}</p>
      {quote && (
        <figure className="mt-2">
          <blockquote
            lang="en"
            className="break-words border-l-4 border-rule-strong bg-surface-2 px-3 py-2 text-sm italic text-ink"
          >
            “{quote}”
          </blockquote>
          {quoteSource === "abstract" ? (
            <figcaption
              className="mt-1 text-xs text-ink-subtle"
              data-quote-source="abstract"
              data-quote-credit={credit}
            >
              出典: {ABSTRACT_SOURCE_LABEL}（{creditPrefix}
              <a
                href={dst ? paperLink(dst).url : "https://www.semanticscholar.org/"}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent-strong underline"
              >
                {titleOf(dst, edge.dst)}
              </a>
              」の要旨より 1 文を引用）
            </figcaption>
          ) : quoteSource === "arxiv-html" ? (
            <figcaption className="mt-1 text-xs text-ink-subtle" data-quote-source="arxiv-html">
              出典: {ARXIV_HTML_SOURCE_LABEL}（
              <a
                href={`https://arxiv.org/html/${arxivHtmlSourceOf(edge.rationale)?.id ?? ""}${arxivHtmlSourceOf(edge.rationale)?.version ?? ""}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent-strong underline"
              >
                {titleOf(dst, edge.dst)}
              </a>
              の本文より 1 文を引用）
            </figcaption>
          ) : (
            <figcaption className="mt-1 text-xs text-ink-subtle" data-quote-credit={credit}>
              出典: {QUOTE_SOURCE_LABEL}（引用文脈、{creditPrefix}
              <a
                href={dst ? semanticScholarUrl(dst) : "https://www.semanticscholar.org/"}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent-strong underline"
              >
                {titleOf(dst, edge.dst)}
              </a>
              」より 1 文を引用）
            </figcaption>
          )}
        </figure>
      )}
    </>
  );
}

/** Pinned evidence panel for one selected edge. `ref` targets the
 * heading so the caller can move focus there when the panel opens. */
export const EdgeEvidencePanel = forwardRef<
  HTMLHeadingElement,
  {
    edge: LineageEdge;
    nodeById: ReadonlyMap<string, LineageNode>;
    onClose: () => void;
    theme?: FeedbackTheme | null;
    onMainPath?: boolean;
  }
>(function EdgeEvidencePanel({ edge, nodeById, onClose, theme, onMainPath }, ref) {
  return (
    // On a phone the panel is a bottom sheet over the tree (the reader
    // keeps the graph in view and closes it with ✕ / Esc); from `sm` up it
    // sits inline right under the graph. Non-modal, so no focus trap: focus
    // moves to the heading on open and back to the opener on close.
    <section
      aria-labelledby="edge-evidence-title"
      data-testid="edge-evidence-panel"
      className="fixed inset-x-0 bottom-0 z-40 max-h-[65vh] overflow-y-auto rounded-t-lg border-t-2 border-accent bg-surface-elevated p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-[0_-8px_24px_rgba(20,15,10,0.18)] sm:static sm:z-auto sm:mt-3 sm:max-h-none sm:overflow-visible sm:rounded-md sm:border-2 sm:pb-3 sm:shadow-none"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <h2
          id="edge-evidence-title"
          ref={ref}
          tabIndex={-1}
          className="font-serif text-base font-semibold text-ink"
        >
          関係の根拠: {relationLabelJa(edge.relation)}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="根拠パネルを閉じる"
          className="inline-flex min-h-9 shrink-0 items-center rounded-md border border-rule px-3 py-1 text-xs text-ink-muted hover:border-rule-strong"
        >
          閉じる ✕
        </button>
      </div>
      {onMainPath && (
        <p className="mt-1 text-xs text-ink-subtle" data-main-path-edge>
          この関係は本流（主経路）に入っています。
        </p>
      )}
      <EvidenceBody edge={edge} nodeById={nodeById} />
      {theme && (
        <p className="mt-2 text-xs text-ink-subtle">
          関係や根拠が誤っていたら <ReportEdgeLink edge={edge} nodeById={nodeById} theme={theme} />
          してください。
        </p>
      )}
    </section>
  );
});

/** "関係の一覧": every currently visible edge, oldest paper first. */
export function EdgeRelationList({
  edges,
  nodeById,
  selectedKey,
  onSelect,
  theme,
  mainPathKeys,
}: {
  edges: readonly LineageEdge[];
  nodeById: ReadonlyMap<string, LineageNode>;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  theme?: FeedbackTheme | null;
  mainPathKeys?: ReadonlySet<string>;
}) {
  const yearOf = (id: string) => {
    const y = nodeById.get(id)?.year;
    return typeof y === "number" ? y : Number.POSITIVE_INFINITY;
  };
  const sorted = [...edges].sort(
    (a, b) => yearOf(a.dst) - yearOf(b.dst) || b.confidence - a.confidence,
  );
  return (
    <details className="mt-6" open={edges.length <= 30}>
      <summary className="cursor-pointer font-serif text-lg font-semibold text-ink">
        関係の一覧（{edges.length} 件）
      </summary>
      {sorted.length === 0 ? (
        <p className="mt-2 text-sm text-ink-subtle">現在の条件で表示できる関係はありません。</p>
      ) : (
        <ul className="mt-2 flex flex-col divide-y divide-rule" data-testid="edge-relation-list">
          {sorted.map((e) => {
            const key = edgeKey(e);
            const { summary, quote } = parseEdgeEvidence(e.rationale);
            return (
              <li key={key} className="flex flex-col gap-1 py-3">
                <div className="flex flex-wrap items-baseline gap-2 text-sm">
                  <span className="min-w-0 break-words font-medium text-ink">
                    {titleOf(nodeById.get(e.src), e.src)}
                  </span>
                  <span className="rounded bg-surface-2 px-1.5 py-0.5 text-xs font-semibold text-ink">
                    → {relationLabelJa(e.relation)} →
                  </span>
                  <span className="min-w-0 break-words font-medium text-ink">
                    {titleOf(nodeById.get(e.dst), e.dst)}
                  </span>
                  {mainPathKeys?.has(key) && (
                    <span
                      className="rounded bg-accent/10 px-1.5 py-0.5 text-xs font-semibold text-accent-strong"
                      data-main-path-edge
                    >
                      本流
                    </span>
                  )}
                </div>
                <p className="break-words text-xs text-ink-muted">
                  {summary}
                  {quote ? "（引用文あり）" : ""}
                </p>
                <div className="flex flex-wrap items-center gap-3 text-xs text-ink-subtle">
                  <span>
                    判定方法: {edgeMethodLabelJa(e.provenance?.classification?.method, e.rationale)}
                  </span>
                  <span>確信度 {e.confidence.toFixed(2)}</span>
                  <button
                    type="button"
                    aria-pressed={selectedKey === key}
                    onClick={() => onSelect(key)}
                    className="-my-1 py-1 text-accent-strong underline"
                  >
                    根拠を表示
                  </button>
                  {theme && <ReportEdgeLink edge={e} nodeById={nodeById} theme={theme} />}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </details>
  );
}
