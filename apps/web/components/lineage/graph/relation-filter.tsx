"use client";

/**
 * Relation-filter chip bar for the tree/timeline graph canvas --
 * ported from docs/assets/lineage.js `renderFilterChips`. A separate
 * instance from components/lineage/relation-list.tsx's own chip bar
 * (that file is outside this page agent's ownership, see the final
 * report's "known gap": the list view and the graph views keep
 * independent `visibleRelations` state, same as before this port,
 * rather than sharing one global filter like the original).
 */
import type { Relation } from "../../../lib/lineage/core";
import { ALL_RELATIONS, RELATION_LABEL_JA } from "../../../lib/lineage/relations";
import { RELATION_DOT_CLASS } from "./relation-colors";

export interface RelationFilterProps {
  visible: ReadonlySet<Relation>;
  onToggle: (relation: Relation) => void;
}

export function RelationFilter({ visible, onToggle }: RelationFilterProps) {
  return (
    <fieldset className="flex flex-wrap gap-2 border-0 p-0">
      <legend className="sr-only">Relation filter</legend>
      {ALL_RELATIONS.map((relation) => {
        const on = visible.has(relation);
        return (
          <button
            key={relation}
            type="button"
            aria-pressed={on}
            onClick={() => onToggle(relation)}
            className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition ${
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
    </fieldset>
  );
}
