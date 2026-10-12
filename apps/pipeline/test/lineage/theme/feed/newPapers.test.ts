/**
 * R4-3 (design 48 P1-1): per-theme new-paper feed — OpenAlex `cites:` OR
 * query + pagination, the ">= 2 lineage papers" selection, the theme topic
 * gate, the `theme-new-papers-v1` document and the Atom rendering.
 * Network is faked; the one real OpenAlex page is a recorded fixture.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateArtifact } from "@paperpilot/core/schemas";
import { XMLParser } from "fast-xml-parser";
import { describe, expect, it } from "vitest";
import type { FetchInit, HttpResponseLike } from "../../../../src/collect/http/requestWithRetry.js";
import { renderAtomFeed, xmlEscape } from "../../../../src/lineage/theme/feed/atom.js";
import {
  anchorToNodeId,
  buildNewPapers,
  fetchCitingWorks,
  type LineageArtifactLike,
  lineageAnchors,
  NewPapersFetchError,
  selectCandidates,
  windowFor,
} from "../../../../src/lineage/theme/feed/newPapers.js";
import type { TopicEmbedder } from "../../../../src/lineage/theme/topicEmbedding.js";
import { TopicScope } from "../../../../src/lineage/theme/topicScope.js";

const FIXTURES = join(import.meta.dirname, "fixtures");
const NOW = Date.parse("2026-10-11T12:00:00Z");
const OA = (n: number) => `https://openalex.org/W${n}`;

/** Bag-of-keywords embedder (graph / language / image dimensions). */
class FakeEmbedder implements TopicEmbedder {
  readonly model = "fake/bow";
  readonly revision = "rev0000000000001";
  readonly queryPrefix = "Q: ";
  static readonly DIMS: RegExp[] = [
    /\b(?:graph|graphs|node|nodes|vertex|message|gnn|convolutional)\b/gi,
    /\b(?:sentence|semantic|language|translation)\b/gi,
    /\b(?:image|images|vision|pixel|segmentation)\b/gi,
  ];
  async embed(texts: readonly string[]): Promise<number[][]> {
    return texts.map((t) => {
      const v = [...FakeEmbedder.DIMS.map((re) => (t.match(re) ?? []).length), 0.5];
      const n = Math.sqrt(v.reduce((a, b) => a + b * b, 0));
      return v.map((x) => x / n);
    });
  }
}

const gnnScope = () => new TopicScope("Graph Neural Network", ["GNN"], {}, []);

function lineage(): LineageArtifactLike {
  const node = (n: number, title: string, abs: string) => ({
    id: `openalex:W${n}`,
    title,
    short_abstract: abs,
    aliases: [["arxiv", `17${n}.00001`]],
  });
  return {
    nodes: [
      node(
        1,
        "Graph Neural Networks: A Review",
        "Graph neural networks pass messages over graph nodes.",
      ),
      node(
        2,
        "Semi-Supervised Classification with Graph Convolutional Networks",
        "A graph convolutional network for node classification on graphs.",
      ),
      node(
        3,
        "Graph Attention Networks",
        "Attention over graph node neighbourhoods; message passing GNN.",
      ),
      {
        ...node(
          4,
          "Inductive Representation Learning on Large Graphs",
          "GraphSAGE samples graph node neighbourhoods.",
        ),
        aliases: [["openalex", "W40"]],
      },
    ],
    meta: {
      theme: "Graph Neural Network",
      slug: "graph-neural-network",
      seeds: ["openalex:W1", "openalex:W3"],
      generated_at: "2026-10-11T10:50:02.432000Z",
    },
  };
}

