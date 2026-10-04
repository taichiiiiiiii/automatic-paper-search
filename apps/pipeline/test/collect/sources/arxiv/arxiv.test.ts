/**
 * Port of `paperpilot/tests/test_arxiv_source.py`.
 *
 * STRUCTURAL DIFFERENCE from the Python suite: the Python tests stub
 * `arxiv.Client.results()` with `SimpleNamespace` result objects (and, for
 * the two tests that exercise the response-hook half of HIGH-1, a canned
 * `requests` transport adapter). This port owns its own HTTP+Atom-parsing
 * layer, so there is no `.results()` seam to stub — every test here
 * injects `fetchText` and returns Atom XML bodies instead. The ASSERTIONS
 * (what `fetch()` returns, `truncatedKeywords`, `degradedKeywords`) are
 * the same as the Python suite's.
 *
 * N/A (no TS port): `test_mid_stream_failure_withdraws_the_papers_it_already_appended`
 * is ported below using a second-page fetch failure (this port's analogue
 * of "the generator dies after yielding one paper") rather than a raising
 * generator, since pagination here is page-by-page HTTP calls, not a
 * Python generator.
 */
import { describe, expect, it } from "vitest";
import {
  ArxivSource,
  type ArxivTextResponse,
} from "../../../../src/collect/sources/arxiv/arxiv.js";
import { AllKeywordsFailedError } from "../../../../src/collect/sources/source.js";

function atomFeed(opts: {
  totalResults?: number;
  startIndex?: number;
  entries: { id: string; published: string; title?: string; authorName?: string }[];
}): string {
  const entries = opts.entries
    .map(
      (e) =>
        `<entry><id>${e.id}</id><updated>${e.published}</updated><published>${e.published}</published>` +
        `<title>${e.title ?? "Paper"}</title><summary>abs</summary><author><name>${
          e.authorName ?? "Author"
        }</name></author></entry>`,
    )
    .join("");
  const total = opts.totalResults ?? opts.entries.length;
  const startIndex = opts.startIndex ?? 0;
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">' +
    `<opensearch:totalResults>${total}</opensearch:totalResults>` +
    `<opensearch:itemsPerPage>${opts.entries.length}</opensearch:itemsPerPage>` +
    `<opensearch:startIndex>${startIndex}</opensearch:startIndex>` +
    entries +
    "</feed>"
  );
}

function textResp(status: number, body: string): ArxivTextResponse {
  return { status, text: async () => body };
}

function newest(
  n: number,
  isoDate: string,
  idPrefix = "2604.0000",
): { id: string; published: string }[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `http://arxiv.org/abs/${idPrefix}${i}`,
    published: `${isoDate}T00:00:00Z`,
  }));
}

describe("ArxivSource.buildQuery / buildCategoryClause", () => {
  it("quotes a multi-word keyword", () => {
    expect(ArxivSource.buildQuery("large language model", "cat:cs.AI OR cat:cs.CL")).toBe(
      '(all:"large language model") AND (cat:cs.AI OR cat:cs.CL)',
    );
  });
  it("leaves a single word unquoted", () => {
    expect(ArxivSource.buildQuery("transformer", "cat:cs.LG")).toBe(
      "(all:transformer) AND (cat:cs.LG)",
    );
  });
  it("omits the AND clause with no categories", () => {
    expect(ArxivSource.buildQuery("gpt", "")).toBe("all:gpt");
  });
  it("builds the category OR clause", () => {
    expect(ArxivSource.buildCategoryClause(["cs.LG", "cs.AI"])).toBe("cat:cs.LG OR cat:cs.AI");
    expect(ArxivSource.buildCategoryClause([])).toBe("");
  });
});

