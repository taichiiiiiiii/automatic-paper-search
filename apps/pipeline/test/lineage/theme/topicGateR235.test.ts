/**
 * R2-35 (design 41): theme quality for web-requested themes, from the
 * "Low-Rank Adaptation" on-demand theme (2026-10-12).
 *
 *  - The theme name a user types is the long form; the field writes the
 *    acronym. "LoRA" was no theme term, so QLoRA / VeRA / AdaLoRA entered
 *    only on the embedding (QLoRA, z = 0.57, never). Acronyms the seeds
 *    define for the theme phrase now count as terms
 *    (`deriveThemeAcronyms`, `TopicScope.withDerivedTerms`), and a long
 *    mixed-case one also closes variant names (QLoRA, PRILoRA).
 *  - OpenAlex never lists QLoRA as citing LoRA (no referenced_works) and
 *    S2 `/citations` stops at the newest 10,000: the ranked descendant
 *    search (`S2Expansion.rankedCiters`) finds the most-cited citers.
 *  - Off-topic predecessors admitted on the embedding alone (2013-16
 *    speaker adaptation of DNN acoustic models, Adafactor):
 *    `confirmPreSeedEmbeddingAdmissions`, and no expansion through
 *    embedding-only nodes at depth >= 2.
 */
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FetchInit, HttpResponseLike } from "../../../src/collect/http/requestWithRetry.js";
import { BuildCompleteness } from "../../../src/lineage/fetch-state/completeness.js";
import type { ThemeGraphNode } from "../../../src/lineage/shared/node.js";
import {
  confirmPreSeedEmbeddingAdmissions,
  type NodeAdmission,
  runBfsAndDescendants,
} from "../../../src/lineage/theme/bfs.js";
import { descendantSearchQuery } from "../../../src/lineage/theme/build.js";
import type { ThemeEdge } from "../../../src/lineage/theme/edges.js";
import type { ThemePaper } from "../../../src/lineage/theme/openalexWork.js";
import { S2CitationSource } from "../../../src/lineage/theme/s2Citations.js";
import { S2Expansion } from "../../../src/lineage/theme/s2Expansion.js";
import type { TopicEmbedder } from "../../../src/lineage/theme/topicEmbedding.js";
import {
  acronymFitsPhrase,
  deriveThemeAcronyms,
  TopicScope,
} from "../../../src/lineage/theme/topicScope.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const LORA_ABSTRACT =
  "We propose Low-Rank Adaptation, or LoRA, which freezes the pre-trained model weights and " +
  "injects trainable rank decomposition matrices into each layer of the Transformer.";
const DORA_ABSTRACT =
  "Among the widely used parameter-efficient fine-tuning methods, Low-Rank Adaptation (LoRA) " +
  "and its variants have gained considerable popularity. We introduce DoRA.";

describe("deriveThemeAcronyms (R2-35)", () => {
  it("takes an acronym two seeds define for the theme phrase", () => {
    expect(
      deriveThemeAcronyms(
        ["Low-Rank Adaptation"],
        [
          { title: "LoRA: Low-Rank Adaptation of Large Language Models", abstract: LORA_ABSTRACT },
          { title: "DoRA: Weight-Decomposed Low-Rank Adaptation", abstract: DORA_ABSTRACT },
        ],
      ),
    ).toEqual(["LoRA"]);
  });

  it("needs two papers, and capitals that spell the phrase's initials", () => {
    expect(deriveThemeAcronyms(["Low-Rank Adaptation"], [{ abstract: LORA_ABSTRACT }])).toEqual([]);
    const odd = {
      abstract: "Low-rank adaptation (Adapters) and low-rank adaptation (LRAX) differ.",
    };
    expect(deriveThemeAcronyms(["Low-Rank Adaptation"], [odd, odd])).toEqual([]);
    expect(acronymFitsPhrase("LoRA", "Low-Rank Adaptation")).toBe(true);
    expect(acronymFitsPhrase("MoE", "Mixture of Experts")).toBe(true);
    expect(acronymFitsPhrase("ViT", "Vision Transformer")).toBe(true);
    expect(acronymFitsPhrase("LRAX", "Low-Rank Adaptation")).toBe(false);
    expect(acronymFitsPhrase("Adapters", "Low-Rank Adaptation")).toBe(false);
  });

  it("reduces a plural and skips acronyms the scope already has (GNN themes unchanged)", () => {
    const gnnAbstract = { abstract: "Graph neural networks (GNNs) learn on graphs." };
    expect(deriveThemeAcronyms(["Graph Neural Network"], [gnnAbstract, gnnAbstract])).toEqual([
      "GNN",
    ]);
    const gnn = new TopicScope("Graph Neural Network", []);
    expect(gnn.deriveAcronyms([gnnAbstract, gnnAbstract])).toEqual([]);
    const moe = new TopicScope("Mixture of Experts", ["mixture-of-experts"]);
    const moeAbs = { abstract: "Sparse Mixture-of-Experts (MoE) layers route tokens." };
    expect(moe.deriveAcronyms([moeAbs, moeAbs])).toEqual([]);
  });
});

