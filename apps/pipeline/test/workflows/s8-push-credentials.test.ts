/**
 * #522 S8: the jobs that call external APIs and then push data to develop
 * (theme-feeds, collect-daily-watch, conference-watch) must not keep a push
 * credential in `.git/config` while the external-API steps run.
 *
 * Contract per workflow:
 * - the checkout step uses `persist-credentials: false`;
 * - the push credential is given only inside the commit-push step, through
 *   `GIT_CONFIG_*` env vars that live for that one step (never written to
 *   `.git/config`, `$GITHUB_ENV`, a URL or argv), and no earlier step
 *   mentions a git credential;
 * - that credential comes from `github.token`, never `secrets.GH_PAT`: a
 *   GITHUB_TOKEN push does not trigger pages.yml, so the publication path
 *   (each workflow's own release job, or none) stays as it is.
 */
import { describe, expect, it } from "vitest";
import { jobsOf, readWorkflow, type YamlDoc } from "./helpers.js";

const CASES = [
  { file: "theme-feeds.yml", job: "feeds" },
  { file: "collect-daily-watch.yml", job: "watch" },
  { file: "conference-watch.yml", job: "watch" },
] as const;

const CHECKOUT_PREFIX = "actions/checkout@";
const CREDENTIAL_MARKERS = [
  /extraheader/i,
  /GIT_CONFIG_/,
  /x-access-token/,
  /PUSH_TOKEN/,
  /persist-credentials"?:\s*true/,
];

function stepsOf(file: string, jobId: string): YamlDoc[] {
  const job = jobsOf(readWorkflow(file)).find(([id]) => id === jobId)?.[1] as YamlDoc | undefined;
  expect(job, `${file}: job ${jobId}`).toBeDefined();
  return job!.steps as YamlDoc[];
}

function isCommitPush(step: YamlDoc): boolean {
  return typeof step.run === "string" && step.run.includes("release/cli.ts commit-push");
}

describe.each(CASES)("#522 S8 push credentials: $file", ({ file, job }) => {
  const steps = stepsOf(file, job);
  const commitIdx = steps.findIndex(isCommitPush);

  it("checks out without persisting credentials", () => {
    const checkouts = steps.filter(
      (s) => typeof s.uses === "string" && s.uses.startsWith(CHECKOUT_PREFIX),
    );
    expect(checkouts).toHaveLength(1);
    expect(checkouts[0]!.with?.["persist-credentials"]).toBe(false);
  });

  it("gives the push credential only inside the commit-push step", () => {
    expect(commitIdx).toBeGreaterThan(0);
    steps.forEach((step, i) => {
      if (i === commitIdx) return;
      const text = JSON.stringify({
        run: step.run ?? "",
        env: step.env ?? {},
        with: step.with ?? {},
      });
      for (const marker of CREDENTIAL_MARKERS) {
        expect(text, `${file} step ${i} (${step.name}) mentions ${marker}`).not.toMatch(marker);
      }
    });
    const commit = steps[commitIdx]!;
    const run = commit.run as string;
    // Env-scoped git config: lives for this step's processes only.
    expect(run).toContain("GIT_CONFIG_COUNT=1");
    expect(run).toContain('GIT_CONFIG_KEY_0="http.https://github.com/.extraheader"');
    expect(run).toMatch(/GIT_CONFIG_VALUE_0="AUTHORIZATION: basic \$auth"/);
    // The encoded header is masked before anything could print it.
    expect(run.indexOf('echo "::add-mask::$auth"')).toBeGreaterThan(-1);
    expect(run.indexOf('echo "::add-mask::$auth"')).toBeLessThan(run.indexOf("GIT_CONFIG_VALUE_0"));
    // The credential must happen before commit-push runs.
    expect(run.indexOf("GIT_CONFIG_VALUE_0")).toBeLessThan(
      run.indexOf("release/cli.ts commit-push"),
    );
    // The raw token does not outlive the header it was encoded into.
    expect(run).toContain("unset PUSH_TOKEN auth");
    expect(run.indexOf("unset PUSH_TOKEN auth")).toBeLessThan(
      run.indexOf("release/cli.ts commit-push"),
    );
    // Never on disk, in later steps' env, in a URL, or in argv.
    expect(run).not.toMatch(/git\s+config/);
    expect(run).not.toContain("GITHUB_ENV");
    expect(run).not.toMatch(/https:\/\/[^\s"]*@github\.com/);
    expect(run).not.toContain("${{");
  });

  it("pushes with github.token, never GH_PAT", () => {
    const commit = steps[commitIdx]!;
    expect(commit.env?.PUSH_TOKEN).toBe("${{ github.token }}");
    expect(JSON.stringify(commit)).not.toContain("GH_PAT");
    expect(commit.run as string).toContain(`printf 'x-access-token:%s' "$PUSH_TOKEN"`);
  });
});

describe("#522 S8 keeps the existing step conditions", () => {
  it("collect-daily-watch still commits on failure (only a cancelled run skips it)", () => {
    const steps = stepsOf("collect-daily-watch.yml", "watch");
    expect(steps.find(isCommitPush)!.if).toBe("${{ !cancelled() }}");
  });

  it("conference-watch still commits only on a material change", () => {
    const steps = stepsOf("conference-watch.yml", "watch");
    expect(steps.find(isCommitPush)!.if).toBe("steps.diff.outputs.changed == 'true'");
  });

  it("collect-daily-watch keeps the API token for the collector (rate limit, not git auth)", () => {
    const steps = stepsOf("collect-daily-watch.yml", "watch");
    const collector = steps.find(
      (s) => typeof s.run === "string" && s.run.includes("collect/cli.ts"),
    )!;
    expect(collector.env.PAPERPILOT_GITHUB_TOKEN).toBe("${{ secrets.GH_PAT || github.token }}");
  });
});
