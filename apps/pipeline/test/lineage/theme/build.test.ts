/**
 * Integration tests for `build.ts`'s `buildThemeLineage` orchestration —
 * TS port of a representative slice of `test_build_theme_lineage.py`'s
 * end-to-end tests (`test_a_genuinely_empty_theme_still_publishes`,
 * `test_completeness_block_is_recorded_on_a_normal_build`).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pyJsonDumps } from "@paperpilot/core";
import { beforeEach, describe, expect, it } from "vitest";
import type { FetchInit, HttpResponseLike } from "../../../src/collect/http/requestWithRetry.js";
import type {
  ClassifyPaperLike,
  LLMProvider,
  PaperEvaluation,
  RelationClassification,
} from "../../../src/collect/llm/provider.js";
import type { DerivedEdge } from "../../../src/lineage/classify/classify.js";
import { IncompleteBuildError } from "../../../src/lineage/fetch-state/completeness.js";
import {
  type BuildThemeLineageDeps,
  buildThemeLineage,
  edgeForJson,
} from "../../../src/lineage/theme/build.js";
import { makeEdge } from "../../../src/lineage/theme/edges.js";
import { sanitizeTheme, themeLineagePath, themeSlug } from "../../../src/lineage/theme/slug.js";

function jsonResp(status: number, body: unknown): HttpResponseLike {
  return { status, json: async () => body };
}

/** Wraps a list of S2-shaped papers for the S2 `/paper/search` (`data`)
 * response shape, with `results` always genuinely empty — mirroring
 * the Python fixture `_mk_s2_search_response` EXACTLY: `results` is
 * `[]`, not `papers`, because the OpenAlex side of this shared mock
 * must read as "no matches" (a legitimate empty answer), not as a
 * malformed-element failure (an S2-shaped dict has no OpenAlex `id`
 * field and would fail `openalexWorkShape` if echoed back). */
function mkSearchResponse(papers: unknown[]): HttpResponseLike {
  return jsonResp(200, { data: papers, results: [] });
}

/** Every seed needs a canonical strong alias (here: an ArXiv id) to
 * survive the identity gate (`resolveAndDedupSeeds`, LIN-25) — mirrors
 * `test_build_theme_lineage.py::_mk_s2_paper`, which always sets one. */
function s2Paper(
  pid: string,
  opts: { title?: string; year?: number; cites?: number; arxivId?: string } = {},
) {
  const { title = "Some paper", year = 2020, cites = 100, arxivId = "2401.00001" } = opts;
  return {
    paperId: pid,
    title,
    year,
    venue: "NeurIPS",
    citationCount: cites,
    abstract: "a".repeat(80),
    authors: [],
    externalIds: { ArXiv: arxivId },
  };
}

let docsRoot: string;
let cacheDir: string;
let githubCacheDir: string;

beforeEach(() => {
  docsRoot = mkdtempSync(join(tmpdir(), "build-docs-"));
  cacheDir = mkdtempSync(join(tmpdir(), "build-cache-"));
  githubCacheDir = mkdtempSync(join(tmpdir(), "build-gh-cache-"));
});

function depsFor(
  fetchImpl: (url: string, init: FetchInit) => Promise<HttpResponseLike>,
): BuildThemeLineageDeps {
  return {
    fetchImpl,
    cacheDir,
    sleep: async () => {},
    docsRoot,
    identityAliasesPath: join(docsRoot, "identity-aliases-v1.json"), // does not exist -> {}
    githubCachePath: join(githubCacheDir, "github_stars.json"),
    logger: {},
  };
}

/** A fetchImpl that answers every S2/OpenAlex endpoint this pipeline
 * touches with "found nothing" (search: empty; references/citations:
 * empty), equivalent to the Python tests' `fetch_related` stub
 * returning `[]` for every call. */
function emptyFetchImpl(
  seedSearchPapers: unknown[] = [],
): (url: string, init: FetchInit) => Promise<HttpResponseLike> {
  return async (url) => {
    if (url.includes("/references") || url.includes("/citations")) {
      return jsonResp(200, { data: [] });
    }
    return mkSearchResponse(seedSearchPapers);
  };
}