describe("TopicScope.withDerivedTerms (R2-35)", () => {
  const base = new TopicScope("Low-Rank Adaptation", []);
  const lora = base.withDerivedTerms(["LoRA"]);

  it("makes the acronym a theme term, also closing variant names", () => {
    for (const title of [
      "QLoRA: Efficient Finetuning of Quantized LLMs",
      "AdaLoRA: Adaptive Budget Allocation for Parameter-Efficient Fine-Tuning",
      "PRILoRA: Pruned and Rank-Increasing Low-Rank Adaptation",
      "LoRA+: Efficient Low Rank Adaptation of Large Models",
      "LoRA-FA: Memory-efficient Low-rank Adaptation",
      "ZipLoRA: Any Subject in Any Style by Effectively Merging LoRAs",
    ]) {
      expect(lora.role({ title }), title).toBe("subject");
    }
    expect(base.role({ title: "QLoRA: Efficient Finetuning of Quantized LLMs" })).toBe("none");
  });

  it("stays case-sensitive and whole-word on the right", () => {
    for (const title of ["Lora wireless networks", "LORA mesh radios", "LoRAWAN gateways"]) {
      expect(lora.role({ title }), title).toBe("none");
    }
  });

  it("keeps the embedding query text and short acronym rules unchanged", () => {
    expect(lora.queryTerms).toEqual(base.queryTerms);
    expect(lora.derivedTerms).toEqual(["LoRA"]);
    const moe = new TopicScope("Mixture of Experts", []).withDerivedTerms(["MoE"]);
    // "MoE" is already the initialism term: nothing derived, no relaxed match.
    expect(moe.derivedTerms).toEqual([]);
    expect(moe.role({ title: "FMoE: a fast MoE system" })).toBe("subject");
    expect(moe.isOnTopic({ title: "XMoE" })).toBe(false);
  });
});

function node(id: string, title: string, year: number, abstract = ""): ThemeGraphNode {
  return { id, title, year, short_abstract: abstract } as unknown as ThemeGraphNode;
}

function edge(
  src: string,
  dst: string,
  relation = "baseline_only",
  method = "s2_context_rule",
): ThemeEdge {
  return {
    src,
    dst,
    rel: relation,
    relation,
    conf: 0.6,
    confidence: 0.6,
    rationale: "",
    provenance: { classification: { method } },
  };
}

const adm = (why: string, z = 1.3): NodeAdmission => ({
  path: "reference",
  why,
  z,
  anchor: "lora",
});

