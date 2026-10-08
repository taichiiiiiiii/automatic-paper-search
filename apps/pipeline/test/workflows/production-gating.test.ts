/**
 * p5-plan.md §2 A7 assertions 4, 5, 6, 8, 9 — the production-deploy
 * gating checks: Cloudflare secrets stay scoped to the develop-only
 * deploy environment, the "known-good ledger" environment name is never
 * written by a job directly, record always waits on smoke, pages.yml's
 * push paths are a superset of the admit diff set, and both
 * production-mutating workflows share the same concurrency group.
 */
import { describe, expect, it } from "vitest";
import { EXPECTED_WORKFLOW_FILES, jobsOf, readAllWorkflows, type YamlDoc } from "./helpers.js";

const docs = readAllWorkflows();

function jobsReferencingCloudflareSecrets(doc: YamlDoc): Array<[string, YamlDoc]> {
  return jobsOf(doc).filter(([, job]) => {
    const text = JSON.stringify(job);
    return text.includes("CLOUDFLARE_");
  });
}

describe("assertion 4: CLOUDFLARE_* only in jobs with environment: cloudflare-pages-deploy, gated on develop", () => {
  for (const file of EXPECTED_WORKFLOW_FILES) {
    it(`${file}`, () => {
      const doc = docs.get(file);
      for (const [jobId, job] of jobsReferencingCloudflareSecrets(doc)) {
        expect(
          job.environment?.name,
          `${file} job ${jobId} references CLOUDFLARE_* without environment: cloudflare-pages-deploy`,
        ).toBe("cloudflare-pages-deploy");
        const ifCond: string = job.if ?? "";
        expect(
          ifCond.includes("refs/heads/develop"),
          `${file} job ${jobId} references CLOUDFLARE_* without an if: gating on refs/heads/develop (got: ${JSON.stringify(ifCond)})`,
        ).toBe(true);
      }
    });
  }
});

describe("assertion 5: no job sets environment: cloudflare-pages-production", () => {
  for (const file of EXPECTED_WORKFLOW_FILES) {
    it(`${file}`, () => {
      const doc = docs.get(file);
      for (const [jobId, job] of jobsOf(doc)) {
        expect(job.environment?.name, `${file} job ${jobId}`).not.toBe(
          "cloudflare-pages-production",
        );
      }
    });
  }
});

describe("assertion 6: every record job needs smoke", () => {
  const filesWithRecord = EXPECTED_WORKFLOW_FILES.filter((f) =>
    jobsOf(docs.get(f)).some(([id]) => id === "record"),
  );

  it("at least one staged workflow actually has a record job (sanity)", () => {
    expect(filesWithRecord.length).toBeGreaterThan(0);
  });

  for (const file of filesWithRecord) {
    it(`${file}`, () => {
      const doc = docs.get(file);
      const [, recordJob] = jobsOf(doc).find(([id]) => id === "record") as [string, YamlDoc];
      const needs: string[] = Array.isArray(recordJob.needs) ? recordJob.needs : [recordJob.needs];
      expect(needs).toContain("smoke");
    });
  }
});

describe("assertion 8: pages.yml paths is a superset of pages-release.yml's admit diff path set", () => {
  it("every ADMIT_PATHS entry is covered by a pages.yml paths glob", () => {
    const pagesDoc = docs.get("pages.yml");
    const releaseDoc = docs.get("pages-release.yml");

    const pagesPaths: string[] = pagesDoc.on.push.paths;

    const [, admitJob] = jobsOf(releaseDoc).find(([id]) => id === "admit") as [string, YamlDoc];
    const freshnessStep = admitJob.steps.find(
      (s: YamlDoc) => typeof s.run === "string" && typeof s.env?.ADMIT_PATHS === "string",
    );
    expect(freshnessStep, "admit job's freshness step must declare env.ADMIT_PATHS").toBeDefined();
    const admitPaths: string[] = freshnessStep.env.ADMIT_PATHS.split(/\s+/).filter(Boolean);
    expect(admitPaths.length).toBeGreaterThan(0);

    for (const admitPath of admitPaths) {
      const covered = pagesPaths.some((p) => p === admitPath || p === `${admitPath}/**`);
      expect(covered, `pages.yml paths does not cover admit path "${admitPath}"`).toBe(true);
    }
  });
});

describe("assertion 9: concurrency group paperpilot-pages-production on pages-release and pages-rollback", () => {
  for (const file of ["pages-release.yml", "pages-rollback.yml"]) {
    it(`${file}`, () => {
      const doc = docs.get(file);
      expect(doc.concurrency?.group).toBe("paperpilot-pages-production");
      expect(doc.concurrency?.["cancel-in-progress"]).toBe(false);
    });
  }
});
