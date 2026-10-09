/**
 * Vitest port of the CLI-level tests in
 * `paperpilot/tests/test_build_theme_lineage.py` (`main`,
 * `_build_arg_parser`, `_expand_params`, the `--auto-expand` retry
 * ladder) — safety contracts LIN-18/LIN-19.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LAYOUT_MODE } from "@paperpilot/core/layout";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FetchInit, HttpResponseLike } from "../../../src/collect/http/requestWithRetry.js";
import { IncompleteBuildError } from "../../../src/lineage/fetch-state/completeness.js";
import type {
  BuildThemeLineageDeps,
  BuildThemeLineageOptions,
} from "../../../src/lineage/theme/build.js";
import { ZeroEdgeBuildError } from "../../../src/lineage/theme/build.js";
import {
  CliArgError,
  defaultDeps,
  envFilePath,
  expandParams,
  parseArgs,
  runThemeCli,
} from "../../../src/lineage/theme/cli.js";

function jsonResp(status: number, body: unknown): HttpResponseLike {
  return { status, json: async () => body };
}

let docsRoot: string;
let cacheDir: string;
let githubCacheDir: string;

beforeEach(() => {
  docsRoot = mkdtempSync(join(tmpdir(), "cli-docs-"));
  cacheDir = mkdtempSync(join(tmpdir(), "cli-cache-"));
  githubCacheDir = mkdtempSync(join(tmpdir(), "cli-gh-cache-"));
});

function depsFor(
  fetchImpl: (url: string, init: FetchInit) => Promise<HttpResponseLike>,
): BuildThemeLineageDeps {
  return {
    fetchImpl,
    cacheDir,
    sleep: async () => {},
    docsRoot,
    identityAliasesPath: join(docsRoot, "identity-aliases-v1.json"),
    githubCachePath: join(githubCacheDir, "github_stars.json"),
    logger: {},
  };
}

describe("parseArgs", () => {
  it("requires --theme", () => {
    expect(() => parseArgs([])).toThrow(CliArgError);
  });

  it("rejects an unknown --llm-strict value", () => {
    expect(() => parseArgs(["--theme", "X", "--llm-strict", "bogus"])).toThrow(CliArgError);
  });

  it("rejects an unknown --primary-source value", () => {
    expect(() => parseArgs(["--theme", "X", "--primary-source", "bogus"])).toThrow(CliArgError);
  });

  it("parses defaults matching the Python argparse defaults", () => {
    const args = parseArgs(["--theme", "Mixture of Experts"]);
    expect(args).toMatchObject({
      theme: "Mixture of Experts",
      depth: 2,
      seedsCount: 8,
      width: 8,
      sinceYear: null,
      useOpenalexFallback: true,
      llmStrict: "off",
      primarySource: "s2",
      allowIncomplete: false,
      autoExpand: false,
    });
  });

  // M3 of the P4 review: migrated from a hand-rolled switch to the
  // shared strict parser — pin the behaviour that actually changed.
  it("accepts --theme=value (single token), same as two tokens", () => {
    expect(parseArgs(["--theme=Mixture of Experts"]).theme).toBe("Mixture of Experts");
  });

  it("resolves a unique prefix abbreviation (--auto-exp -> --auto-expand)", () => {
    expect(parseArgs(["--theme", "X", "--auto-exp"]).autoExpand).toBe(true);
  });

  it("rejects a non-integer --depth instead of silently becoming NaN", () => {
    expect(() => parseArgs(["--theme", "X", "--depth", "x"])).toThrow(CliArgError);
  });

  it("--no-openalex-fallback flips useOpenalexFallback to false", () => {
    expect(parseArgs(["--theme", "X", "--no-openalex-fallback"]).useOpenalexFallback).toBe(false);
  });
});

describe("expandParams", () => {
  it("doubles seeds (capped 12), adds +4 to width (capped 12), +1 to depth (capped 3)", () => {
    expect(expandParams(1, 5, 8)).toEqual([2, 10, 12]);
    expect(expandParams(2, 8, 10)).toEqual([3, 12, 12]); // seeds*2=16 capped to 12; width+4=14 capped to 12
  });
});

describe("runThemeCli", () => {
  it("returns 2 for an empty/whitespace theme", async () => {
    expect(await runThemeCli(["--theme", "   "])).toBe(2);
  });

  it("returns 3 when the build produces zero edges (no --auto-expand)", async () => {
    const seed = {
      paperId: "p1",
      title: "Some Sparse Topic",
      year: 2020,
      venue: "NeurIPS",
      citationCount: 10,
      abstract: "a".repeat(80),
      authors: [],
      externalIds: { ArXiv: "2401.00001" },
    };
    const deps = depsFor(async (url) => {
      if (url.includes("/references") || url.includes("/citations"))
        return jsonResp(200, { data: [] });
      return jsonResp(200, { data: [seed], results: [] });
    });
    const rc = await runThemeCli(
      ["--theme", "Some Sparse Topic", "--depth", "1", "--seeds", "5", "--width", "8"],
      { deps },
    );
    expect(rc).toBe(3);
  });

  it("returns 0 for a normal successful build", async () => {
    const seed = {
      paperId: "p1",
      title: "Happy Path Theme",
      year: 2020,
      venue: "NeurIPS",
      citationCount: 10,
      abstract: "a".repeat(80),
      authors: [],
      externalIds: { ArXiv: "2401.00001" },
    };
    const parent = {
      citedPaper: {
        paperId: "parent1",
        // Mentions the theme so the R2-2b topic gate admits it.
        title: "Foundational method for Happy Path Theme",
        year: 2015,
        citationCount: 500,
        abstract: "a".repeat(80),
        externalIds: {},
      },
      isInfluential: true,
      intents: ["methodology"],
    };
    const deps = depsFor(async (url) => {
      if (url.includes("/references")) return jsonResp(200, { data: [parent] });
      if (url.includes("/citations")) return jsonResp(200, { data: [] });
      return jsonResp(200, { data: [seed], results: [] });
    });
    const rc = await runThemeCli(
      ["--theme", "Happy Path Theme", "--depth", "1", "--seeds", "5", "--width", "8"],
      { deps },
    );
    expect(rc).toBe(0);
  });

  it("returns 4 when the seed search outright fails (cross-checked against a real `build_theme_lineage.main()` run, see the task report)", async () => {
    const deps = depsFor(async () => jsonResp(500, {}));
    const rc = await runThemeCli(
      [
        "--theme",
        "Outage Theme",
        "--primary-source",
        "openalex",
        "--depth",
        "1",
        "--seeds",
        "3",
        "--width",
        "4",
      ],
      { deps },
    );
    expect(rc).toBe(4);
  });

  describe("--auto-expand", () => {
    function fakeBuildLog(): {
      log: { depth: number; seedsCount: number; width: number }[];
      buildFn: (options: BuildThemeLineageOptions, deps: BuildThemeLineageDeps) => Promise<string>;
      outPath: string;
    } {
      const log: { depth: number; seedsCount: number; width: number }[] = [];
      const outPath = join(docsRoot, "out.json");
      const buildFn = async (options: BuildThemeLineageOptions): Promise<string> => {
        log.push({ depth: options.depth, seedsCount: options.seedsCount, width: options.width });
        const nodeCount = log.length === 1 ? 5 : 25;
        const edgeCount = log.length === 1 ? 2 : 30;
        writeFileSync(
          outPath,
          JSON.stringify({
            nodes: Array.from({ length: nodeCount }, (_, i) => ({ id: `n${i}` })),
            edges: Array.from({ length: edgeCount }, (_, i) => ({
              src: `n${i}`,
              dst: `n${i + 1}`,
            })),
          }),
        );
        return outPath;
      };
      return { log, buildFn, outPath };
    }

    it("retries with expanded params when the first pass is sparse", async () => {
      const { log, buildFn, outPath } = fakeBuildLog();
      const deps = depsFor(async () => jsonResp(200, { data: [] }));
      const rc = await runThemeCli(
        [
          "--theme",
          "Mixture of Depths",
          "--depth",
          "1",
          "--seeds",
          "5",
          "--width",
          "8",
          "--auto-expand",
          "--output",
          outPath,
        ],
        { deps, buildFn },
      );
      expect(rc).toBe(0);
      expect(log).toHaveLength(2);
      expect(log[0]).toEqual({ depth: 1, seedsCount: 5, width: 8 });
      expect(log[1]).toEqual({ depth: 2, seedsCount: 10, width: 12 });
    });

    it("does not retry when the first pass is already dense enough", async () => {
      let calls = 0;
      const outPath = join(docsRoot, "out.json");
      const buildFn = async (): Promise<string> => {
        calls += 1;
        writeFileSync(
          outPath,
          JSON.stringify({
            nodes: Array.from({ length: 40 }, (_, i) => ({ id: `n${i}` })),
            edges: Array.from({ length: 50 }, (_, i) => ({ src: `n${i}`, dst: `n${i + 1}` })),
          }),
        );
        return outPath;
      };
      const deps = depsFor(async () => jsonResp(200, { data: [] }));
      const rc = await runThemeCli(
        [
          "--theme",
          "Mamba",
          "--depth",
          "1",
          "--seeds",
          "5",
          "--width",
          "8",
          "--auto-expand",
          "--output",
          outPath,
        ],
        { deps, buildFn },
      );
      expect(rc).toBe(0);
      expect(calls).toBe(1);
    });

    it("without --auto-expand, a sparse-but-nonzero-edge first pass does NOT retry and exits 0 (sparse != zero-edge)", async () => {
      let calls = 0;
      const outPath = join(docsRoot, "out.json");
      const buildFn = async (): Promise<string> => {
        calls += 1;
        writeFileSync(
          outPath,
          JSON.stringify({
            nodes: [{ id: "n0" }, { id: "n1" }],
            edges: [{ src: "n0", dst: "n1" }],
          }),
        );
        return outPath;
      };
      const deps = depsFor(async () => jsonResp(200, { data: [] }));
      const rc = await runThemeCli(
        [
          "--theme",
          "Some Sparse Topic",
          "--depth",
          "1",
          "--seeds",
          "5",
          "--width",
          "8",
          "--output",
          outPath,
        ],
        { deps, buildFn },
      );
      expect(calls).toBe(1);
      expect(rc).toBe(0);
    });

    it("keeps the first pass on disk and returns 0 when the retry build itself throws", async () => {
      let calls = 0;
      const outPath = join(docsRoot, "out.json");
      const buildFn = async (): Promise<string> => {
        calls += 1;
        if (calls === 1) {
          writeFileSync(
            outPath,
            JSON.stringify({ nodes: [{ id: "n0" }], edges: [{ src: "n0", dst: "n1" }] }),
          );
          return outPath;
        }
        throw new Error("simulated retry failure");
      };
      const deps = depsFor(async () => jsonResp(200, { data: [] }));
      const rc = await runThemeCli(
        [
          "--theme",
          "Theme",
          "--depth",
          "1",
          "--seeds",
          "5",
          "--width",
          "8",
          "--auto-expand",
          "--output",
          outPath,
        ],
        { deps, buildFn },
      );
      expect(calls).toBe(2);
      expect(rc).toBe(0);
      const payload = JSON.parse(readFileSync(outPath, "utf-8"));
      expect(payload.edges).toHaveLength(1); // first pass preserved
    });

    it("spends its one retry on a ZeroEdgeBuildError from the first pass, returning 3 if the retry also produces 0 edges", async () => {
      let calls = 0;
      const buildFn = async (): Promise<string> => {
        calls += 1;
        throw new ZeroEdgeBuildError("0 edges produced; refusing to write");
      };
      const deps = depsFor(async () => jsonResp(200, { data: [] }));
      const rc = await runThemeCli(
        ["--theme", "Theme Two", "--depth", "1", "--seeds", "5", "--width", "8", "--auto-expand"],
        { deps, buildFn },
      );
      expect(calls).toBe(2);
      expect(rc).toBe(3);
    });

    it("maps a retry-after-zero-edges IncompleteBuildError to exit 4", async () => {
      let calls = 0;
      const buildFn = async (): Promise<string> => {
        calls += 1;
        if (calls === 1) throw new ZeroEdgeBuildError("0 edges");
        throw new IncompleteBuildError("upstream outage");
      };
      const deps = depsFor(async () => jsonResp(200, { data: [] }));
      const rc = await runThemeCli(["--theme", "Theme Three", "--auto-expand"], {
        deps,
        buildFn,
      });
      expect(calls).toBe(2);
      expect(rc).toBe(4);
    });
  });
});

describe("defaultDeps' fetchImpl — abort timer must cover the body read, not just headers (M6 LOW)", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.useRealTimers();
  });

  it("the abort timer stays armed through resp.json(), not just until fetch() resolves", async () => {
    vi.useFakeTimers();
    let sawAbort = false;
    globalThis.fetch = vi.fn(
      (_url: string, opts: { signal: AbortSignal }) =>
        Promise.resolve({
          status: 200,
          json: () =>
            new Promise((_resolve, reject) => {
              // A server that sent headers but is stalled on the body:
              // this promise only ever settles if the SAME timer/signal
              // that governed the initial fetch() call also covers this
              // read. If the implementation cleared the timer as soon as
              // fetch() resolved (the bug), this abort listener never
              // fires and the promise hangs forever.
              opts.signal.addEventListener("abort", () => {
                sawAbort = true;
                reject(new DOMException("aborted", "AbortError"));
              });
            }),
        }) as unknown as Promise<Response>,
    ) as unknown as typeof fetch;

    const deps = defaultDeps(mkdtempSync(join(tmpdir(), "cli-defaultdeps-")));
    const respPromise = deps.fetchImpl("https://example.invalid/x", {
      method: "GET",
      timeoutMs: 50,
    });
    const resp = await respPromise;
    const jsonPromise = resp.json().catch(() => "aborted");

    await vi.advanceTimersByTimeAsync(100);
    const result = await jsonPromise;

    expect(sawAbort).toBe(true);
    expect(result).toBe("aborted");
  });
});

// L10 (P5 tier-A review): this CLI's `defaultDeps` used to hard-code
// `join(repoRoot, "paperpilot", ".env")` -- a literal that bypasses the
// A0 layout switch entirely, so flipping `LAYOUT_MODE` to `"p5"`
// (`data/config/.env`) would silently leave it reading the WRONG
// location (or nothing), unlike `buildLineageCli.ts`'s own `envFilePath`
// (p5-plan.md §2 A2 follow-up #19), which this mirrors.
describe("envFilePath (L10: loads .env through the layout like buildLineageCli)", () => {
  it("legacy: paperpilot/.env (byte-identical to the pre-change hard-coded path, tier-A inert)", () => {
    expect(envFilePath("/repo", "legacy")).toBe(join("/repo", "paperpilot", ".env"));
  });

  it("p5: inside layout.config, alongside config.yaml (data/config/.env)", () => {
    expect(envFilePath("/repo", "p5")).toBe(join("/repo", "data", "config", ".env"));
  });

  it("defaults to the current LAYOUT_MODE when no mode is given", () => {
    expect(envFilePath("/repo")).toBe(envFilePath("/repo", LAYOUT_MODE));
  });
});
