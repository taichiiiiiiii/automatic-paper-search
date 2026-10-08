/**
 * P5 tier-A review round 3, M1: `data/state/run_history.daily.jsonl` had
 * no rule-table mapping even though the rule table's own
 * `config.daily-watch.yaml` moveEdit points `incremental.run_history_file`
 * at it. Every R-B carry-back after a `collect-daily-watch` run refused
 * the whole call ("no legacy-path equivalent"), and a legacy-tracked
 * `paperpilot/data/run_history.daily.jsonl` made `plan`/`apply` fail as
 * unmapped.
 *
 * The generic invariant this pins: every p5 path a moveEdit edit
 * rewrites a config key to must map back, through the reverse rule
 * table carry-back uses, to exactly the legacy value it replaced, and
 * that legacy value must forward-classify to exactly that p5 path. A
 * directory-valued key (`output.csv.dir`) is checked through a
 * representative child file, since only files are classified.
 */
import { describe, expect, it } from "vitest";
import { reverseMapDataPath } from "../../../src/release/dataMove/carryBack.js";
import { classifyPath, type MoveEditEntry } from "../../../src/release/dataMove/rules.js";

const MOVE_EDIT_PATHS = ["paperpilot/config.yaml", "paperpilot/config.daily-watch.yaml"];

function moveEditEntries(): MoveEditEntry[] {
  return MOVE_EDIT_PATHS.map((path) => {
    const entry = classifyPath(path);
    if (entry.class !== "moveEdit") throw new Error(`${path} is not a moveEdit entry`);
    return entry;
  });
}

/** A value whose last segment has no extension is a directory. */
function isDirectoryValue(value: string): boolean {
  const last = value.split("/").pop() ?? "";
  return !last.includes(".");
}

describe("every moveEdit newValue under data/ maps back to its legacy oldValue (M1)", () => {
  const edits = moveEditEntries().flatMap((entry) =>
    entry.edits.map((edit) => ({ file: entry.path, ...edit })),
  );

  it("sanity: the run_history.daily.jsonl edit is among the checked edits", () => {
    expect(edits.map((e) => e.newValue)).toContain("data/state/run_history.daily.jsonl");
  });

  for (const edit of edits.filter((e) => e.newValue.startsWith("data/"))) {
    it(`${edit.file} ${edit.key}: ${edit.newValue} -> ${edit.oldValue}`, () => {
      if (isDirectoryValue(edit.newValue)) {
        const child = "probe-2026/summary.csv";
        const entry = reverseMapDataPath(`${edit.newValue}/${child}`);
        expect(entry?.path, `${edit.newValue}/${child} has no legacy equivalent`).toBe(
          `${edit.oldValue}/${child}`,
        );
        return;
      }
      const entry = reverseMapDataPath(edit.newValue);
      expect(entry?.path, `${edit.newValue} has no legacy equivalent`).toBe(edit.oldValue);
      const forward = classifyPath(edit.oldValue);
      expect(forward.class).toBe("move");
      expect(forward.class === "move" ? forward.dest : undefined).toBe(edit.newValue);
    });
  }
});
