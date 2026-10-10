/**
 * Vitest port of the cache-v2 tests in
 * `paperpilot/tests/test_build_theme_lineage_p2t.py`
 * (`_ThemeCachedClassifyProvider`, safety contract LIN-41).
 */
import { describe, expect, it } from "vitest";
import type {
  ClassifyPaperLike,
  LLMProvider,
  PaperEvaluation,
  RelationClassification,
} from "../../../src/collect/llm/provider.js";
import type { ClassificationCache } from "../../../src/lineage/classify/cache.js";
import { canonicalJsonSha256, makeProvenance } from "../../../src/lineage/contract/v1.js";
import { buildClassifyPrompt, CLASSIFY_SEMANTIC_VERSION } from "../../../src/lineage/llm/base.js";
import {
  CONTEXT_PROMPT_VERSION,
  CONTEXT_SEMANTIC_VERSION,
  parseContextAnswer,
} from "../../../src/lineage/llm/contextPrompt.js";
import {
  ThemeCachedClassifyProvider,
  type ThemeProducerIdentity,
} from "../../../src/lineage/theme/cachedClassifyProvider.js";

class StubProvider implements LLMProvider {
  enabled = true;
  batchSize = 1;
  calls = 0;
  constructor(
    private readonly result: RelationClassification | null,
    readonly name = "test-provider",
    readonly model = "test-model",
  ) {}
  async evaluateBatch(): Promise<(PaperEvaluation | null)[]> {
    return [];
  }
  async chat(): Promise<string | null> {
    return null;
  }
  async completeJson(): Promise<string | null> {
    throw new Error("not implemented");
  }
  async classifyRelation(
    _a: ClassifyPaperLike,
    _b: ClassifyPaperLike,
  ): Promise<RelationClassification | null> {
    this.calls += 1;
    return this.result;
  }
}

function paper(graphId: string, arxivId: string | null): ClassifyPaperLike {
  return {
    paperId: graphId,
    title: "A paper",
    year: 2024,
    venue: "arXiv",
    citationCount: 10,
    abstract: "A sufficiently specific abstract for deterministic tests.",
    authors: [],
    externalIds: arxivId === null ? {} : { ArXiv: arxivId },
  };
}

function classification(): RelationClassification {
  return {
    relation: "extends",
    confidence: 0.87,
    rationale: "B は A の注意機構を長文コンテキストへ拡張している",
  };
}

const IDENTITY: ThemeProducerIdentity = {
  producerName: "paperpilot.scripts.build_theme_lineage",
  producerVersion: "p2t-v1",
  promptVersion: "relation-prompt-v2",
  classificationSchemaVersion: "relation-classification-v1",
};

function wrap(inner: LLMProvider, cache: ClassificationCache): ThemeCachedClassifyProvider {
  return new ThemeCachedClassifyProvider(inner, cache, IDENTITY, { cachePath: null });
}

