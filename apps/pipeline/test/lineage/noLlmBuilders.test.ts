/**
 * R2-24 (design 41): the conference builder with no LLM — no
 * provider is built; relations come from Semantic Scholar citation
 * contexts (rules), the LLM-free rules and `api_citation`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type BuildLineageDeps, build } from "../../src/lineage/conference/buildLineage.js";
import {
  LINEAGE_LLM_ENV,
  LineageLlmModeError,
  resolveLineageLlm,
} from "../../src/lineage/shared/lineageLlm.js";
import type { PairLookup, S2CitationSource } from "../../src/lineage/theme/s2Citations.js";

const PAPER_ID_ONE = "1".repeat(40);

function responses(focusArxiv: string, focusTitle: string) {
  return {
    [`https://api.semanticscholar.org/graph/v1/paper/arXiv:${focusArxiv}`]: {
      paperId: "S2FOCUS",
      title: focusTitle,
      year: 2026,
      venue: "arXiv",
      citationCount: 0,
      authors: [{ name: "A. Author" }],
      abstract: "Focus abstract.",
      externalIds: { ArXiv: focusArxiv },
    },
    "https://api.semanticscholar.org/graph/v1/paper/S2FOCUS/references": {
      data: [
        {
          citedPaper: {
            paperId: "S2PARENT",
            title: "Parent Paper",
            year: 2020,
            venue: "NeurIPS",
            citationCount: 100,
            authors: [{ name: "B. Author" }],
            abstract: "Parent abstract.",
            externalIds: {},
          },
          isInfluential: true,
          intents: ["methodology"],
        },
      ],
    },
    "https://api.semanticscholar.org/graph/v1/paper/S2FOCUS/citations": {
      data: [
        {
          citingPaper: {
            paperId: "S2CHILD",
            title: "Child Paper",
            year: 2027,
            venue: "ICML",
            citationCount: 3,
            authors: [{ name: "C. Author" }],
            abstract: "Child abstract.",
            externalIds: {},
          },
          isInfluential: true,
          intents: [],
        },
      ],
    },
  } as Record<string, unknown>;
}

let tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

function makeDeps(canned: Record<string, unknown>): BuildLineageDeps {
  const cacheDir = mkdtempSync(join(tmpdir(), "nollm-builders-"));
  tmpDirs.push(cacheDir);
  return {
    cacheDir,
    sleep: async () => {},
    fetchImpl: async (url: string) => {
      const body = canned[url.split("?")[0] as string];
      if (body === undefined) throw new Error(`no canned response for ${url}`);
      return { status: 200, json: async () => body };
    },
  };
}

/** S2 says: the focus paper builds on the parent (a quoted cue); the
 * child's reference list is not in S2. */
function s2Source(): S2CitationSource {
  return {
    lookup: async (citing: Record<string, unknown>, cited: Record<string, unknown>) => {
      if (citing.paperId === "S2FOCUS" && cited.paperId === "S2PARENT") {
        return {
          kind: "pair",
          signals: {
            found: true,
            intents: ["methodology"],
            contexts: ["We build on Parent Paper [4] and extend its encoder to graphs."],
            isInfluential: true,
          },
        } satisfies PairLookup;
      }
      return { kind: "no_s2_data", reason: "citing-not-in-s2" } satisfies PairLookup;
    },
  } as unknown as S2CitationSource;
}

const STRONG = new Set(["extends", "successor", "supersedes", "contrasts"]);

function methodsOf(edges: Record<string, unknown>[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of edges) {
    const c = (e.provenance as { classification: { method: string; provider: unknown } })
      .classification;
    expect(c.provider).toBeNull();
    out[`${e.src}->${e.dst}`] = `${e.relation}/${c.method}`;
  }
  return out;
}

describe("conference build() with provider null (no-LLM mode)", () => {
  function docsRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "nollm-conf-"));
    tmpDirs.push(root);
    const dir = join(root, "docs", "testconf");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "papers.json"),
      JSON.stringify([
        { paper_id: PAPER_ID_ONE, title: "Oral Paper One", type: "Oral", arxiv_id: "2601.00001" },
      ]),
    );
    return join(root, "docs");
  }

  it("reads the quoted cue as extends and keeps the context-less citation as api_citation", async () => {
    const docs = docsRoot();
    const result = await build(
      {
        docsRoot: docs,
        repoRoot: docs,
        conference: "testconf",
        generatedAt: "2026-10-11T00:00:00Z",
        provider: null,
        rateDelayMs: 0,
        s2Citations: s2Source(),
      },
      makeDeps(responses("2601.00001", "Oral Paper One")),
    );
    expect(methodsOf(result.edges as Record<string, unknown>[])).toEqual({
      "S2PARENT->S2FOCUS": "extends/s2_context_rule",
      "S2FOCUS->S2CHILD": "baseline_only/api_citation",
    });
    expect((result.meta as Record<string, unknown>).lineage_llm).toBe("off");
  });

  it("without S2 contexts it keeps the LLM-free heuristics (never a strong unquoted claim)", async () => {
    const docs = docsRoot();
    const result = await build(
      {
        docsRoot: docs,
        repoRoot: docs,
        conference: "testconf",
        generatedAt: "2026-10-11T00:00:00Z",
        provider: null,
        rateDelayMs: 0,
      },
      makeDeps(responses("2601.00001", "Oral Paper One")),
    );
    for (const e of result.edges as Record<string, unknown>[]) {
      expect(STRONG.has(e.relation as string)).toBe(false);
    }
  });
});

describe("resolveLineageLlm", () => {
  it("flag, then PAPERPILOT_LINEAGE_LLM, then the caller's default; typos are errors", () => {
    expect(resolveLineageLlm("on", { [LINEAGE_LLM_ENV]: "off" }, "off")).toBe("on");
    expect(resolveLineageLlm(null, { [LINEAGE_LLM_ENV]: " OFF " }, "on")).toBe("off");
    expect(resolveLineageLlm(null, { [LINEAGE_LLM_ENV]: "on" }, "off")).toBe("on");
    expect(resolveLineageLlm(null, {}, "off")).toBe("off");
    expect(resolveLineageLlm(null, { [LINEAGE_LLM_ENV]: "" }, "on")).toBe("on");
    expect(() => resolveLineageLlm(null, { [LINEAGE_LLM_ENV]: "of" }, "off")).toThrow(
      LineageLlmModeError,
    );
  });
});
