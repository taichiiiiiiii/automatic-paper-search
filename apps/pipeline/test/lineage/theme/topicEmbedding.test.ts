/**
 * R2-11 (design 41 D7, doc 42 stage 2): the embedding+terms topic gate —
 * vector cache keying, z-scores over the candidate pool, BFS admission
 * with a fake embedder, the fallback to the term-only rule and the
 * `meta.topic_gate` stamp in the artifact.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { FetchInit, HttpResponseLike } from "../../../src/collect/http/requestWithRetry.js";
import type { FetchRelatedDeps } from "../../../src/lineage/shared/fetchRelated.js";
import { runBfsAndDescendants } from "../../../src/lineage/theme/bfs.js";
import { type BuildThemeLineageDeps, buildThemeLineage } from "../../../src/lineage/theme/build.js";
import type { ThemePaper } from "../../../src/lineage/theme/openalexWork.js";
import {
  buildTopicRelevance,
  CachedTopicEmbedder,
  createTransformersEmbedder,
  embeddingCacheKey,
  embeddingCachePath,
  paperEmbeddingText,
  prepareTopicGate,
  TOPIC_EMBEDDING_MODEL,
  type TopicEmbedder,
  themeQueryText,
} from "../../../src/lineage/theme/topicEmbedding.js";
import { TopicScope } from "../../../src/lineage/theme/topicScope.js";

const GNN = "Graph Neural Network";
const gnn = () => new TopicScope(GNN, ["GNN"], {}, ["graph convolutional network"]);

/** Bag-of-keywords embedder: dimension = topic cluster. Deterministic,
 * counts its calls and texts. */
class FakeEmbedder implements TopicEmbedder {
  readonly model = "fake/bow";
  readonly revision = "rev0000000000001";
  readonly queryPrefix = "Q: ";
  calls = 0;
  texts = 0;
  static readonly DIMS: RegExp[] = [
    /\b(?:graph|graphs|node|nodes|vertex|vertices|message|walk|gnn|convolutional)\b/gi,
    /\b(?:sentence|sentences|semantic|role|translation|language)\b/gi,
    /\b(?:image|images|vision|pixel|pixels|residual|recognition)\b/gi,
  ];
  async embed(texts: readonly string[]): Promise<number[][]> {
    this.calls += 1;
    this.texts += texts.length;
    return texts.map((t) => {
      const v = [...FakeEmbedder.DIMS.map((re) => (t.match(re) ?? []).length), 0.5];
      const n = Math.sqrt(v.reduce((a, b) => a + b * b, 0));
      return v.map((x) => x / n);
    });
  }
}

class BrokenEmbedder extends FakeEmbedder {
  override async embed(): Promise<number[][]> {
    throw new Error("onnxruntime: inference failed");
  }
}

function paper(pid: string, title: string, abstract: string, year = 2018): ThemePaper {
  return {
    paperId: pid,
    title,
    year,
    venue: "NeurIPS",
    citationCount: 100,
    abstract,
    authors: [],
    externalIds: {},
  };
}

const SEED = paper(
  "seed",
  "Graph Neural Networks for Molecules",
  "Message passing graph neural network over molecular graphs with node and vertex features.",
  2021,
);
const GCN = paper(
  "gcn",
  "Semi-Supervised Classification with Graph Convolutional Networks",
  "A graph convolutional network for node classification on graphs.",
  2017,
);
const SRL = paper(
  "srl",
  "Encoding Sentences with Graph Convolutional Networks for Semantic Role Labeling",
  "Semantic role labeling of sentences: semantic roles, sentence encoders, language and translation; semantic role labeling for language.",
  2017,
);
const DEEPWALK = paper(
  "deepwalk",
  "DeepWalk: Online Learning of Social Representations",
  "Random walk over graph vertices learns node representations of graphs; vertex walk node.",
  2014,
);
const RESNET = paper(
  "resnet",
  "Deep Residual Learning for Image Recognition",
  "Residual learning for image recognition on images; pixel vision.",
  2016,
);
const FILLERS = [1, 2, 3, 4, 5].map((i) =>
  paper(`img${i}`, `Image Paper ${i}`, "Image vision pixel images recognition.", 2015),
);

function jsonResp(status: number, body: unknown): HttpResponseLike {
  return { status, json: async () => body };
}

let cacheDir: string;
beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "topic-emb-"));
});

