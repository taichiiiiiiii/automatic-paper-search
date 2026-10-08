"use client";

/**
 * Ready-state renderer for an audited lineage artifact: relation-filter
 * chips (ported from docs/assets/lineage.js `renderFilterChips`) plus a
 * relation list (the "関係リスト" / list view mode).
 *
 * The relation-filter state (`visibleRelations`/`onToggleRelation`) is
 * owned by the caller, not this component -- on `/[conf]/lineage/`,
 * components/lineage/graph/lineage-graph-app.tsx passes down the exact
 * same state its graph view's own
 * components/lineage/graph/relation-filter.tsx chips use, persisted
 * the same way the original does (`?relations=` + `localStorage
 * ["pp.lineage.prefs"]`), so switching between "関係リスト" and
 * "グラフ" keeps one filter instead of two independent ones (this used
 * to be a known parity gap -- see docs/migration/p2-parity-gaps.md's
 * history). `app/[conf]/deep/page.tsx` has no graph view to share
 * with, so it keeps its own local state and passes that instead.
 *
 * Scope note: this also ports the LIST view only. The Topics / Tree /
 * Timeline SVG graph layouts (`docs/assets/lineage.js` `render()`,
 * ~700 lines of force-directed / generational layout math) live in
 * components/lineage/graph/* instead.
 *
 * All text content goes through React's default escaping (SCR-26) --
 * no `dangerouslySetInnerHTML` anywhere in this tree.
 */
import { useMemo } from "react";
import type { LineageArtifact, LineageNode, Relation } from "../../lib/lineage/core";
import { selectActiveEdges } from "../../lib/lineage/core";
import { ALL_RELATIONS, RELATION_LABEL_JA } from "../../lib/lineage/relations";

// Literal (not computed) Tailwind classes per relation, carrying the
// same colors as docs/assets/style.css's `--rel-*` tokens (ported to
// apps/web/app/globals.css `@theme`). Written out so Tailwind's static
// scanner can see every class name; a runtime-constructed class string
// would not be found by the scanner and would be dropped from the
// built CSS. No `style=""` attribute is used anywhere in this file --
// the CSP (`style-src 'self'`, no `unsafe-inline`) forbids it.
const RELATION_DOT_CLASS: Record<Relation, string> = {
  supersedes: "bg-[var(--rel-supersedes)]",
  successor: "bg-[var(--rel-successor)]",
  extends: "bg-[var(--rel-extends)]",
  ablation: "bg-[var(--rel-ablation)]",
  baseline_only: "bg-[var(--rel-baseline)]",
  contrasts: "bg-[var(--rel-contrasts)]",
};

const RELATION_BADGE_CLASS: Record<Relation, string> = {
  supersedes: "bg-[var(--rel-supersedes)] text-paper",
  successor: "bg-[var(--rel-successor)] text-paper",
  extends: "bg-[var(--rel-extends)] text-paper",
  ablation: "bg-[var(--rel-ablation)] text-paper",
  baseline_only: "bg-[var(--rel-baseline)] text-paper",
  contrasts: "bg-[var(--rel-contrasts)] text-paper",
};

export interface RelationListProps {
  artifact: LineageArtifact;
  /** Node id to show first / highlight, e.g. the resolved `?focus=` node. */
  focusId?: string | null;
  /** Relation filter state -- see this file's header comment on why
   * this is a controlled prop rather than local state. */
  visibleRelations: ReadonlySet<Relation>;
  onToggleRelation: (relation: Relation) => void;
}

function nodeTitle(node: LineageNode | undefined): string {
  if (!node) return "(不明な論文)";
  return node.title || node.id;
}

export function RelationList({
  artifact,
  focusId,
  visibleRelations,
  onToggleRelation,
}: RelationListProps) {
  const nodeById = useMemo(
    () => new Map(artifact.nodes.map((node) => [node.id, node])),
    [artifact.nodes],
  );
  const activeEdges = useMemo(
    () => selectActiveEdges(artifact.edges, new Set(visibleRelations)),
    [artifact.edges, visibleRelations],
  );
  const focusedNode = focusId ? nodeById.get(focusId) : undefined;

  return (
    <div className="flex flex-col gap-6">
      {focusedNode && (
        <p className="text-sm text-ink-muted">
          中心論文: <span className="font-medium text-ink">{nodeTitle(focusedNode)}</span>
        </p>
      )}
      {/* biome-ignore lint/a11y/useSemanticElements: this is a toggle-button
          group (ported from docs/assets/lineage.js's #relation-filter), not
          a form fieldset -- <fieldset> would require a visible <legend>
          that duplicates aria-label and changes default browser styling. */}
      <div
        role="group"
        aria-label="Relation filter"
        className="flex flex-wrap gap-2 border-b border-rule pb-4"
      >
        {ALL_RELATIONS.map((relation) => {
          const on = visibleRelations.has(relation);
          return (
            <button
              key={relation}
              type="button"
              aria-pressed={on}
              onClick={() => onToggleRelation(relation)}
              className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition ${
                on
                  ? "border-ink bg-ink text-paper"
                  : "border-rule text-ink-muted hover:border-ink-muted"
              }`}
            >
              <span
                aria-hidden="true"
                className={`inline-block h-2 w-2 rounded-full ${RELATION_DOT_CLASS[relation]}`}
              />
              {RELATION_LABEL_JA[relation]}
            </button>
          );
        })}
      </div>

      <section aria-labelledby="relation-list-heading" className="flex flex-col gap-3">
        <h2 id="relation-list-heading" className="font-serif text-lg font-semibold text-ink">
          論文間の関係
        </h2>
        {activeEdges.length === 0 ? (
          <p className="text-sm text-ink-subtle">現在の条件で表示できる関係はありません。</p>
        ) : (
          <ul className="flex flex-col divide-y divide-rule">
            {activeEdges.map((edge) => {
              const src = nodeById.get(edge.src);
              const dst = nodeById.get(edge.dst);
              return (
                <li
                  key={`${edge.src}\u0000${edge.dst}\u0000${edge.relation}`}
                  className="flex flex-col gap-1 py-3"
                >
                  <div className="flex flex-wrap items-baseline gap-2 text-sm">
                    <span className="font-medium text-ink">{nodeTitle(src)}</span>
                    <span
                      className={`rounded px-1.5 py-0.5 text-xs font-semibold ${RELATION_BADGE_CLASS[edge.relation]}`}
                    >
                      {RELATION_LABEL_JA[edge.relation]}
                    </span>
                    <span className="font-medium text-ink">{nodeTitle(dst)}</span>
                    <span className="font-mono text-xs text-ink-subtle">
                      確信度 {edge.confidence.toFixed(2)}
                    </span>
                  </div>
                  <p className="text-sm text-ink-muted">{edge.rationale}</p>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