describe("ThemeCachedClassifyProvider (cache v3, provider-agnostic)", () => {
  it("writes a v3-keyed entry with the required shape on a miss, and replays it on the next exact hit", async () => {
    const cache: ClassificationCache = {};
    const first = new StubProvider(classification());
    const wrapped = wrap(first, cache);
    const a = paper("a", "2301.00001");
    const b = paper("b", "2401.00001");
    const result = await wrapped.classifyRelation(a, b);
    expect(result).not.toBeNull();
    expect(first.calls).toBe(1);

    const key = Object.keys(cache)[0];
    // R2-20: written under the semantic (v4) key.
    expect(key?.startsWith("v4:")).toBe(true);
    const entry = cache[key as string] as Record<string, any>;
    expect(new Set(Object.keys(entry))).toEqual(
      new Set(["status", "expires_at", "cache_identity", "classification", "provenance"]),
    );
    // The key identity carries no provider/model; the provenance names the producer.
    expect(entry.cache_identity.provider).toBeUndefined();
    expect(entry.cache_identity.model).toBeUndefined();
    expect(entry.cache_identity.version).toBe("lineage-classification-cache-v4");
    expect(entry.cache_identity.semantic_version).toBe(CLASSIFY_SEMANTIC_VERSION);
    expect(entry.cache_identity.evidence_sha256).toBeUndefined();
    expect(entry.provenance.classification.provider).toBe("test-provider");
    expect(entry.provenance.classification.model).toBe("test-provider:test-model");

    const second = new StubProvider(null);
    const replay = wrap(second, cache);
    const replayed = await replay.classifyRelation(a, b);
    expect(replayed?.relation).toBe("extends");
    expect(second.calls).toBe(0);
  });

  // `any` is deliberate here: each mutator reaches several levels into
  // the cache entry's nested shape (`cache_identity.producer.version`,
  // `provenance.evidence.sha256`), and typing that out fully would add
  // more noise than the type safety is worth for a test-only mutator.
  // biome-ignore lint/suspicious/noExplicitAny: see comment above.
  it.each<[string, (entry: Record<string, any>) => void]>([
    ["status != success", (entry) => (entry.status = "failure")],
    ["expired", (entry) => (entry.expires_at = "2000-01-01T00:00:00Z")],
    ["provenance without a producer", (entry) => (entry.provenance.classification.provider = null)],
    [
      "provenance method not llm",
      (entry) => (entry.provenance.classification.method = "intent_map"),
    ],
    ["semantic_version mismatch", (entry) => (entry.cache_identity.semantic_version = "old")],
    [
      "provenance schema_version mismatch",
      (entry) => (entry.provenance.classification.schema_version = "old"),
    ],
    ["provenance producer mismatch", (entry) => (entry.provenance.producer.name = "other")],
    ["schema_version mismatch", (entry) => (entry.cache_identity.schema_version = "old")],
    ["producer version mismatch", (entry) => (entry.cache_identity.producer.version = "old")],
    ["inputs_sha256 mismatch", (entry) => (entry.cache_identity.inputs_sha256 = "0".repeat(64))],
    ["src mismatch", (entry) => (entry.cache_identity.src = "other")],
  ])("treats a mismatched/expired/failed cache entry as a miss (%s)", async (_label, mutate) => {
    const cache: ClassificationCache = {};
    const a = paper("a", "2301.00001");
    const b = paper("b", "2401.00001");
    await wrap(new StubProvider(classification()), cache).classifyRelation(a, b);
    const entry = Object.values(cache)[0] as Record<string, any>;
    mutate(entry);
    const inner = new StubProvider(null);
    const result = await wrap(inner, cache).classifyRelation(a, b);
    expect(result).toBeNull();
    expect(inner.calls).toBe(1);
  });

  it("a legacy v1-shaped key, and a changed endpoint/evidence, are both misses", async () => {
    const cache: ClassificationCache = {
      "a->b": {
        relation: "extends",
        confidence: 0.9,
        rationale: "legacy cache rationale that must not replay",
      },
    };
    const inner = new StubProvider(null);
    const wrapped = wrap(inner, cache);
    const a = paper("a", "2301.00001");
    const b = paper("b", "2401.00001");
    expect(await wrapped.classifyRelation(a, b)).toBeNull();
    const changedTitle = { ...b, title: "Changed classifier input" };
    expect(await wrapped.classifyRelation(a, changedTitle)).toBeNull();
    expect(await wrapped.classifyRelation(a, { ...b, paperId: "c" })).toBeNull();
    expect(inner.calls).toBe(3);
  });

  it("never caches a failed (null) inner classification", async () => {
    const cache: ClassificationCache = {};
    const inner = new StubProvider(null);
    const result = await wrap(inner, cache).classifyRelation(
      paper("a", "2301.00001"),
      paper("b", "2401.00001"),
    );
    expect(result).toBeNull();
    expect(cache).toEqual({});
  });

  it("skips the cache entirely when either paper lacks a paperId", async () => {
    const cache: ClassificationCache = {};
    const inner = new StubProvider(classification());
    const result = await wrap(inner, cache).classifyRelation({}, paper("b", "2401.00001"));
    expect(result).not.toBeNull();
    expect(cache).toEqual({});
  });

  it("reuses an answer across providers and reports who produced it (Groq run -> Gemini run)", async () => {
    const cache: ClassificationCache = {};
    const a = paper("a", "2301.00001");
    const b = paper("b", "2401.00001");
    const groq = new StubProvider(classification(), "groq", "openai/gpt-oss-120b");
    await wrap(groq, cache).classifyRelation(a, b);
    const gemini = new StubProvider(null, "gemini", "gemini-2.5-flash");
    const replayed = await wrap(gemini, cache).classifyRelation(a, b);
    expect(gemini.calls).toBe(0);
    expect(replayed?.relation).toBe("extends");
    expect(replayed?.producedBy).toEqual({ provider: "groq", model: "groq:openai/gpt-oss-120b" });
  });

  it("records the fallback member that actually answered (producedBy from the inner chain)", async () => {
    const cache: ClassificationCache = {};
    const inner = new StubProvider(
      { ...classification(), producedBy: { provider: "gemini", model: "gemini:gemini-2.5-flash" } },
      "groq",
      "openai/gpt-oss-120b",
    );
    const r = await wrap(inner, cache).classifyRelation(paper("a", null), paper("b", null));
    expect(r?.producedBy?.provider).toBe("gemini");
    const entry = Object.values(cache)[0] as Record<string, any>;
    expect(entry.provenance.classification.provider).toBe("gemini");
    expect(entry.provenance.classification.model).toBe("gemini:gemini-2.5-flash");
  });

  it("still hits a fresh pre-R2-6 v2 entry for its own provider/model", async () => {
    const a = paper("a", "2301.00001");
    const b = paper("b", "2401.00001");
    const [system, user] = buildClassifyPrompt(a, b);
    const evidence = canonicalJsonSha256({ src: "a", dst: "b", system, user });
    const identity = {
      version: "lineage-classification-cache-v2",
      src: "a",
      dst: "b",
      evidence_sha256: evidence,
      producer: { name: IDENTITY.producerName, version: IDENTITY.producerVersion },
      provider: "groq",
      model: "groq:openai/gpt-oss-120b",
      prompt_version: IDENTITY.promptVersion,
      schema_version: IDENTITY.classificationSchemaVersion,
    };
    const cache: ClassificationCache = {
      [`v2:${canonicalJsonSha256(identity)}`]: {
        status: "success",
        expires_at: "2999-01-01T00:00:00Z",
        cache_identity: identity,
        classification: classification(),
        provenance: makeProvenance({
          producerName: IDENTITY.producerName,
          producerVersion: IDENTITY.producerVersion,
          evidenceSource: "semantic_scholar",
          evidenceKind: "relation-input",
          evidenceSha256: evidence,
          method: "llm",
          provider: "groq",
          model: "groq:openai/gpt-oss-120b",
          promptVersion: IDENTITY.promptVersion,
          classificationSchemaVersion: IDENTITY.classificationSchemaVersion,
        }),
      },
    };
    const inner = new StubProvider(null, "groq", "openai/gpt-oss-120b");
    const r = await wrap(inner, cache).classifyRelation(a, b);
    expect(inner.calls).toBe(0);
    expect(r?.relation).toBe("extends");
  });

  it("persists after every successful answer (so a later failed run keeps them)", async () => {
    const cache: ClassificationCache = {};
    const persisted: number[] = [];
    const wrapped = new ThemeCachedClassifyProvider(
      new StubProvider(classification()),
      cache,
      IDENTITY,
      {
        cachePath: "/tmp/x/classifications.json",
        existsSync: () => true,
        persist: async (c) => {
          persisted.push(Object.keys(c).length);
        },
      },
    );
    await wrapped.classifyRelation(paper("a", null), paper("b", null));
    await wrapped.classifyRelation(paper("a", null), paper("c", null));
    expect(persisted).toEqual([1, 2]);
  });

  it("R2-20: a v4 hit survives a wording-only prompt change (provenance text hash / prompt version not compared)", async () => {
    const cache: ClassificationCache = {};
    const a = paper("a", "2301.00001");
    const b = paper("b", "2401.00001");
    await wrap(new StubProvider(classification()), cache).classifyRelation(a, b);
    const entry = Object.values(cache)[0] as Record<string, any>;
    // What a later copy edit of the system prompt / a provenance version
    // bump changes in the stored entry relative to the current run.
    entry.provenance.evidence.sha256 = "0".repeat(64);
    entry.provenance.classification.prompt_version = "relation-prompt-v3";
    const inner = new StubProvider(null);
    const r = await wrap(inner, cache).classifyRelation(a, b);
    expect(inner.calls).toBe(0);
    expect(r?.relation).toBe("extends");
  });

  it("R2-20: changed input data (abstract) is a miss", async () => {
    const cache: ClassificationCache = {};
    const a = paper("a", "2301.00001");
    const b = paper("b", "2401.00001");
    await wrap(new StubProvider(classification()), cache).classifyRelation(a, b);
    const inner = new StubProvider(null);
    await wrap(inner, cache).classifyRelation(a, { ...b, abstract: "Another abstract entirely." });
    expect(inner.calls).toBe(1);
  });

  it("R2-20: a fresh v3 (prompt-text) entry still hits and is copied to its v4 key", async () => {
    const a = paper("a", "2301.00001");
    const b = paper("b", "2401.00001");
    const [system, user] = buildClassifyPrompt(a, b);
    const evidence = canonicalJsonSha256({ src: "a", dst: "b", system, user });
    const identity = {
      version: "lineage-classification-cache-v3",
      src: "a",
      dst: "b",
      evidence_sha256: evidence,
      producer: { name: IDENTITY.producerName, version: IDENTITY.producerVersion },
      prompt_version: IDENTITY.promptVersion,
      schema_version: IDENTITY.classificationSchemaVersion,
    };
    const cache: ClassificationCache = {
      [`v3:${canonicalJsonSha256(identity)}`]: {
        status: "success",
        expires_at: "2999-01-01T00:00:00Z",
        cache_identity: identity,
        classification: classification(),
        provenance: makeProvenance({
          producerName: IDENTITY.producerName,
          producerVersion: IDENTITY.producerVersion,
          evidenceSource: "semantic_scholar",
          evidenceKind: "relation-input",
          evidenceSha256: evidence,
          method: "llm",
          provider: "groq",
          model: "groq:openai/gpt-oss-120b",
          promptVersion: IDENTITY.promptVersion,
          classificationSchemaVersion: IDENTITY.classificationSchemaVersion,
        }),
      },
    };
    const inner = new StubProvider(null);
    const r = await wrap(inner, cache).classifyRelation(a, b);
    expect(inner.calls).toBe(0);
    expect(r?.producedBy).toEqual({ provider: "groq", model: "groq:openai/gpt-oss-120b" });
    expect(Object.keys(cache).some((k) => k.startsWith("v4:"))).toBe(true);
  });

  it("R2-20: context answers — semantic key, lookup/store without a call, wording-proof", async () => {
    const cache: ClassificationCache = {};
    const answer = {
      refers_to_cited: true,
      relation: "builds_on",
      contrast: false,
      confidence: 0.8,
      rationale: "GraphSAGE は GCN の近傍集約を土台にしている。",
    };
    const inner = new StubProvider(null);
    const w = wrap(inner, cache);
    const inputs = { cited: { title: "GCN" }, citing: { title: "GraphSAGE" }, sentences: ["s"] };
    const req = (system: string) => ({
      src: "a",
      dst: "b",
      system,
      user: "u",
      promptVersion: CONTEXT_PROMPT_VERSION,
      semantic: { version: CONTEXT_SEMANTIC_VERSION, inputs },
    });
    expect(w.lookupJsonAnswer(req("sys v1"), parseContextAnswer)).toBeNull();
    await w.storeJsonAnswer(req("sys v1"), answer, { provider: "groq", model: "groq:m" });
    // A reworded system prompt with the same semantic version and inputs hits.
    const hit = w.lookupJsonAnswer(req("sys v1, reworded"), parseContextAnswer);
    expect(hit?.value.relation).toBe("builds_on");
    expect(hit?.producedBy).toEqual({ provider: "groq", model: "groq:m" });
    // A new semantic version misses.
    expect(
      w.lookupJsonAnswer(
        { ...req("sys v1"), semantic: { version: "context-semantic-v2", inputs } },
        parseContextAnswer,
      ),
    ).toBeNull();
    expect(inner.calls).toBe(0);
  });
});