function bfsDeps(refs: Record<string, ThemePaper[]>): FetchRelatedDeps & { urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = async (url: string, _init: FetchInit): Promise<HttpResponseLike> => {
    urls.push(url);
    for (const [id, list] of Object.entries(refs)) {
      if (url.includes(`/paper/${id}/references`)) {
        return jsonResp(200, {
          data: list.map((p) => ({ citedPaper: p, isInfluential: true, intents: [] })),
        });
      }
    }
    if (url.includes("/references") || url.includes("/citations")) {
      return jsonResp(200, { data: [] });
    }
    throw new Error(`unexpected ${url}`);
  };
  return { fetchImpl, cacheDir, sleep: async () => {}, logger: { warn: () => {} }, urls };
}

const BFS_OPTS = {
  depth: 1,
  width: 20,
  maxSeedCite: 10 ** 9,
  provider: null,
  llmStrict: "off",
  currentYear: 2026,
};
const REFS = { seed: [GCN, SRL, DEEPWALK, RESNET, ...FILLERS] };

describe("vector cache", () => {
  it("keys by model + revision + sha256(text)", () => {
    const k = embeddingCacheKey("m", "r1", "text");
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(embeddingCacheKey("m", "r1", "text")).toBe(k);
    expect(embeddingCacheKey("m", "r2", "text")).not.toBe(k);
    expect(embeddingCacheKey("m2", "r1", "text")).not.toBe(k);
    expect(embeddingCacheKey("m", "r1", "text ")).not.toBe(k);
    const path = embeddingCachePath("/c", "Xenova/bge-small-en-v1.5", "ea104dacec62c0de", "t");
    expect(path).toMatch(/^\/c\/emb_Xenova-bge-small-en-v1\.5_ea104dacec62_[0-9a-f]{64}\.json$/);
  });

  it("embeds each text once, rounds to 4 decimals and reuses the disk cache", async () => {
    const inner = new FakeEmbedder();
    const dir = join(cacheDir, "embeddings");
    const cached = new CachedTopicEmbedder(inner, dir);
    const first = await cached.embed(["graph node", "image", "graph node"]);
    expect(inner.texts).toBe(2); // the duplicate is embedded once
    for (const v of first) for (const x of v) expect(Math.round(x * 10000) / 10000).toBe(x);
    expect(first[0]).toEqual(first[2]);
    expect(readdirSync(dir)).toHaveLength(2);
    const again = new CachedTopicEmbedder(inner, dir);
    expect(await again.embed(["image", "graph node"])).toEqual([first[1], first[0]]);
    expect(inner.calls).toBe(1);
    expect(again.hits).toBe(2);
    // Another revision of the same model does not reuse the vectors.
    const other = new FakeEmbedder();
    Object.defineProperty(other, "revision", { value: "rev0000000000002" });
    await new CachedTopicEmbedder(other, dir).embed(["image"]);
    expect(other.calls).toBe(1);
  });

  it("ignores a corrupt or foreign cache file", async () => {
    const inner = new FakeEmbedder();
    writeFileSync(embeddingCachePath(cacheDir, inner.model, inner.revision, "x"), "{");
    writeFileSync(
      embeddingCachePath(cacheDir, inner.model, inner.revision, "y"),
      JSON.stringify({ model: "other", revision: inner.revision, vector: [1, 0, 0, 0] }),
    );
    const cached = new CachedTopicEmbedder(inner, cacheDir);
    const [v, w] = await cached.embed(["x", "y"]);
    expect(v).toHaveLength(4);
    expect(w).not.toEqual([1, 0, 0, 0]);
    expect(inner.texts).toBe(2);
  });
});

describe("transformers.js embedder", () => {
  it("loads lazily with the pinned model/revision/q8 and never when the cache is warm", async () => {
    const seen: unknown[] = [];
    let imports = 0;
    const env = { cacheDir: null as string | null };
    const importModule = async () => {
      imports += 1;
      return {
        env,
        pipeline: async (task: string, model: string, opts: Record<string, unknown>) => {
          seen.push({ task, model, opts });
          return async (texts: string[]) => ({ tolist: () => texts.map(() => [0.6, 0.8]) });
        },
      };
    };
    const tf = createTransformersEmbedder({ modelCacheDir: "/models", importModule });
    expect(imports).toBe(0);
    const cached = new CachedTopicEmbedder(tf, cacheDir);
    expect(await cached.embed(["a", "b"])).toEqual([
      [0.6, 0.8],
      [0.6, 0.8],
    ]);
    expect(seen).toEqual([
      {
        task: "feature-extraction",
        model: "Xenova/bge-small-en-v1.5",
        opts: { dtype: "q8", revision: TOPIC_EMBEDDING_MODEL.revision },
      },
    ]);
    expect(env.cacheDir).toBe("/models");
    expect(TOPIC_EMBEDDING_MODEL.revision).toMatch(/^[0-9a-f]{40}$/);
    const tf2 = createTransformersEmbedder({ importModule });
    await new CachedTopicEmbedder(tf2, cacheDir).embed(["b", "a"]);
    expect(imports).toBe(1);
  });
});

