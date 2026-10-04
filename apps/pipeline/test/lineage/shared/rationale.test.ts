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
});