describe("confirmPreSeedEmbeddingAdmissions (R2-35)", () => {
  const scope = new TopicScope("Low-Rank Adaptation", []).withDerivedTerms(["LoRA"]);
  const run = (
    nodes: ThemeGraphNode[],
    edges: ThemeEdge[],
    admissions: Record<string, NodeAdmission>,
    s: TopicScope = scope,
  ) => {
    const map = new Map(nodes.map((n) => [n.id, n]));
    const out = confirmPreSeedEmbeddingAdmissions(map, edges, {
      seedIds: new Set(["lora", "dora"]),
      admissions: new Map(Object.entries(admissions)),
      scope: s,
    });
    return { ...out, kept: [...map.keys()].sort() };
  };
  const seeds = [
    node("lora", "LoRA: Low-Rank Adaptation of Large Language Models", 2021),
    node("dora", "DoRA: Weight-Decomposed Low-Rank Adaptation", 2024),
  ];

  it("drops the 2013-16 speaker-adaptation cluster: background citations and each other do not hold it", () => {
    const r = run(
      [
        ...seeds,
        node("lrpd", "Low-rank plus diagonal adaptation for deep neural networks", 2016),
        node(
          "lhuc",
          "Learning hidden unit contributions for unsupervised speaker adaptation",
          2014,
        ),
        node("kld", "KL-divergence regularized deep neural network adaptation", 2013),
        node("adafactor", "Adafactor: Adaptive Learning Rates with Sublinear Memory Cost", 2018),
        node(
          "galore",
          "GaLore: Memory-Efficient LLM Training by Gradient Low-Rank Projection",
          2024,
          "LoRA",
        ),
        node("rslora", "A Rank Stabilization Scaling Factor for Fine-Tuning with LoRA", 2023),
      ],
      [
        edge("lrpd", "lora", "baseline_only", "s2_context_rule"),
        edge("lhuc", "lrpd", "baseline_only", "api_citation"),
        edge("kld", "lhuc", "extends", "s2_context_rule"), // candidates never vouch for each other
        edge("adafactor", "galore"),
        edge("adafactor", "rslora"),
        edge("rslora", "galore"),
      ],
      {
        lrpd: adm("embedding", 2.2),
        lhuc: adm("embedding", 1.4),
        kld: adm("embedding", 1.1),
        adafactor: adm("embedding", 1.2),
        galore: adm("topic", 1.9),
        rslora: adm("topic", 2.6),
      },
    );
    expect(r.dropped.map((d) => d.id).sort()).toEqual(["adafactor", "kld", "lhuc", "lrpd"]);
    expect(r.kept).toEqual(["dora", "galore", "lora", "rslora"]);
    expect(r.edges.map((e) => `${e.src}>${e.dst}`)).toEqual(["rslora>galore"]);
  });

  it("keeps a predecessor an anchored node quotes as built upon, and recent or term-matched ones", () => {
    const r = run(
      [
        ...seeds,
        node(
          "sgd",
          "Accelerating Ill-Conditioned Low-Rank Matrix Estimation via Scaled Gradient Descent",
          2018,
        ),
        node("rlora", "Riemannian Preconditioned LoRA for Fine-Tuning Foundation Models", 2024),
        node("compacter", "Compacter: Efficient Low-Rank Hypercomplex Adapter Layers", 2021),
        node("tune", "To Tune or Not to Tune?", 2019),
        node("api", "An old paper with a heuristic extends", 2015),
        node("old-term", "Low-rank adaptation of acoustic models", 2014),
      ],
      [
        edge("sgd", "rlora", "extends", "s2_context_rule"),
        edge("compacter", "lora"),
        edge("tune", "dora"),
        edge("api", "dora", "extends", "foundational_allowlist"),
        edge("old-term", "lora"),
      ],
      {
        sgd: adm("embedding"),
        rlora: adm("topic"),
        compacter: adm("embedding"), // 2021: the earliest seed's year, not before
        tune: adm("embedding"), // 2019: two years before -> dropped
        api: adm("embedding"),
        "old-term": adm("topic"),
      },
    );
    expect(r.dropped.map((d) => d.id).sort()).toEqual(["api", "tune"]);
    expect(r.kept).toContain("sgd");
    expect(r.kept).toContain("compacter");
    expect(r.kept).toContain("old-term");
  });

  it("is off with preSeedYears = null, and the window follows the option", () => {
    const nodes = [...seeds, node("tune", "To Tune or Not to Tune?", 2019)];
    const edges = [edge("tune", "lora")];
    const off = new TopicScope("Low-Rank Adaptation", [], { preSeedYears: null });
    expect(run(nodes, edges, { tune: adm("embedding") }, off).dropped).toEqual([]);
    const wide = new TopicScope("Low-Rank Adaptation", [], { preSeedYears: 2 });
    expect(run(nodes, edges, { tune: adm("embedding") }, wide).dropped).toEqual([]);
    const tight = new TopicScope("Low-Rank Adaptation", [], { preSeedYears: 1 });
    expect(run(nodes, edges, { tune: adm("embedding") }, tight).dropped).toEqual([
      { id: "tune", year: 2019, z: 1.3 },
    ]);
  });
});

function paper(pid: string, title: string, year: number, abstract: string, cites = 10): ThemePaper {
  return {
    paperId: pid,
    title,
    year,
    venue: "arXiv",
    citationCount: cites,
    abstract,
    authors: [],
    externalIds: {},
  } as ThemePaper;
}

