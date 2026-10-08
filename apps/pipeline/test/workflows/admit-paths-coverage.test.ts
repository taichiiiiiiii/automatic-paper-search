/**
 * M1 of the P5 tier-A review (pass 1): apps/web reads two directories at
 * build time —
 *   - `apps/web/lib/lineage/server-fs.ts`: `layoutFor(REPO_ROOT).published`
 *   - `apps/web/lib/catalog-copy-reader.ts`: `conferenceCopyDir(layoutFor(REPO_ROOT))`
 * — and both must be covered by pages-release.yml's `ADMIT_PATHS` (or a
 * re-run of an older release can pass admit with no diff on the newer
 * content and redeploy/record stale data) AND by pages.yml's push
 * `paths:` filter (or a real change to that directory never triggers a
 * release at all). `data/config/conference-copy` was missing from both.
 *
 * The two p5-shaped relative roots are computed once here via
 * `relLayout("p5")` (the same roots the workflows themselves spell out
 * as literals, since these staged workflows are written for the
 * post-cutover layout regardless of today's `LAYOUT_MODE`), so this is
 * the single enumeration both assertions check against.
 */
import { relLayout } from "@paperpilot/core/layout";
import { describe, expect, it } from "vitest";
import { jobsOf, readWorkflow, type YamlDoc } from "./helpers.js";

const rel = relLayout("p5");

/** Every directory a build-time apps/web reader resolves through layoutFor(). */
const BUILD_TIME_READ_DIRS: readonly string[] = [rel.published, `${rel.config}/conference-copy`];

function admitPaths(): string[] {
  const doc = readWorkflow("pages-release.yml");
  const [, admitJob] = jobsOf(doc).find(([id]) => id === "admit") as [string, YamlDoc];
  const steps: YamlDoc[] = admitJob.steps;
  const freshnessStep = steps.find(
    (s) => typeof s.run === "string" && typeof s.env?.ADMIT_PATHS === "string",
  );
  if (!freshnessStep) throw new Error("admit job's freshness step with env.ADMIT_PATHS not found");
  return (freshnessStep.env.ADMIT_PATHS as string).split(/\s+/).filter(Boolean);
}

function pagesPushPaths(): string[] {
  const doc = readWorkflow("pages.yml");
  return doc.on.push.paths as string[];
}

describe("M1: admit/pages paths cover every enumerable build-time read dir", () => {
  it("sanity: the enumerated list is non-empty and includes conference-copy", () => {
    expect(BUILD_TIME_READ_DIRS.length).toBeGreaterThan(1);
    expect(BUILD_TIME_READ_DIRS).toContain("data/config/conference-copy");
  });

  it("pages-release.yml's ADMIT_PATHS covers every build-time read dir", () => {
    const admit = admitPaths();
    for (const dir of BUILD_TIME_READ_DIRS) {
      expect(admit, `ADMIT_PATHS ${JSON.stringify(admit)} is missing "${dir}"`).toContain(dir);
    }
  });

  it("pages.yml's push paths cover every build-time read dir", () => {
    const paths = pagesPushPaths();
    for (const dir of BUILD_TIME_READ_DIRS) {
      const covered = paths.some((p) => p === dir || p === `${dir}/**`);
      expect(covered, `pages.yml paths ${JSON.stringify(paths)} do not cover "${dir}"`).toBe(true);
    }
  });
});
