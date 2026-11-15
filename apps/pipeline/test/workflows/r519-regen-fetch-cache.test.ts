/**
 * #519: regen-themes.yml shares theme-on-demand.yml's upstream fetch cache
 * (same paths and key family) without letting the cache overwrite the
 * git-tracked copies of the files it contains: those are saved aside before
 * the restore and put back right after it.
 */
import { describe, expect, it } from "vitest";
import { jobsOf, readWorkflow, type YamlDoc } from "./helpers.js";

const stepsOf = (file: string): YamlDoc[] =>
  (Object.fromEntries(jobsOf(readWorkflow(file))) as Record<string, YamlDoc>).generate
    .steps as YamlDoc[];
const regen = stepsOf("regen-themes.yml");
const onDemand = stepsOf("theme-on-demand.yml");
const at = (steps: YamlDoc[], prefix: string) =>
  steps.findIndex((s) => String(s.name).startsWith(prefix));

describe("regen-themes.yml upstream fetch cache (#519 option b)", () => {
  const restore = regen[at(regen, "Restore upstream fetch cache")] as YamlDoc;
  const save = regen[at(regen, "Save upstream fetch cache")] as YamlDoc;
  const odRestore = onDemand[at(onDemand, "Restore upstream fetch cache")] as YamlDoc;

  it("uses the same path list and key family as theme-on-demand (so the caches are shared)", () => {
    expect(restore.with.path).toBe(odRestore.with.path);
    expect(save.with.path).toBe(odRestore.with.path);
    expect(restore.with.key).toBe(odRestore.with.key);
    expect(save.with.key).toBe(restore.with.key);
    expect(restore.with["restore-keys"].trim()).toBe("upstream-fetch-cache-v1-");
  });

  it("saves tracked files aside, restores, then puts them back, all before generating", () => {
    const aside = at(regen, "Save git-tracked cache files aside");
    const back = at(regen, "Put git-tracked cache files back");
    const gen = at(regen, "Regenerate requested themes");
    expect(aside).toBeGreaterThan(-1);
    expect(aside).toBeLessThan(at(regen, "Restore upstream fetch cache"));
    expect(back).toBeGreaterThan(at(regen, "Restore upstream fetch cache"));
    expect(back).toBeLessThan(gen);
  });

  it("backs up exactly the tracked files the cache path list covers", () => {
    const run = String(regen[at(regen, "Save git-tracked cache files aside")]?.run);
    for (const line of String(restore.with.path)
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)) {
      expect(run).toContain(`'${line}'`);
    }
    expect(String(regen[at(regen, "Put git-tracked cache files back")]?.run)).toContain(
      'cp -a "$RUNNER_TEMP/tracked-cache/." .',
    );
  });

  it("saves even when the build failed, and never caches the classifier cache, models or embeddings", () => {
    expect(save.if).toBe("always()");
    expect(String(save.uses)).toMatch(/^actions\/cache\/save@[0-9a-f]{40}/);
    expect(String(restore.uses)).toMatch(/^actions\/cache\/restore@[0-9a-f]{40}/);
    const paths = String(save.with.path);
    for (const bad of ["classifications", "models", "embeddings", "regen-pending"]) {
      expect(paths).not.toContain(bad);
    }
  });
});
