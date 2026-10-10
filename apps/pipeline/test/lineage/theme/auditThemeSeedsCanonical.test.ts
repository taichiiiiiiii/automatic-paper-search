import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { auditThemeSeeds } from "../../../src/lineage/theme/auditThemeSeeds.js";

function writeTheme(meta: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "audit-canonical-"));
  mkdirSync(join(dir, "graph-neural-network"));
  const nodes = [
    {
      id: "openalex:W1",
      title: "Inductive Representation Learning on Large Graphs",
      is_focus: true,
    },
    { id: "openalex:W2", title: "A Comprehensive Survey on Graph Neural Networks", is_focus: true },
  ];
  writeFileSync(
    join(dir, "graph-neural-network", "lineage.json"),
    JSON.stringify({ nodes, edges: [], meta: { theme: "Graph Neural Network", ...meta } }),
  );
  return dir;
}

describe("auditThemeSeeds and canonical method seeds (R2-17)", () => {
  it("flags a seed whose title omits the theme words", () => {
    const result = auditThemeSeeds(writeTheme({}));
    expect(result.exitCode).toBe(1);
    expect(result.problems[0]?.titles).toEqual([
      "Inductive Representation Learning on Large Graphs",
    ]);
  });

  it("accepts it when meta.canonical_seeds records it", () => {
    const result = auditThemeSeeds(writeTheme({ canonical_seeds: ["openalex:W1"] }));
    expect(result.exitCode).toBe(0);
    expect(result.problems).toEqual([]);
  });
});