function work(
  n: number,
  title: string,
  abstract: string,
  refs: number[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const words = abstract.split(" ");
  const inv: Record<string, number[]> = {};
  words.forEach((w, i) => {
    inv[w] = [...(inv[w] ?? []), i];
  });
  return {
    id: OA(n),
    title,
    display_name: title,
    publication_year: 2026,
    publication_date: "2026-10-01",
    type: "article",
    doi: null,
    ids: { openalex: OA(n) },
    cited_by_count: 0,
    abstract_inverted_index: inv,
    authorships: [{ author: { display_name: `Author ${n}` } }],
    primary_location: { source: { display_name: "Venue X" } },
    locations: [],
    referenced_works: refs.map(OA),
    ...extra,
  };
}

const ON_TOPIC = work(
  101,
  "Scalable Message Passing Graph Neural Networks",
  "We propose a graph neural network that passes messages over graph nodes of molecular graphs.",
  [1, 2, 99],
);
const OFF_TOPIC = work(
  102,
  "Pixel Transformers for Image Segmentation",
  "An image segmentation model over pixel grids for vision; images and pixel vision benchmarks.",
  [2, 3],
);
const ONE_CITE = work(
  103,
  "Graph Neural Networks for Traffic",
  "Graph nodes of road networks.",
  [1],
);
const VIA_ALIAS = work(
  104,
  "Graph Neural Networks with Sampling",
  "A graph neural network that samples graph node neighbourhoods for message passing on graphs.",
  [40, 3],
  { publication_date: "2026-10-05", doi: "https://doi.org/10.1/abc" },
);
const PARATEXT = work(105, "Front matter", "graph graph graph", [1, 2], { type: "paratext" });
const IN_LINEAGE = work(
  2,
  "Semi-Supervised Classification with Graph Convolutional Networks",
  "x",
  [1, 3],
);
const TOO_OLD = work(106, "Graph Neural Networks old", "graph nodes", [1, 2], {
  publication_date: "2026-01-01",
});

interface Recorded {
  url: string;
}

function fakeFetch(pages: Array<{ status: number; body?: unknown }>): {
  fetchImpl: (url: string, init: FetchInit) => Promise<HttpResponseLike>;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  let i = 0;
  return {
    calls,
    fetchImpl: async (url) => {
      calls.push({ url });
      const p = pages[Math.min(i, pages.length - 1)]!;
      i += 1;
      return { status: p.status, json: async () => p.body };
    },
  };
}

const page = (results: unknown[], next: string | null) => ({
  status: 200,
  body: { meta: { next_cursor: next, count: results.length }, results },
});

const noSleep = async () => {};

describe("lineage anchors", () => {
  it("collects node ids and openalex aliases, mapping aliases to their node", () => {
    expect(lineageAnchors(lineage())).toEqual(["W1", "W2", "W3", "W4", "W40"]);
    expect(anchorToNodeId(lineage()).get("W40")).toBe("openalex:W4");
  });

  it("windowFor ends on the day of now and spans `days` days", () => {
    expect(windowFor(NOW, 30)).toEqual({ from: "2026-09-12", to: "2026-10-11" });
    expect(windowFor(NOW, 1)).toEqual({ from: "2026-10-11", to: "2026-10-11" });
  });
});

describe("fetchCitingWorks", () => {
  it("sends one cites: OR filter with the window and follows the cursor", async () => {
    const { fetchImpl, calls } = fakeFetch([page([ON_TOPIC], "c2"), page([OFF_TOPIC], null)]);
    const res = await fetchCitingWorks(
      { anchors: ["W1", "W2"], from: "2026-09-12", to: "2026-10-11", maxPages: 5 },
      { fetchImpl, sleep: noSleep },
    );
    expect(res.works.map((w) => w.id)).toEqual([OA(101), OA(102)]);
    expect(res).toMatchObject({ pages: 2, truncated: false });
    const u = new URL(calls[0]!.url);
    expect(u.searchParams.get("filter")).toBe(
      "cites:W1|W2,from_publication_date:2026-09-12,to_publication_date:2026-10-11",
    );
    expect(u.searchParams.get("cursor")).toBe("*");
    expect(u.searchParams.get("select")).toContain("referenced_works");
    expect(new URL(calls[1]!.url).searchParams.get("cursor")).toBe("c2");
  });

  it("splits more than 100 anchors into several OR filters", async () => {
    const anchors = Array.from({ length: 150 }, (_, i) => `W${i + 1}`);
    const { fetchImpl, calls } = fakeFetch([page([], null)]);
    await fetchCitingWorks(
      { anchors, from: "a", to: "b", maxPages: 5 },
      { fetchImpl, sleep: noSleep },
    );
    expect(calls).toHaveLength(2);
    const f0 = new URL(calls[0]!.url).searchParams.get("filter")!;
    expect(f0.split(",")[0]!.split("|")).toHaveLength(100);
  });

  it("stops at maxPages (credit cap) and reports truncation", async () => {
    const { fetchImpl, calls } = fakeFetch([page([ON_TOPIC], "c2"), page([OFF_TOPIC], "c3")]);
    const res = await fetchCitingWorks(
      { anchors: ["W1"], from: "a", to: "b", maxPages: 1 },
      { fetchImpl, sleep: noSleep },
    );
    expect(calls).toHaveLength(1);
    expect(res.truncated).toBe(true);
  });

  it("throws (never a partial list) when a page fails", async () => {
    const { fetchImpl } = fakeFetch([page([ON_TOPIC], "c2"), { status: 403, body: {} }]);
    await expect(
      fetchCitingWorks(
        { anchors: ["W1"], from: "a", to: "b", maxPages: 5 },
        { fetchImpl, sleep: noSleep },
      ),
    ).rejects.toBeInstanceOf(NewPapersFetchError);
  });
});

describe("selectCandidates", () => {
  it("keeps works citing >= 2 distinct lineage nodes, in the window, of an allowed type", () => {
    const { candidates, stats } = selectCandidates(
      [ON_TOPIC, OFF_TOPIC, ONE_CITE, VIA_ALIAS, PARATEXT, IN_LINEAGE, TOO_OLD],
      lineage(),
      { minLineageCites: 2, from: "2026-09-12", to: "2026-10-11" },
    );
    expect(candidates.map((c) => c.paper.paperId)).toEqual([
      // 2 cites each: newest first (104 on 10-05), then id order on ties.
      "openalex:W104",
      "openalex:W101",
      "openalex:W102",
    ]);
    expect(candidates[0]!.citesLineage).toEqual(["openalex:W3", "openalex:W4"]);
    expect(stats).toEqual({ fetched: 7, in_lineage: 1, excluded_type: 2, below_min_cites: 1 });
  });

  it("keeps OpenAlex `conference-paper` works (proceedings papers are new papers too)", () => {
    const proceedings = work(107, "Graph Neural Networks at NeurIPS", "graph nodes", [1, 2], {
      type: "conference-paper",
    });
    const { candidates, stats } = selectCandidates([proceedings, PARATEXT], lineage(), {
      minLineageCites: 2,
      from: "2026-09-12",
      to: "2026-10-11",
    });
    expect(candidates.map((c) => c.paper.paperId)).toEqual(["openalex:W107"]);
    expect(stats.excluded_type).toBe(1);
  });

  it("recorded OpenAlex page: every work cites a single lineage node, so none is kept", () => {
    const recorded = JSON.parse(
      readFileSync(join(FIXTURES, "openalex-cites-flash-attention.json"), "utf8"),
    ) as { results: Record<string, unknown>[] };
    const fa: LineageArtifactLike = {
      nodes: [
        "W2940744433",
        "W2997517014",
        "W3091156754",
        "W3092852584",
        "W4226001818",
        "W4281758439",
        "W4384648639",
        "W4388327470",
        "W4390042124",
        "W4400611982",
        "W4405090274",
        "W4417447635",
        "W7154502343",
        "W7220440728",
      ].map((w) => ({ id: `openalex:${w}` })),
      meta: { theme: "Flash Attention" },
    };
    const { candidates, stats } = selectCandidates(recorded.results, fa, {
      minLineageCites: 2,
      from: "2026-09-11",
      to: "2026-10-11",
    });
    expect(candidates).toEqual([]);
    expect(stats.below_min_cites).toBe(3);
  });
});

describe("buildNewPapers (gate + document)", () => {
  async function build(embedder: TopicEmbedder | null) {
    const { fetchImpl } = fakeFetch([page([ON_TOPIC, OFF_TOPIC, ONE_CITE, VIA_ALIAS], null)]);
    return buildNewPapers(
      lineage(),
      gnnScope(),
      embedder,
      { slug: "graph-neural-network", nowMs: NOW, days: 30 },
      { fetchImpl, sleep: noSleep },
    );
  }

  it("drops an off-topic citer with the embedding gate and validates against the schema", async () => {
    const doc = await build(new FakeEmbedder());
    expect(doc.items.map((i) => i.id)).toEqual(["openalex:W104", "openalex:W101"]);
    expect(doc.stats).toMatchObject({
      fetched: 4,
      below_min_cites: 1,
      off_topic: 1,
      kept: 2,
      pages: 1,
    });
    expect(doc.topic_gate.method).toBe("embedding+terms");
    expect(doc.items[0]).toMatchObject({
      url: "https://doi.org/10.1/abc",
      cites_lineage: ["openalex:W3", "openalex:W4"],
      topic: { admitted_by: "topic" },
    });
    expect(typeof doc.items[0]!.topic.z).toBe("number");
    expect(doc.window).toEqual({ from: "2026-09-12", to: "2026-10-11", days: 30 });
    expect(doc.generated_at).toBe("2026-10-11T12:00:00Z");
    const res = validateArtifact("theme-new-papers-v1", doc);
    expect(res.errors).toBeNull();
    expect(res.ok).toBe(true);
  });

  it("falls back to the term rule without an embedder (title must be about the theme)", async () => {
    const doc = await build(null);
    expect(doc.topic_gate).toMatchObject({
      method: "terms",
      fallback_reason: "embedding disabled",
    });
    expect(doc.items.map((i) => i.id)).toEqual(["openalex:W104", "openalex:W101"]);
    expect(doc.items.every((i) => i.topic.z === null)).toBe(true);
  });

  it("the schema rejects an item without a lineage citation", async () => {
    const doc = await build(new FakeEmbedder());
    const bad = structuredClone(doc);
    bad.items[0]!.cites_lineage = [];
    expect(validateArtifact("theme-new-papers-v1", bad).ok).toBe(false);
  });
});

describe("Atom feed", () => {
  it("is well-formed, escapes text, names the cited lineage papers and is deterministic", async () => {
    const { fetchImpl } = fakeFetch([
      page(
        [
          work(
            201,
            'Graph Neural Networks <&> "Quotes"',
            "graph neural network over graph nodes",
            [1, 2],
          ),
        ],
        null,
      ),
    ]);
    const doc = await buildNewPapers(
      lineage(),
      gnnScope(),
      new FakeEmbedder(),
      { slug: "graph-neural-network", nowMs: NOW },
      { fetchImpl, sleep: noSleep },
    );
    const titles = new Map(lineage().nodes.map((n) => [n.id, String(n.title)]));
    const xml = renderAtomFeed(doc, { titleOf: (id) => titles.get(id) });
    expect(renderAtomFeed(doc, { titleOf: (id) => titles.get(id) })).toBe(xml);
    const parsed = new XMLParser({ ignoreAttributes: false }).parse(xml) as {
      feed: { id: string; link: Array<Record<string, string>>; entry: Record<string, unknown> };
    };
    expect(parsed.feed.id).toBe(
      "https://paperpilot.pages.dev/themes/graph-neural-network/feed.xml",
    );
    expect(parsed.feed.link[1]!["@_href"]).toBe(
      "https://paperpilot.pages.dev/themes/?theme=graph-neural-network",
    );
    expect(parsed.feed.entry.title).toBe('Graph Neural Networks <&> "Quotes"');
    expect(xml).toContain("<title>Graph Neural Networks &lt;&amp;&gt; &quot;Quotes&quot;</title>");
    expect(xml).toContain("<id>https://openalex.org/W201</id>");
    expect(xml).toContain("この系譜の 2 本を引用:");
    expect(xml).toContain("「Graph Neural Networks: A Review」");
    expect(xml).toContain("<published>2026-10-01T00:00:00Z</published>");
  });

  it("an empty list is still a valid feed", () => {
    const xml = renderAtomFeed({
      schema_version: "theme-new-papers-v1",
      kind: "theme-new-papers",
      theme: "X",
      slug: "x",
      generated_at: "2026-10-11T12:00:00Z",
      source: "openalex",
      window: { from: "2026-09-12", to: "2026-10-11", days: 30 },
      lineage_generated_at: null,
      anchor_count: 0,
      min_lineage_cites: 2,
      topic_gate: { method: "terms", model: null, revision: null, thresholds: null, pool_size: 0 },
      stats: {
        fetched: 0,
        pages: 0,
        truncated: false,
        in_lineage: 0,
        excluded_type: 0,
        below_min_cites: 0,
        off_topic: 0,
        kept: 0,
        capped: 0,
      },
      items: [],
    });
    expect(xml).not.toContain("<entry>");
    expect(new XMLParser().parse(xml).feed.title).toBe("PaperPilot 新着論文: X");
  });

  it("xmlEscape strips XML-illegal control characters", () => {
    expect(xmlEscape("a\u0001b<")).toBe("ab&lt;");
  });
});
