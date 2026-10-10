/**
 * R2-17: theme graph structure (ERROR_PATTERNS 5, 6, 10).
 *  - acronym versions ("Pyramid Vision Transformer" -> "PVT v2") are
 *    `title_version` supersedes, guarded by author overlap;
 *  - 2-cycles from revised preprints keep only the year-consistent edge;
 *  - seeds: canonical method papers from the surveys' references, surveys
 *    only when no method paper exists.
 */
import { describe, expect, it } from "vitest";
import {
  deriveRelationHeuristic,
  isAcronymVersionIncrement,
  isVersionIncrement,
} from "../../../src/lineage/classify/classify.js";
import type { ThemeGraphNode } from "../../../src/lineage/shared/node.js";
import { addVersionFamilyEdges, dropReversedEdges } from "../../../src/lineage/theme/bfs.js";
import {
  rankCanonicalMethodSeeds,
  selectThemeSeeds,
} from "../../../src/lineage/theme/discoverSeeds.js";
import type { ThemeEdge } from "../../../src/lineage/theme/edges.js";
import type { ThemePaper } from "../../../src/lineage/theme/openalexWork.js";
import { TopicScope } from "../../../src/lineage/theme/topicScope.js";

const PVT = {
  title:
    "Pyramid Vision Transformer: A Versatile Backbone for Dense Prediction without Convolutions",
  year: 2021,
  authors: ["Wenhai Wang", "Enze Xie", "Xiang Li", "Ping Luo", "Ling Shao"],
};
const PVT2 = {
  title: "PVT v2: Improved Baselines with Pyramid Vision Transformer",
  year: 2022,
  authors: [{ name: "Wenhai Wang" }, { name: "Enze Xie" }, { name: "Ping Luo" }],
};

describe("acronym version increments (ERROR_PATTERNS 5)", () => {
  it("matches the acronym of the parent's name, with v2 / V2 / -2 / ++ / no space", () => {
    expect(isAcronymVersionIncrement(PVT, PVT2)).toBe(true);
    expect(isVersionIncrement(PVT, PVT2)).toBe(true);
    for (const t of ["PVTv2: x", "PVT V2: x", "PVT-2: x", "PVT++: x", "PVT 2"]) {
      expect(isAcronymVersionIncrement(PVT, { ...PVT2, title: t }), t).toBe(true);
    }
    // Parent already written as the acronym.
    expect(isAcronymVersionIncrement({ ...PVT, title: "PVT: a backbone" }, PVT2)).toBe(true);
  });

  it("emits title_version supersedes from the heuristic instead of a successor guess", () => {
    const d = deriveRelationHeuristic({}, PVT, PVT2);
    expect(d?.relation).toBe("supersedes");
    expect(d?.provenance).toBe("title_version");
  });

  it("rejects different authors, a wrong acronym, v1/huge versions and the reverse direction", () => {
    expect(
      isAcronymVersionIncrement(PVT, { ...PVT2, authors: ["Someone Else", "Another Person"] }),
    ).toBe(false);
    expect(isAcronymVersionIncrement(PVT, { ...PVT2, title: "PVTX v2: x" })).toBe(false);
    expect(isAcronymVersionIncrement(PVT, { ...PVT2, title: "PVT v1: x" })).toBe(false);
    expect(isAcronymVersionIncrement(PVT, { ...PVT2, title: "PVT v99: x" })).toBe(false);
    expect(isAcronymVersionIncrement(PVT2, PVT)).toBe(false);
    // An ordinary word is not an acronym.
    expect(
      isAcronymVersionIncrement({ title: "Pyramid Vision", authors: [] }, { title: "Pv 2" }),
    ).toBe(false);
  });

  it("accepts without an author check when either side lists no authors", () => {
    expect(isAcronymVersionIncrement({ title: PVT.title }, { title: PVT2.title })).toBe(true);
  });

  it("the version-family pass links an uncited acronym version", () => {
    const nodes = new Map<string, ThemeGraphNode>([
      ["A", { id: "A", ...PVT } as unknown as ThemeGraphNode],
      [
        "B",
        { id: "B", ...PVT2, authors: ["Wenhai Wang", "Enze Xie"] } as unknown as ThemeGraphNode,
      ],
    ]);
    const edges: ThemeEdge[] = [];
    expect(addVersionFamilyEdges(nodes, edges)).toBe(1);
    expect(edges[0]).toMatchObject({ src: "A", dst: "B", relation: "supersedes" });
  });
});

function edge(src: string, dst: string, relation: string, conf = 0.6, method = "s2"): ThemeEdge {
  return {
    src,
    dst,
    rel: relation,
    relation,
    conf,
    confidence: conf,
    rationale: "r",
    provenance: { classification: { method } },
  } as unknown as ThemeEdge;
}

