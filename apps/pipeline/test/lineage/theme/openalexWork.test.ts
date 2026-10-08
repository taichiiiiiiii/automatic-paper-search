/**
 * Vitest port of the OpenAlex-helper tests in
 * `paperpilot/tests/test_build_theme_lineage.py` (decode_abstract_inverted_index,
 * openalex_short_id, work_to_paper_dict, arxiv_id_from_work, the #273
 * publication_year corruption guard).
 */
import { describe, expect, it } from "vitest";
import {
  arxivIdFromWork,
  decodeAbstractInvertedIndex,
  extractDoi,
  normaliseArxivId,
  openalexShortId,
  workToPaperDict,
} from "../../../src/lineage/theme/openalexWork.js";

function mkOaWorkV2(
  shortId: string,
  opts: {
    title?: string;
    year?: number;
    citedByCount?: number;
    doi?: string;
    venue?: string;
    abstractWords?: readonly string[];
  } = {},
): Record<string, unknown> {
  const {
    title = "Sample paper",
    year = 2022,
    citedByCount = 100,
    doi,
    venue = "NeurIPS",
    abstractWords = ["we", "propose", "a", "method"],
  } = opts;
  const inverted: Record<string, number[]> = {};
  abstractWords.forEach((word, i) => {
    if (!inverted[word]) inverted[word] = [];
    inverted[word].push(i);
  });
  const work: Record<string, unknown> = {
    id: `https://openalex.org/${shortId}`,
    title,
    publication_year: year,
    cited_by_count: citedByCount,
    abstract_inverted_index: inverted,
    primary_location: { source: { display_name: venue } },
    authors: [],
    authorships: [{ author: { display_name: "A. Author" } }],
  };
  if (doi) {
    work.doi = `https://doi.org/${doi}`;
    work.ids = { doi: `https://doi.org/${doi}` };
  }
  return work;
}

describe("decodeAbstractInvertedIndex", () => {
  it("reconstructs text in position order", () => {
    const inverted = {
      We: [0],
      propose: [1],
      a: [2],
      novel: [3],
      method: [4, 7],
      for: [5],
      the: [6],
    };
    expect(decodeAbstractInvertedIndex(inverted)).toBe("We propose a novel method for the method");
  });

  it("is defensive against malformed input", () => {
    expect(decodeAbstractInvertedIndex(null)).toBe("");
    expect(decodeAbstractInvertedIndex("not a dict")).toBe("");
    expect(decodeAbstractInvertedIndex({})).toBe("");
    expect(decodeAbstractInvertedIndex({ hello: [-1], world: [0] })).toBe("world");
  });
});

describe("openalexShortId", () => {
  it("extracts from a full URL, passes through an already-short id, rejects garbage", () => {
    expect(openalexShortId("https://openalex.org/W2962917714")).toBe("W2962917714");
    expect(openalexShortId("W123")).toBe("W123");
    expect(openalexShortId("")).toBeNull();
    expect(openalexShortId(null)).toBeNull();
    expect(openalexShortId("not-a-work-id")).toBeNull();
  });
});

