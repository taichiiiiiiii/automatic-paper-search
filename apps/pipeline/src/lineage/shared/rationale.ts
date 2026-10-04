/**
 * Final-output rationale filter (LIN-37) — TS port of
 * `paperpilot/scripts/build_lineage.py`'s `_is_degenerate_rationale` /
 * `_filter_edges_by_rationale` (#297).
 *
 * Consolidated per docs/migration/p4-followups.md #23:
 * `lineage/conference/buildLineage.ts` used to carry its own verbatim
 * copy of these two functions (with a local `MIN_RATIONALE_LEN = 10`
 * and `Array.from(rationale.trim()).length`, byte-for-byte identical to
 * `lineage/theme/edges.ts`'s copy, which already imported
 * `MIN_RATIONALE_LEN`/`codePointLength` from `../llm/base.js` instead of
 * redefining them). `lineage/theme/edges.ts` re-exports these two names
 * unchanged so its own existing importers (`lineage/theme/build.ts`)
 * are unaffected.
 */

import { codePointLength, MIN_RATIONALE_LEN } from "../llm/base.js";

/** True iff `rationale` is empty or below the `MIN_RATIONALE_LEN` floor
 * (#297). Centralises the "is this a meaningless tooltip" test. */
export function isDegenerateRationale(rationale: unknown): boolean {
  if (typeof rationale !== "string") return true;
  return codePointLength(rationale.trim()) < MIN_RATIONALE_LEN;
}

/** Drop edges whose rationale is empty or below the min-length floor —
 * belt-and-braces final filter (`RelationClassification.from_dict` and
 * the cache-hit guard already reject both, but this also catches edges
 * built outside those paths). */
export function filterEdgesByRationale<T extends { rationale?: unknown }>(
  edges: readonly T[],
): T[] {
  return edges.filter((e) => !isDegenerateRationale(e.rationale));
}
