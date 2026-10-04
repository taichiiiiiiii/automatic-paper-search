/**
 * Topic-tag / acceptance-type chip data, ported from docs/assets/app.js
 * (`buildTagChips`, `buildTypeChips`). Pure data builders -- the
 * components render the chips; these just decide which ones, in which
 * order, with which counts.
 */

import type { AcceptanceType } from "./catalog-constants";
import { ACCEPTANCE_TYPES, TAG_CHIP_HEAD_COUNT, TAG_CHIP_LIMIT } from "./catalog-constants";
import type { CatalogPaper } from "./catalog-core";

export interface TagChip {
  tag: string;
  count: number;
}

export interface TagChipGroups {
  /** Always-visible chips (the most frequent `TAG_CHIP_HEAD_COUNT`). */
  head: TagChip[];
  /** The remaining chips (up to `TAG_CHIP_LIMIT` total), behind a "+N
   * タグ" expander. */
  tail: TagChip[];
  /** True when an active (URL/state-restored) filter tag is in `tail` --
   * the caller must start expanded so a restored filter is never
   * invisibly on. */
  tailActiveByDefault: boolean;
}

/** Top `TAG_CHIP_LIMIT` tags by paper count, split into `head` (always
 * shown) and `tail` (behind the expander). Ties keep the tags' first
 * appearance order (`Map` insertion order), matching
 * `Array.prototype.sort`'s stability in the original. */
export function buildTagChipGroups(
  papers: readonly CatalogPaper[],
  activeTags: ReadonlySet<string>,
): TagChipGroups {
  const counts = new Map<string, number>();
  for (const p of papers) {
    for (const t of p.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const sorted = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TAG_CHIP_LIMIT)
    .map(([tag, count]) => ({ tag, count }));
  const head = sorted.slice(0, TAG_CHIP_HEAD_COUNT);
  const tail = sorted.slice(TAG_CHIP_HEAD_COUNT);
  return { head, tail, tailActiveByDefault: tail.some((chip) => activeTags.has(chip.tag)) };
}

export interface TypeChip {
  value: AcceptanceType;
  label: string;
  count: number;
}

/** Acceptance-type chips (All / Oral / Poster), with counts. A type with
 * zero rows (e.g. a conference with no Oral) is still listed as long as
 * it is one of the three known values -- only `all` is unconditional. */
export function buildTypeChips(papers: readonly CatalogPaper[]): TypeChip[] {
  const counts = new Map<string, number>([["all", papers.length]]);
  for (const p of papers) counts.set(p.type, (counts.get(p.type) ?? 0) + 1);
  return ACCEPTANCE_TYPES.filter((value) => value === "all" || counts.has(value)).map((value) => ({
    value,
    label: value,
    count: counts.get(value) ?? 0,
  }));
}
