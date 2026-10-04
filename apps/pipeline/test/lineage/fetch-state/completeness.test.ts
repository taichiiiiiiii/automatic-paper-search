/**
 * Vitest port of the `_fetch_state.py` contract tests that exercise the
 * module directly (not through a concrete builder): the `expansion_gate_*`
 * cases of `paperpilot/tests/test_build_lineage.py`, plus direct unit
 * tests of `BuildCompleteness`'s documented behaviour (LIN-01..04).
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BuildCompleteness,
  expansionGateBlocks,
  focusIds,
  publishedGraphSize,
} from "../../../src/lineage/fetch-state/completeness.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fetch-state-"));
});
afterEach(() => {
  // best-effort; OS temp cleanup is acceptable for a test run
});

function write(name: string, payload: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, typeof payload === "string" ? payload : JSON.stringify(payload));
  return path;
}

describe("BuildCompleteness", () => {
  it("starts complete with nothing recorded", () => {
    const c = new BuildCompleteness();
    expect(c.subjectComplete).toBe(true);
    expect(c.expansionComplete).toBe(true);
    expect(c.complete).toBe(true);
    expect(c.lossSummary()).toBe("");
  });

  it("subjectFailed makes subjectComplete false but does not affect complete", () => {
    const c = new BuildCompleteness();
    c.subjectFailed("boom");
    expect(c.subjectComplete).toBe(false);
    // subject failures are a separate, harder gate (LIN-01); `complete`
    // only reflects expansion/supplement loss (LIN-02/04).
    expect(c.complete).toBe(true);
  });

  it("expansionFailed makes expansionComplete and complete false", () => {
    const c = new BuildCompleteness();
    c.expansionAttempted();
    c.expansionFailed("boom");
    expect(c.expansionComplete).toBe(false);
    expect(c.complete).toBe(false);
    expect(c.lossSummary()).toBe("1 of 1 expansion(s) failed");
  });

  it("supplementFailed makes complete false without touching expansionComplete", () => {
    const c = new BuildCompleteness();
    c.supplementFailed("alias outage");
    expect(c.expansionComplete).toBe(true);
    expect(c.complete).toBe(false);
    expect(c.lossSummary()).toBe("1 supplementary source request(s) failed");
  });

  it("lossSummary joins both kinds of loss with 'and'", () => {
    const c = new BuildCompleteness();
    c.expansionAttempted();
    c.expansionFailed();
    c.supplementFailed("alias outage");
    expect(c.lossSummary()).toBe(
      "1 of 1 expansion(s) failed and 1 supplementary source request(s) failed",
    );
  });

  it("asMeta derives complete from the counters, never independently", () => {
    const c = new BuildCompleteness();
    c.expansionAttempted();
    c.expansionFailed();
    expect(c.asMeta()).toEqual({
      complete: false,
      expansions_attempted: 1,
      expansions_failed: 1,
      supplement_failures: [],
    });
  });

  it("subjectGateMessage shows up to 5 failures and counts the rest", () => {
    const c = new BuildCompleteness();
    for (let i = 0; i < 7; i++) c.subjectFailed(`reason ${i}`);
    const msg = c.subjectGateMessage();
    expect(msg).toContain("subject resolution incomplete: 7 request(s)");
    expect(msg).toContain("reason 0");
    expect(msg).toContain("reason 4");
    expect(msg).not.toContain("reason 5");
    expect(msg).toContain("... and 2 more");
  });
});

describe("focusIds", () => {
  it("collects only string ids of is_focus===true nodes", () => {
    const nodes = [
      { id: "a", is_focus: true },
      { id: "b", is_focus: false },
      { id: 123, is_focus: true },
      { is_focus: true },
      "not-an-object",
    ];
    expect(focusIds(nodes)).toEqual(new Set(["a"]));
  });
});

describe("publishedGraphSize", () => {
  it("returns null when nothing is published", () => {
    expect(publishedGraphSize(join(dir, "does-not-exist.json"))).toBeNull();
  });

  it("returns [nodes, edges] counts for a well-formed artifact", () => {
    const path = write("lineage.json", { nodes: [{ id: "a" }, { id: "b" }], edges: [] });
    expect(publishedGraphSize(path)).toEqual([2, 0]);
  });

  it("throws on invalid JSON", () => {
    const path = write("lineage.json", '{"nodes": [{"id": "a"');
    expect(() => publishedGraphSize(path)).toThrow();
  });

  it.each([
    ["no-edges-key", { nodes: [] }],
    ["no-nodes-key", { edges: [] }],
    ["non-array-edges", { nodes: [], edges: "x" }],
    ["neither", { meta: {} }],
  ])("throws when the artifact is missing either array (%s)", (_label, payload) => {
    const path = write("lineage.json", payload);
    expect(() => publishedGraphSize(path)).toThrow();
  });
});

describe("expansionGateBlocks", () => {
  it("blocks a smaller result after a failure, but allows the same tiny result when nothing failed, and allows a non-regressing result despite failures", () => {
    const published = write("lineage.json", {
      nodes: Array.from({ length: 300 }, (_, i) => ({ id: `n${i}` })),
      edges: [],
    });

    const failed = new BuildCompleteness({ expansionsAttempted: 10, expansionsFailed: 9 });
    expect(
      expansionGateBlocks(failed, { newNodeCount: 2, newEdgeCount: 0, publishedPath: published }),
    ).toBeTruthy();

    const clean = new BuildCompleteness({ expansionsAttempted: 10, expansionsFailed: 0 });
    expect(
      expansionGateBlocks(clean, { newNodeCount: 2, newEdgeCount: 0, publishedPath: published }),
    ).toBeNull();

    expect(
      expansionGateBlocks(failed, {
        newNodeCount: 300,
        newEdgeCount: 99,
        publishedPath: published,
      }),
    ).toBeNull();
  });

  it.each([
    ["no-edges-key", { nodes: [] }],
    ["no-nodes-key", { edges: [] }],
    ["non-array-edges", { nodes: [], edges: "x" }],
    ["neither", { meta: {} }],
  ])("refuses a published artifact missing either array (%s)", (_label, payload) => {
    const published = write("lineage.json", payload);
    const failed = new BuildCompleteness({ expansionsAttempted: 4, expansionsFailed: 1 });
    expect(
      expansionGateBlocks(failed, { newNodeCount: 1, newEdgeCount: 1, publishedPath: published }),
    ).toBeTruthy();
  });

  it("allows a first build (nothing published yet)", () => {
    const failed = new BuildCompleteness({ expansionsAttempted: 5, expansionsFailed: 5 });
    const missing = join(dir, "does-not-exist.json");
    expect(
      expansionGateBlocks(failed, { newNodeCount: 1, newEdgeCount: 0, publishedPath: missing }),
    ).toBeNull();
  });

  it("refuses when the published artifact is unreadable, but a clean build still refuses too (gate-reads-first, see LIN-03)", () => {
    const corrupt = write("lineage.json", '{"nodes": [{"id": "a"');
    const failed = new BuildCompleteness({ expansionsAttempted: 3, expansionsFailed: 1 });
    expect(
      expansionGateBlocks(failed, { newNodeCount: 1, newEdgeCount: 0, publishedPath: corrupt }),
    ).toBeTruthy();

    const noNodes = write("other.json", { meta: {} });
    expect(
      expansionGateBlocks(failed, { newNodeCount: 1, newEdgeCount: 0, publishedPath: noNodes }),
    ).toBeTruthy();

    // A CLEAN build (nothing failed) short-circuits before even reading
    // the published file, so an unreadable artifact does not block it.
    const clean = new BuildCompleteness();
    expect(
      expansionGateBlocks(clean, { newNodeCount: 1, newEdgeCount: 0, publishedPath: corrupt }),
    ).toBeNull();
  });

  it("blocks an edge-only regression (node count unchanged, edges shrink)", () => {
    const published = write("lineage.json", {
      nodes: Array.from({ length: 10 }, (_, i) => ({ id: `n${i}` })),
      edges: Array.from({ length: 20 }, () => ({ src: "a", dst: "b" })),
    });
    const failed = new BuildCompleteness({ expansionsAttempted: 10, expansionsFailed: 3 });
    expect(
      expansionGateBlocks(failed, { newNodeCount: 10, newEdgeCount: 5, publishedPath: published }),
    ).toBeTruthy();
    expect(
      expansionGateBlocks(failed, {
        newNodeCount: 10,
        newEdgeCount: 20,
        publishedPath: published,
      }),
    ).toBeNull();
  });

  it("with newNodes/newEdges given, blocks a same-size focus swap (identity comparison, not totals)", () => {
    const published = write("lineage.json", {
      nodes: [{ id: "focus-a", is_focus: true }, { id: "n1" }],
      edges: [{ src: "focus-a", dst: "n1" }],
    });
    const failed = new BuildCompleteness({ expansionsAttempted: 1, expansionsFailed: 1 });
    const newNodes = [{ id: "focus-b", is_focus: true }, { id: "n1" }];
    const newEdges = [{ src: "focus-b", dst: "n1" }];
    expect(
      expansionGateBlocks(failed, {
        newNodeCount: newNodes.length,
        newEdgeCount: newEdges.length,
        publishedPath: published,
        newNodes,
        newEdges,
      }),
    ).toBeTruthy();
  });
});
