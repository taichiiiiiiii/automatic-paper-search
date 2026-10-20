/**
 * Relation display constants, ported from docs/assets/lineage.js
 * (`ALL_RELATIONS`, `RELATION_LABEL_JA`, `DEFAULT_RELATIONS`). Pure data
 * -- no DOM -- so it is shared by the conference lineage and theme
 * viewers' relation-filter chips and relation lists.
 */
import type { Relation } from "./core";

export const ALL_RELATIONS: Relation[] = [
  "supersedes",
  "successor",
  "extends",
  "ablation",
  "baseline_only",
  "contrasts",
];

/** Relations visible by default -- mirrors docs/assets/lineage.js
 * DEFAULT_RELATIONS (baseline_only starts hidden; it is comparison
 * noise for a first view, not genealogy). */
export const DEFAULT_VISIBLE_RELATIONS: Relation[] = [
  "supersedes",
  "successor",
  "extends",
  "ablation",
  "contrasts",
];

export const RELATION_LABEL_JA: Record<Relation, string> = {
  supersedes: "置換",
  successor: "後継",
  extends: "拡張",
  ablation: "分析",
  // R2 UX P1-6: most baseline_only edges are S2 "background" citations
  // (design doc 41 D6), not performance baselines -- "比較" misled.
  baseline_only: "参照（背景）",
  contrasts: "対立",
};

/** D-R2-40: a strong relation (everything but `baseline_only`) is inferred
 * by rules from a citation sentence, so it is shown as a candidate unless
 * its collection is human-audited. */
export const CANDIDATE_SUFFIX = "（候補）";
export const CANDIDATE_NOTE = "規則で推定した候補です。引用文で確かめてください。";
export const CANDIDATE_EVIDENCE_HEADING = "引用文から推定した関係（候補）";
export const AUDITED_RELATION_NOTE = "人が確認済み";

export function isCandidateRelation(relation: string, audited: boolean): boolean {
  return !audited && relation !== "baseline_only";
}

/** Japanese relation label; `拡張（候補）` unless `audited`. */
export function relationLabelFor(relation: string, audited: boolean, fallback = "関係"): string {
  const label = (RELATION_LABEL_JA as Record<string, string>)[relation] ?? fallback;
  return isCandidateRelation(relation, audited) && label !== fallback
    ? `${label}${CANDIDATE_SUFFIX}`
    : label;
}

export const RELATION_LABEL_EN: Record<Relation, string> = {
  supersedes: "Supersedes",
  successor: "Successor",
  extends: "Extends",
  ablation: "Ablation",
  baseline_only: "Background",
  contrasts: "Contrasts",
};

/** CSS custom property (apps/web/app/globals.css `--rel-*`) carrying
 * this relation's color -- ported 1:1 from docs/assets/style.css so the
 * relation legend keeps the same colors as today's site. */
export const RELATION_COLOR_VAR: Record<Relation, string> = {
  supersedes: "--rel-supersedes",
  successor: "--rel-successor",
  extends: "--rel-extends",
  ablation: "--rel-ablation",
  baseline_only: "--rel-baseline",
  contrasts: "--rel-contrasts",
};