describe("buildTopicRelevance", () => {
  it("standardises cosine to mean(subject-seed centroid, theme terms) over the pool", async () => {
    const scope = gnn();
    const embedder = new FakeEmbedder();
    const pool = [GCN, SRL, DEEPWALK, RESNET, ...FILLERS];
    const rel = await buildTopicRelevance({ scope, seeds: [SEED], pool, embedder });
    expect(rel.poolSize).toBe(pool.length + 1);
    // One embed call: the query text first, then every pool paper.
    expect(embedder.calls).toBe(1);
    expect(embedder.texts).toBe(pool.length + 2);
    const zs = [SEED, ...pool].map((p) => rel.z(p.paperId)!);
    const mean = zs.reduce((a, b) => a + b, 0) / zs.length;
    expect(Math.abs(mean)).toBeLessThan(1e-9);
    expect(rel.z("deepwalk")!).toBeGreaterThanOrEqual(1);
    expect(rel.z("srl")!).toBeLessThan(0.5);
    expect(rel.z("resnet")!).toBeLessThan(0);
    expect(themeQueryText(scope, "Q: ")).toBe(
      "Q: Graph Neural Network; GNN; graph convolutional network",
    );
    expect(paperEmbeddingText({ title: "T", abstract: "x".repeat(2000) })).toHaveLength(3 + 1500);
  });

  it("prepareTopicGate falls back to the term rule and says why", async () => {
    const scope = gnn();
    const broken = await prepareTopicGate({
      scope,
      seeds: [SEED],
      pool: [GCN],
      embedder: new BrokenEmbedder(),
    });
    expect(broken.relevance).toBeNull();
    expect(broken.meta).toEqual({
      method: "terms",
      model: null,
      revision: null,
      thresholds: null,
      pool_size: 2,
      fallback_reason: "onnxruntime: inference failed",
    });
    const disabled = await prepareTopicGate({ scope, seeds: [SEED], pool: [], embedder: null });
    expect(disabled.meta).toMatchObject({ method: "terms", fallback_reason: "embedding disabled" });
    // Package missing (dynamic import fails) -> same fallback.
    const missing = createTransformersEmbedder({
      importModule: () =>
        Promise.reject(new Error("Cannot find package '@huggingface/transformers'")),
    });
    const r = await prepareTopicGate({ scope, seeds: [SEED], pool: [GCN], embedder: missing });
    expect(r.meta.method).toBe("terms");
    expect(r.meta.fallback_reason).toContain("Cannot find package");
  });
});

describe("runBfsAndDescendants with the embedding gate", () => {
  it("admits by (term AND z>=0) OR z>=1 and embeds the pool once", async () => {
    const embedder = new FakeEmbedder();
    const result = await runBfsAndDescendants(
      [SEED],
      { ...BFS_OPTS, topicScope: gnn(), topicEmbedder: embedder },
      bfsDeps(REFS),
    );
    const ids = [...result.nodes.keys()].sort();
    // GCN: term + high z. DeepWalk: no term but z >= 1 (a precursor).
    // SRL: a term match, but the embedding puts it below the pool mean
    // (GCNs used as a tool for NLP). ResNet / image papers: neither.
    expect(ids).toEqual(["deepwalk", "gcn", "seed"]);
    expect(result.topicGate).toEqual({
      method: "embedding+terms",
      model: "fake/bow",
      revision: "rev0000000000001",
      thresholds: { z_lo: 0, z_hi: 1 },
      pool_size: 10,
    });
    expect(embedder.calls).toBe(1);
    expect(result.onTopicIds.has("deepwalk")).toBe(true);
  });

  it("falls back to the term rule when inference fails, and records it", async () => {
    const result = await runBfsAndDescendants(
      [SEED],
      { ...BFS_OPTS, topicScope: gnn(), topicEmbedder: new BrokenEmbedder() },
      bfsDeps(REFS),
    );
    expect([...result.nodes.keys()].sort()).toEqual(["gcn", "seed", "srl"]);
    expect(result.topicGate).toMatchObject({
      method: "terms",
      fallback_reason: "onnxruntime: inference failed",
      pool_size: 10,
    });
  });

  it("does not prefetch or stamp anything with the gate off", async () => {
    const deps = bfsDeps(REFS);
    const embedder = new FakeEmbedder();
    const result = await runBfsAndDescendants(
      [SEED],
      {
        ...BFS_OPTS,
        topicScope: new TopicScope(GNN, [], { gate: false }),
        topicEmbedder: embedder,
      },
      deps,
    );
    expect(result.topicGate).toBeNull();
    expect(embedder.calls).toBe(0);
  });
});

