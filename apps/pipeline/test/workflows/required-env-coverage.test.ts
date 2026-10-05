/**
 * P5 tier-A review round 2, N3: `pages-rollback.yml`'s "record" step
 * never set `ARTIFACT_NAME`, so `gh-record` always died with
 * `ARTIFACT_NAME is required` AFTER `cf-rollback` had already switched
 * production and smoke had already passed -- a rollback that worked
 * but was never recorded. The underlying gap wasn't just that one
 * missing key: no test checked that a calling workflow step's `env:`
 * actually supplies every env var `release/cli.ts`'s own subcommand
 * handler requires.
 *
 * This derives the required-env list from
 * `apps/pipeline/src/release/cli.ts`'s own exported
 * `REQUIRED_ENV_BY_SUBCOMMAND` (never a second, hand-maintained copy
 * that could drift from the real `requiredEnv` calls) and checks every
 * staged workflow step whose `run:` invokes `release/cli.ts <subcommand>`.
 */
import { describe, expect, it } from "vitest";
import {
  GH_RECORD_CONDITIONAL_ARTIFACT_NAME,
  REQUIRED_ENV_BY_SUBCOMMAND,
} from "../../src/release/cli.js";
import { EXPECTED_WORKFLOW_FILES, jobsOf, readAllWorkflows, type YamlDoc } from "./helpers.js";

interface CliInvocation {
  file: string;
  jobId: string;
  stepName: string;
  subcommand: string;
  env: Record<string, unknown>;
}

const CLI_INVOCATION_RE = /release\/cli\.ts\s+([a-z-]+)/;

/**
 * GitHub Actions sets these on every step's process environment
 * automatically -- a step never needs (and both `gh-record` callers
 * deliberately never add, per their own inline comment) a literal
 * `env:` entry to make `GITHUB_REPOSITORY` visible to `requiredEnv`.
 * Checked against the real default-env docs, not guessed: this is the
 * one such var any `release/cli.ts` subcommand currently reads.
 */
const AMBIENT_RUNNER_ENV = new Set(["GITHUB_REPOSITORY"]);

function stepsOf(job: YamlDoc): YamlDoc[] {
  return Array.isArray(job?.steps) ? job.steps : [];
}

/** Every step, in every job, of every staged workflow, whose `run:`
 * invokes `release/cli.ts <subcommand>` -- paired with that step's own
 * literal `env:` block (never the job's or workflow's `env:`, since
 * `requiredEnv` only ever sees the step's process env, and GitHub
 * Actions does not merge job-level `env:` into a step's literal keys
 * for this kind of static check). */
function allCliInvocations(): CliInvocation[] {
  const docs = readAllWorkflows();
  const found: CliInvocation[] = [];
  for (const file of EXPECTED_WORKFLOW_FILES) {
    const doc = docs.get(file);
    for (const [jobId, job] of jobsOf(doc)) {
      for (const step of stepsOf(job)) {
        const run = typeof step.run === "string" ? step.run : undefined;
        if (run === undefined) continue;
        const match = CLI_INVOCATION_RE.exec(run);
        if (match === null) continue;
        found.push({
          file,
          jobId,
          stepName: typeof step.name === "string" ? step.name : "(unnamed step)",
          subcommand: match[1] as string,
          env: (step.env as Record<string, unknown>) ?? {},
        });
      }
    }
  }
  return found;
}

describe("every release/cli.ts <subcommand> invocation's env: covers that subcommand's required env vars", () => {
  const invocations = allCliInvocations();

  it("found a non-trivial number of invocations (sanity: the extractor isn't silently matching nothing)", () => {
    expect(invocations.length).toBeGreaterThan(5);
  });

  for (const invocation of invocations) {
    const required = REQUIRED_ENV_BY_SUBCOMMAND[invocation.subcommand] ?? [];
    const label = `${invocation.file} / ${invocation.jobId} / "${invocation.stepName}" (${invocation.subcommand})`;

    it(`${label}: env: has every unconditionally-required key`, () => {
      const missing = required.filter(
        (name) => !(name in invocation.env) && !AMBIENT_RUNNER_ENV.has(name),
      );
      expect(missing, `missing required env var(s): ${JSON.stringify(missing)}`).toEqual([]);
    });

    if (invocation.subcommand === "gh-record") {
      it(`${label}: has ARTIFACT_NAME unless RELEASE_KIND is literally "${GH_RECORD_CONDITIONAL_ARTIFACT_NAME.exemptReleaseKindLiteral}"`, () => {
        const { envVar, exemptReleaseKindLiteral } = GH_RECORD_CONDITIONAL_ARTIFACT_NAME;
        const isExempt = invocation.env.RELEASE_KIND === exemptReleaseKindLiteral;
        if (isExempt) {
          // Not required -- but still fine if present (e.g. a future
          // caller that always builds one). Nothing to assert either way.
          return;
        }
        expect(
          envVar in invocation.env,
          `${label} sets RELEASE_KIND to ${JSON.stringify(invocation.env.RELEASE_KIND)} (not the literal "${exemptReleaseKindLiteral}"), so ${envVar} is required but missing`,
        ).toBe(true);
      });
    }
  }
});
