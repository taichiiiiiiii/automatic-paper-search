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

describe("M4: legacy-redirects.yml passes --source from the legacy site layout root", () => {
  it('the "Generate the redirect site" step passes --source legacy/gh-pages-site', () => {
    const doc = readWorkflow("legacy-redirects.yml");
    const [, job] = jobsOf(doc).find(([id]) => id === "redirect") as [string, YamlDoc];
    const step = (job.steps as YamlDoc[]).find((s) => s.name === "Generate the redirect site");
    expect(step?.run).toContain("--source legacy/gh-pages-site");
  });
});
