/**
 * Port of the `_CachedClassifyProvider` tests from
 * `paperpilot/tests/test_build_theme_lineage.py` and the
 * `persist_classifications` lock tests from
 * `paperpilot/tests/test_build_lineage.py`.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ClassifyPaperLike,
  LLMProvider,
  PaperEvaluation,
  RelationClassification,
} from "../../../src/collect/llm/provider.js";
import type { Paper } from "../../../src/collect/model/paper.js";
import {
  CachedClassifyProvider,
  persistClassifications,
} from "../../../src/lineage/classify/cache.js";
import {
  acquireClassificationLock,
  releaseClassificationLock,
} from "../../../src/lineage/classify/lock.js";

class FakeProvider implements LLMProvider {
  readonly name = "fake";
  enabled = true;
  batchSize = 5;
  model?: string;
  classifyCalls: Array<[ClassifyPaperLike, ClassifyPaperLike]> = [];
  constructor(private readonly classification: RelationClassification | null) {}
  async evaluateBatch(papers: readonly Paper[]): Promise<(PaperEvaluation | null)[]> {
    return papers.map(() => null);
  }
  async chat(): Promise<string | null> {
    return null;
  }
  async completeJson(): Promise<string | null> {
    throw new Error("not implemented");
  }
  async classifyRelation(
    a: ClassifyPaperLike,
    b: ClassifyPaperLike,
  ): Promise<RelationClassification | null> {
    this.classifyCalls.push([a, b]);
    return this.classification;
  }
}

const tmpDirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "classify-cache-"));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  // best-effort cleanup is not required for correctness of these tests.
});

describe("CachedClassifyProvider", () => {
  it("test_cached_classify_provider_returns_cached_entry_on_hit", async () => {
    const inner = new FakeProvider({
      relation: "extends",
      confidence: 0.9,
      rationale: "should not be returned",
    });
    const cache = {
      "src1->dst1": {
        relation: "successor",
        confidence: 0.85,
        rationale: "B が A の RoBERTa 事前学習を低リソース言語に転用している",
      },
    };
    const cached = new CachedClassifyProvider(inner, cache, { cachePath: null });
    const rc = await cached.classifyRelation({ paperId: "src1" }, { paperId: "dst1" });
    expect(rc?.relation).toBe("successor");
    expect(rc?.rationale.startsWith("B が A の RoBERTa")).toBe(true);
    expect(inner.classifyCalls).toEqual([]);
  });

  it("test_cached_classify_provider_calls_inner_on_miss", async () => {
    const dir = tmpDir();
    const cachePath = join(dir, "classifications.json");
    const inner = new FakeProvider({
      relation: "extends",
      confidence: 0.9,
      rationale: "B は A の sparse attention を audio 信号に拡張している",
    });
    const cached = new CachedClassifyProvider(inner, {}, { cachePath });
    const rc = await cached.classifyRelation(
      { paperId: "src_miss", title: "A" },
      { paperId: "dst_miss", title: "B" },
    );
    expect(rc?.relation).toBe("extends");
    expect(inner.classifyCalls.length).toBe(1);
    const persisted = JSON.parse(readFileSync(cachePath, "utf-8"));
    expect(persisted["src_miss->dst_miss"].relation).toBe("extends");
  });

  it("test_cached_classify_provider_writes_model_tag_on_miss", async () => {
    const dir = tmpDir();
    const cachePath = join(dir, "classifications.json");
    const inner = new FakeProvider({
      relation: "extends",
      confidence: 0.9,
      rationale: "B は A の sparse attention を audio 信号に拡張している",
    });
    (inner as unknown as { model: string }).model = "llama-3.3-70b-versatile";
    const cache: Record<string, unknown> = {};
    const cached = new CachedClassifyProvider(inner, cache, { cachePath });
    await cached.classifyRelation(
      { paperId: "src_m", title: "A" },
      { paperId: "dst_m", title: "B" },
    );
    const entry = cache["src_m->dst_m"] as Record<string, unknown>;
    expect(entry.model).toBe("fake:llama-3.3-70b-versatile");
    expect(String(entry.model)).not.toContain("+cache");
    const persisted = JSON.parse(readFileSync(cachePath, "utf-8"));
    expect(persisted["src_m->dst_m"].model).toBe("fake:llama-3.3-70b-versatile");
  });

  it("test_cached_classify_provider_model_tag_name_only_without_model", async () => {
    const inner = new FakeProvider({
      relation: "extends",
      confidence: 0.9,
      rationale: "paper-specific 説明文章",
    });
    const cache: Record<string, unknown> = {};
    const cached = new CachedClassifyProvider(inner, cache, { cachePath: null });
    await cached.classifyRelation({ paperId: "x" }, { paperId: "y" });
    expect((cache["x->y"] as Record<string, unknown>).model).toBe("fake");
  });

  it("test_cached_classify_provider_skips_persist_when_inner_returns_none", async () => {
    const dir = tmpDir();
    const cachePath = join(dir, "classifications.json");
    const inner = new FakeProvider(null);
    const cache: Record<string, unknown> = {};
    const cached = new CachedClassifyProvider(inner, cache, { cachePath });
    const rc = await cached.classifyRelation({ paperId: "src_none" }, { paperId: "dst_none" });
    expect(rc).toBeNull();
    expect(cache).toEqual({});
  });

  it("test_cached_classify_provider_no_persist_when_cache_path_none", async () => {
    const inner = new FakeProvider({
      relation: "extends",
      confidence: 0.9,
      rationale: "paper-specific 説明",
    });
    const cache: Record<string, unknown> = {};
    const cached = new CachedClassifyProvider(inner, cache, { cachePath: null });
    const rc = await cached.classifyRelation({ paperId: "x" }, { paperId: "y" });
    expect(rc).not.toBeNull();
    expect("x->y" in cache).toBe(true);
  });

  it("a null-valued cache entry is a MISS (matches Python's `dict.get() is not None`), not a permanent poisoned hit", async () => {
    // Python's `self._cache.get(key)` returns `None` for BOTH a missing key
    // and a key explicitly stored as `null` — there's no third state, so
    // `if cached is not None` treats a stored `null` exactly like a miss
    // and calls the inner provider. A naive `cached !== undefined` check in
    // TS would treat the stored `null` as a hit and never retry — this
    // pins the fix.
    const inner = new FakeProvider({
      relation: "extends",
      confidence: 0.9,
      rationale: "paper-specific 説明文章",
    });
    const cache: Record<string, unknown> = { "x->y": null };
    const cached = new CachedClassifyProvider(inner, cache, { cachePath: null });
    const rc = await cached.classifyRelation({ paperId: "x" }, { paperId: "y" });
    expect(inner.classifyCalls.length).toBe(1);
    expect(rc?.relation).toBe("extends");
    expect(cache["x->y"]).not.toBeNull();
  });

  it("test_cached_classify_provider_missing_paper_ids_skip_cache", async () => {
    const dir = tmpDir();
    const cachePath = join(dir, "classifications.json");
    const inner = new FakeProvider({
      relation: "extends",
      confidence: 0.9,
      rationale: "paper-specific 説明",
    });
    const cache: Record<string, unknown> = {};
    const cached = new CachedClassifyProvider(inner, cache, { cachePath });
    const rc = await cached.classifyRelation({}, { paperId: "dst" });
    expect(rc).not.toBeNull();
    expect(cache).toEqual({});
  });
});

describe("persistClassifications", () => {
  it("merges concurrent writers (setdefault semantics)", async () => {
    const dir = tmpDir();
    const cachePath = join(dir, "cls.json");
    writeFileSync(
      cachePath,
      JSON.stringify({
        "B->C": { relation: "successor", confidence: 0.7, rationale: "B made by another writer" },
      }),
    );
    const classifications: Record<string, unknown> = {};
    classifications["X->Y"] = { relation: "extends", confidence: 0.9, rationale: "A new" };
    await persistClassifications(classifications, cachePath);
    const onDisk = JSON.parse(readFileSync(cachePath, "utf-8"));
    expect("X->Y" in onDisk).toBe(true);
    expect("B->C" in onDisk).toBe(true);
  });

  it("blocks while another holder keeps the lock file present, then merges on release", async () => {
    const dir = tmpDir();
    const cachePath = join(dir, "cls.json");
    writeFileSync(cachePath, JSON.stringify({ base: { relation: "extends" } }));
    const lockPath = `${cachePath}.lock`;
    await acquireClassificationLock(lockPath);

    let done = false;
    const writerPromise = persistClassifications(
      { new: { relation: "successor" } },
      cachePath,
    ).then(() => {
      done = true;
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(done).toBe(false);
    expect(JSON.parse(readFileSync(cachePath, "utf-8"))).toEqual({ base: { relation: "extends" } });

    releaseClassificationLock(lockPath);
    await writerPromise;
    expect(done).toBe(true);
    const final = JSON.parse(readFileSync(cachePath, "utf-8"));
    expect(final).toEqual({ base: { relation: "extends" }, new: { relation: "successor" } });
  });

  it("tolerates a corrupt on-disk cache (treats as empty and proceeds)", async () => {
    const dir = tmpDir();
    const cachePath = join(dir, "cls.json");
    writeFileSync(cachePath, "{not valid json");
    const classifications: Record<string, unknown> = { "A->B": { relation: "extends" } };
    await persistClassifications(classifications, cachePath);
    expect(JSON.parse(readFileSync(cachePath, "utf-8"))).toEqual({
      "A->B": { relation: "extends" },
    });
  });
});
