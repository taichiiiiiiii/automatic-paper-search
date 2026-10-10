/**
 * Port of `paperpilot/tests/test_openalex_source.py`.
 */
import { describe, expect, it, vi } from "vitest";
import { OpenAlexGate } from "../../../src/collect/http/openalexGate.js";
import type { FetchInit, HttpResponseLike } from "../../../src/collect/http/requestWithRetry.js";
import { OpenAlexSource } from "../../../src/collect/sources/openalex.js";
import { AllKeywordsFailedError } from "../../../src/collect/sources/source.js";

function resp(status: number, body: unknown = {}): HttpResponseLike {
  return { status, json: async () => body };
}

function queryParam(url: string, key: string): string | null {
  return new URL(url).searchParams.get(key);
}

const TODAY = "2026-06-15";
function daysAgo(n: number): string {
  const d = new Date(`${TODAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function work(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const pubDate = (overrides["pub_date"] as string | undefined) ?? "2026-04-10";
  const authors = (overrides["authors"] as string[] | undefined) ?? ["Alice", "Bob"];
  const venue = overrides["venue"] === undefined ? "ICLR" : (overrides["venue"] as string | null);
  const doi = overrides["doi"] === undefined ? "10.1/xyz" : (overrides["doi"] as string | null);
  const pdf = overrides["pdf"] === undefined ? "http://pdf" : (overrides["pdf"] as string | null);
  const title = (overrides["title"] as string | undefined) ?? "Sample Work";
  const workId = (overrides["work_id"] as string | undefined) ?? "W123";
  const abstractInverted =
    overrides["abstract_inverted"] !== undefined
      ? overrides["abstract_inverted"]
      : { We: [0], propose: [1], a: [2], new: [3], method: [4] };
  return {
    id: `https://openalex.org/${workId}`,
    title,
    display_name: title,
    abstract_inverted_index: abstractInverted,
    publication_date: pubDate,
    publication_year: pubDate ? Number(pubDate.split("-")[0]) : null,
    doi: doi ? `https://doi.org/${doi}` : null,
    ids: { doi: doi ? `https://doi.org/${doi}` : null },
    authorships: authors.map((a, i) => ({
      author: { display_name: a, id: `https://openalex.org/A${i}` },
      institutions: [{ display_name: "Test University" }],
    })),
    host_venue: venue ? { display_name: venue } : {},
    open_access: pdf ? { oa_url: pdf } : {},
  };
}

function src(fetchImpl: ReturnType<typeof vi.fn>, email: string | null = null): OpenAlexSource {
  return new OpenAlexSource({ delaySeconds: 0 }, { fetchImpl, email, sleep: async () => {} });
}

describe("OpenAlexSource.fetch — happy path", () => {
  it("maps fields and rehydrates the abstract", async () => {
    const w = work({ pub_date: daysAgo(2) });
    const fetchImpl = vi.fn().mockResolvedValue(resp(200, { results: [w] }));
    const result = await src(fetchImpl).fetch({
      keywords: ["language model"],
      categories: [],
      sinceDate: daysAgo(7),
      maxResults: 10,
    });
    expect(result.papers).toHaveLength(1);
    const p = result.papers[0];
    expect(p?.title).toBe("Sample Work");
    expect(p?.source).toBe("openalex");
    expect(p?.doi).toBe("10.1/xyz");
    expect(p?.pdfUrl).toBe("http://pdf");
    expect(p?.venue).toBe("ICLR");
    expect(p?.authors).toEqual(["Alice", "Bob"]);
    expect(p?.matchedKeywords).toEqual(["language model"]);
    expect(p?.abstract).toBe("We propose a new method");
  });

  it("drops works before since_date", async () => {
    const body = {
      results: [
        work({ work_id: "old", pub_date: daysAgo(60) }),
        work({ work_id: "new", pub_date: daysAgo(1) }),
      ],
    };
    const fetchImpl = vi.fn().mockResolvedValue(resp(200, body));
    const result = await src(fetchImpl).fetch({
      keywords: ["x"],
      categories: [],
      sinceDate: daysAgo(7),
      maxResults: 10,
    });
    expect(result.papers).toHaveLength(1);
    expect(result.papers[0]?.url).toContain("new");
  });
});

