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

function artifact(breakdown: Record<string, number> | undefined): Record<string, unknown> {
  return { nodes: [], edges: [], meta: breakdown ? { provenance_breakdown: breakdown } : {} };
}

describe("design 41 theme gate checks", () => {
  const gate = themeGateFromPolicy(policy);

  it("reads both thresholds from the policy, and is off without them", () => {
    expect(gate).toEqual({ minClassifiedRate: 0.8, minGeneratedAt: "2026-10-10T05:00:00Z" });
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
    expect(checks.map((c) => c.status)).toEqual(["failed", "failed"]);
  });
});