describe("runBfsAndDescendants: no expansion through embedding-only nodes (R2-35)", () => {
  const seed = paper(
    "s:lora",
    "LoRA: Low-Rank Adaptation of Large Language Models",
    2021,
    LORA_ABSTRACT,
  );
  const lrpd = paper(
    "s:lrpd",
    "Low-rank plus diagonal adaptation for deep neural networks",
    2016,
    "Speaker adaptation of DNN acoustic models with a low-rank plus diagonal adaptation scheme.",
  );
  const vera = paper(
    "s:vera",
    "VeRA: Vector-based Random Matrix Adaptation",
    2023,
    "VeRA reduces the trainable parameters of Low-Rank Adaptation further.",
  );
  const speech = paper(
    "s:speech",
    "Learning hidden unit contributions for unsupervised speaker adaptation",
    2014,
    "Speaker adaptation of hybrid acoustic models by hidden unit contributions.",
  );
  const veraRef = paper(
    "s:veraref",
    "Low-Rank Adaptation for vision models",
    2022,
    "We apply low-rank adaptation to vision backbones.",
  );
  const filler = (i: number) =>
    paper(`s:f${i}`, `Image classification benchmark ${i}`, 2015, "Images and labels. ".repeat(3));

  async function bfs(scope: TopicScope) {
    const cacheDir = mkdtempSync(join(tmpdir(), "r235-"));
    dirs.push(cacheDir);
    const related: Record<string, Record<string, ThemePaper[]>> = {
      references: {
        "s:lora": [lrpd, vera, filler(1), filler(2), filler(3), filler(4)],
        "s:lrpd": [speech],
        "s:vera": [veraRef],
      },
      citations: {},
    };
    const embedder: TopicEmbedder = {
      model: "fake",
      revision: "r",
      queryPrefix: "",
      embed: async (texts: readonly string[]) =>
        texts.map((t) => (/adapt/i.test(t) ? [1, 0] : [0, 1])),
    };
    const expansion = {
      expand: async (p: ThemePaper, kind: "references" | "citations") =>
        (related[kind]![p.paperId] ?? []).map((x) => ({ ...x })),
      summary: () => "",
    };
    return runBfsAndDescendants(
      [seed],
      {
        depth: 2,
        width: 8,
        maxSeedCite: 10 ** 9,
        provider: null,
        llmStrict: "off",
        currentYear: 2026,
        topicScope: scope,
        topicEmbedder: embedder,
        s2Expansion: expansion as never,
      },
      {
        cacheDir,
        sleep: async () => {},
        fetchImpl: async () => {
          throw new Error("no network");
        },
        logger: { warn: () => {} },
      } as never,
    );
  }

  it("expands term-matched nodes only by default", async () => {
    const r = await bfs(new TopicScope("Low-Rank Adaptation", []));
    expect(r.admissions.get("s:lrpd")?.why).toBe("embedding");
    expect(r.admissions.get("s:vera")?.why).toBe("topic");
    expect(r.nodes.has("s:veraref")).toBe(true);
    expect(r.nodes.has("s:speech")).toBe(false);
  });

  it("expandEmbeddingOnly: true restores the old expansion", async () => {
    const r = await bfs(new TopicScope("Low-Rank Adaptation", [], { expandEmbeddingOnly: true }));
    expect(r.nodes.has("s:speech")).toBe(true);
  });
});

// ---- ranked descendant search ----

function resp(status: number, body: unknown): HttpResponseLike {
  return { status, headers: { get: () => null }, json: async () => body };
}

const sha = (c: string) => c.repeat(40);
const LORA_SEED: ThemePaper = {
  paperId: "openalex:W3168867926",
  title: "LoRA: Low-Rank Adaptation of Large Language Models",
  year: 2021,
  venue: "arXiv",
  citationCount: 2510,
  abstract: LORA_ABSTRACT,
  authors: [],
  externalIds: { ArXiv: "2106.09685" },
};

function hit(id: string, title: string, arxiv: string, cites: number) {
  return {
    paperId: id,
    title,
    year: 2023,
    venue: "NeurIPS",
    citationCount: cites,
    abstract: `${title}. Low-Rank Adapters (LoRA).`,
    authors: [{ name: "A" }],
    externalIds: { ArXiv: arxiv },
  };
}