describe("OpenAlexSource.fetch — HTTP failure contracts (COL-07/10)", () => {
  it("raises when every keyword's request fails (regression, closes #399)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(resp(500));
    await expect(
      src(fetchImpl).fetch({ keywords: ["x"], categories: [], sinceDate: TODAY, maxResults: 5 }),
    ).rejects.toThrow(AllKeywordsFailedError);
  });

  it("keeps partial results when only some keywords fail via HTTP", async () => {
    const good = work({ work_id: "W1", title: "Good Paper", pub_date: TODAY });
    const fetchImpl = vi.fn(async (url: string) => {
      if (queryParam(url, "search") === "bad") return resp(500);
      return resp(200, { results: [good] });
    });
    const result = await src(fetchImpl).fetch({
      keywords: ["bad", "good"],
      categories: [],
      sinceDate: daysAgo(7),
      maxResults: 10,
    });
    expect(result.papers).toHaveLength(1);
    expect(result.papers[0]?.title).toBe("Good Paper");
    expect(result.degradedKeywords).toEqual([
      ["bad", "RuntimeError: openalex search failed for 'bad' (status=500)"],
    ]);
  });
});

describe("OpenAlexSource — polite pool email", () => {
  it("adds the email to mailto when configured", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(resp(200, { results: [] }));
    await src(fetchImpl, "me@example.com").fetch({
      keywords: ["x"],
      categories: [],
      sinceDate: TODAY,
      maxResults: 5,
    });
    const url = fetchImpl.mock.calls[0]?.[0] as string;
    expect(queryParam(url, "mailto")).toBe("me@example.com");
  });

  it("omits mailto with no email configured", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(resp(200, { results: [] }));
    await src(fetchImpl, null).fetch({
      keywords: ["x"],
      categories: [],
      sinceDate: TODAY,
      maxResults: 5,
    });
    const url = fetchImpl.mock.calls[0]?.[0] as string;
    expect(queryParam(url, "mailto")).toBeNull();
  });
});

describe("OpenAlexSource.rehydrateAbstract — COL-14", () => {
  it("returns empty for null/empty index", () => {
    expect(OpenAlexSource.rehydrateAbstract(null)).toBe("");
    expect(OpenAlexSource.rehydrateAbstract({})).toBe("");
  });

  it("preserves word order, repeating a token at multiple positions", () => {
    const inverted = { Fast: [0, 3], and: [1], reliable: [2] };
    expect(OpenAlexSource.rehydrateAbstract(inverted)).toBe("Fast and reliable Fast");
  });

  it("discards the whole abstract on a negative position (regression, closes #398)", () => {
    const inverted = { Fast: [0], corrupt: [-1], reliable: [1] };
    expect(OpenAlexSource.rehydrateAbstract(inverted)).toBe("");
  });

  it("discards the whole abstract on a non-integer position", () => {
    expect(OpenAlexSource.rehydrateAbstract({ Fast: [0], bad_str: ["1"], reliable: [1] })).toBe("");
    expect(OpenAlexSource.rehydrateAbstract({ Fast: [0], bad_float: [2.5], reliable: [1] })).toBe(
      "",
    );
  });

  it("discards the whole abstract on a boolean position", () => {
    expect(OpenAlexSource.rehydrateAbstract({ Fast: [0], boolean: [true] })).toBe("");
  });

  it("discards the whole abstract when positions is not a list", () => {
    expect(OpenAlexSource.rehydrateAbstract({ Fast: [0], malformed: 5 })).toBe("");
  });

  it("returns empty for a non-object top-level value", () => {
    expect(OpenAlexSource.rehydrateAbstract([1, 2, 3])).toBe("");
    expect(OpenAlexSource.rehydrateAbstract("not-a-dict")).toBe("");
    expect(OpenAlexSource.rehydrateAbstract(123)).toBe("");
  });
});

describe("OpenAlexSource.toPaper — survives malformed data (closes #398)", () => {
  it("keeps the paper with the abstract cleared when abstract_inverted_index is malformed", () => {
    const w = {
      id: "https://openalex.org/W1",
      title: "A Paper With Bad Abstract Data",
      publication_date: TODAY,
      abstract_inverted_index: { ok: [0], bad: ["not-an-int"] },
      authorships: [],
    };
    const paper = src(vi.fn()).toPaper(w, "kw", daysAgo(1));
    expect(paper).not.toBeNull();
    expect(paper?.title).toBe("A Paper With Bad Abstract Data");
    expect(paper?.abstract).toBe("");
  });
});

