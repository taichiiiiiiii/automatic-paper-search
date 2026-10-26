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
  it("gives the generate job at least 40 minutes (60 for the expanded upgrade run, R2-54)", () => {
    // `${{ inputs.expand && 60 || 40 }}`: both arms are pinned, and the quick
    // arm must stay below the Worker's 50 min in-flight dedup TTL.
    const cap = String(generate["timeout-minutes"]);
    expect(cap).toBe("${{ inputs.expand && 60 || 40 }}");
    const [, expanded, quick] = /&&\s*(\d+)\s*\|\|\s*(\d+)/.exec(cap)!.map(Number);
    expect(quick).toBeGreaterThanOrEqual(40);
    expect(quick).toBeLessThan(50);
    expect(expanded).toBeGreaterThan(quick!);
  });

  it("caps the side-file step and lets it fail without failing the job", () => {
    const side = steps.find((s) => String(s.name).startsWith("Build side files"));
    expect(side).toBeDefined();
    expect(side!["timeout-minutes"]).toBeLessThanOrEqual(10);
    expect(side!["continue-on-error"]).toBe(true);
  });
});
