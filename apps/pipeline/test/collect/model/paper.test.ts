/**
 * Port of `paperpilot/tests/test_paper_model.py`.
 */
import { describe, expect, it } from "vitest";
import { createPaper, paperToDict, paperUid } from "../../../src/collect/model/paper.js";

describe("paperUid", () => {
  it("prefers arxiv_id", () => {
    const p = createPaper({
      title: "t",
      authors: [],
      abstract: "",
      url: "u",
      publishedDate: "2026-01-01",
      source: "arxiv",
      arxivId: "2604.001",
      doi: "10.1000/x",
    });
    expect(paperUid(p)).toBe("arxiv:2604.001");
  });

  it("falls back to doi", () => {
    const p = createPaper({
      title: "t",
      authors: [],
      abstract: "",
      url: "u",
      publishedDate: "2026-01-01",
      source: "s2",
      doi: "10.1000/x",
    });
    expect(paperUid(p)).toBe("doi:10.1000/x");
  });

  it("falls back to url", () => {
    const p = createPaper({
      title: "t",
      authors: [],
      abstract: "",
      url: "http://x/1",
      publishedDate: "2026-01-01",
      source: "openalex",
    });
    expect(paperUid(p)).toBe("url:http://x/1");
  });
});

describe("paperToDict", () => {
  it("round-trips through a dict, matching Python's to_dict() shape", () => {
    const p = createPaper({
      title: "Hello",
      authors: ["A", "B"],
      abstract: "Abs",
      url: "http://x",
      publishedDate: "2026-03-15",
      source: "arxiv",
      arxivId: "2603.1",
      categories: ["cs.LG"],
    });
    const d = paperToDict(p);
    expect(d["published_date"]).toBe("2026-03-15");
    expect(d["uid"]).toBe("arxiv:2603.1");
    expect(d["title"]).toBe("Hello");
    expect(d["categories"]).toEqual(["cs.LG"]);
  });
});