describe("OpenAlexSource.search — dropped vs. skipped items (D-1, H-1)", () => {
  it("skips a malformed work item and keeps valid siblings", async () => {
    const good = {
      id: "https://openalex.org/W1",
      title: "Good Paper",
      publication_date: TODAY,
      authorships: [],
    };
    const malformed = {
      id: "https://openalex.org/W2",
      title: 12345,
      publication_date: TODAY,
      authorships: [],
    };
    const fetchImpl = vi.fn().mockResolvedValue(resp(200, { results: [malformed, good] }));
    const outcome = await src(fetchImpl).search("kw", daysAgo(7), 2);
    expect(outcome.papers).toHaveLength(1);
    expect(outcome.papers[0]?.title).toBe("Good Paper");
    expect(outcome.unreadable).toBe("1 of 2 works unreadable");
    expect(outcome.pageIsFull).toBe(false);
  });

  it("records a fully dropped page as unreadable, not truncated", async () => {
    const body = {
      results: [0, 1].map((i) => ({
        id: `https://openalex.org/W${i}`,
        title: 12345,
        publication_date: TODAY,
        authorships: [],
      })),
    };
    const fetchImpl = vi.fn().mockResolvedValue(resp(200, body));
    const outcome = await src(fetchImpl).search("kw", daysAgo(7), 2);
    expect(outcome.papers).toEqual([]);
    expect(outcome.pageIsFull).toBe(false);
    expect(outcome.unreadable).toBe("2 of 2 works unreadable");
  });

  it("reports dropped works as an incomplete keyword through fetch(), not truncated", async () => {
    const body = {
      results: [
        work({ work_id: "W1", title: "Good Paper", pub_date: TODAY }),
        { id: "https://openalex.org/W2", title: 12345, publication_date: TODAY, authorships: [] },
        { id: "https://openalex.org/W3", title: 12345, publication_date: TODAY, authorships: [] },
      ],
    };
    const fetchImpl = vi.fn().mockResolvedValue(resp(200, body));
    const result = await src(fetchImpl).fetch({
      keywords: ["llm"],
      categories: [],
      sinceDate: daysAgo(7),
      maxResults: 3,
    });
    expect(result.papers.map((p) => p.title)).toEqual(["Good Paper"]);
    expect(result.degradedKeywords).toEqual([["llm", "2 of 3 works unreadable"]]);
    expect(result.truncatedKeywords).toEqual([]);
  });

  it("reports a whole dropped page as a degraded keyword without raising", async () => {
    const body = {
      results: [0, 1, 2].map((i) => ({
        id: `https://openalex.org/W${i}`,
        title: 12345,
        publication_date: TODAY,
        authorships: [],
      })),
    };
    const fetchImpl = vi.fn().mockResolvedValue(resp(200, body));
    const result = await src(fetchImpl).fetch({
      keywords: ["llm"],
      categories: [],
      sinceDate: daysAgo(7),
      maxResults: 3,
    });
    expect(result.papers).toEqual([]);
    expect(result.degradedKeywords).toEqual([["llm", "3 of 3 works unreadable"]]);
    expect(result.truncatedKeywords).toEqual([]);
  });

  it("continues to the next keyword after an unexpected search failure", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (queryParam(url, "search") === "bad") return resp(200, [1, 2, 3]); // malformed body -> throws in search()
      return resp(200, {
        results: [work({ work_id: "W999", title: "Good Paper", pub_date: TODAY })],
      });
    });
    const result = await src(fetchImpl).fetch({
      keywords: ["bad", "good"],
      categories: [],
      sinceDate: daysAgo(7),
      maxResults: 10,
    });
    expect(result.papers).toHaveLength(1);
    expect(result.papers[0]?.title).toBe("Good Paper");
  });
});

describe("OpenAlexSource.fetch — unreadable response bodies (COL-11)", () => {
  it("fails the keyword when the body has no 'results' list", async () => {
    const bodies: unknown[] = [{ meta: { count: 0 } }, { results: null }, "a string", {}];
    for (const body of bodies) {
      const fetchImpl = vi.fn().mockResolvedValue(resp(200, body));
      await expect(
        src(fetchImpl).fetch({ keywords: ["x"], categories: [], sinceDate: TODAY, maxResults: 5 }),
      ).rejects.toThrow(AllKeywordsFailedError);
    }
  });

  it("fails only the unreadable keyword, keeping the other keyword's real works", async () => {
    const good = work({ work_id: "W1", title: "Good Paper", pub_date: TODAY });
    const fetchImpl = vi.fn(async (url: string) => {
      if (queryParam(url, "search") === "bad") return resp(200, { error: "results unavailable" });
      return resp(200, { results: [good] });
    });
    const result = await src(fetchImpl).fetch({
      keywords: ["bad", "good"],
      categories: [],
      sinceDate: daysAgo(7),
      maxResults: 10,
    });
    expect(result.papers.map((p) => p.title)).toEqual(["Good Paper"]);
    expect(result.truncatedKeywords).toEqual([]);
    expect(result.degradedKeywords.map(([kw]) => kw)).toEqual(["bad"]);
    expect(result.degradedKeywords[0]?.[1]).toContain("no 'results' list");
  });
});

