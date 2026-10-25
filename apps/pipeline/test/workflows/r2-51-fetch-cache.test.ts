/**
 * R2-51: the on-demand build restores / saves the raw upstream fetch caches
 * (S2 etc.) across runs, since there is no S2 key and every run otherwise
 * starts from an empty cache. The classifier's own cache stays out.
 */
import { describe, expect, it } from "vitest";
import { jobsOf, readWorkflow, type YamlDoc } from "./helpers.js";

const jobs = Object.fromEntries(jobsOf(readWorkflow("theme-on-demand.yml"))) as Record<
  string,
  YamlDoc
>;
const steps = jobs.generate.steps as YamlDoc[];
const idx = (prefix: string) => steps.findIndex((s) => String(s.name).startsWith(prefix));

describe("theme-on-demand.yml upstream fetch cache (R2-51)", () => {
  const restore = steps[idx("Restore upstream fetch cache")];
  const save = steps[idx("Save upstream fetch cache")];

  it("restores before generating and saves last, even on failure", () => {
    expect(idx("Restore upstream fetch cache")).toBeGreaterThan(-1);
    expect(idx("Restore upstream fetch cache")).toBeLessThan(idx("Generate theme lineage"));
    expect(idx("Save upstream fetch cache")).toBeGreaterThan(idx("Generate expanded theme"));
    expect(save.if).toBe("always()");
    expect(String(restore.uses)).toMatch(/^actions\/cache\/restore@[0-9a-f]{40}/);
    expect(String(save.uses)).toMatch(/^actions\/cache\/save@[0-9a-f]{40}/);
  });

  it("uses a rolling key with a prefix fallback, the same paths on both sides", () => {
    expect(restore.with.key).toBe(save.with.key);
    expect(restore.with["restore-keys"].trim()).toBe("upstream-fetch-cache-v1-");
    expect(restore.with.path).toBe(save.with.path);
  });

  it("caches raw upstream responses only: never the classifier's cache or the embeddings/models", () => {
    const paths = String(save.with.path);
    expect(paths).toContain("s2_references.json");
    expect(paths).toContain("s2_citation_counts.json");
    expect(paths).not.toContain("classifications");
    expect(paths).not.toContain("models");
    expect(paths).not.toContain("embeddings");
  });
});
