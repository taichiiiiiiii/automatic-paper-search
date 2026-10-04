/**
 * CLI-level tests for `runBuildConferenceLineageCli` — exit codes and the
 * "published file is never touched on a refused build" guarantee (LIN-08,
 * LIN-09, LIN-11 of docs/migration/safety-contracts.md). These complement
 * the real-Python-fixture parity test in `buildConferenceLineage.parity.test.ts`,
 * which covers `buildGraph`'s own output shape; this file exercises the CLI
 * wrapper's gate-then-write ordering, which `buildGraph` alone does not.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HttpResponseLike } from "../../../src/collect/http/requestWithRetry.js";
import type { OpenAlexDeps } from "../../../src/lineage/conference/buildConferenceLineage.js";
import {
  parseArgs,
  runBuildConferenceLineageCli,
} from "../../../src/lineage/conference/buildConferenceLineageCli.js";

const PAPER_ID_ONE = "1".repeat(40);

let tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

function makeRepo(): { repoRoot: string; docsDir: string } {
  const repoRoot = mkdtempSync(join(tmpdir(), "conf-lineage-cli-"));
  tmpDirs.push(repoRoot);
  const docsDir = join(repoRoot, "docs", "testconf");
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(
    join(docsDir, "papers.json"),
    JSON.stringify([
      {
        paper_id: PAPER_ID_ONE,
        title: "Oral Paper One",
        type: "Oral",
        source: "arxiv",
        source_id: "2601.00001",
        arxiv_id: "2601.00001",
      },
    ]),
  );
  return { repoRoot, docsDir };
}

function filterParam(url: string): string {
  return new URL(url).searchParams.get("filter") ?? "";
}

describe("runBuildConferenceLineageCli", () => {
  it("rejects a path-traversal conference slug before reading or writing anything (LIN-11)", async () => {
    const { repoRoot } = makeRepo();
    const deps: OpenAlexDeps = {
      fetchImpl: async () => ({ status: 200, json: async () => ({ results: [] }) }),
    };
    await expect(
      runBuildConferenceLineageCli(parseArgs(["--conference", "../../etc"]), deps, repoRoot),
    ).rejects.toThrow(RangeError);
  });

  it("exit 1 when there are no Oral papers", async () => {
    const { repoRoot, docsDir } = makeRepo();
    writeFileSync(
      join(docsDir, "papers.json"),
      JSON.stringify([{ paper_id: PAPER_ID_ONE, type: "Poster" }]),
    );
    const code = await runBuildConferenceLineageCli(
      parseArgs(["--conference", "testconf"]),
      {
        fetchImpl: async () => ({ status: 200, json: async () => ({ results: [] }) }),
        sleep: async () => {},
      },
      repoRoot,
    );
    expect(code).toBe(1);
  });

  it("exit 4 on a subject-resolution outage, and never writes lineage.json", async () => {
    const { repoRoot, docsDir } = makeRepo();
    const lineagePath = join(docsDir, "lineage.json");
    expect(() => readFileSync(lineagePath)).toThrow();

    const deps: OpenAlexDeps = {
      fetchImpl: async (): Promise<HttpResponseLike> => ({ status: 503, json: async () => ({}) }),
      sleep: async () => {},
    };
    const code = await runBuildConferenceLineageCli(
      parseArgs(["--conference", "testconf"]),
      deps,
      repoRoot,
    );
    expect(code).toBe(4);
    expect(() => readFileSync(lineagePath)).toThrow();
  });

  it("exit 4 when expansion failures would shrink an already-published lineage, and leaves it untouched", async () => {
    const { repoRoot, docsDir } = makeRepo();
    const lineagePath = join(docsDir, "lineage.json");
    const published = {
      schema_version: "lineage-artifact-v1",
      root: "W100",
      nodes: [
        {
          id: "W100",
          title: "Oral Paper One",
          is_focus: true,
          seed_paper_id: PAPER_ID_ONE,
          year: 2026,
        },
        { id: "W200", title: "Reference Paper", is_focus: false, year: 2020 },
        { id: "W300", title: "Citer Paper", is_focus: false, year: 2027 },
      ],
      edges: [
        {
          src: "W200",
          dst: "W100",
          relation: "successor",
          rel: "successor",
          confidence: 0.4,
          conf: 0.4,
        },
        {
          src: "W100",
          dst: "W300",
          relation: "successor",
          rel: "successor",
          confidence: 0.4,
          conf: 0.4,
        },
      ],
      clusters: [],
      meta: {},
    };
    writeFileSync(lineagePath, JSON.stringify(published));

    // Resolve succeeds (so this is an EXPANSION failure, not a subject one),
    // but both the ref-metadata lookup and the citers lookup fail -> the
    // new graph is just the one focus node, smaller than what's published.
    const deps: OpenAlexDeps = {
      fetchImpl: async (url): Promise<HttpResponseLike> => {
        const filt = filterParam(url);
        if (filt.startsWith("title.search:")) {
          return {
            status: 200,
            json: async () => ({
              results: [
                {
                  id: "https://openalex.org/W100",
                  title: "Oral Paper One",
                  publication_year: 2026,
                  authorships: [],
                  primary_location: {},
                  locations: [],
                  ids: { openalex: "https://openalex.org/W100", arxiv: "2601.00001" },
                  doi: null,
                  referenced_works: ["https://openalex.org/W200"],
                  cited_by_count: 10,
                },
              ],
            }),
          };
        }
        return { status: 503, json: async () => ({}) };
      },
      sleep: async () => {},
    };
    const code = await runBuildConferenceLineageCli(
      parseArgs(["--conference", "testconf"]),
      deps,
      repoRoot,
    );
    expect(code).toBe(4);
    expect(JSON.parse(readFileSync(lineagePath, "utf8"))).toEqual(published);
  });
});
