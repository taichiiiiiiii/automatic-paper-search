/**
 * R2-13: explicit versions of one work and seed-to-seed citations.
 *
 * Flash Attention run 38041334727 published FlashAttention 1/2/3 with no
 * edge between them: OpenAlex has no `referenced_works` for any of the
 * three arXiv records, the cross-node pass only read OpenAlex reference
 * lists, and Semantic Scholar was never asked. These tests pin:
 *  - the cross-node pass consults the citing paper's S2 reference list
 *    when OpenAlex has none (seed-to-seed pairs included);
 *  - version increments are `title_version` supersedes even when the
 *    cited paper is on the foundational allowlist / S2 has intents;
 *  - a foundational cited paper with S2 citation sentences is classified
 *    from those sentences, not by the allowlist;
 *  - `addVersionFamilyEdges` chains explicit versions without citation
 *    data (nearest predecessor only, years non-decreasing).
 * Fake fetch only.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FetchInit, HttpResponseLike } from "../../../src/collect/http/requestWithRetry.js";
import {
  foundationalAncestorEdge,
  TITLE_VERSION_UNCITED_CONFIDENCE,
  titleVersionOf,
} from "../../../src/lineage/classify/classify.js";
import type { FetchRelatedDeps } from "../../../src/lineage/shared/fetchRelated.js";
import type { ThemeGraphNode } from "../../../src/lineage/shared/node.js";
import { addCrossNodeEdges, addVersionFamilyEdges } from "../../../src/lineage/theme/bfs.js";
import type { ThemeEdge } from "../../../src/lineage/theme/edges.js";
import { S2CitationSource } from "../../../src/lineage/theme/s2Citations.js";
import { newS2RelationStats } from "../../../src/lineage/theme/s2Relations.js";

function jsonResp(status: number, body: unknown): HttpResponseLike {
  return { status, json: async () => body };
}

function node(id: string, title: string, year: number, arxiv?: string): ThemeGraphNode {
  return {
    id,
    title,
    year,
    venue: "arXiv",
    venue_tier: "preprint",
    authors: ["Tri Dao"],
    kinds: [],
    citation_count: 100,
    github_stars: 0,
    tldr: "",
    ...(arxiv ? { arxiv_id: arxiv } : {}),
  } as ThemeGraphNode;
}

const FA1 = node(
  "WFA1",
  "FlashAttention: Fast and Memory-Efficient Exact Attention with IO-Awareness",
  2022,
  "2205.14135",
);
const FA2 = node(
  "WFA2",
  "FlashAttention-2: Faster Attention with Better Parallelism and Work Partitioning",
  2023,
  "2307.08691",
);
const FA3 = node(
  "WFA3",
  "FlashAttention-3: Fast and Accurate Attention with Asynchrony and Low-precision",
  2024,
  "2407.08608",
);
const VIT = node(
  "WVIT",
  "EfficientViT: Memory Efficient Vision Transformer with Cascaded Group Attention",
  2023,
  "2305.07027",
);

function s2Ref(cited: ThemeGraphNode, contexts: string[], intents: string[] = []) {
  return {
    contexts,
    intents,
    isInfluential: intents.includes("methodology"),
    citedPaper: {
      paperId: null,
      title: cited.title,
      externalIds: { ArXiv: (cited as Record<string, unknown>).arxiv_id },
    },
  };
}

/** S2 `/references` of each FlashAttention paper (contexts from the real
 * S2 records, shortened). */
const S2_REFS: Record<string, unknown[]> = {
  "2205.14135": [],
  "2307.08691": [
    s2Ref(
      FA1,
      [
        "FlashAttention [5] exploits the asymmetric GPU memory hierarchy to bring significant memory saving.",
      ],
      ["methodology", "background"],
    ),
  ],
  "2407.08608": [
    s2Ref(FA1, [
      "In this work, we build on the work of Dao et al. [16] on developing exact-attention algorithms.",
    ]),
    s2Ref(FA2, ["Dao [14] restructured the algorithm as FlashAttention-2 to also parallelize."]),
  ],
  "2305.07027": [
    s2Ref(
      FA1,
      ["Memory access overhead is a critical factor affecting model speed [15,28,31,65]."],
      ["background"],
    ),
  ],
};