describe("workToPaperDict", () => {
  it("returns the S2-shape dict with paperId='openalex:W...'", () => {
    const work = mkOaWorkV2("W2962917714", {
      title: "Deep contextualized word representations",
      year: 2018,
      citedByCount: 12345,
      doi: "10.18653/v1/N18-1202",
      venue: "NAACL",
    });
    const paper = workToPaperDict(work);
    expect(paper).not.toBeNull();
    expect(paper?.paperId).toBe("openalex:W2962917714");
    expect(paper?.title).toBe("Deep contextualized word representations");
    expect(paper?.year).toBe(2018);
    expect(paper?.citationCount).toBe(12345);
    expect(paper?.venue).toBe("NAACL");
    expect(paper?.externalIds.OpenAlex).toBe("W2962917714");
    expect(paper?.externalIds.DOI).toBe("10.18653/v1/N18-1202");
    expect(paper?.abstract.toLowerCase()).toContain("we propose a method");
    expect(paper?.authors).toEqual([{ name: "A. Author" }]);
  });

  it("returns null for a missing id or title", () => {
    expect(workToPaperDict({ title: "T" })).toBeNull();
    expect(workToPaperDict({ id: "https://openalex.org/X1" })).toBeNull();
    expect(workToPaperDict({})).toBeNull();
  });

  it("surfaces ids.arxiv_id as externalIds.ArXiv", () => {
    const work = mkOaWorkV2("W123", { title: "Some paper" });
    work.ids = { arxiv_id: "2103.14030", doi: "https://doi.org/10.x/y" };
    const paper = workToPaperDict(work);
    expect(paper?.externalIds.ArXiv).toBe("2103.14030");
  });

  it("extracts arxiv id from a landing url without disturbing venue", () => {
    const work = mkOaWorkV2("W124", { title: "P", venue: "ICML" });
    work.ids = { arxiv_id: null };
    work.primary_location = {
      source: { display_name: "ICML" },
      landing_page_url: "https://arxiv.org/abs/2103.14030",
    };
    const paper = workToPaperDict(work);
    expect(paper?.venue).toBe("ICML");
    expect(paper?.externalIds.ArXiv).toBe("2103.14030");
  });

  describe("#273 publication_year corruption guard", () => {
    it("trusts publication_year when within the preprint-lag range", () => {
      const w1 = mkOaWorkV2("W1", { year: 2022 });
      w1.created_date = "2022-03-15T00:00:00";
      expect(workToPaperDict(w1)?.year).toBe(2022);

      const w2 = mkOaWorkV2("W2", { year: 2019 });
      w2.created_date = "2017-06-23T00:00:00";
      expect(workToPaperDict(w2)?.year).toBe(2019);
    });

    it("replaces a corrupted publication_year with created_date's year (>=3y forward gap)", () => {
      const work = mkOaWorkV2("W2626778328", { year: 2025 });
      work.created_date = "2017-06-23T00:00:00";
      expect(workToPaperDict(work)?.year).toBe(2017);
    });

    it("keeps publication_year when created_date is absent or malformed", () => {
      const w3 = mkOaWorkV2("W3", { year: 2024 });
      expect(workToPaperDict(w3)?.year).toBe(2024);

      const w4 = mkOaWorkV2("W4", { year: 2024 });
      w4.created_date = "garbage";
      expect(workToPaperDict(w4)?.year).toBe(2024);
    });

    it("treats 3 years as the inclusive drift threshold", () => {
      const w5 = mkOaWorkV2("W5", { year: 2020 });
      w5.created_date = "2018-01-01T00:00:00";
      expect(workToPaperDict(w5)?.year).toBe(2020);

      const w6 = mkOaWorkV2("W6", { year: 2020 });
      w6.created_date = "2017-01-01T00:00:00";
      expect(workToPaperDict(w6)?.year).toBe(2017);
    });

    it("is one-way: created_date ahead of publication_year does not flip it", () => {
      const work = mkOaWorkV2("W7133227460", { year: 2022 });
      work.created_date = "2026-03-03T00:00:00";
      expect(workToPaperDict(work)?.year).toBe(2022);
    });
  });
});

