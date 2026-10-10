/**
 * R2-6 (design 41 D2/D3) workflow contracts:
 *  - regen-themes.yml treats exit 5 (degraded classification) as a failed
 *    theme, records pending-retry state, packages AND promotes both the
 *    classification cache and the pending file (even when every theme
 *    failed), and fails the run afterwards in a `verdict` job;
 *  - regen-retry.yml is a daily, develop-only, minimally-permissioned
 *    dispatcher sharing regen-themes.yml's concurrency group;
 *  - theme-on-demand.yml passes no gate-disabling flag.
 */
import { describe, expect, it } from "vitest";
import { jobsOf, readWorkflow, type YamlDoc } from "./helpers.js";

function job(doc: YamlDoc, id: string): YamlDoc {
  const found = jobsOf(doc).find(([j]) => j === id);
  if (!found) throw new Error(`job ${id} not found`);
  return found[1];
}
function step(j: YamlDoc, name: string): YamlDoc {
  const s = (j.steps as YamlDoc[]).find((x) => x.name === name);
  if (!s) throw new Error(`step ${name} not found`);
  return s;
}

const PENDING = "data/state/lineage-cache/regen-pending.json";
const CACHE = "data/state/lineage-cache/classifications.json";

describe("regen-themes.yml (R2-6)", () => {
  const doc = readWorkflow("regen-themes.yml");
  const gen = job(doc, "generate");
  const regen = step(gen, "Regenerate requested themes");

  it("shares the regen-themes concurrency group without cancelling", () => {
    expect(doc.concurrency).toEqual({ group: "regen-themes", "cancel-in-progress": false });
  });

  it("captures each theme's exit code and result JSON instead of aborting on failure", () => {
    expect(regen.id).toBe("regen");
    expect(regen.run).toContain("--result-json");
    expect(regen.run).toMatch(/\|\| rc=\$\?/);
    expect(regen.run).toMatch(/"\$rc" -eq 5/);
    expect(regen.run).toContain("previous build retained");
  });

  it("records pending-retry state and lists degraded themes in the job summary", () => {
    expect(regen.run).toContain("regenPendingCli.ts record");
    expect(regen.run).toContain('--summary "$GITHUB_STEP_SUMMARY"');
    expect(regen.env.PENDING_FILE).toBe(PENDING);
  });

  it("does not exit before packaging when every theme failed (state must still be promoted)", () => {
    const tail = (regen.run as string).slice(
      (regen.run as string).indexOf("all theme regenerations failed"),
    );
    expect(tail).not.toMatch(/exit 1/);
    expect(gen.outputs.succeeded).toContain("steps.regen.outputs.succeeded");
  });

  it("packages and promotes the classification cache and the pending file", () => {
    const pkg = step(gen, "Package exact themes candidate").run as string;
    expect(pkg).toContain(CACHE);
    expect(pkg).toContain(PENDING);
    const promote = step(job(doc, "promote"), "Validate and promote from the latest develop tip")
      .run as string;
    expect(promote).toContain(CACHE);
    expect(promote).toContain(PENDING);
  });

  it("releases only when a theme regenerated", () => {
    expect(job(doc, "release").if).toContain("needs.generate.outputs.succeeded != '0'");
  });

  it("a verdict job always runs after promote and fails when no theme succeeded", () => {
    const v = job(doc, "verdict");
    expect(v.needs).toEqual(["generate", "promote"]);
    expect(v.if).toBe("always()");
    expect(v.permissions).toEqual({});
    const run = step(v, "Fail when no theme regenerated").run as string;
    expect(run).toMatch(/SUCCEEDED:-0\}" = 0 \]; then[\s\S]*exit 1/);
    expect(run).toMatch(/PROMOTE_RESULT" != success[\s\S]*exit 1/);
  });
});

describe("regen-retry.yml (R2-6)", () => {
  const doc = readWorkflow("regen-retry.yml");
  const d = job(doc, "dispatch");

  it("runs on a daily cron and manual dispatch only", () => {
    expect(Object.keys(doc.on).sort()).toEqual(["schedule", "workflow_dispatch"]);
    expect(doc.on.schedule).toHaveLength(1);
    expect(doc.on.schedule[0].cron).toMatch(/^\d+ \d+ \* \* \*$/);
  });

  it("shares regen-themes.yml's concurrency group", () => {
    expect(doc.concurrency).toEqual({ group: "regen-themes", "cancel-in-progress": false });
  });

  it("is develop-only with minimal permissions", () => {
    expect(d.if).toBe("github.ref == 'refs/heads/develop'");
    expect(d.permissions).toEqual({ contents: "read", actions: "write" });
    const checkout = (d.steps as YamlDoc[]).find(
      (s) => typeof s.uses === "string" && s.uses.startsWith("actions/checkout@"),
    );
    expect(checkout.with).toEqual({ ref: "develop", "persist-credentials": false });
  });

  it("dispatches regen-themes on develop only for a non-empty pending list", () => {
    const list = step(d, "Read pending themes").run as string;
    expect(list).toContain("regenPendingCli.ts list");
    expect(list).toContain(PENDING);
    const disp = step(d, "Dispatch regen-themes for pending themes");
    expect(disp.if).toBe("steps.pending.outputs.themes != ''");
    expect(disp.run).toContain(
      'gh workflow run regen-themes.yml -R "$GITHUB_REPOSITORY" --ref develop -f themes="$THEMES"',
    );
  });
});

describe("theme-on-demand.yml applies the same gate (R2-6)", () => {
  const gen = step(job(readWorkflow("theme-on-demand.yml"), "generate"), "Generate theme lineage");
  it("does not lower or disable the classified-rate threshold", () => {
    expect(gen.run).not.toContain("--min-classified-rate");
  });
});
