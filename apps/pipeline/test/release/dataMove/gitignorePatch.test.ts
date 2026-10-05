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

/** The real repository's `.gitignore` is read-only here, never written. */
describe("against the real repository's .gitignore (read-only)", () => {
  it("contains exactly one occurrence of each block this patch targets", async () => {
    const { readFileSync } = await import("node:fs");
    const { execFileSync } = await import("node:child_process");
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf-8",
    }).trim();
    const text = readFileSync(`${root}/.gitignore`, "utf-8");
    expect(() => applyGitignorePatch(text)).not.toThrow();
  });
});
