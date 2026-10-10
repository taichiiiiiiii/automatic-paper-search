/**
 * Citation-marker counting for one context sentence (R2-10; moved out of
 * `apiRelations.ts` in R2-16 so `citedTarget.ts` can share it without an
 * import cycle). `apiRelations.ts` re-exports it.
 */

const NUMERIC_GROUP = /\[([^\]]{1,80})\]/g;
const BRACKET_RANGE = /\[(\d{1,4})\]\s*[-–—]\s*\[(\d{1,4})\]/g;
const NUMERIC_ITEM = /^\s*\d{1,4}\s*$/;
const NUMERIC_RANGE = /^\s*(\d{1,4})\s*[-–—]\s*(\d{1,4})\s*$/;
const AUTHOR_YEAR_GROUP = /\(([^()]{0,200}\b(?:1[89]|20)\d{2}[a-z]?\b[^()]{0,200})\)/g;
const NARRATIVE_CITATION =
  /\b[A-Z][\w'-]+(?:\s+(?:et\s+al\.?|and\s+[A-Z][\w'-]+))?\s*\((?:1[89]|20)\d{2}[a-z]?\)/g;

/**
 * Number of works a context sentence cites, counted from its citation
 * markers: numeric groups (`[3]`, `[3, 7]`, `[3-5]` counts 3), author-year
 * groups (`(Smith et al., 2020; Lee, 2021)` counts 2) and narrative
 * citations (`Smith et al. (2020)`). Returns 0 when no marker is
 * recognised (S2 sometimes strips them) — callers must treat 0 as
 * "unknown", not as "one".
 */
export function citationTargetCount(sentence: string): number {
  let count = 0;
  // "[3]-[5]": a range written across two bracket groups.
  const rest = sentence.replace(BRACKET_RANGE, (_m, a: string, b: string) => {
    count += Math.max(1, Number(b) - Number(a) + 1);
    return " ";
  });
  for (const m of rest.matchAll(NUMERIC_GROUP)) {
    const items = (m[1] as string).split(/[,;]/);
    if (!items.every((it) => NUMERIC_ITEM.test(it) || NUMERIC_RANGE.test(it))) continue;
    for (const it of items) {
      const r = NUMERIC_RANGE.exec(it);
      count += r ? Math.max(1, Number(r[2]) - Number(r[1]) + 1) : 1;
    }
  }
  const withoutNarrative = rest.replace(NARRATIVE_CITATION, () => {
    count += 1;
    return " ";
  });
  for (const m of withoutNarrative.matchAll(AUTHOR_YEAR_GROUP)) {
    count += (m[1] as string).split(";").filter((s) => /\b(?:1[89]|20)\d{2}/.test(s)).length;
  }
  return count;
}
