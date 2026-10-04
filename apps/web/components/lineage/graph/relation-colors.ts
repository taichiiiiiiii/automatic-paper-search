/**
 * Literal (not computed) Tailwind color classes per relation, carrying
 * the same `--rel-*` tokens as docs/assets/style.css / app/globals.css
 * `@theme`. Written out in full -- not built with a template string --
 * so Tailwind's static scanner can see every class name; see
 * components/themes/LineageTree.tsx's `RELATION_STROKE_CLASS` for the
 * same pattern already established in this codebase, and
 * components/lineage/relation-list.tsx's `RELATION_DOT_CLASS` for the
 * `bg-*` equivalent. No `style=""` attribute is used anywhere in this
 * area -- CSP `style-src 'self'` forbids it; SVG presentation
 * attributes (fill/stroke/x/y/...) are not governed by `style-src`,
 * but `var()` support as a plain attribute VALUE is inconsistent
 * across browsers, so color always goes through one of these classes
 * instead of e.g. `fill="var(--rel-x)"`.
 */
import type { Relation } from "../../../lib/lineage/core";

/** Keyed by `markerClass` (lib/lineage/layout/constants.ts), i.e.
 * `baseline_only` is already normalized to `"baseline"`. */
export const RELATION_STROKE_CLASS: Record<string, string> = {
  supersedes: "stroke-[var(--rel-supersedes)]",
  successor: "stroke-[var(--rel-successor)]",
  extends: "stroke-[var(--rel-extends)]",
  ablation: "stroke-[var(--rel-ablation)]",
  baseline: "stroke-[var(--rel-baseline)]",
  contrasts: "stroke-[var(--rel-contrasts)]",
};

export const RELATION_FILL_CLASS: Record<string, string> = {
  supersedes: "fill-[var(--rel-supersedes)]",
  successor: "fill-[var(--rel-successor)]",
  extends: "fill-[var(--rel-extends)]",
  ablation: "fill-[var(--rel-ablation)]",
  baseline: "fill-[var(--rel-baseline)]",
  contrasts: "fill-[var(--rel-contrasts)]",
};

export const RELATION_BORDER_CLASS: Record<string, string> = {
  supersedes: "border-[var(--rel-supersedes)]",
  successor: "border-[var(--rel-successor)]",
  extends: "border-[var(--rel-extends)]",
  ablation: "border-[var(--rel-ablation)]",
  baseline: "border-[var(--rel-baseline)]",
  contrasts: "border-[var(--rel-contrasts)]",
};

/** Relation dot for filter chips / legend -- keyed by the raw
 * `Relation` (includes `baseline_only`, unlike the marker-class maps
 * above), matching components/lineage/relation-list.tsx's
 * `RELATION_DOT_CLASS` so the two chip bars (list vs. graph) look
 * identical. */
export const RELATION_DOT_CLASS: Record<Relation, string> = {
  supersedes: "bg-[var(--rel-supersedes)]",
  successor: "bg-[var(--rel-successor)]",
  extends: "bg-[var(--rel-extends)]",
  ablation: "bg-[var(--rel-ablation)]",
  baseline_only: "bg-[var(--rel-baseline)]",
  contrasts: "bg-[var(--rel-contrasts)]",
};

const DEFAULT_STROKE_CLASS = "stroke-[var(--rel-baseline)]";
const DEFAULT_FILL_CLASS = "fill-[var(--rel-baseline)]";

export function relationStrokeClass(markerClassName: string): string {
  return RELATION_STROKE_CLASS[markerClassName] ?? DEFAULT_STROKE_CLASS;
}

export function relationFillClass(markerClassName: string): string {
  return RELATION_FILL_CLASS[markerClassName] ?? DEFAULT_FILL_CLASS;
}
