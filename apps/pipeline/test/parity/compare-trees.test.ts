import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compareTrees } from "../../src/parity/compare-trees.js";
import type { RulesFile } from "../../src/parity/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesRoot = path.join(here, "fixtures");

function fixture(name: string) {
  return {
    expectedRoot: path.join(fixturesRoot, name, "expected"),
    actualRoot: path.join(fixturesRoot, name, "actual"),
  };
}

describe("compareTrees", () => {
  it("passes on equal trees (JSON and byte-equal non-JSON)", async () => {
    const report = await compareTrees(fixture("equal"));
    expect(report.equal).toBe(true);
    expect(report.missingFiles).toEqual([]);
    expect(report.extraFiles).toEqual([]);
    expect(report.summary).toEqual({
      filesCompared: 2,
      filesEqual: 2,
      filesDiffering: 0,
      missing: 0,
      extra: 0,
    });
  });

  it("passes when JSON differs only by number format (1.0 vs 1, trailing zero)", async () => {
    const report = await compareTrees(fixture("float-format"));
    expect(report.equal).toBe(true);
    expect(report.fileResults).toHaveLength(1);
    expect(report.fileResults[0]?.equal).toBe(true);
  });

  it("fails when JSON numbers differ in value, even if both look like 0.3-ish floats", async () => {
    const report = await compareTrees(fixture("value-diff"));
    expect(report.equal).toBe(false);
    const result = report.fileResults[0];
    expect(result?.equal).toBe(false);
    expect(result?.diffs).toEqual([
      { pointer: "/score", kind: "value-mismatch", expected: 0.3, actual: 0.30000000000000004 },
    ]);
  });

  it("passes when JSON object key order differs but values are the same", async () => {
    const report = await compareTrees(fixture("key-order"));
    expect(report.equal).toBe(true);
  });

  it("fails when JSON array order differs even though the same elements are present", async () => {
    const report = await compareTrees(fixture("array-order"));
    expect(report.equal).toBe(false);
    const diffs = report.fileResults[0]?.diffs ?? [];
    expect(diffs.some((d) => d.pointer === "/items/0")).toBe(true);
    expect(diffs.some((d) => d.pointer === "/items/2")).toBe(true);
  });

  it("fails on a CSV BOM-only difference (non-JSON files are byte-exact)", async () => {
    const report = await compareTrees(fixture("csv-bom"));
    expect(report.equal).toBe(false);
    expect(report.fileResults[0]).toMatchObject({ path: "data.csv", kind: "binary", equal: false });
  });

  it("fails and reports missing + extra files for a shard assignment mismatch", async () => {
    const report = await compareTrees(fixture("missing-shard"));
    expect(report.equal).toBe(false);
    expect(report.missingFiles).toEqual(["paper-2.json"]);
    expect(report.extraFiles).toEqual(["paper-3.json"]);
    // the one file present on both sides is otherwise equal
    expect(report.fileResults).toEqual([
      { path: "paper-1.json", kind: "json", equal: true, diffs: [] },
    ]);
  });

  it("passes and reports an ignored JSON pointer (ignored fields are never silently skipped)", async () => {
    const rules: RulesFile = {
      ignore: [{ glob: "manifest.json", pointers: ["/generated_at", "/items/*/generated_at"] }],
    };
    const report = await compareTrees({ ...fixture("ignored-pointer"), rules });
    expect(report.equal).toBe(true);
    expect(report.ignoredPointers).toEqual([
      {
        file: "manifest.json",
        glob: "manifest.json",
        pointers: ["/generated_at", "/items/*/generated_at"],
      },
    ]);
  });

  it("does not ignore a field whose glob does not match the file", async () => {
    const rules: RulesFile = {
      ignore: [{ glob: "other-file.json", pointers: ["/generated_at"] }],
    };
    const report = await compareTrees({ ...fixture("ignored-pointer"), rules });
    expect(report.equal).toBe(false);
    expect(report.ignoredPointers).toEqual([]);
  });

  it("treats unknown extensions as byte-compared, not JSON", async () => {
    const report = await compareTrees(fixture("equal"));
    const csv = report.fileResults.find((f) => f.path === "data.csv");
    expect(csv?.kind).toBe("binary");
  });
});
