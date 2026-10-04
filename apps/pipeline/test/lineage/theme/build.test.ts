/**
 * Integration tests for `build.ts`'s `buildThemeLineage` orchestration —
 * TS port of a representative slice of `test_build_theme_lineage.py`'s
 * end-to-end tests (`test_a_genuinely_empty_theme_still_publishes`,
 * `test_completeness_block_is_recorded_on_a_normal_build`).
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pyJsonDumps } from "@paperpilot/core";
import { beforeEach, describe, expect, it } from "vitest";
import type { FetchInit, HttpResponseLike } from "../../../src/collect/http/requestWithRetry.js";
import type { DerivedEdge } from "../../../src/lineage/classify/classify.js";
import {
  type BuildThemeLineageDeps,
  buildThemeLineage,
  edgeForJson,
} from "../../../src/lineage/theme/build.js";
import { makeEdge } from "../../../src/lineage/theme/edges.js";

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
