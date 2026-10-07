/**
 * L3, L4, L7 and the legacy-redirects.yml half of M4, all from the P5
 * tier-A review (pass 1). Grouped here because each is a small,
 * independent text-level pin on a staged workflow rather than a new
 * mechanism.
 */
import { describe, expect, it } from "vitest";
import { allRunStrings, jobsOf, readWorkflow, type YamlDoc } from "./helpers.js";

describe("L3: pages-release.yml deploys with the workspace's own pinned wrangler, not npx", () => {
  const doc = readWorkflow("pages-release.yml");

  it("the deploy step invokes `pnpm --filter @paperpilot/api exec wrangler`", () => {
    const [, deployJob] = jobsOf(doc).find(([id]) => id === "deploy") as [string, YamlDoc];
    const deployStep = (deployJob.steps as YamlDoc[]).find(
      (s) => s.name === "Deploy to Cloudflare Pages",
    );
    expect(deployStep?.run).toContain("pnpm --filter @paperpilot/api exec wrangler pages deploy");
  });

  it("no run: string anywhere in the workflow invokes wrangler via npx", () => {
    for (const run of allRunStrings(doc)) {
      expect(run).not.toMatch(/npx\s+--yes\s+wrangler/);
    }
  });
});

describe("L4: pages-release.yml's build job asserts the marker and checks HEAD==SHA", () => {
  const doc = readWorkflow("pages-release.yml");
  const [, buildJob] = jobsOf(doc).find(([id]) => id === "build") as [string, YamlDoc];
  const steps: YamlDoc[] = buildJob.steps;

  it("asserts the marker's source_sha matches before validating the bundle", () => {
    const markerIdx = steps.findIndex((s) => s.name === "Write deterministic deployment marker");
    const assertIdx = steps.findIndex(
      (s) => typeof s.run === "string" && s.run.includes("_paperpilot-deployment.json"),
    );
    const validateIdx = steps.findIndex((s) => s.name === "Validate local Pages bundle");
    expect(markerIdx).toBeGreaterThanOrEqual(0);
    expect(assertIdx, "no step asserts the marker's source_sha").toBeGreaterThan(markerIdx);
    expect(validateIdx).toBeGreaterThan(assertIdx);
  });

  // P5 tier-A review round 2 (survivor fix): the test above only checks
  // that SOME step mentions `_paperpilot-deployment.json` -- it doesn't
  // pin the actual compare, so replacing `test "$marker_sha" =
  // "$SOURCE_SHA"` with a no-op `true` survived. Pinned here for both
  // the build job's own fast-fail assert AND the deploy job's assert
  // right after downloading the artifact (same literal shape, two
  // independent places it could silently regress).
  it('the literal `test "$marker_sha" = "$SOURCE_SHA"` compare is present (not replaced by a no-op)', () => {
    const buildAssertStep = steps.find(
      (s) => typeof s.run === "string" && s.run.includes("_paperpilot-deployment.json"),
    );
    expect(buildAssertStep?.run).toContain('test "$marker_sha" = "$SOURCE_SHA"');

    const [, deployJob] = jobsOf(doc).find(([id]) => id === "deploy") as [string, YamlDoc];
    const deployAssertStep = (deployJob.steps as YamlDoc[]).find(
      (s) => s.name === "Assert marker matches the requested SHA",
    );
    expect(deployAssertStep?.run).toContain('test "$marker_sha" = "$SOURCE_SHA"');
  });

  it('"Validate local Pages bundle" uses `validate local <sha>` (HEAD==SHA check), not `validate bundle`', () => {
    const validateStep = steps.find((s) => s.name === "Validate local Pages bundle");
    expect(validateStep?.run).toContain('validate local "$SOURCE_SHA" apps/web/out');
    expect(validateStep?.run).not.toMatch(/validate bundle apps\/web\/out/);
  });

  it("does not compute an out.sha256 that nothing ever reads", () => {
    for (const run of allRunStrings(doc)) {
      expect(run).not.toContain("out.sha256");
    }
  });
});

describe("L7: collect-daily-watch.yml passes PAPERPILOT_SLACK_WEBHOOK_URL to the collector step", () => {
  it('the "Run PaperPilot (daily follow-watch)" step carries the secret', () => {
    const doc = readWorkflow("collect-daily-watch.yml");
    const [, watchJob] = jobsOf(doc).find(([id]) => id === "watch") as [string, YamlDoc];
    const step = (watchJob.steps as YamlDoc[]).find(
      (s) => s.name === "Run PaperPilot (daily follow-watch)",
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression (YAML env value), not a JS template literal.
    expect(step?.env?.PAPERPILOT_SLACK_WEBHOOK_URL).toBe("${{ secrets.SLACK_WEBHOOK_URL }}");
  });
});

describe("N2 (P5 tier-A review round 2): legacy-redirects.yml passes no cwd-relative path flag", () => {
  // M4 (round 1) added an explicit `--source legacy/gh-pages-site` to
  // pin the p5-era literal path. That regressed: `pnpm --filter
  // @paperpilot/web run legacy-redirects` runs with cwd = apps/web, so
  // the relative path resolved under apps/web and the generator always
  // failed (see apps/web/test/legacy-redirects/generator.cwd.spawn.test.ts
  // for the real-process reproduction). Since Tier C the generator reads
  // the frozen legacy/redirect/paths.json (`--paths`, default computed
  // from the script's own location), so the only safe forms for any
  // path flag here are: none at all, or an absolute, workspace-rooted
  // path that does not depend on cwd.
  it('the "Generate the redirect site" step passes no relative --paths/--source/--out', () => {
    const doc = readWorkflow("legacy-redirects.yml");
    const [, job] = jobsOf(doc).find(([id]) => id === "redirect") as [string, YamlDoc];
    const step = (job.steps as YamlDoc[]).find((s) => s.name === "Generate the redirect site");
    const run = step?.run as string;
    expect(run).toContain("legacy-redirects");
    for (const match of run.matchAll(/--(?:paths|source|out)\s+(\S+)/g)) {
      const value = match[1] as string;
      expect(
        value.startsWith("/") ||
          value.startsWith("$GITHUB_WORKSPACE") ||
          value.startsWith('"$GITHUB_WORKSPACE'),
        `${match[0]} must be absolute/workspace-anchored, not resolved against the step's cwd`,
      ).toBe(true);
    }
  });

  it("does not forward flags through a literal ` -- --` (pnpm would swallow everything after a bare `--`)", () => {
    const doc = readWorkflow("legacy-redirects.yml");
    for (const run of allRunStrings(doc)) {
      expect(run).not.toMatch(/\s--\s--/);
    }
  });
});