// ---- artifact meta ----

function s2Paper(pid: string, title: string, abstract: string, arxivId: string, year = 2020) {
  return {
    paperId: pid,
    title,
    year,
    venue: "NeurIPS",
    citationCount: 100,
    abstract,
    authors: [],
    externalIds: { ArXiv: arxivId },
  };
}

function buildDeps(topicEmbedder?: TopicEmbedder | null): BuildThemeLineageDeps {
  const docsRoot = mkdtempSync(join(tmpdir(), "emb-docs-"));
  const seed = s2Paper(
    "seedg",
    "Graph Neural Networks for Molecules",
    "Message passing graph neural network over molecular graphs with node features.",
    "2401.00001",
    2021,
  );
  const parent = s2Paper(
    "parentg",
    "Semi-Supervised Classification with Graph Convolutional Networks",
    "A graph convolutional network for node classification on graphs.",
    "1609.02907",
    2017,
  );
  const image = s2Paper("imageg", "Image Paper", "Image vision pixel images.", "1500.00001", 2015);
  return {
    fetchImpl: async (url: string) => {
      if (url.includes("/references")) {
        return jsonResp(200, {
          data: [parent, image].map((p) => ({ citedPaper: p, isInfluential: true, intents: [] })),
        });
      }
      if (url.includes("/citations")) return jsonResp(200, { data: [] });
      return jsonResp(200, { data: [seed], results: [] });
    },
    cacheDir,
    sleep: async () => {},
    docsRoot,
    identityAliasesPath: join(docsRoot, "identity-aliases-v1.json"),
    githubCachePath: join(docsRoot, "github_stars.json"),
    logger: {},
    ...(topicEmbedder !== undefined ? { topicEmbedder } : {}),
  };
}

const BUILD_OPTS = {
  theme: "Graph Neural Network",
  depth: 1,
  seedsCount: 3,
  width: 4,
  sinceYear: null,
};

describe("meta.topic_gate in the artifact", () => {
  it("records embedding+terms with model, revision, thresholds and pool size", async () => {
    const out = await buildThemeLineage(BUILD_OPTS, buildDeps(new FakeEmbedder()));
    const payload = JSON.parse(readFileSync(out, "utf-8"));
    expect(payload.meta.topic_gate).toEqual({
      method: "embedding+terms",
      model: "fake/bow",
      revision: "rev0000000000001",
      thresholds: { z_lo: 0, z_hi: 1 },
      pool_size: 3,
    });
    expect(payload.nodes.map((n: { id: string }) => n.id).sort()).toEqual(["parentg", "seedg"]);
  });

  it("records the term-only fallback (inference failure, opt-out, no embedder)", async () => {
    const broken = JSON.parse(
      readFileSync(await buildThemeLineage(BUILD_OPTS, buildDeps(new BrokenEmbedder())), "utf-8"),
    );
    expect(broken.meta.topic_gate).toMatchObject({
      method: "terms",
      model: null,
      fallback_reason: "onnxruntime: inference failed",
    });
    const embedder = new FakeEmbedder();
    const optOut = JSON.parse(
      readFileSync(
        await buildThemeLineage({ ...BUILD_OPTS, topicEmbedding: false }, buildDeps(embedder)),
        "utf-8",
      ),
    );
    expect(optOut.meta.topic_gate).toMatchObject({
      method: "terms",
      fallback_reason: "embedding disabled",
    });
    expect(embedder.calls).toBe(0);
    const none = JSON.parse(
      readFileSync(await buildThemeLineage(BUILD_OPTS, buildDeps()), "utf-8"),
    );
    expect(none.meta.topic_gate.method).toBe("terms");
    // Gate off: no stamp (the pre-R2-2b parity fixtures stay byte-identical).
    const off = await buildThemeLineage(
      { ...BUILD_OPTS, topicScope: { gate: false } },
      buildDeps(new FakeEmbedder()),
    );
    expect(existsSync(off)).toBe(true);
    expect(JSON.parse(readFileSync(off, "utf-8")).meta.topic_gate).toBeUndefined();
  });
});
