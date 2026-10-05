/**
 * P5 tier-A review round 2, N1 (c): `no-skip-gate` fails the release the
 * moment `LAYOUT_MODE` flips to "p5" if any test is still conditionally
 * SKIPPED on that flip rather than conditionally ASSERTING the
 * mode-appropriate fact. Round 1 left eight such conditional-skip calls
 * (`it.skipIf(` gated on whether that same flag equals `"legacy"`);
 * this changeset converted the two it owns
 * (`packages/core/test/layout/index.test.ts`,
 * `apps/web/test/legacy-redirects/generator.test.ts`) into unconditional
 * tests that branch on `LAYOUT_MODE` internally instead of skipping
 * either branch.
 *
 * This is a repo-wide static scan, not a one-off pin on those two files:
 * a `.skip(`/`.skipIf(` call keyed on `LAYOUT_MODE` is a standing defect
 * class (it reports "skipped" under p5, which `no-skip-gate` treats as
 * fail-closed), so any NEW one introduced anywhere must be caught the
 * same way a regression of the two fixed ones would be.
 *
 * `apps/pipeline/test/release/dataMove/**` is owned by a different,
 * concurrent P5 changeset (the data-move tool) and is intentionally
 * excluded here with this comment naming that -- its own six
 * `LAYOUT_MODE`-keyed skips are that agent's to convert, and asserting
 * on them from this changeset would make this test fail for a fix that
 * isn't this changeset's to make. They also do not affect today's gate:
 * `LAYOUT_MODE` is "legacy" in the real repo, so `skipIf(LAYOUT_MODE !==
 * "legacy")` evaluates to `skipIf(false)` and none of the six actually
 * skip right now -- only a p5-mode rehearsal flips that.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { getRepoRoot } from "@paperpilot/core";
import { describe, expect, it } from "vitest";

const REPO_ROOT = getRepoRoot();
const SCAN_ROOTS = ["apps", "packages"];
const EXCLUDED_DIR_PREFIXES = [
  join("apps", "pipeline", "test", "release", "dataMove"), // owned by the dataMove changeset
];

function findTestFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "out" || name === ".next") continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...findTestFiles(full));
    } else if (/\.test\.tsx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

function isExcluded(relPath: string): boolean {
  return EXCLUDED_DIR_PREFIXES.some((prefix) => relPath.startsWith(prefix));
}

/** A `.skip(`/`.skipIf(` call where `LAYOUT_MODE` appears on the same
 * source line as the call -- matches this codebase's actual style of
 * gating a conditional skip on that flag, without requiring a full JS
 * parse. (Deliberately not spelled out as a single contiguous example
 * here, or this doc comment would match its own scan.) */
const SKIP_CALL_WITH_LAYOUT_MODE = /\b(?:it|describe)\.(?:skip|skipIf)\s*\([^)]*\bLAYOUT_MODE\b/;

describe("no test file (outside dataMove) calls .skip(/.skipIf( keyed on LAYOUT_MODE", () => {
  const allFiles = SCAN_ROOTS.flatMap((root) => findTestFiles(join(REPO_ROOT, root)));
  const files = allFiles
    .map((f) => relative(REPO_ROOT, f))
    .filter((relPath) => !isExcluded(relPath));

  it("found a non-trivial number of test files (sanity: the scan isn't silently matching nothing)", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("excluded at least the known dataMove LAYOUT_MODE-skip files (sanity: the exclusion isn't silently matching everything)", () => {
    expect(allFiles.length).toBeGreaterThan(files.length);
  });

  for (const relPath of files) {
    const source = readFileSync(join(REPO_ROOT, relPath), "utf-8");
    const lines = source.split("\n");
    const offenders = lines.filter((line) => SKIP_CALL_WITH_LAYOUT_MODE.test(line));
    if (offenders.length === 0) continue;
    it(`${relPath}: has no LAYOUT_MODE-keyed .skip(/.skipIf( call`, () => {
      expect(
        offenders,
        `${relPath} skips a test keyed on LAYOUT_MODE -- convert it to an unconditional test that branches on the mode-appropriate fact instead:\n${offenders.join("\n")}`,
      ).toEqual([]);
    });
  }
});
