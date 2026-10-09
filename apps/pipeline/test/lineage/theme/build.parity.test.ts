/**
 * Python <-> TS parity test for the OpenAlex-primary theme builder.
 *
 * `fixtures/mamba-openalex/expected-lineage.json` and
 * `expected-manifest.json` were recorded by running the REAL
 * `paperpilot/scripts/build_theme_lineage.py` (`--primary-source
 * openalex`) with `request_with_retry` mocked against the exact same
 * canned OpenAlex `/works` bodies this file defines, a fixed clock
 * (`2026-06-04T00:00:00Z`), and GitHub-stars enrichment stubbed to 0
 * (matching the Python test suite's own `_stub_external_calls`
 * convention). See `fixtures/mamba-openalex/python-requests.json` for
 * the exact request sequence/params Python issued — this test's
 * `fetchImpl` dispatches on the same shapes and records its own
 * requests for comparison.
 *
 * Regenerate the fixtures with the driver described in this task's
 * final report (not run in CI; the driver script lived in the task's
 * scratchpad, not the repo, per the "no network ever in CI" / "record
 * fixtures, don't regenerate" brief instruction).
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import type { FetchInit, HttpResponseLike } from "../../../src/collect/http/requestWithRetry.js";
import { type BuildThemeLineageDeps, buildThemeLineage } from "../../../src/lineage/theme/build.js";
import { generateManifest } from "../../../src/lineage/theme/generateThemesManifest.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures", "mamba-openalex");

function work(
  shortId: string,
  opts: {
    title: string;
    year: number;
    cites: number;
    referencedWorks?: string[];
    arxivId?: string;
  },
): Record<string, unknown> {
  const words = "we present a research contribution in this area".split(" ");
  const invertedIndex: Record<string, number[]> = {};
  words.forEach((w, i) => {
    invertedIndex[w] = [i];
  });
  const w: Record<string, unknown> = {
    id: `https://openalex.org/${shortId}`,
    title: opts.title,
    display_name: opts.title,
    publication_year: opts.year,
    cited_by_count: opts.cites,
    authorships: [{ author: { display_name: "A. Author" } }],
    abstract_inverted_index: invertedIndex,
    primary_location: { source: { display_name: "NeurIPS" } },
  };
  if (opts.referencedWorks !== undefined) {
    w.referenced_works = opts.referencedWorks.map((r) => `https://openalex.org/${r}`);
  }
  if (opts.arxivId) w.ids = { arxiv_id: opts.arxivId };
  return w;
}

const W_SEED = "W1001";
const W_PARENT = "W1002";
const W_CHILD = "W1003";

const seedWork = work(W_SEED, {
  title: "Mamba Sequence Modeling Paper",
  year: 2023,
  cites: 500,
  referencedWorks: [W_PARENT],
  arxivId: "2301.00001",
});
const parentWork = work(W_PARENT, {
  title: "Earlier Foundational Sequence Work",
  year: 2018,
  cites: 300,
  referencedWorks: [],
});
const childWork = work(W_CHILD, {
  title: "Later Extension Of Mamba",
  year: 2024,
  cites: 50,
  referencedWorks: [],
});

interface CapturedRequest {
  method: string;
  url: string;
  params: Record<string, string>;
}

function jsonResp(status: number, body: unknown): HttpResponseLike {
  return { status, json: async () => body };
}

function makeFetchImpl(
  captured: CapturedRequest[],
): (url: string, init: FetchInit) => Promise<HttpResponseLike> {
  return async (url, init) => {
    const parsed = new URL(url);
    const params = Object.fromEntries(parsed.searchParams.entries());
    captured.push({ method: init.method, url: `${parsed.origin}${parsed.pathname}`, params });

    if (parsed.pathname === `/works/${W_SEED}`) return jsonResp(200, seedWork);
    if (parsed.pathname === `/works/${W_PARENT}`) return jsonResp(200, parentWork);
    if (parsed.pathname === `/works/${W_CHILD}`) return jsonResp(200, childWork);
    if (parsed.pathname === "/works" && params.search)
      return jsonResp(200, { results: [seedWork] });
    if (parsed.pathname === "/works" && params.filter?.startsWith("openalex:")) {
      const ids = params.filter.slice("openalex:".length).split("|");
      const byId: Record<string, Record<string, unknown>> = {
        [W_SEED]: seedWork,
        [W_PARENT]: parentWork,
        [W_CHILD]: childWork,
      };
      return jsonResp(200, { results: ids.filter((i) => i in byId).map((i) => byId[i]) });
    }
    if (parsed.pathname === "/works" && params.filter?.startsWith("cites:")) {
      const cited = params.filter.slice("cites:".length);
      return jsonResp(200, { results: cited === W_SEED ? [childWork] : [] });
    }
    return jsonResp(200, { results: [] });
  };
}

let docsRoot: string;
let cacheDir: string;
let githubCacheDir: string;

beforeEach(() => {
  docsRoot = mkdtempSync(join(tmpdir(), "parity-docs-"));
  cacheDir = mkdtempSync(join(tmpdir(), "parity-cache-"));
  githubCacheDir = mkdtempSync(join(tmpdir(), "parity-gh-cache-"));
});

function stripIgnoredFields(payload: unknown): unknown {
  // Nothing is stripped: `generated_at` is pinned to the same fixed
  // clock on both sides, so a byte-for-byte compare is possible
  // without an ignore-rules file.
  return payload;
}

describe("buildThemeLineage <-> build_theme_lineage.py parity (OpenAlex-primary)", () => {
  it("produces a byte-identical docs-shaped lineage.json for the Mamba fixture", async () => {
    const captured: CapturedRequest[] = [];
    const deps: BuildThemeLineageDeps = {
      fetchImpl: makeFetchImpl(captured),
      cacheDir,
      sleep: async () => {},
      docsRoot,
      identityAliasesPath: join(docsRoot, "identity-aliases-v1.json"), // absent -> {}
      githubCachePath: join(githubCacheDir, "github_stars.json"),
      wallClockNow: () => new Date("2026-06-04T00:00:00Z"),
      logger: {},
    };

    const outPath = await buildThemeLineage(
      {
        theme: "Mamba",
        depth: 1,
        seedsCount: 1,
        width: 4,
        sinceYear: null,
        primarySource: "openalex",
        // The Python golden output predates the R2-2b topic gate (its
        // parent paper does not mention "Mamba"); parity pins the legacy
        // traversal, the gate has its own tests (topicScope/bfs).
        topicScope: { gate: false },
      },
      deps,
    );
    const actual = JSON.parse(readFileSync(outPath, "utf-8"));
    const expected = JSON.parse(readFileSync(join(FIXTURES, "expected-lineage.json"), "utf-8"));

    expect(stripIgnoredFields(actual)).toEqual(stripIgnoredFields(expected));
  });

  it("issues the same OpenAlex request sequence/params as Python (order and shape)", async () => {
    const captured: CapturedRequest[] = [];
    const deps: BuildThemeLineageDeps = {
      fetchImpl: makeFetchImpl(captured),
      cacheDir,
      sleep: async () => {},
      docsRoot,
      identityAliasesPath: join(docsRoot, "identity-aliases-v1.json"),
      githubCachePath: join(githubCacheDir, "github_stars.json"),
      wallClockNow: () => new Date("2026-06-04T00:00:00Z"),
      logger: {},
    };
    await buildThemeLineage(
      {
        theme: "Mamba",
        depth: 1,
        seedsCount: 1,
        width: 4,
        sinceYear: null,
        primarySource: "openalex",
        // The Python golden output predates the R2-2b topic gate (its
        // parent paper does not mention "Mamba"); parity pins the legacy
        // traversal, the gate has its own tests (topicScope/bfs).
        topicScope: { gate: false },
      },
      deps,
    );

    const pythonRequests = JSON.parse(
      readFileSync(join(FIXTURES, "python-requests.json"), "utf-8"),
    ) as CapturedRequest[];
    expect(captured).toHaveLength(pythonRequests.length);
    for (let i = 0; i < pythonRequests.length; i++) {
      expect(captured[i]!.method).toBe(pythonRequests[i]!.method);
      expect(captured[i]!.url).toBe(pythonRequests[i]!.url);
      // Compare params as maps, not strings — Python's dict insertion
      // order and the Node URLSearchParams iteration order needn't
      // match for this to be a faithful "same request" comparison.
      expect(captured[i]!.params).toEqual(
        Object.fromEntries(
          Object.entries(pythonRequests[i]!.params).map(([k, v]) => [k, String(v)]),
        ),
      );
    }
  });

  it("generate_themes_manifest produces a matching entry for the generated theme", async () => {
    const deps: BuildThemeLineageDeps = {
      fetchImpl: makeFetchImpl([]),
      cacheDir,
      sleep: async () => {},
      docsRoot,
      identityAliasesPath: join(docsRoot, "identity-aliases-v1.json"),
      githubCachePath: join(githubCacheDir, "github_stars.json"),
      wallClockNow: () => new Date("2026-06-04T00:00:00Z"),
      logger: {},
    };
    await buildThemeLineage(
      {
        theme: "Mamba",
        depth: 1,
        seedsCount: 1,
        width: 4,
        sinceYear: null,
        primarySource: "openalex",
        // The Python golden output predates the R2-2b topic gate (its
        // parent paper does not mention "Mamba"); parity pins the legacy
        // traversal, the gate has its own tests (topicScope/bfs).
        topicScope: { gate: false },
      },
      deps,
    );

    const entries = generateManifest(join(docsRoot, "themes"));
    const expected = JSON.parse(readFileSync(join(FIXTURES, "expected-manifest.json"), "utf-8"));
    expect(entries).toEqual(expected);
  });
});
