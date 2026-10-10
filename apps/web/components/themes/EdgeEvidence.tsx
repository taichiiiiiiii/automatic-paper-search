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
import {
  methodLabelJa,
  paperLink,
  parseEdgeEvidence,
  QUOTE_SOURCE_LABEL,
  semanticScholarUrl,
} from "../../lib/lineage/evidence";
import { RELATION_LABEL_JA } from "../../lib/lineage/relations";
import type { LineageEdge, LineageNode } from "../../lib/themes-quality";

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
        className="text-accent underline"
      >
        {primary.label}
      </a>
      {primary.label !== "Semantic Scholar" && (
        <a href={s2} target="_blank" rel="noopener noreferrer" className="text-accent underline">
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
  const { summary, quote } = parseEdgeEvidence(edge.rationale);
  const src = nodeById.get(edge.src);
  const dst = nodeById.get(edge.dst);
  const method = edge.provenance?.classification?.method;
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
          {methodLabelJa(method)}
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
          <figcaption className="mt-1 text-xs text-ink-subtle">
            出典: {QUOTE_SOURCE_LABEL}（引用文脈、
            <a
              href={dst ? semanticScholarUrl(dst) : "https://www.semanticscholar.org/"}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent underline"
            >
              {titleOf(dst, edge.dst)}
            </a>
            より 1 文を引用）
          </figcaption>
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
  }
>(function EdgeEvidencePanel({ edge, nodeById, onClose }, ref) {
  return (
    <section
      aria-labelledby="edge-evidence-title"
      data-testid="edge-evidence-panel"
      className="mt-3 rounded-md border border-accent bg-surface-elevated p-3"
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
          className="rounded-md border border-rule px-2 py-1 text-xs text-ink-muted hover:border-rule-strong"
        >
          閉じる ✕
        </button>
      </div>
      <EvidenceBody edge={edge} nodeById={nodeById} />
    </section>
  );
});

/** "関係の一覧": every currently visible edge, oldest paper first. */
export function EdgeRelationList({
  edges,
  nodeById,
  selectedKey,
  onSelect,
}: {
  edges: readonly LineageEdge[];
  nodeById: ReadonlyMap<string, LineageNode>;
  selectedKey: string | null;
  onSelect: (key: string) => void;
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
                </div>
                <p className="break-words text-xs text-ink-muted">
                  {summary}
                  {quote ? "（引用文あり）" : ""}
                </p>
                <div className="flex flex-wrap items-center gap-3 text-xs text-ink-subtle">
                  <span>判定方法: {methodLabelJa(e.provenance?.classification?.method)}</span>
                  <span>確信度 {e.confidence.toFixed(2)}</span>
                  <button
                    type="button"
                    aria-pressed={selectedKey === key}
                    onClick={() => onSelect(key)}
                    className="text-accent underline"
                  >
                    根拠を表示
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </details>
  );
}
