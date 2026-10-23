/**
 * R2-43 (owner decision 2026-10-23): a field typed into the site is
 * published as `unaudited` even when few strong relations were found (the
 * web page then says so). Conferences keep the 3-relation bar.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  conferenceGateFromPolicy,
  type QualityPolicy,
  themeGateFromPolicy,
  themeStructureChecks,
} from "../../../src/lineage/quality/buildLineageQuality.js";

const here = dirname(fileURLToPath(import.meta.url));
const policy = JSON.parse(
  readFileSync(join(here, "../../../../../data/config/lineage-quality-policy-v1.json"), "utf8"),
) as QualityPolicy;

const graph = (strong: number) => ({
  nodes: Array.from({ length: 10 }, (_, i) => ({ id: `n${i}`, title: `Paper ${i}`, year: 2020 })),
  edges: [
    ...Array.from({ length: strong }, (_, i) => ({
      src: `n${i}`,
      dst: `n${i + 1}`,
      relation: "extends",
    })),
    { src: "n8", dst: "n9", relation: "baseline_only" },
  ],
});

const countCheck = (
  data: ReturnType<typeof graph>,
  gate: ReturnType<typeof conferenceGateFromPolicy>,
) => themeStructureChecks(data, gate).find((c) => c.name === "lineage_relation_count")!;

describe("lineage_relation_count with the committed policy (R2-43)", () => {
  it("lets a theme with no strong relation pass", () => {
    const gate = themeGateFromPolicy(policy)!;
    expect(gate.minLineageEdges).toBe(0);
    expect(countCheck(graph(0), gate).status).toBe("passed");
  });

  it("still requires 3 for a conference", () => {
    const gate = conferenceGateFromPolicy(policy);
    expect(gate.minLineageEdges).toBe(3);
    expect(countCheck(graph(2), gate).status).toBe("failed");
    expect(countCheck(graph(3), gate).status).toBe("passed");
  });
});
