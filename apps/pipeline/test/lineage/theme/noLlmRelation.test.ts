/**
 * R2-24 (design 41): lineage generation with no LLM at all — the
 * `api_citation` edge, when the no-LLM path may state it, and how the
 * builders use it (`theme/noLlmRelation.ts`, `bfs.ts`).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { FetchInit, HttpResponseLike } from "../../../src/collect/http/requestWithRetry.js";
import {
  CLASSIFICATION_METHODS,
  validateLineageArtifact,
} from "../../../src/lineage/contract/v1.js";
import type { FetchRelatedDeps } from "../../../src/lineage/shared/fetchRelated.js";
import { runBfsAndDescendants } from "../../../src/lineage/theme/bfs.js";
import { evidenceClassifiedRate } from "../../../src/lineage/theme/classificationGate.js";
import {
  API_CITATION_CONFIDENCE,
  apiCitationEdge,
  makeEdge,
} from "../../../src/lineage/theme/edges.js";
import {
  citationListSource,
  classifyPairApiOnly,
  classifyWithoutLlm,
  newNoLlmCounters,
  noLlmProvenance,
} from "../../../src/lineage/theme/noLlmRelation.js";
import type { ThemePaper } from "../../../src/lineage/theme/openalexWork.js";
import type { PairLookup, S2CitationSource } from "../../../src/lineage/theme/s2Citations.js";
import {
  newS2RelationStats,
  type S2RelationContext,
} from "../../../src/lineage/theme/s2Relations.js";

const cited = { paperId: "openalex:W1", title: "Graph Attention Networks", year: 2017 };
const citing = { paperId: "openalex:W2", title: "A Later Graph Paper", year: 2020 };

function staticS2(answer: (citing: string, cited: string) => PairLookup): S2RelationContext {
  const source = {
    lookup: async (c: Record<string, unknown>, d: Record<string, unknown>) =>
      answer(String(c.paperId), String(d.paperId)),
  } as unknown as S2CitationSource;
  return { source, provider: null, stats: newS2RelationStats() };
}

const pair = (contexts: string[], found = true): PairLookup => ({
  kind: "pair",
  signals: { found, intents: [], contexts, isInfluential: true },
});

describe("apiCitationEdge", () => {
  it("claims only the citation: baseline_only, method api_citation, the list named", () => {
    const e = apiCitationEdge(cited, citing, "openalex");
    expect(e.relation).toBe("baseline_only");
    expect(e.provenance).toBe("api_citation");
    expect(e.confidence).toBe(API_CITATION_CONFIDENCE);
    expect(e.rationale).toContain("OpenAlex の参考文献リストで確認");
    expect(e.rationale).toContain("参照/背景");
    expect(e.evidence?.source).toBe("openalex");
    expect(e.evidence?.kind).toBe("citation-list");
    expect(e.evidence?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(apiCitationEdge(cited, citing, "semantic_scholar").rationale).toContain(
      "Semantic Scholar の参考文献リスト",
    );
    expect(CLASSIFICATION_METHODS.has("api_citation")).toBe(true);
  });

  it("serialises to a v1-valid theme edge", () => {
    const edge = makeEdge(apiCitationEdge(cited, citing, "openalex"), {
      srcId: cited.paperId,
      dstId: citing.paperId,
      parent: cited,
      child: citing,
      intentRecord: cited,
      provider: null,
    });
    const artifact = {
      schema_version: "lineage-artifact-v1",
      root: citing.paperId,
      nodes: [
        { id: cited.paperId, is_focus: false, title: cited.title, year: cited.year },
        {
          id: citing.paperId,
          is_focus: true,
          title: citing.title,
          year: citing.year,
          seed_paper_id: "arxiv:2001.00001",
        },
      ],
      edges: [edge],
      clusters: [],
      meta: { kind: "theme", generator: "test", generated_at: "2026-10-11T00:00:00Z" },
    };
    const issues = validateLineageArtifact(artifact, { kind: "theme" });
    expect(issues.filter((i) => i.path.includes("edges"))).toEqual([]);
    expect((edge.provenance.classification as Record<string, unknown>).method).toBe("api_citation");
  });

  it("counts as classified in the D3 gate, and is reported as citation-only", () => {
    const r = evidenceClassifiedRate({
      api_citation: 3,
      s2_context_rule: 6,
      citation_heuristic: 1,
    });
    expect(r.classified).toBe(9);
    expect(r.guessed).toBe(1);
    expect(r.referenceOnly).toBe(3);
    expect(r.ratio).toBeCloseTo(0.9);
  });
});

describe("citationListSource", () => {
  it("names the list only when the S2 lookup answered", () => {
    expect(citationListSource("listed", cited, citing)).toBe("semantic_scholar");
    expect(citationListSource("not_listed", cited, citing)).toBe("openalex");
    expect(citationListSource("citing-not-in-s2", cited, citing)).toBe("openalex");
    expect(citationListSource("no-id", cited, citing)).toBe("openalex");
    expect(citationListSource("not_listed", { paperId: "s2:abc" }, citing)).toBe(
      "semantic_scholar",
    );
    expect(citationListSource("not_listed", cited, citing, "semantic_scholar")).toBe(
      "semantic_scholar",
    );
    // S2 not reached this run / no lookup: the sentences were never read.
    expect(citationListSource("fetch-failed", cited, citing)).toBeNull();
    expect(citationListSource(undefined, cited, citing)).toBeNull();
  });
});

describe("classifyWithoutLlm", () => {
  it("turns the year/citation guess into api_citation when S2 answered", async () => {
    const c = newNoLlmCounters();
    const e = await classifyWithoutLlm(cited, cited, citing, c, { lookup: "listed" });
    expect(e?.provenance).toBe("api_citation");
    expect(e?.relation).toBe("baseline_only");
    expect(c.apiCitationEdges).toBe(1);
  });

  it("keeps it an unclassified citation_heuristic guess when S2 could not be reached", async () => {
    const c = newNoLlmCounters();
    const e = await classifyWithoutLlm(cited, cited, citing, c, { lookup: "fetch-failed" });
    expect(e?.provenance).toBe("citation_heuristic");
    expect(c.s2Unreachable).toBe(1);
    // No S2 lookup at all (S2 relations disabled): same.
    const e2 = await classifyWithoutLlm(cited, cited, citing, newNoLlmCounters(), null);
    expect(e2?.provenance).toBe("citation_heuristic");
  });

  it("keeps a far-apart pair (no heuristic signal) as api_citation instead of dropping it", async () => {
    const old = { paperId: "openalex:W0", title: "An Old Paper", year: 2001 };
    const e = await classifyWithoutLlm(old, old, citing, newNoLlmCounters(), {
      lookup: "not_listed",
    });
    expect(e?.provenance).toBe("api_citation");
    expect(e?.evidence?.source).toBe("openalex");
    expect(
      await classifyWithoutLlm(old, old, citing, newNoLlmCounters(), { lookup: "fetch-failed" }),
    ).toBeNull();
  });

  it("drops a pair S2 marks non-influential, like the LLM mode", async () => {
    const rec = { ...cited, _is_influential: false };
    expect(
      await classifyWithoutLlm(rec, cited, citing, newNoLlmCounters(), { lookup: "listed" }),
    ).toBeNull();
  });

  it("keeps the other LLM-free rules (S2 intents) — and the guard still demotes build claims", async () => {
    const rec = { ...cited, _intents: ["methodology"], _is_influential: true };
    const e = await classifyWithoutLlm(rec, cited, citing, newNoLlmCounters(), {
      lookup: "listed",
    });
    expect(e?.provenance).toBe("intent_map");
    expect(e?.relation).toBe("baseline_only");
  });
});

describe("classifyPairApiOnly (conference / deep builders)", () => {
  it("reads a strong claim from a quoted build cue (rule stands, no LLM)", async () => {
    const s2 = staticS2(() =>
      pair(["We build on Graph Attention Networks [7] and extend its attention to edges."]),
    );
    const e = await classifyPairApiOnly(
      cited,
      citing,
      cited,
      s2,
      newNoLlmCounters(),
      "semantic_scholar",
    );
    expect(e?.provenance).toBe("s2_context_rule");
    expect(e?.relation).toBe("extends");
    expect(e?.rationale).toContain("引用文");
  });

  it("falls back to api_citation when the contexts state no relation", async () => {
    const c = newNoLlmCounters();
    const s2 = staticS2(() => pair([], true));
    const e = await classifyPairApiOnly(cited, citing, cited, s2, c, "semantic_scholar");
    expect(e?.provenance).toBe("api_citation");
    expect(e?.evidence?.source).toBe("semantic_scholar");
    expect(c.apiCitationEdges).toBe(1);
  });

  it("labels an explicit new version by its title, before S2", async () => {
    const v1 = {
      paperId: "a",
      title: "FlashAttention: Fast and Memory-Efficient Exact Attention",
      year: 2022,
    };
    const v2 = {
      paperId: "b",
      title: "FlashAttention-2: Faster Attention with Better Parallelism",
      year: 2023,
    };
    const s2 = staticS2(() => {
      throw new Error("S2 must not be asked");
    });
    const e = await classifyPairApiOnly(v1, v2, v1, s2, newNoLlmCounters(), "semantic_scholar");
    expect(e?.provenance).toBe("title_version");
    expect(e?.relation).toBe("supersedes");
  });

  it("refuses an S2 context carrying an LLM provider", async () => {
    const s2 = { ...staticS2(() => pair([])), provider: {} as never };
    await expect(
      classifyPairApiOnly(cited, citing, cited, s2, newNoLlmCounters(), "semantic_scholar"),
    ).rejects.toThrow(/provider must be null/);
  });

  it("noLlmProvenance: no provider/model/prompt, evidence hash of the rule input; never for llm", () => {
    const derived = apiCitationEdge(cited, citing, "semantic_scholar");
    const prov = noLlmProvenance(derived, {
      producerName: "p",
      producerVersion: "v",
      classificationSchemaVersion: "relation-classification-v1",
      srcId: "a",
      dstId: "b",
      parent: cited,
      child: citing,
      intentRecord: cited,
    }) as { classification: Record<string, unknown>; evidence: Record<string, unknown> };
    expect(prov.classification.method).toBe("api_citation");
    expect(prov.classification.provider).toBeNull();
    expect(prov.classification.prompt_version).toBeNull();
    expect(prov.evidence.sha256).toBe(derived.evidence?.sha256);
    expect(() =>
      noLlmProvenance(
        { ...derived, provenance: "llm" },
        {
          producerName: "p",
          producerVersion: "v",
          classificationSchemaVersion: "s",
          srcId: "a",
          dstId: "b",
          parent: cited,
          child: citing,
          intentRecord: cited,
        },
      ),
    ).toThrow();
  });
});

// ---- the theme BFS in the no-LLM mode ----

function jsonResp(status: number, body: unknown): HttpResponseLike {
  return { status, json: async () => body };
}

function paper(pid: string, title: string, year: number): ThemePaper {
  return {
    paperId: pid,
    title,
    year,
    venue: "NeurIPS",
    citationCount: 100,
    abstract: "a".repeat(80),
    authors: [],
    externalIds: {},
  };
}

let cacheDir: string;
beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "nollm-bfs-"));
});

describe("runBfsAndDescendants with apiCitations (no-LLM mode)", () => {
  const seed = paper("seed", "Seed Method", 2023);
  const far = paper("far", "A Far Older Paper", 2010); // no year/citation signal
  const near = paper("near", "A Recent Paper", 2021); // year_cite guess
  const entry = (p: ThemePaper) => ({ citedPaper: p, isInfluential: true, intents: [] });
  function deps(): FetchRelatedDeps {
    return {
      fetchImpl: async (url: string, _init: FetchInit) => {
        if (url.includes("/references")) return jsonResp(200, { data: [entry(far), entry(near)] });
        if (url.includes("/citations")) return jsonResp(200, { data: [] });
        throw new Error(`unexpected ${url}`);
      },
      cacheDir,
      sleep: async () => {},
      logger: { warn: () => {} },
    };
  }
  // S2 lists `far` without contexts; `near`'s citing paper could not be fetched.
  const s2 = () =>
    staticS2((_c, d) =>
      d === "far" ? pair([], true) : { kind: "no_s2_data", reason: "fetch-failed" },
    );
  const opts = {
    depth: 1,
    width: 4,
    maxSeedCite: 10 ** 9,
    provider: null,
    llmStrict: "off",
    currentYear: 2026,
  };

  it("emits api_citation where S2 answered, a guess where it did not", async () => {
    const r = await runBfsAndDescendants(
      [seed],
      { ...opts, s2Relations: s2(), apiCitations: true },
      deps(),
    );
    const method = (src: string) =>
      (r.edges.find((e) => e.src === src)?.provenance.classification as Record<string, unknown>)
        ?.method;
    expect(method("far")).toBe("api_citation");
    expect(method("near")).toBe("citation_heuristic");
    expect(r.apiCitations).toBe(1);
    expect(r.s2Unreachable).toBe(1);
    expect(r.llmCalls).toBe(0);
  });

  it("without the mode (legacy / LLM mode with no provider) nothing changes", async () => {
    const r = await runBfsAndDescendants([seed], { ...opts, s2Relations: s2() }, deps());
    expect(r.edges.some((e) => e.src === "far")).toBe(false);
    const near = r.edges.find((e) => e.src === "near");
    expect((near?.provenance.classification as Record<string, unknown> | undefined)?.method).toBe(
      "citation_heuristic",
    );
    expect(r.apiCitations).toBe(0);
  });
});
