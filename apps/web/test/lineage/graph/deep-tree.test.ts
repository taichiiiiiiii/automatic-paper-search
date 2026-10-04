/**
 * Parity test: lib/lineage/layout/deep-tree.ts `layoutDeepTree` must
 * produce byte-identical `_x`/`_y` coordinates to docs/assets/deep.js's
 * own `layoutTree`, for the same (nodes, edges, focusId) input. The
 * original runs under node:vm (./oracle.ts's `loadDeepOracle`) so this
 * test fails the moment the port and the shipped JS diverge.
 *
 * Input: a real docs/iclr-2026/deep-*.json (the raw build_deep_lineage.py
 * output -- no `schema_version`/`clusters`, so it is NOT routed through
 * lib/lineage/core.ts's `parseArtifact`; all 14 published deep rows are
 * quality-gate-ineligible today, so none would pass that contract
 * anyway). Its `rel`/`conf` edge fields are renamed to the
 * `relation`/`confidence` shape both `layoutTree` implementations
 * actually read, same as test/lineage/graph/tree.test.ts does for the
 * conference artifact.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { LineageEdge, LineageNode } from "../../../lib/lineage/core";
import { layoutDeepTree } from "../../../lib/lineage/layout/deep-tree";
import { loadDeepOracle } from "./oracle";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "..", "..", "..", "..", "..");

interface RawDeepJson {
  root: string;
  nodes: LineageNode[];
  edges: { src: string; dst: string; rel: string; conf: number; rationale: string }[];
}

const raw: RawDeepJson = JSON.parse(
  readFileSync(resolve(REPO_ROOT, "docs/iclr-2026/deep-1706.03762.json"), "utf8"),
);

const nodes: LineageNode[] = raw.nodes;
const edges: LineageEdge[] = raw.edges.map((e) => ({
  src: e.src,
  dst: e.dst,
  relation: e.rel as LineageEdge["relation"],
  confidence: e.conf,
  rationale: e.rationale,
  provenance: {} as LineageEdge["provenance"],
}));

const connected = new Set<string>();
for (const e of edges) {
  connected.add(e.src);
  connected.add(e.dst);
}
const isolatedNode = nodes.find((n) => !connected.has(n.id));

const oracle = loadDeepOracle();

describe("deep-tree.ts constants match docs/assets/deep.js", () => {
  it("240×180 cards, 100px level gap, 32px sibling gap, 48px padding -- NOT lineage.js's values", () => {
    expect({
      NODE_W: 240,
      NODE_H: 180,
      LEVEL_GAP: 100,
      SIBLING_GAP: 32,
      PADDING: 48,
    }).toEqual({
      NODE_W: oracle.NODE_W,
      NODE_H: oracle.NODE_H,
      LEVEL_GAP: oracle.LEVEL_GAP,
      SIBLING_GAP: oracle.SIBLING_GAP,
      PADDING: oracle.PADDING,
    });
  });

  it("deep.js has no MAX_DEPTH -- the oracle module exposes no such binding", () => {
    expect((oracle as unknown as { MAX_DEPTH?: unknown }).MAX_DEPTH).toBeUndefined();
  });
});

describe("layoutDeepTree matches docs/assets/deep.js layoutTree", () => {
  const focusIds: (string | null)[] = [
    raw.root,
    ...edges.slice(0, 3).flatMap((e) => [e.src, e.dst]),
    isolatedNode?.id ?? nodes[nodes.length - 1]?.id ?? raw.root,
    "this-id-does-not-exist-in-the-artifact",
    null,
  ];

  for (const focusId of [...new Set(focusIds)]) {
    it(`produces identical positions for focus=${focusId ?? "null"}`, () => {
      const expected = oracle.layoutTree(nodes, edges, focusId);
      const actual = layoutDeepTree(nodes, edges, focusId);
      expect(actual).toEqual(expected);
    });
  }

  it("includes nodes reachable only through a baseline_only/contrasts edge (deep.js walks all six relations)", () => {
    const comparisonOnly = edges.filter(
      (e) => e.relation === "baseline_only" || e.relation === "contrasts",
    );
    expect(comparisonOnly.length).toBeGreaterThan(0);
    const actual = layoutDeepTree(nodes, edges, raw.root);
    const positionedIds = new Set(actual.map((n) => n.id));
    for (const e of comparisonOnly) {
      // At least one endpoint of every comparison edge must be
      // reachable from the root once comparison edges are walked too
      // (both endpoints are, since BFS walks them in both directions).
      expect(positionedIds.has(e.src) || positionedIds.has(e.dst)).toBe(true);
    }
  });

  it("is unbounded depth: every node in this depth-2 fixture is positioned from the root (sanity bound so this cannot pass vacuously)", () => {
    const actual = layoutDeepTree(nodes, edges, raw.root);
    expect(actual.length).toBe(nodes.length);
  });
});