function searchHarness(opts: { search?: () => HttpResponseLike } = {}) {
  const calls: string[] = [];
  const refsOf: Record<string, unknown[]> = {
    // QLoRA cites LoRA; Stable Video Diffusion does not.
    "2305.14314": [
      {
        contexts: ["we use LoRA [12]"],
        intents: ["methodology"],
        isInfluential: true,
        citedPaper: { paperId: sha("1"), title: "LoRA", externalIds: { ArXiv: "2106.09685" } },
      },
    ],
    "2311.15127": [
      {
        contexts: [],
        intents: [],
        isInfluential: false,
        citedPaper: { paperId: sha("9"), title: "U-Net", externalIds: {} },
      },
    ],
  };
  const fetchImpl = async (url: string, _init: FetchInit): Promise<HttpResponseLike> => {
    calls.push(url);
    const u = decodeURIComponent(url);
    if (u.includes("/paper/search/bulk?")) {
      return (
        opts.search?.() ??
        resp(200, {
          total: 2,
          data: [
            hit(sha("e"), "QLoRA: Efficient Finetuning of Quantized LLMs", "2305.14314", 5951),
            hit(sha("f"), "Stable Video Diffusion", "2311.15127", 3003),
          ],
        })
      );
    }
    const m = u.match(/\/paper\/ARXIV:([\d.]+)\/references\?/);
    if (m) return resp(200, { data: refsOf[m[1]!] ?? [] });
    // An unmapped hit is looked up under its S2 id.
    if (u.includes(`/paper/${sha("f")}/references?`))
      return resp(200, { data: refsOf["2311.15127"] });
    // The seed's own S2 /citations (OpenAlex-empty fallback): newest
    // citers only, none of them the ranked hits.
    if (u.includes("/citations?")) return resp(200, { data: [] });
    if (u.startsWith("https://api.openalex.org/works?") && u.includes("filter=doi:")) {
      return resp(200, {
        results: [
          {
            id: "https://openalex.org/W4378509449",
            title: "QLoRA: Efficient Finetuning of Quantized LLMs",
            publication_year: 2023,
            doi: "https://doi.org/10.48550/arxiv.2305.14314",
            cited_by_count: 500,
            ids: { openalex: "https://openalex.org/W4378509449" },
          },
        ],
      });
    }
    throw new Error(`unexpected ${url}`);
  };
  const sleep = async () => {};
  const source = new S2CitationSource(null, {
    fetchImpl,
    sleep,
    now: () => new Date("2026-10-12T00:00:00Z"),
  });
  const cacheDir = mkdtempSync(join(tmpdir(), "r235-desc-"));
  dirs.push(cacheDir);
  const expansion = new S2Expansion({
    source,
    openalex: { fetchImpl, sleep, logger: { warn: () => {} } },
    cacheDir,
    descendantSearch: { candidates: 16 },
  });
  return { calls, expansion, cacheDir };
}

describe("S2Expansion ranked descendant search (R2-35)", () => {
  it("keeps the most-cited hits that cite the seed, under their OpenAlex id with S2's count", async () => {
    const h = searchHarness();
    h.expansion.setDescendantQuery('"Low Rank Adaptation" | LoRA', 2021);
    const ledger = new BuildCompleteness();
    const got = await h.expansion.expand(LORA_SEED, "citations", 16, async () => [], ledger);
    expect(got.map((p) => p.paperId)).toEqual(["openalex:W4378509449"]);
    expect(got[0]?._s2_citation_count).toBe(5951);
    expect(got[0]?._is_influential).toBe(true);
    expect(ledger.expansionsFailed).toBe(0);
    const search = h.calls.find((u) => u.includes("/search/bulk?"))!;
    expect(decodeURIComponent(search)).toContain('query="Low Rank Adaptation" | LoRA');
    expect(search).toContain("sort=citationCount:desc");
    expect(search).toContain("year=2021-");
    expect(h.expansion.summary()).toContain("verified seed citers=1");
    // One search per build; the pool is cached on disk.
    await h.expansion.expand(LORA_SEED, "citations", 16, async () => []);
    expect(h.calls.filter((u) => u.includes("/search/bulk?"))).toHaveLength(1);
    expect(readdirSync(h.cacheDir).some((f) => f.startsWith("s2descsearch_"))).toBe(true);
  });

  it("does nothing without a query (off by default) and for references", async () => {
    const h = searchHarness();
    expect(await h.expansion.expand(LORA_SEED, "citations", 16, async () => [])).toEqual([]);
    h.expansion.setDescendantQuery("LoRA", 2021);
    expect(await h.expansion.expand(LORA_SEED, "references", 16, async () => [])).toEqual([]);
    expect(h.calls.some((u) => u.includes("/search/bulk?"))).toBe(false);
  });

  it("records an unreachable search as a failed expansion", async () => {
    const h = searchHarness({ search: () => resp(503, {}) });
    h.expansion.setDescendantQuery("LoRA", 2021);
    const ledger = new BuildCompleteness();
    expect(await h.expansion.expand(LORA_SEED, "citations", 16, async () => [], ledger)).toEqual(
      [],
    );
    expect(ledger.expansionsFailed).toBe(1);
  });

  it("builds the query from the theme phrase, aliases and derived acronyms", () => {
    const scope = new TopicScope("Low-Rank Adaptation", ["low-rank adapters"]).withDerivedTerms([
      "LoRA",
    ]);
    expect(descendantSearchQuery(scope)).toBe('"Low Rank Adaptation" | "low rank adapters" | LoRA');
  });
});
