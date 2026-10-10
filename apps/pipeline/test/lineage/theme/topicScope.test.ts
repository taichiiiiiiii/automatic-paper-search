/**
 * R2-2b (design doc 40): topic drift fixes in the theme lineage builder —
 * seed role / weighting, root choice, the BFS admission gate, the
 * demotion of year/citation guesses, the CLI flags and the offline eval.
 * Fixtures mirror the drifted `graph-neural-network` artifact (SuperGlue
 * as root pulling in SLAM / SfM / text augmentation).
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { FetchInit, HttpResponseLike } from "../../../src/collect/http/requestWithRetry.js";
import type {
  ClassifyPaperLike,
  LLMProvider,
  PaperEvaluation,
  RelationClassification,
} from "../../../src/collect/llm/provider.js";
import { deriveRelationHeuristic } from "../../../src/lineage/classify/classify.js";
import type { FetchRelatedDeps } from "../../../src/lineage/shared/fetchRelated.js";
import { runBfsAndDescendants } from "../../../src/lineage/theme/bfs.js";
import type {
  BuildThemeLineageDeps,
  BuildThemeLineageOptions,
} from "../../../src/lineage/theme/build.js";
import { pickRootSeed } from "../../../src/lineage/theme/build.js";
import { parseArgs, runThemeCli } from "../../../src/lineage/theme/cli.js";
import { applySeedFilters } from "../../../src/lineage/theme/discoverSeeds.js";
import {
  CITATION_HEURISTIC_CONFIDENCE,
  demoteLowInformationEdge,
  type ThemeEdge,
} from "../../../src/lineage/theme/edges.js";
import { evaluateArtifact, runEvalCli } from "../../../src/lineage/theme/evalTopicDriftCli.js";
import type { ThemePaper } from "../../../src/lineage/theme/openalexWork.js";
import {
  _resetSeedFilterCachesForTests,
  aliasesFor,
  topicTermsFor,
} from "../../../src/lineage/theme/seedFilters.js";
import {
  DEFAULT_TOPIC_SCOPE_OPTIONS,
  pickTopicalRoot,
  reapplyAdmission,
  TopicScope,
  themeTerms,
} from "../../../src/lineage/theme/topicScope.js";

const GNN = "Graph Neural Network";
const gnn = (options = {}) => new TopicScope(GNN, [], options);

function paper(
  pid: string,
  title: string,
  opts: { year?: number; cites?: number; abstract?: string } = {},
): ThemePaper {
  return {
    paperId: pid,
    title,
    year: opts.year ?? 2020,
    venue: "NeurIPS",
    citationCount: opts.cites ?? 100,
    abstract: opts.abstract ?? `${"Unrelated filler text. ".repeat(4)}`,
    authors: [],
    externalIds: {},
  };
}

const SURVEY = paper("survey", "A Comprehensive Survey on Graph Neural Networks", { cites: 8000 });
const SUPERGLUE = paper(
  "superglue",
  "SuperGlue: Learning Feature Matching With Graph Neural Networks",
  { cites: 3000 },
);

describe("themeTerms", () => {
  it("covers plural, space-less form and a 3+ letter initialism", () => {
    const terms = themeTerms(GNN);
    expect(terms).toEqual(
      expect.arrayContaining(["graph neural network", "graph neural networks", "GNN", "GNNs"]),
    );
    expect(themeTerms("Flash Attention")).toContain("flashattention");
    // Two-letter initialisms ("FA", "VT") are too ambiguous.
    expect(themeTerms("Flash Attention")).not.toContain("fa");
    expect(themeTerms("Vision Transformer")).not.toContain("vt");
  });

  it("takes CamelCase / upper-case names out of search aliases and adds extra terms", () => {
    const terms = themeTerms("Vision Transformer", ["ViT image patches"], ["swin transformer"]);
    // Short acronyms keep their case (matched case-sensitively, R2-2d).
    expect(terms).toContain("ViT");
    expect(terms).not.toContain("vit");
    expect(terms).toContain("swin transformer");
  });
});

describe("TopicScope.role / isOnTopic", () => {
  it("tells a theme-as-subject title from a theme-as-component title", () => {
    const scope = gnn();
    expect(scope.role(SURVEY)).toBe("subject");
    expect(scope.role(SUPERGLUE)).toBe("component");
    expect(scope.role({ title: "Pre-training Strategies for GNNs" })).toBe("subject");
    expect(
      scope.role({ title: "DeepWalk", abstract: "We compare against graph neural networks." }),
    ).toBe("abstract");
    expect(scope.role({ title: "Structure-from-Motion Revisited", abstract: "SfM." })).toBe("none");
  });

  it("matches whole words only and reads the TL;DR / short abstract of artifact nodes", () => {
    const scope = gnn();
    expect(scope.isOnTopic({ title: "Signal processing", tldr: "a GNN for signals" })).toBe(true);
    expect(scope.isOnTopic({ title: "GNNExplainer-like wording" })).toBe(false);
    // The old per-word gate accepted any "neural network" abstract.
    expect(
      scope.isOnTopic({
        title: "Text Data Augmentation for Deep Learning",
        short_abstract: "Deep neural network models need large data; graph-based tricks help.",
      }),
    ).toBe(false);
  });
});

describe("seed ranking (applySeedFilters with a topic scope)", () => {
  it("ranks a subject seed above a more-cited component seed", () => {
    const component = paper("c", "Feature Matching With Graph Neural Networks", {
      cites: 5000,
      year: 2020,
    });
    const subject = paper("s", "Graph Neural Networks for Molecules", { cites: 2000, year: 2020 });
    const byId = new Map([
      ["c", component],
      ["s", subject],
    ]);
    const ranked = applySeedFilters(byId, { theme: GNN, topN: 2, sinceYear: null });
    expect(ranked.map((p) => p.paperId)).toEqual(["s", "c"]);
    // Weighting off -> raw velocity order (the pre-R2-2b behaviour).
    const legacy = applySeedFilters(byId, {
      theme: GNN,
      topN: 2,
      sinceYear: null,
      topicScope: null,
    });
    expect(legacy.map((p) => p.paperId)).toEqual(["c", "s"]);
  });
});

describe("root choice", () => {
  const edges = (pairs: [string, string][]): ThemeEdge[] =>
    pairs.map(([src, dst]) => ({ src, dst }) as unknown as ThemeEdge);
  // SuperGlue has more edges (its SLAM/SfM neighbourhood), the survey fewer.
  const graph = edges([
    ["slam", "superglue"],
    ["sfm", "superglue"],
    ["scannet", "superglue"],
    ["deepwalk", "survey"],
  ]);

  it("legacy degree rule picks the component seed", () => {
    expect(pickRootSeed(["superglue", "survey"], graph)).toBe("superglue");
  });

  it("topical rule picks the subject seed", () => {
    const papers = new Map<string, Record<string, unknown>>([
      ["superglue", SUPERGLUE],
      ["survey", SURVEY],
      ["deepwalk", { title: "DeepWalk", abstract: "node embedding with graph neural networks" }],
    ]);
    expect(pickRootSeed(["superglue", "survey"], graph, { scope: gnn(), papers })).toBe("survey");
  });

  it("prefers an on-topic foundational-allowlist seed (the canonical paper)", () => {
    const scope = new TopicScope("Flash Attention", []);
    const papers = new Map<string, Record<string, unknown>>([
      ["fa1", { title: "FlashAttention: Fast and Memory-Efficient Exact Attention" }],
      ["fa2", { title: "FlashAttention-2: Faster Attention with Better Parallelism" }],
    ]);
    const g = edges([
      ["fa1", "fa2"],
      ["x", "fa2"],
      ["y", "fa2"],
    ]);
    expect(pickTopicalRoot(["fa1", "fa2"], g, papers, scope)).toBe("fa1");
  });
});

describe("TopicScope.admits", () => {
  it("R2-11 default: only a theme-term match admits (no allowlist, no support)", () => {
    const scope = gnn();
    expect(DEFAULT_TOPIC_SCOPE_OPTIONS).toMatchObject({
      minSupport: 0,
      admitFoundational: false,
      zLo: 0,
      zHi: 1.0,
    });
    expect(scope.admits(SURVEY, 0)).toBe("topic");
    expect(scope.admits({ title: "Attention Is All You Need" }, 0)).toBeNull();
    expect(scope.admits({ title: "Structure-from-Motion Revisited" }, 99)).toBeNull();
    expect(scope.supportSuffices(99)).toBe(false);
    expect(gnn({ gate: false }).admits({ title: "SfM" }, 0)).toBe("topic");
  });

  it("the pre-R2-11 allowlist / support admission stays available as an opt-in", () => {
    const scope = gnn({ minSupport: 2, admitFoundational: true });
    expect(scope.admits({ title: "Attention Is All You Need" }, 0)).toBe("foundational");
    expect(scope.admits({ title: "Structure-from-Motion Revisited" }, 1)).toBeNull();
    expect(scope.admits({ title: "Structure-from-Motion Revisited" }, 2)).toBe("support");
    expect(gnn({ minSupport: 3 }).admits({ title: "SfM" }, 2)).toBeNull();
  });

  it("with an embedding z: (term match AND z >= 0) OR z >= 1.0", () => {
    const scope = gnn();
    const off = { title: "Structure-from-Motion Revisited" };
    // Term match: kept unless the embedding puts it below the pool mean.
    expect(scope.admits(SURVEY, 0, 0)).toBe("topic");
    expect(scope.admits(SURVEY, 0, -0.01)).toBeNull();
    // No term match: needs a high z.
    expect(scope.admits(off, 0, 0.99)).toBeNull();
    expect(scope.admits(off, 0, 1.0)).toBe("embedding");
    // The allowlist no longer admits by itself, but an allowlisted paper
    // that passes the rule is reported as foundational.
    const attn = { title: "Attention Is All You Need" };
    expect(scope.admits(attn, 0, 0.5)).toBeNull();
    expect(scope.admits(attn, 0, 1.2)).toBe("foundational");
    // Support (opt-in) still needs z >= zLo; null z falls back to terms.
    expect(gnn({ minSupport: 2 }).admits(off, 2, 0.1)).toBe("support");
    expect(gnn({ minSupport: 2 }).admits(off, 2, -0.1)).toBeNull();
    expect(scope.admits(SURVEY, 0, null)).toBe("topic");
    // Custom thresholds.
    expect(gnn({ zLo: 0.5, zHi: 2 }).admits(SURVEY, 0, 0.4)).toBeNull();
    expect(gnn({ zLo: 0.5, zHi: 2 }).admits(off, 0, 1.5)).toBeNull();
  });

  it("citing papers with an embedding z: (title about the theme AND z >= 0) OR z >= 1.0", () => {
    const scope = gnn();
    expect(scope.admitsDescendant(SURVEY, 0.2)).toBe("topic");
    expect(scope.admitsDescendant(SURVEY, -0.2)).toBeNull();
    // Component title / abstract-only: only a high z admits.
    expect(scope.admitsDescendant(SUPERGLUE, 0.9)).toBeNull();
    expect(scope.admitsDescendant(SUPERGLUE, 1.1)).toBe("topic");
    expect(scope.admitsDescendant({ title: "UltraAttn" }, 1.3)).toBe("topic");
  });
});

// ---- BFS integration ----

function jsonResp(status: number, body: unknown): HttpResponseLike {
  return { status, json: async () => body };
}

let cacheDir: string;
beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "topic-bfs-"));
});

function ref(p: ThemePaper, intents: string[] = []): Record<string, unknown> {
  return { citedPaper: p, isInfluential: true, intents };
}

function bfsDeps(refsBySeed: Record<string, Record<string, unknown>[]>): FetchRelatedDeps {
  const fetchImpl = async (url: string, _init: FetchInit): Promise<HttpResponseLike> => {
    for (const [id, refs] of Object.entries(refsBySeed)) {
      if (url.includes(`/paper/${id}/references`)) return jsonResp(200, { data: refs });
    }
    if (url.includes("/references") || url.includes("/citations")) {
      return jsonResp(200, { data: [] });
    }
    throw new Error(`unexpected ${url}`);
  };
  return { fetchImpl, cacheDir, sleep: async () => {}, logger: { warn: () => {} } };
}

const SEED_A = paper("seedA", "Graph Neural Networks for Molecules", { year: 2021, cites: 900 });
const SEED_B = paper("seedB", "Scalable Graph Neural Network Training", { year: 2021, cites: 800 });
const ON_TOPIC = paper("gcn", "Semi-Supervised Classification with Graph Convolutional Networks", {
  year: 2017,
  abstract: "We present a scalable approach ... a graph neural network variant ...",
});
const SLAM = paper("slam", "Past, Present, and Future of SLAM", { year: 2016 });
const SFM = paper("sfm", "Structure-from-Motion Revisited", { year: 2016 });

const BFS_OPTS = {
  depth: 1,
  width: 8,
  maxSeedCite: 10 ** 9,
  provider: null,
  llmStrict: "off",
  currentYear: 2026,
};

describe("runBfsAndDescendants topic gate", () => {
  it("keeps an off-topic reference of one seed out, admits a shared one by support", async () => {
    const deps = bfsDeps({
      seedA: [ref(ON_TOPIC), ref(SLAM), ref(SFM)],
      seedB: [ref(SFM)],
    });
    const result = await runBfsAndDescendants(
      [SEED_A, SEED_B],
      { ...BFS_OPTS, topicScope: gnn({ minSupport: 2 }) },
      deps,
    );
    expect(result.nodes.has("gcn")).toBe(true);
    // Cited only by seedA -> 1 on-topic link < minSupport 2.
    expect(result.nodes.has("slam")).toBe(false);
    // Cited by both on-topic seeds -> admitted in the deferred pass, with
    // an edge from each citing seed.
    expect(result.nodes.has("sfm")).toBe(true);
    expect(
      result.edges
        .filter((e) => e.src === "sfm")
        .map((e) => e.dst)
        .sort(),
    ).toEqual(["seedA", "seedB"]);
    expect(result.topicRejected).toBe(1);
    expect(result.topicAdmittedBySupport).toBe(1);
  });

  it("honours a higher --topic-min-support and gate off", async () => {
    const refs = { seedA: [ref(ON_TOPIC), ref(SLAM), ref(SFM)], seedB: [ref(SFM)] };
    const strict = await runBfsAndDescendants(
      [SEED_A, SEED_B],
      { ...BFS_OPTS, topicScope: gnn({ minSupport: 3 }) },
      bfsDeps(refs),
    );
    expect(strict.nodes.has("sfm")).toBe(false);
    const legacy = await runBfsAndDescendants([SEED_A, SEED_B], BFS_OPTS, bfsDeps(refs));
    expect(legacy.nodes.has("slam")).toBe(true);
    expect(legacy.topicRejected).toBe(0);
  });

  it("an off-topic seed lends no support", async () => {
    const offSeed = paper("offSeed", "Feature Matching for SLAM", { year: 2021 });
    const deps = bfsDeps({ seedA: [ref(SFM)], offSeed: [ref(SFM)] });
    const result = await runBfsAndDescendants(
      [SEED_A, offSeed],
      { ...BFS_OPTS, topicScope: gnn({ minSupport: 2 }) },
      deps,
    );
    expect(result.nodes.has("sfm")).toBe(false);
  });

  it("R2-11 default: a reference shared by two seeds is not admitted by support", async () => {
    const deps = bfsDeps({
      seedA: [ref(ON_TOPIC), ref(SLAM), ref(SFM)],
      seedB: [ref(SFM)],
    });
    const result = await runBfsAndDescendants(
      [SEED_A, SEED_B],
      { ...BFS_OPTS, topicScope: gnn() },
      deps,
    );
    expect(result.nodes.has("gcn")).toBe(true);
    expect(result.nodes.has("sfm")).toBe(false);
    expect(result.nodes.has("slam")).toBe(false);
    expect(result.topicAdmittedBySupport).toBe(0);
    expect(result.provisional.size).toBe(0);
    // No embedder: the term rule ran, recorded for meta.topic_gate.
    expect(result.topicGate).toMatchObject({ method: "terms", model: null });
  });
});

// ---- relations ----

class NullProvider implements LLMProvider {
  readonly name = "groq";
  enabled = true;
  batchSize = 1;
  constructor(private readonly answer: RelationClassification | null = null) {}
  async evaluateBatch(): Promise<(PaperEvaluation | null)[]> {
    return [];
  }
  async chat(): Promise<string | null> {
    return null;
  }
  async completeJson(): Promise<string | null> {
    return null;
  }
  async classifyRelation(_a: ClassifyPaperLike, _b: ClassifyPaperLike) {
    return this.answer;
  }
}

describe("low-information relations", () => {
  // Same year band and citation scale -> the year_cite heuristic says "contrasts".
  const parent = paper("p", "Graph Neural Network Baselines", { year: 2020, cites: 400 });
  const child = paper("c", "Graph Neural Network Benchmarks", { year: 2021, cites: 300 });

  it("demotes a year_cite contrasts guess to a 0.4 citation_heuristic successor", () => {
    const guess = deriveRelationHeuristic({}, parent, child);
    expect(guess?.relation).toBe("contrasts");
    expect(guess?.provenance).toBe("year_cite");
    const demoted = demoteLowInformationEdge(guess!, parent, child);
    expect(demoted).toMatchObject({
      relation: "successor",
      confidence: CITATION_HEURISTIC_CONFIDENCE,
      provenance: "citation_heuristic",
    });
    expect(demoted.rationale).toContain("Graph Neural Network Benchmarks");
    // Real classifications pass through untouched.
    const ctx = {
      relation: "contrasts",
      confidence: 0.86,
      rationale: "unlike X",
      provenance: "context_pattern",
    } as const;
    expect(demoteLowInformationEdge(ctx, parent, child)).toBe(ctx);
  });

  it("an LLM that returns nothing under --llm-strict ambiguous yields citation_heuristic, never contrasts", async () => {
    const seed = paper("seedA", "Graph Neural Network Benchmarks", { year: 2021, cites: 300 });
    const deps = bfsDeps({ seedA: [ref(parent)] });
    const result = await runBfsAndDescendants(
      [seed],
      { ...BFS_OPTS, provider: new NullProvider(null), llmStrict: "ambiguous", topicScope: gnn() },
      deps,
    );
    expect(result.llmCalls).toBe(1);
    expect(result.llmUnusable).toBe(1);
    expect(result.edges).toHaveLength(1);
    const edge = result.edges[0]!;
    expect(edge.relation).toBe("successor");
    expect(edge.confidence).toBe(CITATION_HEURISTIC_CONFIDENCE);
    expect((edge.provenance.classification as Record<string, unknown>).method).toBe(
      "citation_heuristic",
    );
  });

  it("a real LLM 'contrasts' classification is kept as such", async () => {
    // Not a survey/benchmark title: the R2-2d relation guard leaves it alone.
    const seed = paper("seedA", "Spatial Graph Neural Networks", { year: 2021, cites: 300 });
    const deps = bfsDeps({ seedA: [ref(parent)] });
    const result = await runBfsAndDescendants(
      [seed],
      {
        ...BFS_OPTS,
        provider: new NullProvider({
          relation: "contrasts",
          confidence: 0.8,
          rationale: "B replaces A's spectral filters with spatial message passing.",
        }),
        llmStrict: "ambiguous",
        topicScope: gnn(),
      },
      deps,
    );
    const edge = result.edges[0]!;
    expect(edge.relation).toBe("contrasts");
    expect((edge.provenance.classification as Record<string, unknown>).method).toBe("llm");
    expect(result.llmUnusable).toBe(0);
  });
});

// ---- config / CLI / offline eval ----

describe("_topic_terms in theme_aliases.json", () => {
  it("is read by topicTermsFor and ignored by the alias loader", () => {
    const dir = mkdtempSync(join(tmpdir(), "topic-terms-"));
    const path = join(dir, "theme_aliases.json");
    writeFileSync(
      path,
      JSON.stringify({
        moe: ["mixture-of-experts"],
        _topic_terms: { "Graph Neural Network": ["gcn"] },
      }),
    );
    _resetSeedFilterCachesForTests();
    try {
      expect(topicTermsFor("graph neural network", path)).toEqual(["gcn"]);
      expect(aliasesFor("moe", path)).toEqual(["mixture-of-experts"]);
      expect(aliasesFor("_topic_terms", path)).toEqual([]);
      expect(TopicScope.forTheme(GNN, {}, path).isOnTopic({ title: "Simplifying GCN" })).toBe(true);
    } finally {
      _resetSeedFilterCachesForTests();
    }
  });

  it("the committed config gives every published theme its extra terms", () => {
    for (const theme of [
      "graph neural network",
      "mixture of experts",
      "vision transformer",
      "flash attention",
    ]) {
      expect(topicTermsFor(theme).length).toBeGreaterThan(0);
    }
  });
});

describe("CLI topic flags", () => {
  it("parses --no-topic-gate, --no-topic-embedding and --topic-min-support (default 0)", () => {
    expect(parseArgs(["--theme", "X"])).toMatchObject({
      topicGate: true,
      topicMinSupport: 0,
      topicEmbedding: true,
    });
    expect(
      parseArgs([
        "--theme",
        "X",
        "--no-topic-gate",
        "--topic-min-support",
        "3",
        "--no-topic-embedding",
      ]),
    ).toMatchObject({ topicGate: false, topicMinSupport: 3, topicEmbedding: false });
  });

  it("forwards them to buildThemeLineage and rejects a negative support", async () => {
    const seen: BuildThemeLineageOptions[] = [];
    const outDir = mkdtempSync(join(tmpdir(), "topic-cli-"));
    const outPath = join(outDir, "lineage.json");
    writeFileSync(outPath, JSON.stringify({ nodes: [{}], edges: [{}] }));
    const buildFn = async (options: BuildThemeLineageOptions): Promise<string> => {
      seen.push(options);
      return outPath;
    };
    const deps = {} as BuildThemeLineageDeps;
    expect(
      await runThemeCli(["--theme", "GNN", "--topic-min-support", "3"], { deps, buildFn }),
    ).toBe(0);
    expect(seen[0]?.topicScope).toEqual({ gate: true, minSupport: 3 });
    expect(seen[0]?.topicEmbedding).toBe(true);
    expect(
      await runThemeCli(["--theme", "GNN", "--topic-min-support", "0", "--no-topic-embedding"], {
        deps,
        buildFn,
      }),
    ).toBe(0);
    expect(seen[1]?.topicScope).toEqual({ gate: true, minSupport: 0 });
    expect(seen[1]?.topicEmbedding).toBe(false);
    expect(await runThemeCli(["--theme", "GNN", "--topic-min-support=-1"], { deps, buildFn })).toBe(
      2,
    );
  });
});

describe("offline admission re-application", () => {
  const artifact = {
    root: "superglue",
    meta: { theme: GNN },
    nodes: [
      { id: "superglue", is_focus: true, title: SUPERGLUE.title },
      { id: "survey", is_focus: true, title: SURVEY.title },
      { id: "slam", title: "Past, Present, and Future of SLAM" },
      { id: "loftr", title: "LoFTR: Detector-Free Local Feature Matching with Transformers" },
      { id: "deepwalk", title: "DeepWalk", tldr: "online learning of social representations" },
      {
        id: "gcn",
        title: "Graph convolutional networks: a comprehensive review",
        tldr: "GNN review",
      },
      { id: "aug", title: "Text Data Augmentation for Deep Learning" },
      { id: "gat", title: "Graph Attention Networks", tldr: "a GNN with masked self-attention" },
    ],
    edges: [
      { src: "slam", dst: "superglue" },
      { src: "superglue", dst: "loftr" },
      { src: "deepwalk", dst: "survey" },
      { src: "deepwalk", dst: "gcn" },
      { src: "gcn", dst: "survey" },
      { src: "survey", dst: "aug" },
      { src: "deepwalk", dst: "gat" },
      { src: "gat", dst: "survey" },
    ],
  };

  it("R2-11 default: DeepWalk (no theme term) is no longer kept by support", () => {
    const r = reapplyAdmission(artifact, gnn());
    expect(r.kept.map((k) => k.id).sort()).toEqual(["gat", "gcn", "superglue", "survey"]);
    expect(r.dropped.find((d) => d.id === "deepwalk")?.support).toBe(2);
    expect(r.root).toBe("survey");
  });

  it("drops the off-topic neighbourhood and moves the root to the subject seed", () => {
    const r = reapplyAdmission(artifact, gnn({ minSupport: 2 }));
    expect(r.kept.map((k) => k.id).sort()).toEqual([
      "deepwalk",
      "gat",
      "gcn",
      "superglue",
      "survey",
    ]);
    expect(r.dropped.map((d) => d.id).sort()).toEqual(["aug", "loftr", "slam"]);
    // Two on-topic NON-focus nodes (gcn, gat) cite DeepWalk; the focus
    // survey does not count as support (R2-2d).
    expect(r.kept.find((k) => k.id === "deepwalk")?.reason).toBe("support");
    // Newer papers citing a seed need a title about the theme.
    expect(r.dropped.find((d) => d.id === "loftr")?.rule).toBe("descendant(none)");
    expect(r.dropped.find((d) => d.id === "aug")?.rule).toBe("descendant(none)");
    expect(r.previousRoot).toBe("superglue");
    expect(r.root).toBe("survey");
  });

  it("evaluateArtifact / runEvalCli read a lineage.json without network", () => {
    const dir = mkdtempSync(join(tmpdir(), "topic-eval-"));
    const path = join(dir, "lineage.json");
    writeFileSync(path, JSON.stringify(artifact));
    const report = evaluateArtifact(path);
    expect(report.nodeCountBefore).toBe(8);
    expect(report.nodeCountAfter).toBe(4);
    expect(evaluateArtifact(path, { minSupport: 2 }).nodeCountAfter).toBe(5);
    expect(runEvalCli([path, "--json"])).toBe(0);
    expect(runEvalCli([])).toBe(2);
    expect(runEvalCli([path, "--json", "--min-support", "0"])).toBe(0);
    expect(runEvalCli([path, "--min-support", "-1"])).toBe(2);
  });
});
