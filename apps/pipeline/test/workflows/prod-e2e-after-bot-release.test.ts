/**
 * #508: a run started with GITHUB_TOKEN (theme-on-demand's `upgrade`
 * dispatch of the expanded rebuild, regen-retry's dispatch of
 * regen-themes) never fires `workflow_run` when it completes, so
 * prod-e2e.yml's `workflow_run` trigger missed every bot-started release.
 * Those two callers therefore dispatch prod-e2e.yml themselves (a
 * `workflow_dispatch` made with GITHUB_TOKEN does start a run), only when
 * the run was triggered by the bot (a human/PAT-started run already gets
 * prod-e2e via `workflow_run`, so it must not run twice), only after a
 * successful release, and never fail the publishing run (prod-e2e is
 * observe-only; the Worker's run-status and the watchdog read the run's
 * conclusion).
 */
import { describe, expect, it } from "vitest";
import { jobsOf, readWorkflow, readWorkflowRawText, type YamlDoc } from "./helpers.js";

const CALLERS = ["theme-on-demand.yml", "regen-themes.yml"] as const;
const JOB = "prod-e2e";

function dispatchJob(file: string): YamlDoc {
  const job = new Map(jobsOf(readWorkflow(file))).get(JOB);
  if (!job) throw new Error(`${file} has no ${JOB} job`);
  return job;
}

describe.each(CALLERS)("%s dispatches prod-e2e after a bot-started release", (file) => {
  it("runs only after a successful release of a bot-triggered run", () => {
    const job = dispatchJob(file);
    const needs = Array.isArray(job.needs) ? job.needs : [job.needs];
    expect(needs).toContain("release");
    expect(job.if).toBe(
      "needs.release.result == 'success' && github.triggering_actor == 'github-actions[bot]'",
    );
  });

  it("has only actions: write, never fails the run, and dispatches develop", () => {
    const job = dispatchJob(file);
    expect(job.permissions).toEqual({ actions: "write" });
    expect(job["continue-on-error"]).toBe(true);
    expect(job["timeout-minutes"]).toBeLessThanOrEqual(5);
    expect(job.steps).toHaveLength(1);
    const step = job.steps[0];
    expect(step.env.GH_TOKEN).toBe("${{ github.token }}");
    expect(step.run).toContain(
      'gh workflow run prod-e2e.yml -R "$GITHUB_REPOSITORY" --ref develop',
    );
    expect(step.uses).toBeUndefined();
  });

  it("adds actions: write to this job only", () => {
    const writers = jobsOf(readWorkflow(file))
      .filter(([, j]) => j.permissions?.actions === "write")
      .map(([id]) => id)
      .sort();
    const before = file === "theme-on-demand.yml" ? ["upgrade"] : [];
    expect(writers).toEqual([...before, JOB].sort());
    expect(readWorkflowRawText(file).match(/actions: write/g)).toHaveLength(before.length + 1);
  });
});