describe("OpenAlexSource.fetch — truncated pages (COL-09)", () => {
  it("records a filled page as truncated", async () => {
    const body = {
      results: [0, 1, 2].map((i) =>
        work({ work_id: `W${i}`, title: `Paper ${i}`, pub_date: daysAgo(1) }),
      ),
    };
    const fetchImpl = vi.fn().mockResolvedValue(resp(200, body));
    const result = await src(fetchImpl).fetch({
      keywords: ["llm"],
      categories: [],
      sinceDate: daysAgo(7),
      maxResults: 3,
    });
    expect(result.papers).toHaveLength(3);
    const url = fetchImpl.mock.calls[0]?.[0] as string;
    expect(queryParam(url, "per-page")).toBe("3");
    expect(result.truncatedKeywords).toEqual(["llm"]);
  });

  it("is not truncated when the page had room left", async () => {
    const body = {
      results: [work({ work_id: "W1", pub_date: TODAY }), work({ work_id: "W2", pub_date: TODAY })],
    };
    const fetchImpl = vi.fn().mockResolvedValue(resp(200, body));
    const result = await src(fetchImpl).fetch({
      keywords: ["llm"],
      categories: [],
      sinceDate: daysAgo(7),
      maxResults: 5,
    });
    expect(result.papers).toHaveLength(2);
    expect(result.truncatedKeywords).toEqual([]);
  });
});

