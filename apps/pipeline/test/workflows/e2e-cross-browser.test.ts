/**
 * e2e.yml cross-browser contract: every e2e trigger runs one job per
 * engine (chromium / webkit / firefox) with fail-fast off, each engine's
 * job runs exactly that engine's Playwright projects (as defined in
 * apps/web/playwright.config.ts), and a manual `update-snapshots` dispatch
 * runs only the Linux visual-baseline job, which uploads the PNGs. In CI
 * the Playwright globalTimeout ends a slow suite (with a report) before the
 * job bound cancels it (#517).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { jobsOf, readWorkflow, workflowsDir, type YamlDoc } from "./helpers.js";

const doc = readWorkflow("e2e.yml");
const jobs = new Map(jobsOf(doc));
const e2e = jobs.get("e2e") as YamlDoc;
const update = jobs.get("update-snapshots") as YamlDoc;

const configText = readFileSync(
  join(workflowsDir(), "..", "..", "apps", "web", "playwright.config.ts"),
  "utf8",
);
const configProjects = [
  ...configText.matchAll(/name:\s*"([a-z]+-(?:chromium|webkit|firefox))"/g),
].map((m) => m[1]!);

describe("e2e.yml (cross-browser)", () => {
  it("runs a fail-fast-off matrix over chromium, webkit and firefox", () => {
    expect(e2e.strategy["fail-fast"]).toBe(false);
    const browsers = (e2e.strategy.matrix.include as YamlDoc[]).map((m) => m.browser);
    expect(browsers).toEqual(["chromium", "webkit", "firefox"]);
  });

  it("covers every Playwright project exactly once, each in its own engine's job", () => {
    expect(configProjects.length).toBeGreaterThanOrEqual(5);
    const seen: string[] = [];
    for (const m of e2e.strategy.matrix.include as YamlDoc[]) {
      const projects = [...String(m.projects).matchAll(/--project=(\S+)/g)].map((x) => x[1]!);
      for (const p of projects) expect(p.endsWith(`-${m.browser}`), p).toBe(true);
      seen.push(...projects);
    }
    expect([...seen].sort()).toEqual([...configProjects].sort());
  });

  it("runs the request-flow suite once, in the chromium job only", () => {
    const steps = e2e.steps as YamlDoc[];
    const rf = steps.filter((s) => String(s.run ?? "").includes("e2e:request-flow"));
    expect(rf).toHaveLength(1);
    // The suite resolves the Worker host via Chromium's --host-resolver-rules;
    // the webkit/firefox jobs never install Chromium.
    expect(rf[0]!.if).toBe("${{ !cancelled() && matrix.browser == 'chromium' }}");
  });

  it("the suite jobs skip on an update-snapshots dispatch, the baseline job runs only then", () => {
    expect(doc.on.workflow_dispatch.inputs["update-snapshots"].type).toBe("boolean");
    expect(doc.on.workflow_dispatch.inputs["update-snapshots"].default).toBe(false);
    expect(e2e.if).toBe("${{ !inputs.update-snapshots }}");
    expect(update.if).toBe("${{ inputs.update-snapshots }}");
  });

  it("the baseline job regenerates the Chromium visual tests and uploads linux/", () => {
    const steps = update.steps as YamlDoc[];
    const run = steps.map((s) => String(s.run ?? "")).join("\n");
    expect(run).toMatch(/e2e\/visual\.e2e\.ts/);
    expect(run).toMatch(/--update-snapshots=all/);
    expect(run).toMatch(/--project=desktop-chromium/);
    expect(run).toMatch(/--project=mobile-chromium/);
    const upload = steps.find((s) => String(s.uses ?? "").startsWith("actions/upload-artifact@"));
    expect(upload?.with.path).toBe("apps/web/e2e/__screenshots__/linux");
    expect(update.permissions).toEqual({ contents: "read" });
  });

  // #517: without a Playwright globalTimeout a slow run is killed by the job
  // bound (GitHub cancels the job), so Playwright writes no report and the
  // `if: failure()` upload never runs. The global bound must fire first:
  //   globalTimeout + steps before the suite + report upload <= job bound.
  // Measured on the successful e2e runs of 2026-11-03..11-12 (21 runs x 3
  // engines): steps before "Run e2e suite" took at most 2.8 min (cache hit or
  // miss; a 2026-10-12 apt stall of 18.8 min is #512's problem and leaves no
  // room for any suite), the suite itself at most 27.6 min (webkit). The lower
  // bound keeps a normal run from tripping the global bound.
  describe("Playwright globalTimeout (#517)", () => {
    const PRE_SUITE_BUDGET_MIN = 5; // measured max 2.8 min, rounded up
    const REPORT_UPLOAD_BUDGET_MIN = 2; // upload-artifact of report + traces
    const SLOWEST_SUCCESSFUL_SUITE_MIN = 27.6;
    const m = configText.match(/globalTimeout:\s*CI\s*\?\s*([\d_]+)\s*\*\s*60_000\s*:\s*undefined/);

    it("is set in CI only, in whole minutes", () => {
      expect(m, "globalTimeout: CI ? <minutes> * 60_000 : undefined").not.toBeNull();
    });

    it("fires before the job's timeout-minutes, leaving room for setup and the report upload", () => {
      const minutes = Number(m?.[1]?.replaceAll("_", ""));
      const jobMinutes = Number(e2e["timeout-minutes"]);
      expect(jobMinutes).toBeGreaterThan(0);
      expect(minutes + PRE_SUITE_BUDGET_MIN + REPORT_UPLOAD_BUDGET_MIN).toBeLessThanOrEqual(
        jobMinutes,
      );
    });

    it("stays well above the slowest successful suite", () => {
      const minutes = Number(m?.[1]?.replaceAll("_", ""));
      expect(minutes).toBeGreaterThanOrEqual(SLOWEST_SUCCESSFUL_SUITE_MIN + 5);
    });
  });
});