function s2Source(): { source: S2CitationSource; urls: string[] } {
  const urls: string[] = [];
  const source = new S2CitationSource(null, {
    fetchImpl: async (url: string, _init: FetchInit) => {
      urls.push(url);
      const m = /paper\/ARXIV:([0-9.]+)\/references/.exec(url);
      if (m && S2_REFS[m[1] as string]) return jsonResp(200, { data: S2_REFS[m[1] as string] });
      return jsonResp(404, null);
    },
    sleep: async () => {},
  });
  return { source, urls };
}

/** "OpenAlex" reference lists: empty for the three FlashAttention records
 * (as in reality), EfficientViT's lists FlashAttention. */
function depsFor(openalexRefs: Record<string, unknown[]>): FetchRelatedDeps {
  return {
    fetchImpl: async (url: string) => {
      const m = /paper\/([^/]+)\/references/.exec(url);
      const data = (m && openalexRefs[m[1] as string]) || [];
      return jsonResp(200, { data });
    },
    cacheDir: mkdtempSync(join(tmpdir(), "r2-13-cache-")),
    sleep: async () => {},
    logger: { warn: () => {} },
  } as FetchRelatedDeps;
}

function methodOf(e: ThemeEdge): string {
  return (e.provenance as { classification: { method: string } }).classification.method;
}

describe("cross-node pass with S2 reference lists (R2-13)", () => {
  it("links the three FlashAttention seeds although OpenAlex has no references for them", async () => {
    const nodes = new Map([FA1, FA2, FA3].map((n) => [n.id, n]));
    const edges: ThemeEdge[] = [];
    const { source } = s2Source();
    const added = await addCrossNodeEdges(
      nodes,
      edges,
      {
        seedIds: new Set(nodes.keys()),
        provider: null,
        strictMode: "off",
        s2Relations: { source, provider: null, stats: newS2RelationStats() },
      },
      depsFor({}),
    );
    const got = edges.map((e) => [e.src, e.dst, e.relation, methodOf(e)]).sort();
    expect(added).toBe(3);
    expect(got).toEqual([
      ["WFA1", "WFA2", "supersedes", "title_version"],
      ["WFA1", "WFA3", "supersedes", "title_version"],
      ["WFA2", "WFA3", "supersedes", "title_version"],
    ]);
    expect(edges[0]?.rationale).toMatch(/バージョンアップ版/);
  });

  it("does not ask S2 without s2Relations (the pre-R2-13 path)", async () => {
    const nodes = new Map([FA1, FA2].map((n) => [n.id, n]));
    const edges: ThemeEdge[] = [];
    const added = await addCrossNodeEdges(
      nodes,
      edges,
      { provider: null, strictMode: "off" },
      depsFor({}),
    );
    expect(added).toBe(0);
  });

  it("classifies a foundational cited paper from S2 citation sentences, not the allowlist", async () => {
    const nodes = new Map([FA1, VIT].map((n) => [n.id, n]));
    const edges: ThemeEdge[] = [];
    const { source } = s2Source();
    const fa1Ref = {
      paperId: "WFA1",
      title: FA1.title,
      year: 2022,
      citationCount: 100,
      abstract: "a".repeat(80),
      externalIds: { ArXiv: "2205.14135" },
    };
    await addCrossNodeEdges(
      nodes,
      edges,
      {
        provider: null,
        strictMode: "off",
        s2Relations: { source, provider: null, stats: newS2RelationStats() },
      },
      depsFor({ WVIT: [{ citedPaper: fa1Ref, isInfluential: null, intents: null }] }),
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ src: "WFA1", dst: "WVIT", relation: "baseline_only" });
    expect(methodOf(edges[0] as ThemeEdge)).toBe("s2_context_rule");
  });

  it("skips newer papers and pairs S2 says are not cited", async () => {
    const nodes = new Map([FA1, VIT].map((n) => [n.id, n]));
    const edges: ThemeEdge[] = [];
    const { source } = s2Source();
    // FA1's S2 list is empty and EfficientViT is newer than FA1 anyway;
    // EfficientViT's OpenAlex list is empty here, so S2 is asked for it.
    await addCrossNodeEdges(
      nodes,
      edges,
      {
        provider: null,
        strictMode: "off",
        s2Relations: { source, provider: null, stats: newS2RelationStats() },
      },
      depsFor({}),
    );
    // VIT -> FA1 only via S2 (EfficientViT cites FlashAttention).
    expect(edges.map((e) => [e.src, e.dst])).toEqual([["WFA1", "WVIT"]]);
    expect(source.stats.citingFetched).toBe(1); // FA1 never fetched: VIT is newer
  });
});

