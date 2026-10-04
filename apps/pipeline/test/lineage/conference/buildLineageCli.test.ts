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
});
