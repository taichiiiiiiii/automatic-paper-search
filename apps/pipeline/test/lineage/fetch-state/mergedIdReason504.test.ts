/**
 * #504 (owner decision 2026-11-12, option 2): when a known-incomplete
 * rebuild is refused because published nodes are missing, the reason
 * counts separately the missing nodes whose DOI or arXiv id reappears
 * on a NEW node under a different id — OpenAlex merged the Work, so
 * only the id changed. The gate itself is unchanged: such a build is
 * still refused (no id remapping, no relaxation of LIN-02).
 *
 * Identity matching uses stable ids only (absolute rule 17: never a
 * title alone); a stable-id match whose titles disagree strongly is
 * reported as its own suspicious bucket, not as a likely merge.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  BuildCompleteness,
  expansionGateBlocks,
  mergedIdMatches,
} from "../../../src/lineage/fetch-state/completeness.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "merged-id-504-"));
});

type Node = Record<string, unknown>;

function node(id: string, title: string, extra: Node = {}): Node {
  return { id, title, ...extra };
}

function incomplete(): BuildCompleteness {
  const c = new BuildCompleteness();
  c.expansionAttempted();
  c.expansionFailed("s2 429");
  return c;
}

function gate(
  published: { nodes: Node[]; edges: Node[] },
  newNodes: Node[],
  newEdges: Node[],
  completeness: BuildCompleteness = incomplete(),
): string | null {
  const path = join(dir, "lineage.json");
  writeFileSync(path, JSON.stringify(published));
  return expansionGateBlocks(completeness, {
    newNodeCount: newNodes.length,
    newEdgeCount: newEdges.length,
    publishedPath: path,
    newNodes,
    newEdges,
  });
}

const KEEP = node("openalex:W9", "Prefix-Tuning: Optimizing Continuous Prompts for Generation", {
  doi: "10.18653/v1/2021.acl-long.353",
});
const TITLE = "The Power of Scale for Parameter-Efficient Prompt Tuning";

describe("#504 merged-id breakdown in the expansion gate reason", () => {
  it("(a) a missing node whose DOI reappears under a new id is counted as a likely OpenAlex merge", () => {
    const old = node("openalex:W1", TITLE, {
      doi: "https://doi.org/10.18653/V1/2021.EMNLP-MAIN.243",
    });
    const merged = node("openalex:W2", TITLE, { doi: "10.18653/v1/2021.emnlp-main.243" });
    const reason = gate(
      { nodes: [KEEP, old], edges: [{ src: "openalex:W1", dst: "openalex:W9" }] },
      [KEEP, merged],
      [{ src: "openalex:W2", dst: "openalex:W9" }],
    );
    expect(reason).not.toBeNull();
    expect(reason).toContain("1 published node(s) missing from the result");
    expect(reason).toContain(
      "1 of them share a DOI/arXiv id with a new node (likely an OpenAlex merge: openalex:W1 -> openalex:W2)",
    );
    // (f) the edge lost with the old id reappears once its endpoint is rewritten
    expect(reason).toContain("1 of 1 missing published edge(s) reappear");
  });

  it("(a') a focus paper whose id changed by a merge gets the same breakdown in the focus reason", () => {
    const old = node("openalex:W1", TITLE, { is_focus: true, aliases: [["arxiv", "2104.08691"]] });
    const merged = node("openalex:W2", TITLE, {
      is_focus: true,
      aliases: [["arxiv", "2104.08691v2"]],
    });
    const reason = gate({ nodes: [KEEP, old], edges: [] }, [KEEP, merged], []);
    expect(reason).not.toBeNull();
    expect(reason).toContain("1 published focus paper(s) missing from the result");
    expect(reason).toContain("likely an OpenAlex merge: openalex:W1 -> openalex:W2");
  });

  it("(b) an arXiv alias match alone (no DOI on either side) counts as a likely merge", () => {
    const old = node("openalex:W1", TITLE, { aliases: [["arxiv", "arXiv:2104.08691"]] });
    const merged = node("openalex:W2", TITLE, { arxiv_id: "2104.08691" });
    const reason = gate({ nodes: [KEEP, old], edges: [] }, [KEEP, merged], []);
    expect(reason).toContain("likely an OpenAlex merge: openalex:W1 -> openalex:W2");
  });

  it("(c) a title-only match is never counted as a merge (absolute rule 17)", () => {
    const old = node("openalex:W1", TITLE, { doi: "10.1/aaa" });
    const sameTitle = node("openalex:W2", TITLE, { doi: "10.1/bbb" });
    const reason = gate({ nodes: [KEEP, old], edges: [] }, [KEEP, sameTitle], []);
    expect(reason).not.toBeNull();
    expect(reason).toContain("1 published node(s) missing from the result (openalex:W1)");
    expect(reason).not.toContain("share a DOI/arXiv id");
    expect(reason).not.toContain("OpenAlex merge");
  });

  it("(d) the build is still refused when every missing node is a likely merge (gate unchanged)", () => {
    const olds = [1, 2, 3, 4].map((i) =>
      node(`openalex:W${i}`, `${TITLE} part ${i}`, { doi: `10.1/x${i}` }),
    );
    const merged = [1, 2, 3, 4].map((i) =>
      node(`openalex:W${i}0`, `${TITLE} part ${i}`, { doi: `10.1/X${i}` }),
    );
    const reason = gate({ nodes: [KEEP, ...olds], edges: [] }, [KEEP, ...merged], []);
    expect(reason).not.toBeNull();
    expect(reason).toContain("4 published node(s) missing from the result");
    expect(reason).toContain("4 of them share a DOI/arXiv id with a new node");
    // only the first three pairs are listed
    expect(reason).toContain(
      "openalex:W1 -> openalex:W10, openalex:W2 -> openalex:W20, openalex:W3 -> openalex:W30, ...",
    );
    expect(reason).toContain("Refusing to replace published content");
  });

  it("(e) a complete fetch still publishes (null) even when ids changed", () => {
    const old = node("openalex:W1", TITLE, { doi: "10.1/x" });
    const merged = node("openalex:W2", TITLE, { doi: "10.1/x" });
    const reason = gate(
      { nodes: [KEEP, old], edges: [] },
      [KEEP, merged],
      [],
      new BuildCompleteness(),
    );
    expect(reason).toBeNull();
  });

  it("(g) a stable-id match whose titles disagree strongly is counted separately, not as a likely merge", () => {
    const old = node(
      "openalex:W1",
      "Parameter-Efficient Transfer Learning for Natural Language Processing",
      {
        doi: "10.1/conf",
      },
    );
    const other = node(
      "openalex:W2",
      "Graph Convolutional Networks for Molecular Property Prediction",
      {
        doi: "10.1/conf",
      },
    );
    const reason = gate({ nodes: [KEEP, old], edges: [] }, [KEEP, other], []);
    expect(reason).not.toBeNull();
    expect(reason).not.toContain("likely an OpenAlex merge");
    expect(reason).toContain(
      "1 share a DOI/arXiv id but the titles disagree (openalex:W1 -> openalex:W2)",
    );
  });

  it("with no stable-id match the reason is byte-identical to the pre-#504 text", () => {
    const old = node("openalex:W1", TITLE, { doi: "10.1/aaa" });
    const reason = gate({ nodes: [KEEP, old], edges: [] }, [KEEP], []);
    expect(reason).toBe(
      "1 of 1 expansion(s) failed and 1 published node(s) missing from the result (openalex:W1). " +
        "Refusing to replace published content on a known-incomplete fetch; re-run when the " +
        "upstream recovers, or pass --allow-incomplete.",
    );
  });

  it("an edge-only loss carries no merged-id text", () => {
    const a = node("openalex:W1", TITLE, { doi: "10.1/x" });
    const reason = gate(
      { nodes: [KEEP, a], edges: [{ src: "openalex:W1", dst: "openalex:W9" }] },
      [KEEP, a],
      [],
    );
    expect(reason).toContain("1 published edge(s) missing from the result");
    expect(reason).not.toContain("share a DOI/arXiv id");
  });
});

describe("mergedIdMatches", () => {
  it("normalises DOI prefixes/case and arXiv prefixes/versions, and ignores ids still present", () => {
    const published = [
      node("openalex:W1", TITLE, { doi: "DOI: 10.1/ABC" }),
      node("openalex:W3", TITLE, { aliases: [["arxiv", "https://arxiv.org/abs/2104.08691v3"]] }),
      node("openalex:W5", TITLE, { doi: "10.1/zzz" }),
    ];
    const next = [
      node("openalex:W2", TITLE, { aliases: [["doi", "doi.org/10.1/abc"]] }),
      node("openalex:W4", TITLE, { arxiv_id: "2104.08691" }),
    ];
    const m = mergedIdMatches(
      published,
      next,
      new Set(["openalex:W1", "openalex:W3", "openalex:W5"]),
    );
    expect(m.likelyMerges).toEqual([
      ["openalex:W1", "openalex:W2"],
      ["openalex:W3", "openalex:W4"],
    ]);
    expect(m.titleMismatches).toEqual([]);
  });
});