describe("addVersionFamilyEdges (R2-13)", () => {
  it("chains explicit versions with no citation data, nearest predecessor only", () => {
    const nodes = new Map([FA3, FA1, FA2, VIT].map((n) => [n.id, n]));
    const edges: ThemeEdge[] = [];
    expect(addVersionFamilyEdges(nodes, edges)).toBe(2);
    expect(edges.map((e) => [e.src, e.dst, e.relation, methodOf(e), e.confidence])).toEqual([
      ["WFA1", "WFA2", "supersedes", "title_version", TITLE_VERSION_UNCITED_CONFIDENCE],
      ["WFA2", "WFA3", "supersedes", "title_version", TITLE_VERSION_UNCITED_CONFIDENCE],
    ]);
    expect(edges[0]?.rationale).toMatch(/引用データにこの引用は見当たらない/);
  });

  it("falls back to the unnumbered first version when v2 is missing", () => {
    const nodes = new Map([FA1, FA3].map((n) => [n.id, n]));
    const edges: ThemeEdge[] = [];
    addVersionFamilyEdges(nodes, edges);
    expect(edges.map((e) => [e.src, e.dst])).toEqual([["WFA1", "WFA3"]]);
  });

  it("keeps citation-backed edges and adds nothing on top of them", () => {
    const nodes = new Map([FA1, FA2].map((n) => [n.id, n]));
    const existing = { src: "WFA1", dst: "WFA2", relation: "supersedes" } as ThemeEdge;
    const edges: ThemeEdge[] = [existing];
    expect(addVersionFamilyEdges(nodes, edges)).toBe(0);
    expect(edges).toEqual([existing]);
  });

  it("never links when the newer version has an older year, or for non-version names", () => {
    const nodes = new Map([
      ["a", node("a", "FlashAttention: X", 2024)],
      ["b", node("b", "FlashAttention-2: Y", 2023)],
      ["c", node("c", "GPT-3: Language Models", 2020)],
      ["d", node("d", "GPT-4 Technical Report", 2023)],
      ["e", node("e", "YOLOv3: An Incremental Improvement", 2018)],
      ["f", node("f", "YOLOv4: Optimal Speed", 2020)],
    ]);
    const edges: ThemeEdge[] = [];
    expect(addVersionFamilyEdges(nodes, edges)).toBe(0);
  });

  it("titleVersionOf splits the family and version", () => {
    expect(titleVersionOf(FA2)).toEqual({ base: "flashattention", version: 2 });
    expect(titleVersionOf(FA1)).toEqual({ base: "flashattention", version: null });
    expect(titleVersionOf({ title: "" })).toBeNull();
  });
});

describe("foundational allowlist rationale (R2-13)", () => {
  it("is Japanese and names both papers", () => {
    const e = foundationalAncestorEdge(FA1, VIT);
    expect(e.provenance).toBe("foundational_allowlist");
    expect(e.relation).toBe("extends");
    expect(e.rationale).toMatch(
      /^「EfficientViT.*」\(2023\) は分野の基礎文献「FlashAttention.*」\(2022\)/,
    );
    expect(e.rationale).not.toMatch(/canonical research-lineage/);
    expect(foundationalAncestorEdge(FA1).rationale).toMatch(/基礎文献リストに基づく規則/);
  });
});
