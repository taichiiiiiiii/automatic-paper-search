import { describe, expect, it } from "vitest";
import {
  bibtexEscape,
  bibtexKeyBase,
  CATALOG_CSV_HEADER,
  catalogPapersToBibtex,
  catalogPapersToCsv,
  conferenceYear,
  csvCell,
  exportFilename,
  THEME_EDGE_CSV_HEADER,
  themeEdgesToCsv,
  themeNodesToBibtex,
  themeNodesToCsv,
  toCsv,
} from "../../lib/export-formats";

describe("CSV (design 48 P0-3)", () => {
  it("quotes commas, quotes and newlines", () => {
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell("x\ny")).toBe('"x\ny"');
    expect(csvCell(null)).toBe("");
    expect(csvCell(3)).toBe("3");
  });

  it("neutralises spreadsheet formulas (CSV injection)", () => {
    for (const bad of ["=HYPERLINK(1)", "+1", "-1+2", "@SUM(A1)"]) {
      expect(csvCell(bad).startsWith("'")).toBe(true);
    }
  });

  it("starts with a BOM and uses CRLF", () => {
    const csv = toCsv(["a", "b"], [[1, 2]]);
    expect(csv.startsWith("\uFEFFa,b\r\n1,2\r\n")).toBe(true);
  });
});

describe("BibTeX", () => {
  it("escapes LaTeX specials", () => {
    expect(bibtexEscape("50% & $x$ #1 a_b {c}")).toBe("50\\% \\& \\$x\\$ \\#1 a\\_b \\{c\\}");
    expect(bibtexEscape("a\\b ~ ^")).toBe(
      "a\\textbackslash{}b \\textasciitilde{} \\textasciicircum{}",
    );
  });

  it("builds ASCII keys from last name, year and first content word", () => {
    expect(bibtexKeyBase(["Ashish Vaswani"], 2017, "Attention Is All You Need")).toBe(
      "vaswani2017attention",
    );
    expect(bibtexKeyBase([], null, "The Graph Neural Network Model")).toBe("anongraph");
    expect(bibtexKeyBase(["Jürgen Schmidhuber"], 1997, "Long short-term memory")).toBe(
      "schmidhuber1997long",
    );
  });

  it("writes one entry per theme node with unique keys and arXiv/DOI fields", () => {
    const bib = themeNodesToBibtex([
      {
        id: "a",
        title: "FlashAttention",
        year: 2022,
        authors: ["Tri Dao"],
        arxiv_id: "2205.14135",
      },
      {
        id: "b",
        title: "FlashAttention again",
        year: 2022,
        authors: ["Tri Dao"],
        doi: "10.1234/xyz",
      },
      { id: "c", title: "No authors" },
    ]);
    expect(bib.match(/^@misc\{/gm)).toHaveLength(3);
    expect(bib).toContain("@misc{dao2022flashattention,");
    expect(bib).toContain("@misc{dao2022flashattentiona,");
    expect(bib).toContain("eprint = {2205.14135}");
    expect(bib).toContain("archiveprefix = {arXiv}");
    expect(bib).toContain("doi = {10.1234/xyz}");
    expect(bib).toContain("title = {{FlashAttention}}");
    expect(bib).not.toContain("author = {}");
  });

  it("writes catalog entries as inproceedings with the conference year", () => {
    expect(conferenceYear("iclr-2026")).toBe(2026);
    expect(conferenceYear("weird")).toBeNull();
    const bib = catalogPapersToBibtex(
      [
        {
          paper_id: "p1",
          title: "$PhyWorldBench$: physics",
          authors: ["Jing Gu", "Xian Liu"],
          tags: [],
          type: "Oral",
          arxiv_url: "https://openreview.net/forum?id=rlZeILv3fm",
        },
      ],
      { slug: "iclr-2026", display: "ICLR 2026" },
    );
    expect(bib).toContain("@inproceedings{gu2026phyworldbench,");
    expect(bib).toContain("author = {Jing Gu and Xian Liu}");
    expect(bib).toContain("booktitle = {ICLR 2026}");
    expect(bib).toContain("year = {2026}");
    expect(bib).toContain("title = {{\\$PhyWorldBench\\$: physics}}");
    expect(bib).toContain("url = {https://openreview.net/forum?id=rlZeILv3fm}");
  });
});

describe("theme / catalog CSV", () => {
  it("marks main-path nodes and edges and includes relation evidence", () => {
    const nodes = [
      { id: "a", title: "Old", year: 2020, authors: ["A B"] },
      { id: "b", title: "New, improved", year: 2021, authors: ["C D", "E F"] },
    ];
    const nodeCsv = themeNodesToCsv(nodes, new Set(["a"]));
    expect(nodeCsv).toContain("a,Old,2020,,A B,,,,");
    expect(nodeCsv.split("\r\n")[1]?.endsWith(",yes")).toBe(true);
    expect(nodeCsv).toContain('"New, improved"');
    const e = {
      src: "a",
      dst: "b",
      relation: "extends",
      confidence: 0.8,
      rationale: "=evil()",
      provenance: { classification: { method: "s2_context_rule" } },
    };
    const edgeCsv = themeEdgesToCsv([e], new Map(nodes.map((n) => [n.id, n])), () => true);
    const [header, row] = edgeCsv.replace("\uFEFF", "").split("\r\n");
    expect(header).toBe(THEME_EDGE_CSV_HEADER.join(","));
    expect(row).toContain("a,Old,b,");
    expect(row).toContain("extends,拡張,0.80,");
    expect(row).toContain(",'=evil(),yes");
  });

  it("exports catalog rows", () => {
    const csv = catalogPapersToCsv([
      {
        paper_id: "p1",
        title: "T",
        authors: ["X", "Y"],
        tags: ["LLM", "RL"],
        type: "Poster",
        arxiv_id: "2401.00001",
        pdf_url: "https://arxiv.org/pdf/2401.00001",
      },
    ]);
    const [header, row] = csv.replace("\uFEFF", "").split("\r\n");
    expect(header).toBe(CATALOG_CSV_HEADER.join(","));
    expect(row).toBe(
      "p1,T,X; Y,Poster,LLM; RL,2401.00001,https://arxiv.org/abs/2401.00001,https://arxiv.org/pdf/2401.00001",
    );
  });

  it("makes safe file names", () => {
    expect(exportFilename("iclr-2026-papers", "csv", new Date("2026-10-11T00:00:00Z"))).toBe(
      "iclr-2026-papers-2026-10-11.csv",
    );
    expect(exportFilename("../x y", "bib", new Date("2026-10-11T00:00:00Z"))).toBe(
      "..-x-y-2026-10-11.bib",
    );
  });
});
