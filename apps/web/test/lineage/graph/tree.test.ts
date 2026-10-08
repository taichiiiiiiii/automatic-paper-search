/**
 * Parity test: lib/lineage/layout/tree.ts `layoutTree` must produce
 * byte-identical `_x`/`_y` coordinates to docs/assets/lineage.js's own
 * `layoutTree`, for the same (nodes, edges, focusId) input. The
 * original runs under node:vm (see ./oracle.ts) so this test fails
 * the moment the port and the shipped JS diverge, rather than
 * comparing against a fixture that could go stale.
 *
 * Input: the real docs/iclr-2026/lineage.json (the one published
 * conference artifact with graph-worthy structure), with its `rel`
 * field renamed to `relation` (the shape both `layoutTree`
 * implementations actually read) and `unrelated` edges dropped
 * (excluded before publication in the real pipeline -- see CLAUDE.md
 * "`unrelated` はエッジから除外" -- and not a member of the `Relation`
 * union the TS port's edges are typed against).
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { layoutFor } from "@paperpilot/core/layout";
import { describe, expect, it } from "vitest";
import type { LineageEdge, LineageNode } from "../../../lib/lineage/core";
import { layoutTree } from "../../../lib/lineage/layout/tree";
import { loadLineageOracle } from "./oracle";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "..", "..", "..", "..", "..");

interface RawLineageJson {
  root: string;
  nodes: LineageNode[];
  edges: { src: string; dst: string; rel: string; conf: number; rationale: string }[];
}

const raw: RawLineageJson = JSON.parse(
  readFileSync(join(layoutFor(REPO_ROOT).published, "iclr-2026", "lineage.json"), "utf8"),
);

const nodes: LineageNode[] = raw.nodes;
const edges: LineageEdge[] = raw.edges
  .filter((e) => e.rel !== "unrelated")
  .map((e) => ({
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

const oracle = loadLineageOracle();

const focusIds: (string | null)[] = [
  raw.root,
  ...edges.slice(0, 3).flatMap((e) => [e.src, e.dst]),
  isolatedNode?.id ?? nodes[nodes.length - 1]?.id ?? raw.root,
  "this-id-does-not-exist-in-the-artifact",
  null,
];

describe("layoutTree matches docs/assets/lineage.js layoutTree", () => {
  for (const focusId of [...new Set(focusIds)]) {
    it(`produces identical positions for focus=${focusId ?? "null"}`, () => {
      const expected = oracle.layoutTree(nodes, edges, focusId);
      const actual = layoutTree(nodes, edges, focusId);
      expect(actual).toEqual(expected);
    });
  }

  it("agrees on a non-trivial number of positioned nodes for the real root", () => {
    const actual = layoutTree(nodes, edges, raw.root);
    // Sanity bound so this test cannot pass vacuously (e.g. both sides
    // silently returning `[]`) -- MAX_DEPTH=3 each direction over a
    // 158-node / 63-edge graph should surface more than just the root.
    expect(actual.length).toBeGreaterThan(5);
  });
});