describe("arxivIdFromWork (#301)", () => {
  it("prefers ids.arxiv_id", () => {
    expect(arxivIdFromWork({ ids: { arxiv_id: "2010.11929" } })).toBe("2010.11929");
  });

  it("extracts from primary_location.landing_page_url", () => {
    const work = {
      ids: { arxiv_id: null },
      primary_location: { landing_page_url: "https://arxiv.org/abs/2010.11929" },
    };
    expect(arxivIdFromWork(work)).toBe("2010.11929");
  });

  it("extracts from primary_location.pdf_url (with version suffix stripped)", () => {
    const work = { primary_location: { pdf_url: "https://arxiv.org/pdf/2205.14135v2" } };
    expect(arxivIdFromWork(work)).toBe("2205.14135");
  });

  it("extracts from the locations[] array when primary_location is absent", () => {
    const work = {
      locations: [
        { landing_page_url: "https://example.com/not-arxiv" },
        { landing_page_url: "https://arxiv.org/abs/2103.14030" },
      ],
    };
    expect(arxivIdFromWork(work)).toBe("2103.14030");
  });

  it("extracts from the DataCite arXiv DOI via doi and ids.doi", () => {
    expect(arxivIdFromWork({ doi: "https://doi.org/10.48550/arXiv.2010.11929" })).toBe(
      "2010.11929",
    );
    expect(arxivIdFromWork({ ids: { doi: "https://doi.org/10.48550/arXiv.2103.14030" } })).toBe(
      "2103.14030",
    );
  });

  it("returns null for a genuinely non-arXiv work", () => {
    const work = {
      ids: { arxiv_id: null, doi: "https://doi.org/10.1234/foo" },
      primary_location: { landing_page_url: "https://example.com/x" },
      locations: [{ landing_page_url: "https://nature.com/y" }],
      doi: "https://doi.org/10.1234/foo",
    };
    expect(arxivIdFromWork(work)).toBeNull();
  });

  it("is defensive against bad input shapes and never throws", () => {
    expect(arxivIdFromWork(null)).toBeNull();
    expect(arxivIdFromWork("not a dict")).toBeNull();
    expect(arxivIdFromWork({})).toBeNull();
    expect(arxivIdFromWork({ primary_location: "x", locations: "y", ids: "z" })).toBeNull();
  });

  it("respects allowDataciteDoi=false (LIN-22: identity callers must not promote a DataCite DOI)", () => {
    const work = { doi: "https://doi.org/10.48550/arXiv.2010.11929" };
    expect(arxivIdFromWork(work, { allowDataciteDoi: false })).toBeNull();
    expect(arxivIdFromWork(work, { allowDataciteDoi: true })).toBe("2010.11929");
  });
});

describe("normaliseArxivId", () => {
  it("accepts bare ids, arXiv: prefix, URLs, and DataCite DOIs", () => {
    expect(normaliseArxivId("2010.11929")).toBe("2010.11929");
    expect(normaliseArxivId("2010.11929v3")).toBe("2010.11929");
    expect(normaliseArxivId("arXiv:2010.11929")).toBe("2010.11929");
    expect(normaliseArxivId("https://arxiv.org/abs/2010.11929")).toBe("2010.11929");
    expect(normaliseArxivId("https://arxiv.org/pdf/2010.11929v2.pdf")).toBe("2010.11929");
    expect(normaliseArxivId("10.48550/arXiv.2010.11929")).toBe("2010.11929");
  });

  it("rejects non-arxiv input", () => {
    expect(normaliseArxivId(null)).toBeNull();
    expect(normaliseArxivId("")).toBeNull();
    expect(normaliseArxivId("https://nature.com/articles/x")).toBeNull();
    expect(normaliseArxivId("cs.LG/0512345")).toBeNull();
    expect(normaliseArxivId("https://arxiv.org/abs/2010.11929?x=1")).toBeNull();
  });
});

describe("extractDoi", () => {
  it("strips the doi.org URL prefix", () => {
    expect(extractDoi({ doi: "https://doi.org/10.1234/abc" })).toBe("10.1234/abc");
    expect(extractDoi({ ids: { doi: "http://dx.doi.org/10.1234/abc" } })).toBe("10.1234/abc");
  });

  it("passes a bare DOI through unchanged", () => {
    expect(extractDoi({ doi: "10.1234/abc" })).toBe("10.1234/abc");
  });

  it("returns null when absent", () => {
    expect(extractDoi({})).toBeNull();
  });
});
