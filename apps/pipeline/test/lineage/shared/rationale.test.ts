/**
 * Vitest port of `test_build_lineage.py::test_build_final_filter_drops_short_rationale_edges`
 * (LIN-37). Relocated from `test/lineage/theme/edges.test.ts` per
 * docs/migration/p4-followups.md #23: `lineage/conference/buildLineage.ts`
 * used to carry its own byte-for-byte-identical copy of these two
 * functions, independently of `lineage/theme/edges.ts`'s copy; both are
 * now the one implementation in `src/lineage/shared/rationale.ts`.
 */
import { describe, expect, it } from "vitest";
import {
  filterEdgesByRationale,
  isDegenerateRationale,
} from "../../../src/lineage/shared/rationale.js";

describe("filterEdgesByRationale / isDegenerateRationale (LIN-37)", () => {
  it("drops edges whose rationale is below MIN_RATIONALE_LEN, not just empty ones", () => {
    const edges = [
      { src: "a", dst: "b", rel: "extends", conf: 0.7, rationale: "A" },
      { src: "a", dst: "c", rel: "extends", conf: 0.7, rationale: "   " },
      {
        src: "a",
        dst: "d",
        rel: "extends",
        conf: 0.7,
        rationale: "論文 B は論文 A の手法を別ドメインに拡張している。",
      },
    ];
    const kept = filterEdgesByRationale(edges);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.dst).toBe("d");
  });

  it("isDegenerateRationale: non-string, empty-after-trim, and below-floor are all degenerate; a full sentence is not", () => {
    expect(isDegenerateRationale(undefined)).toBe(true);
    expect(isDegenerateRationale(null)).toBe(true);
    expect(isDegenerateRationale(123)).toBe(true);
    expect(isDegenerateRationale("   ")).toBe(true);
    expect(isDegenerateRationale("A")).toBe(true);
    expect(isDegenerateRationale("論文 B は論文 A の手法を別ドメインに拡張している。")).toBe(false);
  });

  // MEDIUM-13 (#review): the exact `MIN_RATIONALE_LEN` (10) boundary. The
  // Python/TS rule is `len(trimmed) < MIN_RATIONALE_LEN` — strictly less
  // than, so exactly 10 code points is NOT degenerate. A mutant that
  // widens this to `<=` would flip ONLY this exact-10 case (9 is
  // degenerate under both operators, so a 9-length case alone can't
  // distinguish them).
  it("boundary: exactly MIN_RATIONALE_LEN (10) code points is NOT degenerate, 9 IS (< vs <= mutant)", () => {
    expect(isDegenerateRationale("123456789")).toBe(true); // 9 chars
    expect(isDegenerateRationale("1234567890")).toBe(false); // 10 chars, the boundary itself
  });

  // MEDIUM-13 (#review): pins the `.trim()` call itself. Built so that
  // trimming moves the string from "below floor" to "even further below
  // floor" is NOT the point — instead this is built so the UNTRIMMED
  // length is >= MIN_RATIONALE_LEN (10) while the TRIMMED length is below
  // it, so a mutant that drops `.trim()` would read the untrimmed string
  // as long enough (not degenerate) where the real code (trim first) must
  // call it degenerate.
  it("whitespace padding cannot rescue a below-floor rationale (pins the .trim() call)", () => {
    const padded = `       123`; // 7 spaces + 3 chars = 10 raw code points, trims to "123" (len 3)
    expect(padded.length).toBe(10);
    expect(padded.trim()).toBe("123");
    expect(isDegenerateRationale(padded)).toBe(true);
  });
});
