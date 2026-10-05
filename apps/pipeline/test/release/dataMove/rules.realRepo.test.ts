/**
 * p5-plan.md §5.2: "The rule table covers today's `git ls-files` (run in
 * CI on feat): no orphans, no collisions." Runs a **read-only**
 * `git ls-files` against the real repository (never writes, never
 * `git mv`/`git add`/commit here) and feeds it straight through
 * `buildPlan`.
 */
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { buildPlan, planIsClean } from "../../../src/release/dataMove/plan.js";
import { isManagedPath } from "../../../src/release/dataMove/rules.js";

function repoRoot(): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf-8" }).trim();
}

function realLsFiles(): string[] {
  const out = execFileSync("git", ["ls-files"], { cwd: repoRoot(), encoding: "utf-8" });
  return out.trim().length === 0 ? [] : out.trim().split("\n");
}

describe("the rule table against the real repository's git ls-files", () => {
  it("classifies every tracked path with no unmapped path and no destination collision", () => {
    const paths = realLsFiles();
    expect(paths.length).toBeGreaterThan(1000); // sanity: this really is the whole repo
    const plan = buildPlan({ paths });
    if (!planIsClean(plan)) {
      // Fail with every problem listed, not just the first, since this is
      // the test meant to catch rule-table drift as the repo evolves.
      throw new Error(
        `${plan.problems.length} plan problem(s):\n${plan.problems.map((p) => `  [${p.kind}] ${p.message}`).join("\n")}`,
      );
    }
    expect(plan.problems).toEqual([]);
  });

  it("every managed-root path appears in the plan and vice versa", () => {
    const paths = realLsFiles();
    const plan = buildPlan({ paths });
    const managed = paths.filter(isManagedPath);
    expect(plan.entries.length).toBe(paths.length);
    expect(managed.length).toBeGreaterThan(900); // docs/ + paperpilot/data/ + paperpilot/output/ + 3 config files
  });

  it("the two gated/ungated deletes are exactly docs/daily/papers.json and docs/search-index.json", () => {
    const paths = realLsFiles();
    const plan = buildPlan({ paths });
    const deletes = plan.entries
      .filter((e) => e.class === "delete")
      .map((e) => e.path)
      .sort();
    expect(deletes).toEqual(["docs/daily/papers.json", "docs/search-index.json"]);
  });

  it("both collector config files are moveEdit entries", () => {
    const paths = realLsFiles();
    const plan = buildPlan({ paths });
    const moveEdits = plan.entries
      .filter((e) => e.class === "moveEdit")
      .map((e) => e.path)
      .sort();
    expect(moveEdits).toEqual(["paperpilot/config.daily-watch.yaml", "paperpilot/config.yaml"]);
  });
});
