/**
 * H4 of the P5 tier-A review (pass 1): `actions/upload-artifact` roots a
 * multi-path artifact at the paths' least common ancestor, which strips
 * the `published/`/`state/`/`inputs/`/`config/` prefix `promote.ts`'s
 * allowlist requires — regen-themes.yml and conference-on-demand.yml
 * uploaded raw multi-path `data/...` locations directly and would fail
 * at promote on every run. The fix is to package through
 * `release/cli.ts package` first (as theme-on-demand.yml and
 * collect-weekly.yml already did) and upload the packaged directory.
 */
import { describe, expect, it } from "vitest";
import { EXPECTED_WORKFLOW_FILES, jobsOf, readAllWorkflows, type YamlDoc } from "./helpers.js";

const docs = readAllWorkflows();
// biome-ignore lint/suspicious/noTemplateCurlyInString: a literal GitHub Actions expression string (YAML `with.path` value), not a JS template literal.
const PACKAGED_CANDIDATE_PATH = "${{ runner.temp }}/candidate";

function uploadArtifactSteps(job: YamlDoc): YamlDoc[] {
  const steps: YamlDoc[] = job.steps ?? [];
  return steps.filter(
    (s) => typeof s.uses === "string" && s.uses.startsWith("actions/upload-artifact@"),
  );
}

describe("H4: no generate-job upload-artifact step uploads a raw multi-path repo location", () => {
  let sawAtLeastOneUpload = false;

  for (const file of EXPECTED_WORKFLOW_FILES) {
    const doc = docs.get(file);
    for (const [jobId, job] of jobsOf(doc)) {
      if (jobId !== "generate") continue;
      const uploads = uploadArtifactSteps(job);
      if (uploads.length > 0) sawAtLeastOneUpload = true;
      for (const step of uploads) {
        it(`${file} generate step "${step.name}" does not upload a multi-line (multi-path) artifact`, () => {
          const path = step.with?.path;
          if (typeof path === "string") {
            expect(
              path.includes("\n"),
              `${file} step "${step.name}" uploads a raw multi-path artifact (would be rooted at ` +
                `the paths' common ancestor, stripping the real prefix): ${JSON.stringify(path)}`,
            ).toBe(false);
          }
        });
      }
    }
  }

  it("sanity: at least one generate-job upload-artifact step was actually found", () => {
    expect(sawAtLeastOneUpload).toBe(true);
  });
});

describe('H4: the "Upload generated candidate" step in every generate job uploads the packaged candidate dir', () => {
  let sawAtLeastOneCandidateUpload = false;

  for (const file of EXPECTED_WORKFLOW_FILES) {
    const doc = docs.get(file);
    for (const [jobId, job] of jobsOf(doc)) {
      if (jobId !== "generate") continue;
      const steps: YamlDoc[] = job.steps ?? [];
      const uploadStep = steps.find((s) => s.name === "Upload generated candidate");
      if (!uploadStep) continue;
      sawAtLeastOneCandidateUpload = true;
      it(`${file}`, () => {
        expect(uploadStep.with?.path).toBe(PACKAGED_CANDIDATE_PATH);
      });
    }
  }

  it('sanity: at least one "Upload generated candidate" step was actually found', () => {
    expect(sawAtLeastOneCandidateUpload).toBe(true);
  });
});

// P5 tier-A review round 2 (survivor fix): the describe block above only
// checks the UPLOAD step's `with.path` -- it never confirms anything
// actually ran `release/cli.ts package` to populate that directory
// first. Deleting the "Package exact ... candidate" step entirely
// survived every existing test (the only runtime guard,
// `if-no-files-found: error`, isn't visible to a static YAML check).
describe("H4 (round 2): every generate job runs `release/cli.ts package` before uploading the candidate", () => {
  let sawAtLeastOnePackageStep = false;

  for (const file of EXPECTED_WORKFLOW_FILES) {
    const doc = docs.get(file);
    for (const [jobId, job] of jobsOf(doc)) {
      if (jobId !== "generate") continue;
      const steps: YamlDoc[] = job.steps ?? [];
      const uploadIdx = steps.findIndex((s) => s.name === "Upload generated candidate");
      if (uploadIdx < 0) continue; // covered by the sanity check above
      it(`${file}: a step before "Upload generated candidate" invokes release/cli.ts package`, () => {
        const packageIdx = steps.findIndex(
          (s) => typeof s.run === "string" && /release\/cli\.ts\s+package\b/.test(s.run),
        );
        expect(
          packageIdx,
          `${file}'s generate job has no step invoking \`release/cli.ts package\` before uploading the candidate`,
        ).toBeGreaterThanOrEqual(0);
        sawAtLeastOnePackageStep = true;
        expect(packageIdx).toBeLessThan(uploadIdx);
      });
    }
  }

  it("sanity: at least one release/cli.ts package step was actually found", () => {
    expect(sawAtLeastOnePackageStep).toBe(true);
  });
});
