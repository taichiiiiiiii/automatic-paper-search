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

  // #512: the two Playwright install steps reach the runner's apt mirror
  // (azure.archive.ubuntu.com), which has failed to resolve or stalled for
  // tens of minutes (actions/runner-images#14823, #15040, #15297). Each
  // attempt is bounded on its own (a step-level timeout alone would kill the
  // step at the first hang, leaving no retry), the step bound covers every
  // attempt plus the waits, and it stays below the job bound. The two steps
  // are mutually exclusive (cache hit / miss), so each is compared alone.
  describe.each([
    ["Install browser", /pnpm exec playwright install --with-deps "\$BROWSER"/],
    ["Install browser system dependencies", /pnpm exec playwright install-deps "\$BROWSER"/],
  ])("%s (apt retry, #512)", (name, command) => {
    const step = (e2e.steps as YamlDoc[]).find((s) => s.name === name) as YamlDoc;
    const run = String(step?.run ?? "");

    it("retries up to 3 times, each attempt bounded by timeout, and fails after the last", () => {
      expect(step, name).toBeDefined();
      expect(run).toMatch(/for i in 1 2 3; do/);
      const attempt = run.match(
        /timeout --kill-after=(\d+)s (\d+)m pnpm exec playwright [^\n]*&& exit 0/,
      );
      expect(attempt, run).not.toBeNull();
      expect(run).toMatch(command);
      // No wait after the last attempt; the loop ends with a hard failure.
      expect(run).toMatch(/\[ "\$i" -lt 3 \] && sleep \$\(\(i \* 30\)\)/);
      expect(run.trimEnd().endsWith("exit 1")).toBe(true);
    });

    it("has a step timeout above 3 attempts + waits and below the job timeout", () => {
      const m = run.match(/timeout --kill-after=(\d+)s (\d+)m/);
      expect(m).not.toBeNull();
      const perAttemptMin = Number(m![2]) + Number(m![1]) / 60;
      const waitsMin = (30 + 60) / 60;
      const stepMin = Number(step["timeout-minutes"]);
      expect(Number.isFinite(stepMin)).toBe(true);
      expect(stepMin).toBeGreaterThan(3 * perAttemptMin + waitsMin);
      expect(stepMin).toBeLessThan(Number(e2e["timeout-minutes"]));
      // Inputs reach the shell only through env (no ${{ }} in run).
      expect(run).not.toMatch(/\$\{\{/);
      expect(step.env?.BROWSER).toBe("${{ matrix.browser }}");
    });
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
