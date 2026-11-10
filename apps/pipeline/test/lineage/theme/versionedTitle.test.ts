/**
 * R2-70 (#498): the explicit fallback rule that folds a preprint into its
 * renamed venue version when no stable ID links them (GNN-RAG 2024 arXiv
 * vs 2025 ACL Findings), and keeps look-alikes apart (Vision Mamba
 * method paper vs a survey of the same name).
 */
import { describe, expect, it } from "vitest";
import {
  authorSurnames,
  TitleIdentity,
  VERSIONED_TITLE_RULE,
  type VersionedTitlePaper,
  versionedTitlePrefix,
} from "../../../src/lineage/theme/dedup.js";

const team = [{ name: "Costas Mavromatis" }, { name: "George Karypis" }];
const preprint = {
  paperId: "W4399253046",
  title: "GNN-RAG: Graph Neural Retrieval for Large Language Model Reasoning",
  year: 2024,
  authors: team,
  externalIds: { OpenAlex: "W4399253046", ArXiv: "2405.20139", DOI: "10.48550/arxiv.2405.20139" },
};
const venue = {
  paperId: "W4412888160",
  title:
    "GNN-RAG: Graph Neural Retrieval for Efficient Large Language Model Reasoning on Knowledge Graphs",
  year: 2025,
  authors: team,
  externalIds: { OpenAlex: "W4412888160", DOI: "10.18653/v1/2025.findings-acl.856" },
};

function identityWith(...papers: ({ paperId: string } & VersionedTitlePaper)[]): TitleIdentity {
  const t = new TitleIdentity();
  for (const p of papers) t.register(p.paperId, p);
  return t;
}

describe("versioned-title fallback rule (R2-70)", () => {
  it("normalises the name before the colon and the author surnames", () => {
    expect(versionedTitlePrefix(venue.title)).toBe("gnn rag");
    expect(versionedTitlePrefix("No colon in this title")).toBeNull();
    expect(versionedTitlePrefix("X: too short a name")).toBeNull();
    expect([...authorSurnames(["José Núñez", { name: "Ann Lee" }])]).toEqual(["nunez", "lee"]);
  });

  it("folds the renamed venue version into the registered preprint, either way round", () => {
    expect(identityWith(preprint).resolveWithRule(venue)).toEqual({
      id: preprint.paperId,
      rule: VERSIONED_TITLE_RULE,
    });
    expect(identityWith(venue).resolveWithRule(preprint)?.id).toBe(venue.paperId);
  });

  it("keeps a same-name survey by other authors apart (Vision Mamba)", () => {
    const method = {
      paperId: "vim",
      title:
        "Vision Mamba: Efficient Visual Representation Learning with Bidirectional State Space Model",
      year: 2024,
      authors: [{ name: "Lianghui Zhu" }, { name: "Bencheng Liao" }, { name: "Qian Zhang" }],
      externalIds: { ArXiv: "2401.09417" },
    };
    const survey = {
      paperId: "vimSurvey",
      title: "Vision Mamba: A Comprehensive Survey and Taxonomy",
      year: 2025,
      authors: [{ name: "Xiao Liu" }, { name: "Chenxu Zhang" }],
      externalIds: {},
    };
    expect(identityWith(method).resolveWithRule(survey)).toBeNull();
  });

  it("needs every condition: years, author containment, >= 2 authors, exactly one arXiv id", () => {
    const t = identityWith(preprint);
    expect(t.resolveWithRule({ ...venue, year: 2026 })).toBeNull();
    expect(t.resolveWithRule({ ...venue, year: null })).toBeNull();
    expect(
      t.resolveWithRule({ ...venue, authors: [team[0], { name: "Someone Else" }] }),
    ).toBeNull();
    // A superset of the team still qualifies (venue version adds an author).
    expect(t.resolveWithRule({ ...venue, authors: [...team, { name: "New Coauthor" }] })?.id).toBe(
      preprint.paperId,
    );
    const solo = identityWith({ ...preprint, authors: [team[0]] });
    expect(solo.resolveWithRule({ ...venue, authors: [team[0]] })).toBeNull();
    expect(t.resolveWithRule({ ...venue, externalIds: { ArXiv: "2405.99999" } })).toBeNull();
  });

  it("rejects generic prefixes, changed subtitles, another first author and journal extensions", () => {
    const pos = (id: string, title: string, year: number, ext: Record<string, string>) => ({
      paperId: id,
      title,
      year,
      authors: [{ name: "Jiliang Tang" }, { name: "Xiangyu Zhao" }],
      externalIds: ext,
    });
    const a = pos("p1", "Position: Graph Foundation Models Are Already Here", 2024, {
      ArXiv: "2402.02216",
    });
    const b = pos("p2", "Position: Graph Foundation Models Are Already Here and Scaling", 2025, {});
    expect(versionedTitlePrefix(a.title)).toBeNull();
    expect(identityWith(a).resolve(b)).toBeNull();
    expect(identityWith(a).resolveWithRule(b)).toBeNull();
    const t = identityWith(preprint);
    // A sequel changes the subtitle words.
    expect(
      t.resolveWithRule({ ...venue, title: "GNN-RAG: Scaling Retrieval to Many Hops" }),
    ).toBeNull();
    // Same surnames, different first author.
    expect(t.resolveWithRule({ ...venue, authors: [team[1], team[0]] })).toBeNull();
    // Two different publisher DOIs: conference paper vs journal extension.
    const conf = {
      ...preprint,
      externalIds: { ArXiv: "2405.20139", DOI: "10.18653/v1/2024.acl-long.1" },
    };
    const journal = { ...venue, externalIds: { DOI: "10.1162/tacl_a_00001" } };
    expect(identityWith(conf).resolveWithRule(journal)).toBeNull();
    // The arXiv DataCite DOI never conflicts with the venue DOI.
    expect(t.resolveWithRule(venue)?.rule).toBe(VERSIONED_TITLE_RULE);
  });

  it("resolve() stays title-only; the fallback answers only through resolveWithRule", () => {
    expect(identityWith(preprint).resolve(venue)).toBeNull();
  });

  it("merges nothing when two registered nodes qualify (ambiguous)", () => {
    const other = { ...preprint, paperId: "W1", externalIds: { ArXiv: "2405.11111" } };
    expect(identityWith(preprint, other).resolveWithRule(venue)).toBeNull();
  });

  it("still answers the exact-title rule first", () => {
    const same = { ...preprint, paperId: "S2x", year: 2025, externalIds: {} };
    expect(identityWith(preprint).resolveWithRule(same)).toEqual({
      id: preprint.paperId,
      rule: "title",
    });
  });
});