describe("dropReversedEdges (ERROR_PATTERNS 6)", () => {
  const nodes = new Map<string, { year?: unknown }>([
    ["pvt", { year: 2021 }],
    ["pvt2", { year: 2022 }],
    ["x", { year: 2020 }],
    ["y", { year: 2020 }],
    ["s19", { year: 2019 }],
    ["s20", { year: 2020 }],
  ]);

  it("keeps the year-consistent direction of a 2-cycle and reports the drop", () => {
    const fwd = edge("pvt", "pvt2", "successor", 0.4);
    const back = edge("pvt2", "pvt", "baseline_only", 0.9);
    const out = dropReversedEdges(nodes, [fwd, back]);
    expect(out.edges).toEqual([fwd]);
    expect(out.dropped).toEqual([
      { src: "pvt2", dst: "pvt", relation: "baseline_only", reason: "two_cycle_year_inverted" },
    ]);
  });

  it("a title_version edge wins; same-year cycles keep the higher confidence", () => {
    const tv = edge("pvt", "pvt2", "supersedes", 0.6, "title_version");
    const back = edge("pvt2", "pvt", "baseline_only", 0.9);
    expect(dropReversedEdges(nodes, [back, tv]).edges).toEqual([tv]);
    const a = edge("x", "y", "baseline_only", 0.5);
    const b = edge("y", "x", "extends", 0.7);
    const out = dropReversedEdges(nodes, [a, b]);
    expect(out.edges).toEqual([b]);
    expect(out.dropped[0]?.reason).toBe("two_cycle_tie");
  });

  it("keeps a lone year-inverted edge (arXiv version of the cited paper) and counts it", () => {
    const lone = edge("s20", "s19", "baseline_only");
    const out = dropReversedEdges(nodes, [lone, edge("x", "pvt", "extends")]);
    expect(out.edges).toHaveLength(2);
    expect(out.loneInverted).toBe(1);
    expect(out.dropped).toEqual([]);
  });
});

function paper(
  id: string,
  title: string,
  extra: Partial<ThemePaper> & { abstract?: string } = {},
): ThemePaper {
  return {
    paperId: id,
    title,
    year: 2017,
    venue: "",
    citationCount: 100,
    abstract: "We propose a method for graph neural networks.",
    authors: [],
    externalIds: { ArXiv: id.replace(/\D/g, "") || "1609.02907" },
    ...extra,
  } as ThemePaper;
}

describe("canonical method seeds from survey references (ERROR_PATTERNS 10)", () => {
  const scope = TopicScope.forTheme("Graph Neural Network");
  const GCN = paper(
    "openalex:W1",
    "Semi-Supervised Classification with Graph Convolutional Networks",
    {
      citationCount: 30000,
      abstract: "A scalable approach based on graph convolutional networks.",
    },
  );
  const GAT = paper("openalex:W2", "Graph Attention Networks", { citationCount: 15000 });
  const MPNN = paper("openalex:W3", "Neural Message Passing for Quantum Chemistry", {
    citationCount: 8000,
    abstract: "We reformulate models as message passing neural networks (MPNNs).",
  });
  const RESNET = paper("openalex:W4", "Deep Residual Learning for Image Recognition", {
    citationCount: 200000,
    abstract: "Deeper neural networks are more difficult to train.",
  });
  const SURVEY = paper("openalex:W5", "A Comprehensive Survey on Graph Neural Networks", {
    citationCount: 10000,
  });
  const CORA = paper("openalex:W6", "Collective Classification in Network Data", {
    citationCount: 3000,
    abstract: "We introduce a new benchmark dataset for graph neural networks.",
  });

  it("ranks on-topic non-survey references by survey support, then citations", () => {
    const ranked = rankCanonicalMethodSeeds(
      [
        [RESNET, GAT, SURVEY, CORA, MPNN],
        [GCN, GAT, RESNET],
      ],
      { scope, limit: 5 },
    );
    expect(ranked.map((p) => p.title)).toEqual([
      "Graph Attention Networks",
      "Semi-Supervised Classification with Graph Convolutional Networks",
      "Neural Message Passing for Quantum Chemistry",
    ]);
  });

  it("applies the caller's accept test and the limit", () => {
    const ranked = rankCanonicalMethodSeeds([[GCN, GAT, MPNN]], {
      scope,
      limit: 1,
      accept: (p) => p.paperId !== "openalex:W1",
    });
    expect(ranked.map((p) => p.paperId)).toEqual(["openalex:W2"]);
  });

  it("selectThemeSeeds: canonical first, then non-survey search hits; surveys only as a last resort", () => {
    const hetero = paper("openalex:W7", "Heterogeneous Graph Neural Network");
    const picked = selectThemeSeeds([SURVEY, hetero], [GCN, GAT, MPNN], {
      topN: 4,
      canonicalSlots: 2,
    });
    expect(picked.map((p) => p.paperId)).toEqual([
      "openalex:W1",
      "openalex:W2",
      "openalex:W7",
      "openalex:W3",
    ]);
    const onlySurveys = selectThemeSeeds([SURVEY, { ...SURVEY, paperId: "openalex:W8" }], [], {
      topN: 5,
      canonicalSlots: 2,
    });
    expect(onlySurveys.map((p) => p.paperId)).toEqual(["openalex:W5"]);
  });

  it("selectThemeSeeds skips candidates the accept test refuses (no identity / duplicate)", () => {
    const picked = selectThemeSeeds([GCN, GAT], [], {
      topN: 2,
      canonicalSlots: 0,
      accept: (_sel, c) => c.paperId !== "openalex:W1",
    });
    expect(picked.map((p) => p.paperId)).toEqual(["openalex:W2"]);
  });
});
