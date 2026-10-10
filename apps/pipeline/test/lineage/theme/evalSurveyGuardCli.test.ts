/** R2-15: offline survey-citing guard report over a theme artifact. */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { guardArtifact, runSurveyGuardCli } from "../../../src/lineage/theme/evalSurveyGuardCli.js";

const prov = (method: string) => ({ classification: { method } });

/** Trimmed from the published graph-neural-network artifact. */
const artifact = {
  root: "openalex:W2",
  meta: { theme: "Graph Neural Network" },
  nodes: [
    { id: "openalex:W1", title: "A new model for learning in graph domains", year: 2006 },
    { id: "openalex:W2", title: "The Graph Neural Network Model", year: 2008 },
    {
      id: "openalex:W3",
      title: "Graph neural networks for materials science and chemistry",
      year: 2022,
      short_abstract:
        "Machine learning plays an increasingly important role in chemistry. In this Review, we " +
        "provide an overview of the basic principles of GNNs, widely used datasets, and " +
        "state-of-the-art architectures.",
    },
    {
      id: "openalex:W4",
      title: "Semi-Supervised Classification with Graph Convolutional Networks",
      year: 2017,
    },
  ],
  edges: [
    {
      src: "openalex:W1",
      dst: "openalex:W2",
      rel: "supersedes",
      relation: "supersedes",
      conf: 0.75,
      confidence: 0.75,
      rationale: "r",
      provenance: prov("llm"),
    },
    {
      src: "openalex:W1",
      dst: "openalex:W3",
      rel: "extends",
      relation: "extends",
      conf: 0.92,
      confidence: 0.92,
      rationale: "B は A を材料科学に応用",
      provenance: prov("llm"),
    },
    {
      src: "openalex:W2",
      dst: "openalex:W3",
      rel: "successor",
      relation: "successor",
      conf: 0.4,
      confidence: 0.4,
      rationale: "r",
      provenance: prov("citation_heuristic"),
    },
    {
      src: "openalex:W4",
      dst: "openalex:W3",
      rel: "baseline_only",
      relation: "baseline_only",
      conf: 0.7,
      confidence: 0.7,
      rationale: "r",
      provenance: prov("s2_context_rule"),
    },
    {
      src: "openalex:W2",
      dst: "openalex:W4",
      rel: "extends",
      relation: "extends",
      conf: 0.8,
      confidence: 0.8,
      rationale: "r",
      provenance: prov("llm"),
    },
  ],
};

describe("guardArtifact", () => {
  it("rewrites only the edges whose citing paper is a review", () => {
    const { report, guarded } = guardArtifact("x.json", structuredClone(artifact));
    expect(report.surveyLikeNodes.map((n) => n.id)).toEqual(["openalex:W3"]);
    expect(report.changes.map((c) => [c.src, c.before.relation, c.after.relation])).toEqual([
      ["openalex:W1", "extends", "baseline_only"],
      ["openalex:W2", "successor", "baseline_only"],
    ]);
    expect(report.changes.every((c) => c.reason === "citing_survey")).toBe(true);
    const edges = guarded.edges as Record<string, unknown>[];
    expect(edges[1]).toMatchObject({
      rel: "baseline_only",
      relation: "baseline_only",
      conf: 0.6,
      confidence: 0.6,
    });
    expect(String(edges[1]!.rationale)).toContain("引用側の論文がサーベイ/レビュー");
    expect(edges[1]!.provenance).toEqual(prov("llm"));
    expect(edges[2]).toMatchObject({ relation: "baseline_only", confidence: 0.4 });
    expect(edges[0]!.relation).toBe("supersedes");
    expect(edges[4]!.relation).toBe("extends");
  });

  it("keeps a title_version supersedes even into a survey", () => {
    const a = structuredClone(artifact);
    a.edges = [{ ...a.edges[0]!, dst: "openalex:W3", provenance: prov("title_version") }];
    expect(guardArtifact("x.json", a).report.changes).toEqual([]);
  });
});

describe("runSurveyGuardCli", () => {
  it("refuses to write into data/published", () => {
    expect(runSurveyGuardCli(["x.json", "--out", "data/published/themes"])).toBe(2);
  });

  it("writes guarded copies to --out", async () => {
    const dir = mkdtempSync(join(tmpdir(), "survey-guard-"));
    const src = join(dir, "in", "graph-neural-network");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "lineage.json"), JSON.stringify(artifact));
    const write = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      expect(runSurveyGuardCli([join(src, "lineage.json"), "--out", join(dir, "out")])).toBe(0);
    } finally {
      process.stdout.write = write;
    }
    const out = JSON.parse(
      readFileSync(join(dir, "out", "graph-neural-network", "lineage.json"), "utf-8"),
    );
    expect(out.edges[1].relation).toBe("baseline_only");
  });
});
