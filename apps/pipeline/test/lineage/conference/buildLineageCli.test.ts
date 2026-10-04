/**
 * CLI-level tests for `runBuildLineageCli` — exit codes and the "published
 * file is never touched on a refused build" guarantee (LIN-05, LIN-06,
 * LIN-07, LIN-44 of docs/migration/safety-contracts.md).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ClassifyPaperLike,
  LLMProvider,
  PaperEvaluation,
  RelationClassification,
} from "../../../src/collect/llm/provider.js";
import {
  defaultDeps,
  parseArgs,
  type RunBuildLineageCliDeps,
  runBuildLineageCli,
} from "../../../src/lineage/conference/buildLineageCli.js";

const PAPER_ID_ONE = "1".repeat(40);

class FakeDarkProvider implements LLMProvider {
  readonly name = "fake";
  enabled = true;
  batchSize = 1;
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
    return null;
  }
  async completeJson(): Promise<string | null> {
    return null;
  }
}

let tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

function makeRepo(): string {
  const repoRoot = mkdtempSync(join(tmpdir(), "build-lineage-cli-"));
  tmpDirs.push(repoRoot);
  const docsDir = join(repoRoot, "docs", "testconf");
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(
    join(docsDir, "papers.json"),
    JSON.stringify([
      { paper_id: PAPER_ID_ONE, title: "Oral Paper One", type: "Oral", arxiv_id: "2601.00001" },
    ]),
  );
  return repoRoot;
}

function makeDeps(fetchImpl: RunBuildLineageCliDeps["fetchImpl"]): RunBuildLineageCliDeps {
  const cacheDir = mkdtempSync(join(tmpdir(), "build-lineage-cli-cache-"));
  tmpDirs.push(cacheDir);
  return {
    cacheDir,
    sleep: async () => {},
    fetchImpl,
    buildProvider: () => ({ provider: new FakeDarkProvider(), rateDelay: 0 }),
  };
}

describe("runBuildLineageCli", () => {
  it("exit 4 on a subject-resolution outage, and never writes lineage.json", async () => {
    const repoRoot = makeRepo();
    const lineagePath = join(repoRoot, "docs", "testconf", "lineage.json");
    const deps = makeDeps(async () => ({ status: 503, json: async () => ({}) }));
    const code = await runBuildLineageCli(parseArgs(["--conference", "testconf"]), deps, repoRoot);
    expect(code).toBe(4);
    expect(() => readFileSync(lineagePath)).toThrow();
  });

  it("exit 3 when build_provider (here, the injected deps.buildProvider) throws (LIN-44)", async () => {
    const repoRoot = makeRepo();
    const deps = makeDeps(async () => ({ status: 200, json: async () => ({}) }));
    deps.buildProvider = () => {
      throw new Error("No LLM key found.");
    };
    const code = await runBuildLineageCli(parseArgs(["--conference", "testconf"]), deps, repoRoot);
    expect(code).toBe(3);
  });

  it("--allow-incomplete never overrides the subject gate (LIN-07)", async () => {
    const repoRoot = makeRepo();
    const lineagePath = join(repoRoot, "docs", "testconf", "lineage.json");
    const deps = makeDeps(async () => ({ status: 503, json: async () => ({}) }));
    const code = await runBuildLineageCli(
      parseArgs(["--conference", "testconf", "--allow-incomplete"]),
      deps,
      repoRoot,
    );
    expect(code).toBe(4);
    expect(() => readFileSync(lineagePath)).toThrow();
  });

  // LIN-06: build_lineage's references/citations expansion (as opposed to
  // the oral/focus SUBJECT lookup above) can fail independently —
  // `main()` must refuse to shrink an already-published lineage.json and
  // exit 4, leaving the file byte-identical.
  it("exit 4 when expansion failures would shrink an already-published lineage (LIN-06), file untouched", async () => {
    const repoRoot = makeRepo();
    const lineagePath = join(repoRoot, "docs", "testconf", "lineage.json");
    const published = {
      schema_version: "lineage-artifact-v1",
      root: "S2FOCUS",
      nodes: [
        {
          id: "S2FOCUS",
          title: "Oral Paper One",
          is_focus: true,
          seed_paper_id: PAPER_ID_ONE,
          year: 2026,
        },
        { id: "S2PARENT", title: "Parent Paper", is_focus: false, year: 2020 },
      ],
      edges: [
        {
          src: "S2PARENT",
          dst: "S2FOCUS",
          relation: "extends",
          rel: "extends",
          confidence: 0.6,
          conf: 0.6,
        },
      ],
      clusters: [],
      meta: {},
    };
    writeFileSync(lineagePath, JSON.stringify(published));

    // Focus resolves fine (subject gate passes) but references/citations
    // both fail -> an expansion failure, not a subject one.
    const deps = makeDeps(async (url: string) => {
      if (url.includes("arXiv:")) {
        return {
          status: 200,
          json: async () => ({
            paperId: "S2FOCUS",
            title: "Oral Paper One",
            year: 2026,
            authors: [],
            abstract: "x",
            externalIds: { ArXiv: "2601.00001" },
          }),
        };
      }
      return { status: 503, json: async () => ({}) };
    });
    const code = await runBuildLineageCli(parseArgs(["--conference", "testconf"]), deps, repoRoot);
    expect(code).toBe(4);
    expect(JSON.parse(readFileSync(lineagePath, "utf8"))).toEqual(published);
  });

  // LIN-07's other direction (even the Python test suite has no positive
  // test for this): `--allow-incomplete` DOES bypass the EXPANSION gate
  // (unlike the subject gate above) — the same outage that exit-4'd
  // above must now publish successfully.
  it("LIN-07: --allow-incomplete DOES bypass the expansion gate (positive direction), publishing despite the same outage", async () => {
    const repoRoot = makeRepo();
    const lineagePath = join(repoRoot, "docs", "testconf", "lineage.json");
    const published = {
      schema_version: "lineage-artifact-v1",
      root: "S2FOCUS",
      nodes: [
        {
          id: "S2FOCUS",
          title: "Oral Paper One",
          is_focus: true,
          seed_paper_id: PAPER_ID_ONE,
          year: 2026,
        },
        { id: "S2PARENT", title: "Parent Paper", is_focus: false, year: 2020 },
      ],
      edges: [
        {
          src: "S2PARENT",
          dst: "S2FOCUS",
          relation: "extends",
          rel: "extends",
          confidence: 0.6,
          conf: 0.6,
        },
      ],
      clusters: [],
      meta: {},
    };
    writeFileSync(lineagePath, JSON.stringify(published));

    const deps = makeDeps(async (url: string) => {
      if (url.includes("arXiv:")) {
        return {
          status: 200,
          json: async () => ({
            paperId: "S2FOCUS",
            title: "Oral Paper One",
            year: 2026,
            authors: [],
            abstract: "x",
            externalIds: { ArXiv: "2601.00001" },
          }),
        };
      }
      return { status: 503, json: async () => ({}) };
    });
    const code = await runBuildLineageCli(
      parseArgs(["--conference", "testconf", "--allow-incomplete"]),
      deps,
      repoRoot,
    );
    expect(code).toBe(0);
    const written = JSON.parse(readFileSync(lineagePath, "utf8"));
    // It published a (smaller) result rather than refusing — exactly the
    // override the subject gate test above showed is NOT available.
    expect(written).not.toEqual(published);
    expect(written.meta.completeness.complete).toBe(false);
  });
});

// M2 of the P4 review: this CLI's entry block used to be a permanent stub
// ("build_lineage CLI wiring (env/provider construction) is not yet
// connected.") that printed a message and exited 1 for every invocation,
// regardless of argv — a CLI that never does the thing it's named for.
// `defaultDeps` is the real wiring the entry block now calls.
describe("defaultDeps (real entry-point wiring, M2)", () => {
  it("constructs real fetchImpl/cacheDir/sleep/buildProvider deps without touching the network", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "build-lineage-defaultdeps-"));
    try {
      const deps = defaultDeps(repoRoot);
      expect(typeof deps.fetchImpl).toBe("function");
      expect(typeof deps.sleep).toBe("function");
      expect(typeof deps.buildProvider).toBe("function");
      expect(deps.cacheDir).toContain("lineage-cache");
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("buildProvider() throws (LLM-44) lazily, not during defaultDeps() construction, when no LLM key is configured", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "build-lineage-defaultdeps-nokey-"));
    try {
      const deps = defaultDeps(repoRoot); // must not throw here
      expect(() => deps.buildProvider()).toThrow(/No LLM key found/);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
