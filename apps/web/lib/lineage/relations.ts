/**
 * Relation display constants, ported from docs/assets/lineage.js
 * (`ALL_RELATIONS`, `RELATION_LABEL_JA`, `DEFAULT_RELATIONS`). Pure data
 * -- no DOM -- so it is shared by the conference lineage and deep
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
