/**
 * Direct unit test for `percentTable`'s rounding (via the exported
 * `printHuman`, since `percentTable` itself is module-private) —
 * p4-followups.md #18: Python's `f"{v * 100 / total:.1f}%"` rounds
 * half-to-even, not `.toFixed(1)`'s behaviour on an un-pre-rounded ratio.
 * See `auditLineageClassificationBreakdown.parity.test.ts` for the
 * real-data parity harness this file complements.
 */
import { describe, expect, it } from "vitest";
import {
  type ClassificationsCacheAudit,
  type PublishedThemesAudit,
  printHuman,
} from "../../../src/lineage/quality/auditLineageClassificationBreakdown.js";

describe("percentTable formats an exact .X5 tie to the nearest EVEN decimal (p4-followups #18)", () => {
  it("5/80 == 6.25% exactly: Python rounds to 6.2%, not .toFixed(1)'s 6.3%", () => {
    const published: PublishedThemesAudit = {
      per_theme: {},
      per_provenance_rel: { llm: { successor: 5, extends: 75 } },
    };
    const cache: ClassificationsCacheAudit = { available: false };
    const lines: string[] = [];
    printHuman(published, cache, (line) => lines.push(line));
    const successorLine = lines.find((l) => l.trim().startsWith("successor:"));
    expect(successorLine).toContain("(6.2%)");
    expect(successorLine).not.toContain("6.3%");
  });
});