describe("ArxivSource.fetch — happy path & since_date boundary", () => {
  it("stops once an entry older than since_date is seen (results sorted DESC)", async () => {
    const body = atomFeed({
      entries: [
        { id: "http://arxiv.org/abs/2604.01", published: "2026-04-14T00:00:00Z" },
        { id: "http://arxiv.org/abs/2601.01", published: "2026-01-01T00:00:00Z" },
      ],
    });
    const src = new ArxivSource(
      { delaySeconds: 0 },
      { fetchText: async () => textResp(200, body) },
    );
    const result = await src.fetch({
      keywords: ["transformer"],
      categories: ["cs.LG"],
      sinceDate: "2026-04-10",
      maxResults: 10,
    });
    expect(result.papers).toHaveLength(1);
    expect(result.papers[0]?.arxivId).toBe("2604.01");
  });

  it("maps title/authors/abstract/arxivId/pdfUrl/doi/comment/categories", async () => {
    const body =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns:arxiv="http://arxiv.org/schemas/atom">' +
      "<opensearch:totalResults>1</opensearch:totalResults><opensearch:itemsPerPage>1</opensearch:itemsPerPage><opensearch:startIndex>0</opensearch:startIndex>" +
      "<entry><id>http://arxiv.org/abs/1706.03762v5</id><updated>2017-06-12T17:50:16Z</updated><published>2017-06-12T17:50:16Z</published>" +
      "<title>Attention Is All You Need</title><summary>We propose the Transformer.</summary>" +
      "<author><name>Vaswani</name></author><author><name>Shazeer</name></author>" +
      '<link title="pdf" href="http://arxiv.org/pdf/1706.03762v5" rel="related" type="application/pdf"/>' +
      '<category term="cs.CL"/><category term="cs.LG"/>' +
      "<arxiv:comment>Accepted at NeurIPS 2017</arxiv:comment><arxiv:doi>10.1234/abc</arxiv:doi>" +
      "</entry></feed>";
    const src = new ArxivSource(
      { delaySeconds: 0 },
      { fetchText: async () => textResp(200, body) },
    );
    const result = await src.fetch({
      keywords: ["transformer"],
      categories: [],
      sinceDate: "2000-01-01",
      maxResults: 5,
    });
    const p = result.papers[0];
    expect(p).toBeDefined();
    if (!p) return;
    expect(p.title).toBe("Attention Is All You Need");
    expect(p.arxivId).toBe("1706.03762"); // version suffix stripped
    expect(p.source).toBe("arxiv");
    expect(p.authors).toEqual(["Vaswani", "Shazeer"]);
    expect(p.abstract).toContain("Transformer");
    expect(p.pdfUrl).toBe("http://arxiv.org/pdf/1706.03762v5");
    expect(p.doi).toBe("10.1234/abc");
    expect(p.comment).toBe("Accepted at NeurIPS 2017");
    expect(p.categories).toEqual(["cs.CL", "cs.LG"]);
    expect(p.matchedKeywords).toEqual(["transformer"]);
  });
});

describe("ArxivSource.fetch — all-keywords-failed vs. partial success", () => {
  it("raises when every keyword's request fails (regression, closes #387)", async () => {
    const src = new ArxivSource({ delaySeconds: 0 }, { fetchText: async () => textResp(500, "") });
    await expect(
      src.fetch({ keywords: ["x"], categories: [], sinceDate: "2026-01-01", maxResults: 5 }),
    ).rejects.toThrow(AllKeywordsFailedError);
  });

  it("keeps partial results when only some keywords fail", async () => {
    const goodBody = atomFeed({
      entries: [{ id: "http://arxiv.org/abs/2604.00001", published: "2026-04-01T00:00:00Z" }],
    });
    const src = new ArxivSource(
      { delaySeconds: 0 },
      {
        fetchText: async (url) => {
          if (url.includes("bad")) return textResp(500, "");
          return textResp(200, goodBody);
        },
      },
    );
    const result = await src.fetch({
      keywords: ["bad", "good"],
      categories: [],
      sinceDate: "2026-01-01",
      maxResults: 5,
    });
    expect(result.papers).toHaveLength(1);
  });
});

