/**
 * e2e.yml cross-browser contract: every e2e trigger runs one job per
 * engine (chromium / webkit / firefox) with fail-fast off, each engine's
 * job runs exactly that engine's Playwright projects (as defined in
 * apps/web/playwright.config.ts), and a manual `update-snapshots` dispatch
 * runs only the Linux visual-baseline job, which uploads the PNGs.
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
});
