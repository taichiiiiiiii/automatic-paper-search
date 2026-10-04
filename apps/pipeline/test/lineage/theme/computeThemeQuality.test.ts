/**
 * Vitest port of `paperpilot/tests/test_compute_theme_quality.py`
 * (LIN-53).
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { TEMPLATE_RATIONALES } from "../../../src/lineage/llm/base.js";
import {
  computeQuality,
  writeThemeQuality,
} from "../../../src/lineage/theme/computeThemeQuality.js";

const EXTENDS_TEMPLATE = TEMPLATE_RATIONALES.extends_methodology!;

let themesDir: string;
beforeEach(() => {
  themesDir = mkdtempSync(join(tmpdir(), "theme-quality-"));

  // Theme A — clean. 1 on-topic seed, 1 paper-specific rationale, no
  // year reversals. Edge convention: src = parent (older), dst = child
  // (newer extender).
  mkdirSync(join(themesDir, "clean-theme"), { recursive: true });
  writeFileSync(
    join(themesDir, "clean-theme", "lineage.json"),
    JSON.stringify({
      meta: { theme: "Clean Theme" },
      nodes: [
        {
          id: "p1",
          title: "Clean Theme: a survey",
          year: 2020,
          is_focus: true,
          tldr: "we present clean theme techniques",
        },
        { id: "p2", title: "Earlier work", year: 2018, tldr: "earlier related study" },
      ],
      edges: [
        {
          src: "p2",
          dst: "p1",
          rel: "extends",
          rationale: "p1 directly cites p2 and benchmarks against its proposed metric",
        },
      ],
    }),
  );

  // Theme B — degraded: 1 off-topic seed, 1 template rationale, 1 year reversal.
  mkdirSync(join(themesDir, "messy-theme"), { recursive: true });
  writeFileSync(
    join(themesDir, "messy-theme", "lineage.json"),
    JSON.stringify({
      meta: { theme: "Messy Topic" },
      nodes: [
        {
          id: "p3",
          title: "Unrelated work",
          year: 2025,
          is_focus: true,
          tldr: "study of network protocols",
        },
        { id: "p4", title: "Even earlier work", year: 2020, tldr: "..." },
      ],
      edges: [{ src: "p3", dst: "p4", rel: "extends", rationale: EXTENDS_TEMPLATE }],
    }),
  );
});

const FIXED_NOW = new Date("2026-06-04T00:00:00Z");

describe("computeQuality", () => {
  it("emits clean signals for the clean theme", () => {
    const rollup = computeQuality({ themesDir, now: FIXED_NOW });
    const clean = rollup.themes["clean-theme"]!;
    expect(clean.theme).toBe("Clean Theme");
    expect(clean.node_count).toBe(2);
    expect(clean.focus_count).toBe(1);
    expect(clean.off_topic_focus).toBe(0);
    expect(clean.edge_count).toBe(1);
    expect(clean.template_count).toBe(0);
    expect(clean.template_ratio).toBe(0.0);
    expect(clean.popularity_sinks).toBe(0);
    expect(clean.year_reversals).toBe(0);
  });

  it("flags off-topic and template signals for the messy theme", () => {
    const rollup = computeQuality({ themesDir, now: FIXED_NOW });
    const messy = rollup.themes["messy-theme"]!;
    expect(messy.off_topic_focus).toBe(1);
    expect(messy.template_count).toBe(1);
    expect(messy.template_ratio).toBe(1.0);
    expect(messy.year_reversals).toBe(1);
  });

  it("rolls up summary counts for high-template and off-topic themes", () => {
    const rollup = computeQuality({ themesDir, now: FIXED_NOW });
    expect(rollup.summary).toEqual({
      theme_count: 2,
      total_nodes: 4,
      total_edges: 2,
      total_off_topic_focus: 1,
      themes_with_template_rationale_high: 1,
      themes_with_off_topic_seeds: 1,
    });
  });

  it("silently skips a half-built theme dir with no lineage.json", () => {
    const empty = mkdtempSync(join(tmpdir(), "theme-quality-empty-"));
    mkdirSync(join(empty, "half-built"), { recursive: true });
    const rollup = computeQuality({ themesDir: empty, now: FIXED_NOW });
    expect(rollup.themes).toEqual({});
    expect(rollup.summary.theme_count).toBe(0);
  });
});

describe("writeThemeQuality", () => {
  it("writes the file and reports both themes", () => {
    const out = writeThemeQuality({ themesDir, now: FIXED_NOW });
    const written = JSON.parse(readFileSync(out, "utf-8"));
    expect(new Set(Object.keys(written.themes))).toEqual(new Set(["clean-theme", "messy-theme"]));
  });

  it("serializes an integer-valued template_ratio with a decimal point, matching Python's float(...)", () => {
    const out = writeThemeQuality({ themesDir, now: FIXED_NOW });
    const raw = readFileSync(out, "utf-8");
    expect(raw).toContain('"template_ratio": 0.0');
    expect(raw).toContain('"template_ratio": 1.0');
  });
});