describe("buildThemeLineage", () => {
  it("publishes a genuinely empty theme (every request succeeded, no papers found)", async () => {
    const deps = depsFor(emptyFetchImpl([]));
    const outPath = await buildThemeLineage(
      { theme: "Genuinely Empty", depth: 1, seedsCount: 3, width: 4, sinceYear: null },
      deps,
    );
    const payload = JSON.parse(readFileSync(outPath, "utf-8"));
    expect(payload.root).toBeNull();
    expect(payload.nodes).toEqual([]);
    expect(payload.meta.completeness).toEqual({
      complete: true,
      expansions_attempted: 0,
      expansions_failed: 0,
      supplement_failures: [],
    });
  });

  it("records a complete=true completeness block on a normal build", async () => {
    const seed = s2Paper("p1", { title: "Normal Theme" });
    const deps = depsFor(emptyFetchImpl([seed]));
    const outPath = await buildThemeLineage(
      { theme: "Normal Theme", depth: 1, seedsCount: 3, width: 4, sinceYear: null },
      deps,
    );
    const payload = JSON.parse(readFileSync(outPath, "utf-8"));
    expect(payload.meta.completeness.complete).toBe(true);
    expect(
      payload.nodes.some((n: Record<string, unknown>) => n.id === "p1" && n.is_focus === true),
    ).toBe(true);
  });

  it("writes to docsRoot/themes/<slug>/lineage.json by default", async () => {
    const deps = depsFor(emptyFetchImpl([]));
    const outPath = await buildThemeLineage(
      { theme: "Mixture of Experts", depth: 1, seedsCount: 3, width: 4, sinceYear: null },
      deps,
    );
    expect(outPath).toBe(join(docsRoot, "themes", "mixture-of-experts", "lineage.json"));
    expect(existsSync(outPath)).toBe(true);
  });

  it("refuses to publish (throws) when seed search failed outright (subject gate, LIN-15)", async () => {
    const deps = depsFor(async (url) =>
      url.includes("/references") || url.includes("/citations")
        ? jsonResp(200, { data: [] })
        : jsonResp(500, {}),
    );
    await expect(
      buildThemeLineage(
        { theme: "Outage Theme", depth: 1, seedsCount: 3, width: 4, sinceYear: null },
        deps,
      ),
    ).rejects.toThrow();
    // Nothing was published for this brand-new slug.
    expect(existsSync(join(docsRoot, "themes", "outage-theme", "lineage.json"))).toBe(false);
  });

  it("throws ZeroEdgeBuildError-shaped rejection only when the caller opts in via allowEdgeless=false, and otherwise publishes a 0-edge graph", async () => {
    const seed = s2Paper("p1", { title: "Lonely Theme" });
    const deps = depsFor(emptyFetchImpl([seed]));
    // Default allowEdgeless=true: publishes even with 0 edges.
    const outPath = await buildThemeLineage(
      { theme: "Lonely Theme", depth: 1, seedsCount: 3, width: 4, sinceYear: null },
      deps,
    );
    const payload = JSON.parse(readFileSync(outPath, "utf-8"));
    expect(payload.edges).toEqual([]);

    // allowEdgeless=false: must throw instead of writing.
    const deps2 = depsFor(emptyFetchImpl([seed]));
    await expect(
      buildThemeLineage(
        {
          theme: "Lonely Theme Two",
          depth: 1,
          seedsCount: 3,
          width: 4,
          sinceYear: null,
          allowEdgeless: false,
        },
        deps2,
      ),
    ).rejects.toThrow(/refusing to write/);
  });

  // LIN-15/16: a supplement (top-up) failure that leaves ZERO focus
  // papers must be PROMOTED to a subject failure (build.ts:490) — an
  // outage that happens to coincide with "nothing survived identity
  // filtering" must not be published as a legitimately-empty theme.
  it("promotes a supplement failure to a subject failure when it leaves zero focus papers (LIN-15/16)", async () => {
    const deps = depsFor(async (url) => {
      if (url.includes("/references") || url.includes("/citations")) {
        return jsonResp(200, { data: [] });
      }
      if (url.includes("openalex.org")) {
        // OpenAlex top-up (triggered because S2 alone found fewer than
        // seedsCount) fails outright -> a supplement failure.
        return jsonResp(503, {});
      }
      // S2 search succeeds, but the one hit has NO canonical alias, so
      // the identity gate drops it -> zero surviving focus papers.
      return mkSearchResponse(
        [s2Paper("p1", { arxivId: undefined as unknown as string })].map((p) => ({
          ...p,
          externalIds: {},
        })),
      );
    });
    await expect(
      buildThemeLineage(
        { theme: "Promotion Theme", depth: 1, seedsCount: 3, width: 4, sinceYear: null },
        deps,
      ),
    ).rejects.toThrow(/no focus paper survived/);
    expect(existsSync(join(docsRoot, "themes", "promotion-theme", "lineage.json"))).toBe(false);
  });
});