describe("OpenAlexSource — D-1 skipped vs. dropped", () => {
  it("does not degrade the keyword for a single blank-title record beside a good one", async () => {
    const good = work({ work_id: "W1", title: "Good Paper", pub_date: TODAY });
    const blank = work({ work_id: "W2", pub_date: TODAY, title: "" });
    (blank as Record<string, unknown>)["display_name"] = "";
    const fetchImpl = vi.fn().mockResolvedValue(resp(200, { results: [good, blank] }));
    const outcome = await src(fetchImpl).search("kw", daysAgo(7), 2);
    expect(outcome.papers.map((p) => p.title)).toEqual(["Good Paper"]);
    expect(outcome.unreadable).toBeNull();
    expect(outcome.pageIsFull).toBe(true);
  });

  it("does not degrade a keyword for a single skipped record end-to-end", async () => {
    const good = work({ work_id: "W1", title: "Good Paper", pub_date: TODAY });
    const unparseable = work({ work_id: "W2", pub_date: undefined });
    delete (unparseable as Record<string, unknown>)["publication_date"];
    (unparseable as Record<string, unknown>)["publication_year"] = null;
    const fetchImpl = vi.fn().mockResolvedValue(resp(200, { results: [good, unparseable] }));
    const result = await src(fetchImpl).fetch({
      keywords: ["llm"],
      categories: [],
      sinceDate: daysAgo(7),
      maxResults: 10,
    });
    expect(result.papers.map((p) => p.title)).toEqual(["Good Paper"]);
    expect(result.degradedKeywords).toEqual([]);
  });

  it("records a fully skipped page as unreadable", async () => {
    const body = {
      results: [0, 1].map((i) => ({
        id: `https://openalex.org/W${i}`,
        title: "",
        display_name: "",
        publication_date: TODAY,
        authorships: [],
      })),
    };
    const fetchImpl = vi.fn().mockResolvedValue(resp(200, body));
    const outcome = await src(fetchImpl).search("kw", daysAgo(7), 2);
    expect(outcome.papers).toEqual([]);
    expect(outcome.unreadable).toBe(
      "2 of 2 works skipped (blank title or unparseable date); no paper survived this page",
    );
    expect(outcome.pageIsFull).toBe(true);
  });

  it("reports a fully skipped page as a degraded keyword through fetch()", async () => {
    const body = {
      results: [
        {
          id: "https://openalex.org/W1",
          title: "",
          display_name: "",
          publication_date: TODAY,
          authorships: [],
        },
      ],
    };
    const fetchImpl = vi.fn().mockResolvedValue(resp(200, body));
    const result = await src(fetchImpl).fetch({
      keywords: ["llm"],
      categories: [],
      sinceDate: daysAgo(7),
      maxResults: 10,
    });
    expect(result.papers).toEqual([]);
    expect(result.degradedKeywords).toEqual([
      [
        "llm",
        "1 of 1 works skipped (blank title or unparseable date); no paper survived this page",
      ],
    ]);
  });

  it("dropped takes priority in the unreadable message when mixed with skipped", async () => {
    const body = {
      results: [
        work({ work_id: "good", title: "Good Paper", pub_date: TODAY }),
        {
          id: "https://openalex.org/W2",
          title: "",
          display_name: "",
          publication_date: TODAY,
          authorships: [],
        },
        { id: "https://openalex.org/W3", title: 12345, publication_date: TODAY, authorships: [] },
      ],
    };
    const fetchImpl = vi.fn().mockResolvedValue(resp(200, body));
    const outcome = await src(fetchImpl).search("kw", daysAgo(7), 3);
    expect(outcome.papers.map((p) => p.title)).toEqual(["Good Paper"]);
    expect(outcome.unreadable).toBe(
      "1 of 3 works unreadable (1 further skipped: blank title/unparseable date)",
    );
    expect(outcome.pageIsFull).toBe(false);
  });

  it("degrades the keyword when a date-filtered item sits beside a skipped item and nothing survives (MEDIUM-1)", async () => {
    const since = daysAgo(7);
    const old = work({ work_id: "old", title: "Old Paper", pub_date: "2000-01-01" });
    const blank = work({ work_id: "blank", pub_date: TODAY, title: "" });
    (blank as Record<string, unknown>)["display_name"] = "";
    const body = { results: [old, blank] };
    const fetchImpl = vi.fn().mockResolvedValue(resp(200, body));
    const outcome = await src(fetchImpl).search("kw", since, 2);
    expect(outcome.papers).toEqual([]);
    expect(outcome.unreadable).toBe(
      "1 of 2 works skipped (blank title or unparseable date); no paper survived this page",
    );

    const fetchImpl2 = vi.fn().mockResolvedValue(resp(200, body));
    const result = await src(fetchImpl2).fetch({
      keywords: ["llm"],
      categories: [],
      sinceDate: since,
      maxResults: 10,
    });
    expect(result.papers).toEqual([]);
    expect(result.degradedKeywords).toEqual([
      [
        "llm",
        "1 of 2 works skipped (blank title or unparseable date); no paper survived this page",
      ],
    ]);
  });

  it("stays clean when every item is a legitimate date-window exclusion", async () => {
    const since = daysAgo(7);
    const old1 = work({ work_id: "old1", title: "Old Paper 1", pub_date: "2000-01-01" });
    const old2 = work({ work_id: "old2", title: "Old Paper 2", pub_date: "1999-01-01" });
    const body = { results: [old1, old2] };
    const fetchImpl = vi.fn().mockResolvedValue(resp(200, body));
    const outcome = await src(fetchImpl).search("kw", since, 2);
    expect(outcome.papers).toEqual([]);
    expect(outcome.unreadable).toBeNull();

    const fetchImpl2 = vi.fn().mockResolvedValue(resp(200, body));
    const result = await src(fetchImpl2).fetch({
      keywords: ["llm"],
      categories: [],
      sinceDate: since,
      maxResults: 10,
    });
    expect(result.papers).toEqual([]);
    expect(result.degradedKeywords).toEqual([]);
  });
});

