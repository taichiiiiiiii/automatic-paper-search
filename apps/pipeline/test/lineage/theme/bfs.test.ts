/**
 * Integration-style tests for `bfs.ts`'s wiring of `fetchRelated`,
 * `filterOffTopicRefs`, `deriveRelation` and `makeEdge`/`toThemeNode`
 * (each already unit-tested on its own) plus the completeness-ledger
 * forwarding safety contract (LIN-02), a TS port of
 * `test_build_theme_lineage.py`'s ledger-forwarding parametrized test.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { FetchInit, HttpResponseLike } from "../../../src/collect/http/requestWithRetry.js";
import { BuildCompleteness } from "../../../src/lineage/fetch-state/completeness.js";
import { addCrossNodeEdges, runBfsAndDescendants } from "../../../src/lineage/theme/bfs.js";
import type { ThemeEdge } from "../../../src/lineage/theme/edges.js";
import type { FetchRelatedDeps } from "../../../src/lineage/theme/fetchRelated.js";
import type { ThemePaper } from "../../../src/lineage/theme/openalexWork.js";

function jsonResp(status: number, body: unknown): HttpResponseLike {
  return { status, json: async () => body };
}

function s2Paper(
  pid: string,
  opts: { title?: string; year?: number; cites?: number } = {},
): ThemePaper {
  const { title = "Some paper", year = 2020, cites = 100 } = opts;
  return {
    paperId: pid,
    title,
    year,
    venue: "NeurIPS",
    citationCount: cites,
    abstract: "a".repeat(80),
    authors: [],
    externalIds: {},
  };
}

let cacheDir: string;
beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "bfs-cache-"));
});

function depsFor(
  fetchImpl: (url: string, init: FetchInit) => Promise<HttpResponseLike>,
): FetchRelatedDeps {
  return { fetchImpl, cacheDir, sleep: async () => {}, logger: { warn: () => {} } };
}

describe("runBfsAndDescendants", () => {
  it("creates a focus node per seed and a methodology-intent parent edge", async () => {
    const seed = s2Paper("seed1", { year: 2023 });
    const parentEntry = {
      citedPaper: {
        paperId: "parent1",
        title: "Foundational method",
        year: 2018,
        citationCount: 500,
        abstract: "a".repeat(80),
        externalIds: {},
      },
      isInfluential: true,
      intents: ["methodology"],
    };
    const deps = depsFor(async (url) => {
      if (url.includes("/references")) return jsonResp(200, { data: [parentEntry] });
      if (url.includes("/citations")) return jsonResp(200, { data: [] });
      throw new Error(`unexpected ${url}`);
    });

    const result = await runBfsAndDescendants(
      [seed],
      {
        depth: 1,
        width: 4,
        maxSeedCite: 10 ** 9,
        provider: null,
        llmStrict: "off",
        currentYear: 2026,
      },
      deps,
    );

    expect(result.seedIds).toEqual(["seed1"]);
    expect(result.nodes.get("seed1")?.is_focus).toBe(true);
    expect(result.nodes.has("parent1")).toBe(true);
    expect(result.classifyAttempted).toBeGreaterThan(0);
    expect(result.edges.some((e) => e.src === "parent1" && e.dst === "seed1")).toBe(true);
  });

  it("adds a descendants-direction edge (seed -> newer citing paper)", async () => {
    const seed = s2Paper("seed2", { year: 2018 });
    const childEntry = {
      citingPaper: {
        paperId: "child1",
        title: "Later extension",
        year: 2024,
        citationCount: 50,
        abstract: "a".repeat(80),
        externalIds: {},
      },
      isInfluential: true,
      intents: ["methodology"],
    };
    const deps = depsFor(async (url) => {
      if (url.includes("/references")) return jsonResp(200, { data: [] });
      if (url.includes("/citations")) return jsonResp(200, { data: [childEntry] });
      throw new Error(`unexpected ${url}`);
    });

    const result = await runBfsAndDescendants(
      [seed],
      {
        depth: 1,
        width: 4,
        maxSeedCite: 10 ** 9,
        provider: null,
        llmStrict: "off",
        currentYear: 2026,
      },
      deps,
    );
    expect(result.nodes.has("child1")).toBe(true);
    expect(result.edges.some((e) => e.src === "seed2" && e.dst === "child1")).toBe(true);
  });

  it("forwards the completeness ledger for both the ancestor BFS and the descendants pass", async () => {
    const seed = s2Paper("p1", { year: 2020, cites: 1 });
    for (const kindUnderTest of ["references", "citations"] as const) {
      const completeness = new BuildCompleteness();
      // Fresh cache dir per iteration: a successful empty result for the
      // OTHER kind in iteration 1 would otherwise be read back as a
      // cache hit in iteration 2 and never reach the network/ledger.
      const deps = {
        ...depsFor(async (url) => {
          if (url.includes(`/${kindUnderTest}`)) return jsonResp(503, {});
          return jsonResp(200, { data: [] });
        }),
        cacheDir: mkdtempSync(join(tmpdir(), `bfs-cache-${kindUnderTest}-`)),
      };
      await runBfsAndDescendants(
        [seed],
        { depth: 1, width: 4, maxSeedCite: 10 ** 9, provider: null, llmStrict: "off" },
        deps,
        completeness,
      );
      expect(completeness.expansionsAttempted).toBeGreaterThan(0);
      expect(completeness.expansionsFailed).toBeGreaterThan(0);
    }
  });
});

describe("addCrossNodeEdges", () => {
  it("adds an edge for an in-graph citation not seen by BFS", async () => {
    const nodes = new Map([
      [
        "a",
        {
          id: "a",
          title: "A",
          year: 2020,
          venue: "arXiv",
          venue_tier: "preprint",
          authors: [],
          kinds: [],
          citation_count: 10,
          github_stars: 0,
          tldr: "",
        },
      ],
      [
        "b",
        {
          id: "b",
          title: "B",
          year: 2021,
          venue: "arXiv",
          venue_tier: "preprint",
          authors: [],
          kinds: [],
          citation_count: 10,
          github_stars: 0,
          tldr: "",
        },
      ],
    ]);
    const edges: ThemeEdge[] = [];
    const deps = depsFor(async (url) => {
      if (url.includes("/b/references")) {
        // b cites a
        return jsonResp(200, {
          data: [
            {
              citedPaper: {
                paperId: "a",
                title: "A",
                year: 2020,
                citationCount: 10,
                abstract: "a".repeat(80),
                externalIds: {},
              },
              isInfluential: true,
              intents: ["methodology"],
            },
          ],
        });
      }
      return jsonResp(200, { data: [] });
    });
    const added = await addCrossNodeEdges(
      nodes,
      edges,
      { provider: null, strictMode: "off" },
      deps,
    );
    expect(added).toBe(1);
    expect(edges[0]).toMatchObject({ src: "a", dst: "b" });
  });

  it("never emits a self-loop even if S2 lists a paper among its own references", async () => {
    const nodes = new Map([
      [
        "a",
        {
          id: "a",
          title: "A",
          year: 2020,
          venue: "arXiv",
          venue_tier: "preprint",
          authors: [],
          kinds: [],
          citation_count: 10,
          github_stars: 0,
          tldr: "",
        },
      ],
    ]);
    const edges: ThemeEdge[] = [];
    const deps = depsFor(async () =>
      jsonResp(200, {
        data: [
          {
            citedPaper: {
              paperId: "a",
              title: "A",
              year: 2020,
              citationCount: 10,
              abstract: "a".repeat(80),
              externalIds: {},
            },
            isInfluential: true,
            intents: ["methodology"],
          },
        ],
      }),
    );
    const added = await addCrossNodeEdges(
      nodes,
      edges,
      { provider: null, strictMode: "off" },
      deps,
    );
    expect(added).toBe(0);
    expect(edges).toEqual([]);
  });

  it("forwards the completeness ledger on a references outage", async () => {
    const nodes = new Map([
      [
        "p1",
        {
          id: "p1",
          title: "Seed",
          year: 2020,
          venue: "arXiv",
          venue_tier: "preprint",
          authors: [],
          kinds: [],
          citation_count: 1,
          github_stars: 0,
          tldr: "",
        },
      ],
    ]);
    const completeness = new BuildCompleteness();
    const deps = depsFor(async () => jsonResp(503, {}));
    await addCrossNodeEdges(nodes, [], { provider: null, strictMode: "off" }, deps, completeness);
    expect(completeness.expansionsAttempted).toBeGreaterThan(0);
    expect(completeness.expansionsFailed).toBeGreaterThan(0);
  });
});