describe("MEDIUM-4 (#review, build.ts:523): the expansion gate's IncompleteBuildError is actually thrown and respected", () => {
  it("refuses to shrink a larger/differently-focused published lineage after an expansion failure, leaving the file byte-unchanged", async () => {
    const theme = "Incomplete Gate Theme";
    const slug = themeSlug(sanitizeTheme(theme));
    const outPath = themeLineagePath(docsRoot, slug);
    mkdirSync(join(docsRoot, "themes", slug), { recursive: true });
    // Larger AND differently-focused than what this build can produce
    // (the new build's only focus will be "p1"): any one of "focus
    // paper(s)"/"node(s)"/"edge(s)" missing is enough to block.
    const published = {
      schema_version: "lineage-artifact-v1",
      root: "other-focus",
      nodes: [
        { id: "other-focus", title: "Other Focus", is_focus: true, seed_paper_id: "f".repeat(40) },
        { id: "other-parent", title: "Other Parent", is_focus: false },
      ],
      edges: [
        {
          src: "other-parent",
          dst: "other-focus",
          rel: "extends",
          relation: "extends",
          conf: 0.6,
          confidence: 0.6,
          rationale: "a real published rationale",
          provenance: {},
        },
      ],
      clusters: [],
      meta: {},
    };
    const publishedBytes = JSON.stringify(published);
    writeFileSync(outPath, publishedBytes);

    // Seed search succeeds (subject gate passes) but references/citations
    // both fail -> an expansion failure, not a subject one (same split as
    // buildLineageCli.test.ts's LIN-06 test).
    const seed = s2Paper("p1", { title: "Incomplete Gate Theme Seed", cites: 100 });
    const deps = depsFor(async (url) => {
      if (url.includes("/references") || url.includes("/citations")) {
        return jsonResp(503, {});
      }
      return mkSearchResponse([seed]);
    });

    await expect(
      buildThemeLineage({ theme, depth: 1, seedsCount: 1, width: 4, sinceYear: null }, deps),
    ).rejects.toThrow(IncompleteBuildError);
    // The published file must be untouched, byte-for-byte.
    expect(readFileSync(outPath, "utf-8")).toBe(publishedBytes);

    // allowIncomplete=true bypasses the EXPANSION gate (not the subject
    // gate) and publishes despite the same outage.
    const deps2 = depsFor(async (url) => {
      if (url.includes("/references") || url.includes("/citations")) {
        return jsonResp(503, {});
      }
      return mkSearchResponse([seed]);
    });
    const written = await buildThemeLineage(
      {
        theme,
        depth: 1,
        seedsCount: 1,
        width: 4,
        sinceYear: null,
        allowIncomplete: true,
      },
      deps2,
    );
    expect(written).toBe(outPath);
    const payload = JSON.parse(readFileSync(outPath, "utf-8"));
    expect(payload).not.toEqual(published);
    expect(payload.meta.completeness.complete).toBe(false);
  });
});

describe("edgeForJson (p4-followups #24)", () => {
  it("wraps an exactly-1.0/0.0 confidence so it serializes as the Python float literal, not a bare int", () => {
    const classification: DerivedEdge = {
      relation: "successor",
      confidence: 1,
      rationale: "an LLM returned exactly 1.0 confidence",
      provenance: "llm",
    };
    const edge = makeEdge(classification, {
      srcId: "a",
      dstId: "b",
      parent: {},
      child: {},
      intentRecord: {},
      provider: null,
    });
    // The in-memory edge keeps plain numbers (arithmetic/typeof checks
    // downstream must keep working on it).
    expect(edge.conf).toBe(1);
    expect(edge.confidence).toBe(1);
    const json = pyJsonDumps(edgeForJson(edge), { ensureAscii: false });
    expect(json).toContain('"conf": 1.0');
    expect(json).toContain('"confidence": 1.0');
    expect(json).not.toMatch(/"conf": 1,/);
    expect(json).not.toMatch(/"confidence": 1,/);
  });
});

