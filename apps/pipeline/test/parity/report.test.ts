import { describe, expect, it } from "vitest";
import { formatSummary } from "../../src/parity/report.js";
import type { CompareTreesReport } from "../../src/parity/types.js";

function baseReport(overrides: Partial<CompareTreesReport> = {}): CompareTreesReport {
  return {
    mode: "compare-trees",
    expectedRoot: "/expected",
    actualRoot: "/actual",
    equal: true,
    durationMs: 5,
    missingFiles: [],
    extraFiles: [],
    fileResults: [],
    summary: { filesCompared: 0, filesEqual: 0, filesDiffering: 0, missing: 0, extra: 0 },
    ignoredPointers: [],
    skippedEntries: [],
    ...overrides,
  };
}

describe("formatSummary", () => {
  it("prints PASS and the roots for an equal report", () => {
    const text = formatSummary(baseReport());
    expect(text).toContain("PASS");
    expect(text).toContain("/expected");
    expect(text).toContain("/actual");
  });

  it("prints FAIL, missing/extra files and diff detail", () => {
    const text = formatSummary(
      baseReport({
        equal: false,
        missingFiles: ["a.json"],
        extraFiles: ["b.json"],
        fileResults: [
          {
            path: "c.json",
            kind: "json",
            equal: false,
            diffs: [{ pointer: "/x", kind: "value-mismatch", expected: 1, actual: 2 }],
          },
        ],
        summary: { filesCompared: 1, filesEqual: 0, filesDiffering: 1, missing: 1, extra: 1 },
      }),
    );
    expect(text).toContain("FAIL");
    expect(text).toContain("a.json");
    expect(text).toContain("b.json");
    expect(text).toContain("c.json");
    expect(text).toContain("/x");
  });

  it("lists ignored pointers so nothing is silently skipped", () => {
    const text = formatSummary(
      baseReport({
        ignoredPointers: [{ file: "m.json", glob: "*.json", pointers: ["/generated_at"] }],
      }),
    );
    expect(text).toContain("ignored pointers");
    expect(text).toContain("m.json");
    expect(text).toContain("/generated_at");
  });
});
