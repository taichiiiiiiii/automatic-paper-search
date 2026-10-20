/**
 * Static relation-type legend -- ported from docs/iclr-2026/lineage.html's
 * `<details class="legend-collapsible">`. Only shown for the tree/
 * timeline SVG modes (lib/lineage/layout/view-model.ts
 * `legendVisible`); the toolbar's relation-filter chips already carry
 * the same color swatch on each pill, same rationale as the original
 * comment this ports.
 */

import type { Relation } from "../../../lib/lineage/core";
import {
  ALL_RELATIONS,
  CANDIDATE_NOTE,
  CANDIDATE_SUFFIX,
  isCandidateRelation,
  RELATION_LABEL_EN,
  RELATION_LABEL_JA,
} from "../../../lib/lineage/relations";
import { useRelationAudited } from "../relation-audit";
import { RELATION_DOT_CLASS } from "./relation-colors";

const RELATION_JA_PAREN: Record<Relation, string> = {
  supersedes: "置換",
  successor: "後継",
  extends: "拡張",
  ablation: "成分分析",
  baseline_only: "参照（背景）",
  contrasts: "対立",
};

export function Legend() {
  const audited = useRelationAudited();
  return (
    <details className="rounded-md border border-rule p-3 text-xs" open>
      <summary className="cursor-pointer font-medium text-ink-muted">
        関係種別の凡例（6 種）
      </summary>
      <div className="mt-2 flex flex-wrap gap-3">
        {ALL_RELATIONS.map((relation) => (
          <span key={relation} className="flex items-center gap-1.5 text-ink-muted">
            <span
              aria-hidden="true"
              className={`inline-block h-2 w-2 rounded-full ${RELATION_DOT_CLASS[relation]}`}
            />
            {isCandidateRelation(relation, audited)
              ? `${RELATION_LABEL_EN[relation]}：${RELATION_JA_PAREN[relation] ?? RELATION_LABEL_JA[relation]}${CANDIDATE_SUFFIX}`
              : `${RELATION_LABEL_EN[relation]}（${RELATION_JA_PAREN[relation] ?? RELATION_LABEL_JA[relation]}）`}
          </span>
        ))}
      </div>
      {!audited && <p className="mt-2 text-ink-subtle">{CANDIDATE_NOTE}</p>}
    </details>
  );
}
