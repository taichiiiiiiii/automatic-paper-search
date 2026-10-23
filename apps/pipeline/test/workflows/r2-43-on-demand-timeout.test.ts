/**
 * R2-43: a new field typed into the site must come out as a published
 * lineage. A real request (Retrieval-Augmented Generation, 2026-10-23) was
 * cancelled by the 15 min job cap right after the lineage build finished,
 * so nothing was promoted. The generate job needs head-room for the
 * depth-1 pass + auto-expand rebuild, and the best-effort side-file step
 * must be capped on its own and never fail the job.
 */
import { describe, expect, it } from "vitest";
import { jobsOf, readWorkflow, type YamlDoc } from "./helpers.js";

const doc = readWorkflow("theme-on-demand.yml");
const generate = jobsOf(doc).find(([id]) => id === "generate")![1] as YamlDoc;
const steps = generate.steps as YamlDoc[];

describe("theme-on-demand.yml time budget (R2-43)", () => {
  it("gives the generate job at least 40 minutes", () => {
    expect(generate["timeout-minutes"]).toBeGreaterThanOrEqual(40);
  });

  it("caps the side-file step and lets it fail without failing the job", () => {
    const side = steps.find((s) => String(s.name).startsWith("Build side files"));
    expect(side).toBeDefined();
    expect(side!["timeout-minutes"]).toBeLessThanOrEqual(10);
    expect(side!["continue-on-error"]).toBe(true);
  });
});
