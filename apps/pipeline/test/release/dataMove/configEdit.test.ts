import { describe, expect, it } from "vitest";
import {
  applyConfigEdits,
  ConfigEditError,
  reverseConfigEdits,
} from "../../../src/release/dataMove/configEdit.js";
import {
  CONFIG_DAILY_WATCH_ALLOWED_KEYS,
  CONFIG_WEEKLY_ALLOWED_KEYS,
} from "../../../src/release/dataMove/rules.js";
import { CONFIG_DAILY_WATCH_YAML_FIXTURE, CONFIG_YAML_FIXTURE } from "./fixtures.js";

const WEEKLY_EDITS = [
  { key: "output.csv.dir", oldValue: "paperpilot/output", newValue: "data/inputs" },
  { key: "output.json.dir", oldValue: "paperpilot/output", newValue: "data/inputs" },
  {
    key: "incremental.seen_ids_file",
    oldValue: "paperpilot/data/seen_ids.json",
    newValue: "data/state/seen_ids.json",
  },
  {
    key: "logging.file",
    oldValue: "paperpilot/logs/paperpilot.log",
    newValue: "logs/paperpilot.log",
  },
];

describe("applyConfigEdits", () => {
  it("rewrites only the matched keys' values, byte-for-byte elsewhere", () => {
    const out = applyConfigEdits(CONFIG_YAML_FIXTURE, WEEKLY_EDITS);
    expect(out).toContain("    dir: data/inputs\n");
    expect(out).not.toContain("paperpilot/output");
    expect(out).toContain("seen_ids_file: data/state/seen_ids.json\n");
    expect(out).toContain("file: logs/paperpilot.log\n");
    // Untouched keys/comments/blank lines survive verbatim.
    expect(out).toContain("    enabled: true\n    dir: data/inputs\n    encoding: utf-8-sig\n");
    expect(out).toContain("  max_age_days: 14\n");
  });

  it("round-trips exactly back to the original via reverseConfigEdits", () => {
    const forward = applyConfigEdits(CONFIG_YAML_FIXTURE, WEEKLY_EDITS);
    const back = reverseConfigEdits(forward, WEEKLY_EDITS);
    expect(back).toBe(CONFIG_YAML_FIXTURE);
  });

  it("covers every allowed key for config.yaml and config.daily-watch.yaml", () => {
    expect(WEEKLY_EDITS.map((e) => e.key).sort()).toEqual([...CONFIG_WEEKLY_ALLOWED_KEYS].sort());
    const dailyEdits = [
      { key: "output.csv.dir", oldValue: "x", newValue: "y" },
      { key: "incremental.seen_ids_file", oldValue: "x", newValue: "y" },
      { key: "incremental.run_history_file", oldValue: "x", newValue: "y" },
      { key: "logging.file", oldValue: "x", newValue: "y" },
    ];
    expect(dailyEdits.map((e) => e.key).sort()).toEqual(
      [...CONFIG_DAILY_WATCH_ALLOWED_KEYS].sort(),
    );
    expect(applyConfigEdits(CONFIG_DAILY_WATCH_YAML_FIXTURE, [])).toBe(
      CONFIG_DAILY_WATCH_YAML_FIXTURE,
    );
  });

  it("RED: throws (never silently no-ops) when the expected old value is not found", () => {
    expect(() =>
      applyConfigEdits(CONFIG_YAML_FIXTURE, [
        { key: "output.csv.dir", oldValue: "this/value/does/not/exist", newValue: "data/inputs" },
      ]),
    ).toThrow(ConfigEditError);
  });

  it("distinguishes sibling keys with the same leaf name by their full dotted path", () => {
    const text = "a:\n  k: v\nb:\n  k: v\n";
    const out = applyConfigEdits(text, [{ key: "a.k", oldValue: "v", newValue: "w" }]);
    expect(out).toBe("a:\n  k: w\nb:\n  k: v\n");
  });

  it("RED: throws when the same dotted path + value is ambiguous (more than one match)", () => {
    const text = "a:\n  k: v\na:\n  k: v\n";
    expect(() => applyConfigEdits(text, [{ key: "a.k", oldValue: "v", newValue: "w" }])).toThrow(
      ConfigEditError,
    );
  });

  it("never touches a key outside the given edits list", () => {
    const out = applyConfigEdits(CONFIG_YAML_FIXTURE, [
      { key: "logging.file", oldValue: "paperpilot/logs/paperpilot.log", newValue: "logs/x.log" },
    ]);
    expect(out).toContain("dir: paperpilot/output\n");
    expect(out).toContain("seen_ids_file: paperpilot/data/seen_ids.json\n");
  });
});