describe("OpenAlexSource.toPaper — field mapping edge cases", () => {
  it("raises on an empty title", () => {
    const w = work({ title: "", pub_date: TODAY });
    (w as Record<string, unknown>)["display_name"] = "";
    expect(() => src(vi.fn()).toPaper(w, "kw", daysAgo(7))).toThrow(/no title/);
  });

  it("raises when the date is unparseable", () => {
    const w = work({ pub_date: undefined });
    delete (w as Record<string, unknown>)["publication_date"];
    (w as Record<string, unknown>)["publication_year"] = null;
    expect(() => src(vi.fn()).toPaper(w, "kw", daysAgo(7))).toThrow(
      /no parseable publication date/,
    );
  });

  it("normalizes the DOI by stripping the https://doi.org/ prefix", () => {
    const w = work({ pub_date: TODAY, doi: "10.1/abc" });
    const p = src(vi.fn()).toPaper(w, "kw", daysAgo(7));
    expect(p?.doi).toBe("10.1/abc");
  });

  it("prefers primary_location.source over host_venue", () => {
    const w = work({ pub_date: TODAY, venue: "LEGACY_VENUE" });
    (w as Record<string, unknown>)["primary_location"] = { source: { display_name: "Nature" } };
    const p = src(vi.fn()).toPaper(w, "kw", daysAgo(7));
    expect(p?.venue).toBe("Nature");
  });

  it("falls back to host_venue when primary_location is missing", () => {
    const w = work({ pub_date: TODAY, venue: "ICLR" });
    (w as Record<string, unknown>)["primary_location"] = null;
    const p = src(vi.fn()).toPaper(w, "kw", daysAgo(7));
    expect(p?.venue).toBe("ICLR");
  });

  it("flattens and dedups affiliations across authorships", () => {
    const w = work({ pub_date: TODAY, authors: ["Alice", "Bob"] });
    (w as Record<string, unknown>)["authorships"] = [
      {
        author: { display_name: "Alice", id: "A1" },
        institutions: [{ display_name: "Meta AI Research" }, { display_name: "OpenAI" }],
      },
      {
        author: { display_name: "Bob", id: "A2" },
        institutions: [{ display_name: "Meta AI Research" }],
      },
    ];
    const p = src(vi.fn()).toPaper(w, "kw", daysAgo(7));
    expect(p?.affiliations).toEqual(["Meta AI Research", "OpenAI"]);
  });

  it("has empty affiliations when institutions is missing", () => {
    const w = work({ pub_date: TODAY });
    (w as Record<string, unknown>)["authorships"] = [{ author: { display_name: "Alice" } }];
    const p = src(vi.fn()).toPaper(w, "kw", daysAgo(7));
    expect(p?.affiliations).toEqual([]);
  });

  it("venue is null when both primary_location and host_venue are missing", () => {
    const w = work({ pub_date: TODAY, venue: null });
    (w as Record<string, unknown>)["primary_location"] = null;
    const p = src(vi.fn()).toPaper(w, "kw", daysAgo(7));
    expect(p?.venue).toBeNull();
  });
});

describe("OpenAlexSource.parsePubDate", () => {
  it("falls back to publication_year", () => {
    expect(OpenAlexSource.parsePubDate({ publication_date: null, publication_year: 2024 })).toBe(
      "2024-01-01",
    );
  });
  it("returns null when invalid", () => {
    expect(OpenAlexSource.parsePubDate({})).toBeNull();
    expect(OpenAlexSource.parsePubDate({ publication_date: "garbage" })).toBeNull();
  });
});

describe("OpenAlexSource — R2-19 API key and daily-budget gate", () => {
  it("sends the key as a bearer header, stops after a budget 429, logs one summary line", async () => {
    const inits: FetchInit[] = [];
    const urls: string[] = [];
    const warnings: string[] = [];
    const fetchImpl = async (url: string, init: FetchInit): Promise<HttpResponseLike> => {
      urls.push(url);
      inits.push(init);
      if (urls.length === 1) {
        return {
          status: 200,
          headers: { get: (n: string) => (n === "x-ratelimit-remaining" ? "15" : null) },
          json: async () => ({ results: [work()] }),
        };
      }
      return {
        status: 429,
        headers: { get: (n: string) => (n === "x-ratelimit-remaining" ? "5" : null) },
        json: async () => ({ message: "daily budget exceeded" }),
      };
    };
    const src = new OpenAlexSource(
      { delaySeconds: 0 },
      {
        fetchImpl,
        budgetGate: new OpenAlexGate({ apiKey: "secret-key" }),
        sleep: async () => {},
        logger: { warn: (m) => warnings.push(m) },
      },
    );
    const result = await src.fetch({
      keywords: ["a", "b", "c"],
      categories: [],
      sinceDate: daysAgo(120),
      maxResults: 10,
    });
    expect(result.papers).toHaveLength(1);
    // keyword "b" spent the last search budget (429); "c" never left.
    expect(urls).toHaveLength(2);
    expect(inits[0]?.headers?.Authorization).toBe("Bearer secret-key");
    expect(urls.join(" ")).not.toContain("secret-key");
    const summary = warnings.filter((w) => w.startsWith("openalex budget: remaining="));
    expect(summary).toHaveLength(1);
    expect(summary[0]).toContain("searches=2");
    expect(summary[0]).toContain("429=1");
    expect(summary[0]).toContain("blocked=1");
    expect(summary[0]).toContain("key=yes");
    expect(warnings.join("\n")).not.toContain("secret-key");
  });
});
