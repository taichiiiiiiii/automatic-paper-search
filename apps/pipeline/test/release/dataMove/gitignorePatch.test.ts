import { LAYOUT_MODE } from "@paperpilot/core/layout";
import { describe, expect, it } from "vitest";
import {
  applyGitignorePatch,
  GitignorePatchError,
  reverseGitignorePatch,
} from "../../../src/release/dataMove/gitignorePatch.js";
import { GITIGNORE_FIXTURE } from "./fixtures.js";

describe("applyGitignorePatch", () => {
  it("rewrites the lineage-cache block and the unarxive line, and appends logs/", () => {
    const out = applyGitignorePatch(GITIGNORE_FIXTURE);
    expect(out).toContain(
      "data/state/lineage-cache/*\n!data/state/lineage-cache/classifications.json",
    );
    expect(out).not.toContain("paperpilot/data/lineage-cache");
    expect(out).toContain("data/state/unarxive/");
    expect(out).not.toContain("paperpilot/data/unarxive/");
    expect(out).toContain("logs/");
    expect(out).toContain("node_modules/"); // untouched line survives
  });

  it("round-trips exactly back to the original via reverseGitignorePatch", () => {
    const forward = applyGitignorePatch(GITIGNORE_FIXTURE);
    expect(reverseGitignorePatch(forward)).toBe(GITIGNORE_FIXTURE);
  });

  it("RED: throws if the lineage-cache block is missing", () => {
    expect(() => applyGitignorePatch("node_modules/\n")).toThrow(GitignorePatchError);
  });

  it("RED: reverse throws if the appended logs/ block is missing", () => {
    expect(() => reverseGitignorePatch(GITIGNORE_FIXTURE)).toThrow(GitignorePatchError);
  });

  it("RED: refuses to append logs/ twice (the cache/unarxive blocks still present, logs/ already appended)", () => {
    const alreadyHasLogsBlock =
      `${GITIGNORE_FIXTURE}\n# P5 operator logs (apply, docs/migration/p5-plan.md §5.1) ` +
      "— never committed.\nlogs/\n";
    expect(() => applyGitignorePatch(alreadyHasLogsBlock)).toThrow(GitignorePatchError);
    expect(() => applyGitignorePatch(alreadyHasLogsBlock)).toThrow(/twice/);
  });
});

/**
 * The real repository's `.gitignore` is read-only here, never written.
 * This sanity-checks that the patch's targeted blocks still look as
 * `apply`/`verify` expect in the PRE-MOVE (legacy) `.gitignore` -- once
 * commit B's `apply` has actually run (including during this task's own
 * p5-rehearsal, which applies that same patch to a scratch clone),
 * `.gitignore` is already patched and this specific assertion no longer
 * applies to it (the real `verify`/round-trip coverage for the patched
 * shape lives in `roundTrip.test.ts`). An explicit `LAYOUT_MODE` check,
 * not a mode branch on what this test asserts, skips it there.
 */
describe("against the real repository's .gitignore (read-only)", () => {
  it.skipIf(LAYOUT_MODE !== "legacy")(
    "contains exactly one occurrence of each block this patch targets",
    async () => {
      const { readFileSync } = await import("node:fs");
      const { execFileSync } = await import("node:child_process");
      const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
        encoding: "utf-8",
      }).trim();
      const text = readFileSync(`${root}/.gitignore`, "utf-8");
      expect(() => applyGitignorePatch(text)).not.toThrow();
    },
  );
});