/** A fixed-answer LLM provider for the two integration tests below —
 * every `classifyRelation` call returns the same classification, so the
 * one candidate edge each test's fetchImpl produces is driven entirely
 * by the constructor argument. */
class FixedClassificationProvider implements LLMProvider {
  readonly name = "fixed";
  enabled = true;
  batchSize = 1;
  constructor(private readonly classification: RelationClassification | null) {}
  async evaluateBatch(): Promise<(PaperEvaluation | null)[]> {
    return [];
  }
  async chat(): Promise<string | null> {
    return null;
  }
  async classifyRelation(
    _a: ClassifyPaperLike,
    _b: ClassifyPaperLike,
  ): Promise<RelationClassification | null> {
    return this.classification;
  }
  async completeJson(): Promise<string | null> {
    return null;
  }
}

describe("LIN-37 call site (build.ts:378): filterEdgesByRationale is actually applied to the published graph", () => {
  it("drops a candidate edge whose LLM classification carries a 3-char rationale, keeping both endpoint nodes", async () => {
    const seed = s2Paper("seed1", { title: "Short Rationale Theme Seed", cites: 100 });
    const parent = s2Paper("parent1", {
      title: "Some Unrelated Earlier Parent Paper",
      year: 2015,
      cites: 50,
      arxivId: "2015.00002",
    });
    const deps = depsFor(async (url) => {
      if (url.includes("/references")) {
        return jsonResp(200, {
          data: [{ citedPaper: parent, isInfluential: true, intents: [] }],
        });
      }
      if (url.includes("/citations")) return jsonResp(200, { data: [] });
      return mkSearchResponse([seed]);
    });
    deps.buildProvider = () => ({
      provider: new FixedClassificationProvider({
        relation: "extends",
        confidence: 0.9,
        rationale: "xyz", // below MIN_RATIONALE_LEN (10) -> degenerate
      }),
      rateDelay: 0,
    });
    const outPath = await buildThemeLineage(
      {
        theme: "Short Rationale Theme",
        depth: 1,
        seedsCount: 3,
        width: 4,
        sinceYear: null,
        llmStrict: "all",
      },
      deps,
    );
    const payload = JSON.parse(readFileSync(outPath, "utf-8"));
    // The candidate edge existed (both nodes were discovered) but was
    // filtered out — a mutant that drops the `filterEdgesByRationale`
    // call at build.ts:378 would leave it in `edges`.
    expect(payload.nodes.map((n: Record<string, unknown>) => n.id).sort()).toEqual([
      "parent1",
      "seed1",
    ]);
    expect(payload.edges).toEqual([]);
  });
});

describe("pyFloat write-site (p4-followups #24, build.ts:535 edgeForJson)", () => {
  it("the actual file buildThemeLineage writes contains the Python float literal for an exactly-1.0 LLM confidence", async () => {
    const seed = s2Paper("seed2", { title: "Pyfloat Write Site Theme Seed", cites: 100 });
    const parent = s2Paper("parent2", {
      title: "Another Unrelated Earlier Parent Paper",
      year: 2015,
      cites: 50,
      arxivId: "2015.00003",
    });
    const deps = depsFor(async (url) => {
      if (url.includes("/references")) {
        return jsonResp(200, {
          data: [{ citedPaper: parent, isInfluential: true, intents: [] }],
        });
      }
      if (url.includes("/citations")) return jsonResp(200, { data: [] });
      return mkSearchResponse([seed]);
    });
    deps.buildProvider = () => ({
      provider: new FixedClassificationProvider({
        relation: "extends",
        confidence: 1,
        rationale: "an LLM returned exactly 1.0 confidence for this specific pair",
      }),
      rateDelay: 0,
    });
    const outPath = await buildThemeLineage(
      {
        theme: "Pyfloat Write Site Theme",
        depth: 1,
        seedsCount: 3,
        width: 4,
        sinceYear: null,
        llmStrict: "all",
      },
      deps,
    );
    const raw = readFileSync(outPath, "utf-8");
    expect(raw).toContain('"conf": 1.0');
    expect(raw).toContain('"confidence": 1.0');
    expect(raw).not.toMatch(/"conf": 1,/);
    expect(raw).not.toMatch(/"confidence": 1,/);
  });
});
