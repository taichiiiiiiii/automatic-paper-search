/**
 * #506: two records of one work in the SAME fetched list (neither in the
 * graph yet) used to both become nodes, because the BFS fold only looked
 * at nodes already in (or pending for) the graph and new candidates were
 * registered after the whole list was gated (NeRF: "Baking Neural
 * Radiance Fields…" twice, GRF preprint + venue version). The same
 * TitleIdentity rules now apply inside one list; a record the gate
 * rejects never absorbs a later one.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { FetchInit, HttpResponseLike } from "../../../src/collect/http/requestWithRetry.js";
import type { FetchRelatedDeps } from "../../../src/lineage/shared/fetchRelated.js";
import { runBfsAndDescendants } from "../../../src/lineage/theme/bfs.js";
import type { ThemePaper } from "../../../src/lineage/theme/openalexWork.js";
import { TopicScope } from "../../../src/lineage/theme/topicScope.js";

function paper(
  pid: string,
  title: string,
  year: number,
  extra: Partial<ThemePaper> = {},
): ThemePaper {
  return {
    paperId: pid,
    title,
    year,
    venue: "NeurIPS",
    citationCount: 100,
    abstract: `${"Unrelated filler text. ".repeat(4)}`,
    authors: [],
    externalIds: {},
    ...extra,
  };
}

let cacheDir: string;
beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "bfs-inlist-"));
});

function jsonResp(status: number, body: unknown): HttpResponseLike {
  return { status, json: async () => body };
}

function bfsDeps(
  refs: Record<string, ThemePaper[]>,
  cites: Record<string, ThemePaper[]> = {},
): FetchRelatedDeps {
  const fetchImpl = async (url: string, _init: FetchInit): Promise<HttpResponseLike> => {
    for (const [id, list] of Object.entries(refs)) {
      if (url.includes(`/paper/${id}/references`)) {
        return jsonResp(200, {
          data: list.map((p) => ({ citedPaper: p, isInfluential: true, intents: ["methodology"] })),
        });
      }
    }
    for (const [id, list] of Object.entries(cites)) {
      if (url.includes(`/paper/${id}/citations`)) {
        return jsonResp(200, {
          data: list.map((p) => ({
            citingPaper: p,
            isInfluential: true,
            intents: ["methodology"],
          })),
        });
      }
    }
    if (url.includes("/references") || url.includes("/citations"))
      return jsonResp(200, { data: [] });
    throw new Error(`unexpected ${url}`);
  };
  return { fetchImpl, cacheDir, sleep: async () => {}, logger: { warn: () => {} } };
}

const OPTS = {
  depth: 1,
  width: 8,
  maxSeedCite: 10 ** 9,
  provider: null,
  llmStrict: "off",
  currentYear: 2026,
};

const BAKING = "Baking Neural Radiance Fields for Real-Time View Synthesis";
const team = [{ name: "Costas Mavromatis" }, { name: "George Karypis" }];
const gnnPre = paper(
  "gnnArxiv",
  "GNN-RAG: Graph Neural Retrieval for Large Language Model Reasoning",
  2024,
  { authors: team, externalIds: { ArXiv: "2405.20139" } },
);
const gnnAcl = paper(
  "gnnAcl",
  "GNN-RAG: Graph Neural Retrieval for Efficient Large Language Model Reasoning on Knowledge Graphs",
  2025,
  { authors: team, externalIds: { DOI: "10.18653/v1/2025.findings-acl.856" } },
);

describe("BFS folds duplicates inside one fetched list (#506)", () => {
  it("same title twice in one reference list -> one node", async () => {
    const seed = paper("snerg", "Neural Radiance Fields for Real-Time Rendering", 2022);
    const a = paper("bakeA", BAKING, 2021);
    const b = paper("bakeB", BAKING, 2021);
    const scope = new TopicScope("Neural Radiance Fields", []);
    const result = await runBfsAndDescendants(
      [seed],
      { ...OPTS, topicScope: scope },
      bfsDeps({ snerg: [a, b] }),
    );
    expect([...result.nodes.keys()].sort()).toEqual(["bakeA", "snerg"]);
    expect(result.titleMerged).toBe(1);
    expect(result.edges.map((e) => `${e.src}>${e.dst}`)).toEqual(["bakeA>snerg"]);
  });

  it("preprint and renamed venue version in one citing list -> one node (versioned-title-v1)", async () => {
    const seed = paper(
      "rag",
      "Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks",
      2020,
    );
    const result = await runBfsAndDescendants([seed], OPTS, bfsDeps({}, { rag: [gnnPre, gnnAcl] }));
    expect([...result.nodes.keys()].sort()).toEqual(["gnnArxiv", "rag"]);
    expect(result.versionMerges).toEqual([
      {
        rule: "versioned-title-v1",
        survivor: "gnnArxiv",
        merged: "gnnAcl",
        survivor_title: gnnPre.title,
        merged_title: gnnAcl.title,
      },
    ]);
    expect(result.edges.map((e) => `${e.src}>${e.dst}`)).toEqual(["rag>gnnArxiv"]);
  });

  it("a record the gate rejects does not absorb the later admitted one", async () => {
    // Only the venue title names the theme, so the descendant gate rejects
    // the preprint and admits the venue version, under its own ID.
    const seed = paper(
      "rag",
      "Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks",
      2020,
    );
    const scope = new TopicScope("Knowledge Graphs", []);
    const result = await runBfsAndDescendants(
      [seed],
      { ...OPTS, topicScope: scope },
      bfsDeps({}, { rag: [gnnPre, gnnAcl] }),
    );
    expect([...result.nodes.keys()].sort()).toEqual(["gnnAcl", "rag"]);
    expect(result.versionMerges).toEqual([]);
    expect(result.titleMerged).toBe(0);
  });

  it("reference path: a record parked in pending by the gate does not absorb the later one", async () => {
    // The seed is on topic, so the gate parks the rejected preprint in
    // `pending`; the venue version must still be gated under its own ID.
    const seed = paper("kgseed", "Reasoning over Knowledge Graphs with Language Models", 2025);
    const scope = new TopicScope("Knowledge Graphs", []);
    const result = await runBfsAndDescendants(
      [seed],
      { ...OPTS, topicScope: scope },
      bfsDeps({ kgseed: [gnnPre, gnnAcl] }),
    );
    expect([...result.nodes.keys()].sort()).toEqual(["gnnAcl", "kgseed"]);
    expect(result.versionMerges).toEqual([]);
    expect(result.edges.map((e) => `${e.src}>${e.dst}`)).toEqual(["gnnAcl>kgseed"]);
  });

  it("different titles in one list stay two nodes", async () => {
    const seed = paper("snerg", "Neural Radiance Fields for Real-Time Rendering", 2022);
    const a = paper("bakeA", BAKING, 2021);
    const c = paper("plen", "PlenOctrees for Real-time Rendering of Neural Radiance Fields", 2021);
    const scope = new TopicScope("Neural Radiance Fields", []);
    const result = await runBfsAndDescendants(
      [seed],
      { ...OPTS, topicScope: scope },
      bfsDeps({ snerg: [a, c] }),
    );
    expect([...result.nodes.keys()].sort()).toEqual(["bakeA", "plen", "snerg"]);
    expect(result.titleMerged).toBe(0);
  });
});
