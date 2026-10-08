/**
 * p5-plan.md §5.2: "The rule table covers today's `git ls-files` (run in
 * CI on feat): no orphans, no collisions." Runs a **read-only**
 * `git ls-files` against the real repository (never writes, never
 * `git mv`/`git add`/commit here) and feeds it straight through
 * `buildPlan`.
 */
import { execFileSync } from "node:child_process";
import { LAYOUT_MODE } from "@paperpilot/core/layout";
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

  // The next three tests run in both layouts and assert the fact that
  // holds in the current one (review round 2, N1: a mode-gated skip reports
  // "skipped" once commit B flips LAYOUT_MODE, which the release no-skip
  // gate rejects). Legacy: the pre-move tree, with the managed roots full
  // of move/moveEdit/delete entries. p5 (after B, including the p5
  // rehearsal clone): the moved tree, where every remaining managed-root
  // path is a `stay` and the data lives under data/.
  it("every tracked path is in the plan, and the managed roots match the current layout", () => {
    const paths = realLsFiles();
    const plan = buildPlan({ paths });
    const managed = paths.filter(isManagedPath);
    expect(plan.entries.length).toBe(paths.length);
    expect(["legacy", "p5"]).toContain(LAYOUT_MODE);
    if (LAYOUT_MODE === "legacy") {
      expect(managed.length).toBeGreaterThan(900); // docs/ + paperpilot/data/ + paperpilot/output/ + 3 config files
      expect(paths.filter((p) => p.startsWith("data/"))).toEqual([]);
    } else {
      expect(paths.filter((p) => p.startsWith("data/")).length).toBeGreaterThan(900);
      const notStay = plan.entries.filter((e) => isManagedPath(e.path) && e.class !== "stay");
      expect(notStay.map((e) => e.path)).toEqual([]);
    }
  });

  it("the two deletes are exactly docs/daily/papers.json and docs/search-index.json (legacy), and gone after B (p5)", () => {
    const paths = realLsFiles();
    const deletes = buildPlan({ paths })
      .entries.filter((e) => e.class === "delete")
      .map((e) => e.path)
      .sort();
    if (LAYOUT_MODE === "legacy") {
      expect(deletes).toEqual(["docs/daily/papers.json", "docs/search-index.json"]);
    } else {
      expect(deletes).toEqual([]);
      expect(paths).not.toContain("docs/daily/papers.json");
      expect(paths).not.toContain("docs/search-index.json");
    }
  });

  it("both collector config files are moveEdit entries (legacy), and live under data/config (p5)", () => {
    const paths = realLsFiles();
    const moveEdits = buildPlan({ paths })
      .entries.filter((e) => e.class === "moveEdit")
      .map((e) => e.path)
      .sort();
    if (LAYOUT_MODE === "legacy") {
      expect(moveEdits).toEqual(["paperpilot/config.daily-watch.yaml", "paperpilot/config.yaml"]);
    } else {
      expect(moveEdits).toEqual([]);
      expect(paths).toEqual(
        expect.arrayContaining(["data/config/config.daily-watch.yaml", "data/config/config.yaml"]),
      );
      expect(paths).not.toContain("paperpilot/config.yaml");
    }
  });
});
