import { describe, expect, it } from "vitest";
import {
  themeGateChecks,
  themeGateFromPolicy,
} from "../../../src/lineage/quality/buildLineageQuality.js";

const policy = {
  conference_max_age_days: 30,
  theme_max_age_days: 90,
  theme_min_evidence_classified_rate: 0.8,
  theme_min_generated_at: "2026-10-10T05:00:00Z",
};

function artifact(
  breakdown: Record<string, number> | undefined,
  edgeCount = 5,
  nodeCount = 6,
): Record<string, unknown> {
  return {
    nodes: Array.from({ length: nodeCount }, (_, i) => ({ id: `n${i}` })),
    edges: Array.from({ length: edgeCount }, (_, i) => ({ src: `n${i}`, dst: `n${i + 1}` })),
    meta: breakdown ? { provenance_breakdown: breakdown } : {},
  };
}

describe("design 41 theme gate checks", () => {
  const gate = themeGateFromPolicy(policy);

  it("reads both thresholds from the policy, and is off without them", () => {
    expect(gate).toEqual({
      minClassifiedRate: 0.8,
      minGeneratedAt: "2026-10-10T05:00:00Z",
      minEdges: 3,
    });
    expect(themeGateFromPolicy({ conference_max_age_days: 30, theme_max_age_days: 90 })).toBeNull();
  });

  it("passes an evidence-classified, current theme", () => {
    const checks = themeGateChecks(
      artifact({ llm: 31, citation_heuristic: 4 }),
      "2026-10-10T05:21:53Z",
      gate!,
    );
    expect(checks.map((c) => [c.name, c.status])).toEqual([
      ["evidence_classified_rate", "passed"],
      ["edge_density", "passed"],
      ["generator_current", "passed"],
    ]);
  });

  it("fails when year/citation guesses exceed 20% (ViT run 38035068035 shape)", () => {
    const [rate] = themeGateChecks(
      artifact({ foundational_allowlist: 46, citation_heuristic: 60, llm: 2, title_version: 1 }),
      "2026-10-10T07:38:27Z",
      gate!,
    );
    expect(rate?.status).toBe("failed");
    expect(rate?.observed).toBe(0.45);
    expect(rate?.evidence).toEqual(["guessed:60/109"]);
  });

  it("fails an artifact generated before the current generator rules", () => {
    const checks = themeGateChecks(artifact({ llm: 3 }), "2026-10-10T04:36:54Z", gate!);
    expect(checks.find((c) => c.name === "generator_current")?.status).toBe("failed");
  });

  it("fails closed without a provenance breakdown or a generated_at", () => {
    const checks = themeGateChecks(artifact(undefined), null, gate!);
    expect(checks.map((c) => [c.name, c.status])).toEqual([
      ["evidence_classified_rate", "failed"],
      ["edge_density", "passed"],
      ["generator_current", "failed"],
    ]);
  });
});

describe("R2-13 edge_density theme check", () => {
  const gate = themeGateFromPolicy(policy)!;

  it("fails a theme with fewer edges than theme_min_edges (Flash Attention run 38041334727: 4 nodes, 1 edge)", () => {
    const checks = themeGateChecks(
      artifact({ foundational_allowlist: 1 }, 1, 4),
      "2026-10-10T09:26:08Z",
      gate,
    );
    const density = checks.find((c) => c.name === "edge_density");
    expect(density).toEqual({
      name: "edge_density",
      status: "failed",
      observed: 1,
      expected: 3,
      evidence: ["edges:1<3", "nodes:4"],
    });
  });

  it("passes at exactly the minimum, and fails an artifact without an edges list", () => {
    const at = themeGateChecks(artifact({ llm: 3 }, 3, 4), "2026-10-10T09:26:08Z", gate);
    expect(at.find((c) => c.name === "edge_density")?.status).toBe("passed");
    const none = themeGateChecks({ meta: { provenance_breakdown: {} } }, null, gate);
    expect(none.find((c) => c.name === "edge_density")?.status).toBe("failed");
  });

  it("reads theme_min_edges from the policy, defaulting to 3", () => {
    expect(themeGateFromPolicy({ ...policy, theme_min_edges: 10 })?.minEdges).toBe(10);
    expect(themeGateFromPolicy({ ...policy, theme_min_edges: -1 })?.minEdges).toBe(3);
    expect(
      themeGateFromPolicy({
        conference_max_age_days: 30,
        theme_max_age_days: 90,
        theme_min_edges: 5,
      }),
    ).toEqual({ minClassifiedRate: 0.8, minGeneratedAt: null, minEdges: 5 });
    const strict = themeGateFromPolicy({ ...policy, theme_min_edges: 10 })!;
    const [, density] = themeGateChecks(artifact({ llm: 5 }, 5, 6), "2026-10-10T09:26:08Z", strict);
    expect(density).toMatchObject({ name: "edge_density", status: "failed", expected: 10 });
  });
});
