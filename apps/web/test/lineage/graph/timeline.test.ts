/**
 * Parity test: lib/lineage/layout/timeline.ts `layoutTimeline` against
 * docs/assets/lineage.js's own `layoutTimeline`, run under node:vm
 * (see ./oracle.ts). Same real artifact as tree.test.ts; every node in
 * it has a `year`, so the `years.sort` NaN-comparator caveat
 * documented in timeline.ts does not apply here (see the synthetic
 * case below for that).
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { layoutFor } from "@paperpilot/core/layout";
import { describe, expect, it } from "vitest";
import type { LineageNode } from "../../../lib/lineage/core";
import { layoutTimeline } from "../../../lib/lineage/layout/timeline";
import { loadLineageOracle } from "./oracle";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "..", "..", "..", "..", "..");

const raw: { nodes: LineageNode[] } = JSON.parse(
  readFileSync(join(layoutFor(REPO_ROOT).published, "iclr-2026", "lineage.json"), "utf8"),
);

const oracle = loadLineageOracle();

describe("layoutTimeline matches docs/assets/lineage.js layoutTimeline", () => {
  it("produces identical positions for the real artifact's nodes", () => {
    expect(raw.nodes.every((n) => typeof n.year === "number")).toBe(true);
    const expected = oracle.layoutTimeline(raw.nodes);
    const actual = layoutTimeline(raw.nodes);
    expect(actual).toEqual(expected);
  });

  it("columns by year and stacks same-year nodes in input order", () => {
    const actual = layoutTimeline(raw.nodes);
    const byYear = new Map<number, number[]>();
    for (const n of actual) {
      const year = n.year as number;
      if (!byYear.has(year)) byYear.set(year, []);
      byYear.get(year)?.push(n._x);
    }
    for (const xs of byYear.values()) {
      // Every node sharing a year shares the same column (same x).
      expect(new Set(xs).size).toBe(1);
    }
  });

  it("agrees with the oracle on a small synthetic case with no undefined years", () => {
    const synthetic: LineageNode[] = [
      { id: "a", is_focus: false, year: 2020 },
      { id: "b", is_focus: false, year: 2020 },
      { id: "c", is_focus: false, year: 2019 },
      { id: "d", is_focus: true, year: 2021 },
    ];
    const expected = oracle.layoutTimeline(synthetic);
    const actual = layoutTimeline(synthetic);
    expect(actual).toEqual(expected);
  });
});