describe("ArxivSource.fetch — malformed feed pages (COL-01..06)", () => {
  it("raises when a malformed empty page is the only keyword", async () => {
    const src = new ArxivSource(
      { delaySeconds: 0 },
      { fetchText: async () => textResp(200, "<html><body>rate limited</body></html>") },
    );
    await expect(
      src.fetch({
        keywords: ["transformer"],
        categories: [],
        sinceDate: "2026-01-01",
        maxResults: 5,
      }),
    ).rejects.toThrow(AllKeywordsFailedError);
  });

  it("a malformed keyword is a failed keyword beside a clean one; its papers are withdrawn", async () => {
    const goodBody = atomFeed({
      entries: [
        {
          id: "http://arxiv.org/abs/2604.00002",
          published: "2026-04-01T00:00:00Z",
          title: "Good Paper",
        },
      ],
    });
    const src = new ArxivSource(
      { delaySeconds: 0 },
      {
        fetchText: async (url) => {
          if (url.includes("broken"))
            return textResp(200, "<html><body>rate limited</body></html>");
          return textResp(200, goodBody);
        },
      },
    );
    const result = await src.fetch({
      keywords: ["broken", "good"],
      categories: [],
      sinceDate: "2026-01-01",
      maxResults: 5,
    });
    expect(result.papers.map((p) => p.title)).toEqual(["Good Paper"]);
    expect(result.degradedKeywords.map(([kw]) => kw)).toEqual(["broken"]);
    expect(result.degradedKeywords[0]?.[1]).toContain("non-feed 200 response body");
    expect(result.truncatedKeywords).toEqual([]);
  });

  it("a skipped entry within an otherwise well-formed feed degrades the keyword (COL-01/06)", async () => {
    const body =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">' +
      "<opensearch:totalResults>1</opensearch:totalResults><opensearch:itemsPerPage>1</opensearch:itemsPerPage><opensearch:startIndex>0</opensearch:startIndex>" +
      "<entry><id>http://arxiv.org/abs/2604.00002v1</id><updated>2026-04-02T00:00:00Z</updated><title>Missing Published</title><summary>an abstract</summary><author><name>Alice</name></author></entry>" +
      "</feed>";
    const src = new ArxivSource(
      { delaySeconds: 0 },
      { fetchText: async () => textResp(200, body) },
    );
    await expect(
      src.fetch({
        keywords: ["transformer"],
        categories: [],
        sinceDate: "2026-01-01",
        maxResults: 5,
      }),
    ).rejects.toThrow(AllKeywordsFailedError);
  });

  it("withdraws papers already appended when a later page fails (mid-stream failure)", async () => {
    const page1 = atomFeed({
      totalResults: 5,
      entries: [
        {
          id: "http://arxiv.org/abs/2604.00010",
          published: "2026-04-05T00:00:00Z",
          title: "Orphan",
        },
      ],
    });
    const goodBody = atomFeed({
      entries: [
        {
          id: "http://arxiv.org/abs/2604.00002",
          published: "2026-04-01T00:00:00Z",
          title: "Good Paper",
        },
      ],
    });
    let riskyCalls = 0;
    const src = new ArxivSource(
      { delaySeconds: 0, pageSize: 1, numRetries: 0 },
      {
        fetchText: async (url) => {
          if (url.includes("risky")) {
            riskyCalls += 1;
            if (riskyCalls === 1) return textResp(200, page1);
            return textResp(500, "");
          }
          return textResp(200, goodBody);
        },
      },
    );
    const result = await src.fetch({
      keywords: ["risky", "good"],
      categories: [],
      sinceDate: "2026-01-01",
      maxResults: 5,
    });
    expect(result.papers.map((p) => p.title)).toEqual(["Good Paper"]);
    expect(result.degradedKeywords.map(([kw]) => kw)).toEqual(["risky"]);
  });

  it("a well-formed empty page is a successful zero-paper keyword, not a failure", async () => {
    const src = new ArxivSource(
      { delaySeconds: 0 },
      { fetchText: async () => textResp(200, atomFeed({ entries: [] })) },
    );
    const result = await src.fetch({
      keywords: ["obscure term"],
      categories: [],
      sinceDate: "2026-01-01",
      maxResults: 5,
    });
    expect(result.papers).toEqual([]);
    expect(result.truncatedKeywords).toEqual([]);
  });
});

describe("ArxivSource.fetch — truncated windows (COL-09)", () => {
  it("records a window-filling keyword as truncated", async () => {
    const body = atomFeed({ totalResults: 3, entries: newest(3, "2026-04-10") });
    const src = new ArxivSource(
      { delaySeconds: 0 },
      { fetchText: async () => textResp(200, body) },
    );
    const result = await src.fetch({
      keywords: ["llm"],
      categories: [],
      sinceDate: "2026-04-01",
      maxResults: 3,
    });
    expect(result.papers).toHaveLength(3);
    expect(result.truncatedKeywords).toEqual(["llm"]);
  });

  it("is not truncated when the last item reaches the since_date boundary", async () => {
    const entries = [
      ...newest(2, "2026-04-10"),
      { id: "http://arxiv.org/abs/2601.00001", published: "2026-01-01T00:00:00Z" },
    ];
    const body = atomFeed({ totalResults: 3, entries });
    const src = new ArxivSource(
      { delaySeconds: 0 },
      { fetchText: async () => textResp(200, body) },
    );
    const result = await src.fetch({
      keywords: ["llm"],
      categories: [],
      sinceDate: "2026-04-01",
      maxResults: 3,
    });
    expect(result.papers).toHaveLength(2);
    expect(result.truncatedKeywords).toEqual([]);
  });

  it("is not truncated when fewer items than max_results came back", async () => {
    const body = atomFeed({ totalResults: 2, entries: newest(2, "2026-04-10") });
    const src = new ArxivSource(
      { delaySeconds: 0 },
      { fetchText: async () => textResp(200, body) },
    );
    const result = await src.fetch({
      keywords: ["llm"],
      categories: [],
      sinceDate: "2026-04-01",
      maxResults: 5,
    });
    expect(result.papers).toHaveLength(2);
    expect(result.truncatedKeywords).toEqual([]);
  });
});
