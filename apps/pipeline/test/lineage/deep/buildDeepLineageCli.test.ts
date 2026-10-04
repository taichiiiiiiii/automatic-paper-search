/**
 * CLI-level tests for `runBuildDeepLineageCli` — exit codes (LIN-12,
 * LIN-13, LIN-14 of docs/migration/safety-contracts.md).
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
  type RunBuildDeepLineageCliDeps,
  runBuildDeepLineageCli,
} from "../../../src/lineage/deep/buildDeepLineageCli.js";

const SEED_PAPER_ID = "1".repeat(40);

class FakeProvider implements LLMProvider {
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
    return JSON.stringify({ relation: "extends", confidence: 0.6, rationale: "" });
  }
}

let tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

function makeDeps(fetchImpl: RunBuildDeepLineageCliDeps["fetchImpl"]): RunBuildDeepLineageCliDeps {
  const cacheDir = mkdtempSync(join(tmpdir(), "build-deep-cli-cache-"));
  tmpDirs.push(cacheDir);
  return {
    cacheDir,
    sleep: async () => {},
    fetchImpl,
    buildProvider: () => ({ provider: new FakeProvider(), rateDelay: 0 }),
  };
}

describe("runBuildDeepLineageCli", () => {
  it("exit 4 on a subject-resolution outage (LIN-12)", async () => {
    const deps = makeDeps(async () => ({ status: 503, json: async () => ({}) }));
    const code = await runBuildDeepLineageCli(
      parseArgs(["--arxiv-id", "2602.18473", "--seed-paper-id", SEED_PAPER_ID]),
      deps,
    );
    expect(code).toBe(4);
  });

  it("exit 1 when S2 confirms the paper does not exist (404, LIN-12's confirmed-absence branch)", async () => {
    const deps = makeDeps(async () => ({ status: 404, json: async () => ({}) }));
    const code = await runBuildDeepLineageCli(
      parseArgs(["--arxiv-id", "2602.18473", "--seed-paper-id", SEED_PAPER_ID]),
      deps,
    );
    expect(code).toBe(1);
  });

  it("exit 4 when expansion failures would shrink an already-published deep artifact (LIN-13), file untouched", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "build-deep-cli-repo-"));
    tmpDirs.push(repoRoot);
    const outDir = join(repoRoot, "docs", "iclr-2026");
    mkdirSync(outDir, { recursive: true });
    const outPath = join(outDir, "deep-2602.18473.json");
    const published = {
      schema_version: "lineage-artifact-v1",
      root: "S2FOCUS",
      nodes: [
        {
          id: "S2FOCUS",
          title: "Deep Focus Paper",
          is_focus: true,
          seed_paper_id: SEED_PAPER_ID,
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
    writeFileSync(outPath, JSON.stringify(published));

    const deps = makeDeps(async (url: string) => {
      if (url.includes("arXiv:")) {
        return {
          status: 200,
          json: async () => ({
            paperId: "S2FOCUS",
            title: "Deep Focus Paper",
            year: 2026,
            authors: [],
            abstract: "x",
            externalIds: { ArXiv: "2602.18473" },
          }),
        };
      }
      return { status: 503, json: async () => ({}) };
    });
    const code = await runBuildDeepLineageCli(
      parseArgs([
        "--arxiv-id",
        "2602.18473",
        "--seed-paper-id",
        SEED_PAPER_ID,
        "--output",
        outPath,
      ]),
      deps,
      repoRoot,
    );
    expect(code).toBe(4);
    expect(JSON.parse(readFileSync(outPath, "utf8"))).toEqual(published);
  });
});
