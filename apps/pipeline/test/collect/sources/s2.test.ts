/**
 * Port of `paperpilot/tests/test_s2_source.py`.
 */
import { describe, expect, it, vi } from "vitest";
import type { HttpResponseLike } from "../../../src/collect/http/requestWithRetry.js";
import { S2Source } from "../../../src/collect/sources/s2.js";
import { AllKeywordsFailedError } from "../../../src/collect/sources/source.js";

function resp(status: number, body: unknown = {}): HttpResponseLike {
  return { status, json: async () => body };
}

/** `requestWithRetry`'s `fetchImpl` receives the fully-built URL, not a separate params object. */
function queryParam(url: string, key: string): string | null {
  return new URL(url).searchParams.get(key);
}

const TODAY = "2026-06-15";
function daysAgo(n: number): string {
  const d = new Date(`${TODAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function item(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    paperId: "pid1",
    title: "RAG Paper",
    abstract: "Retrieval-Augmented Generation abstract",
    authors: [{ name: "Alice", authorId: "AID" }],
    year: 2026,
    publicationDate: daysAgo(3),
    externalIds: { ArXiv: "2604.01234", DOI: "10.1/abc" },
    openAccessPdf: { url: "http://pdf" },
    venue: "ICLR",
    url: "http://s2/pid1",
    ...overrides,
  };
}

function src(fetchImpl: ReturnType<typeof vi.fn>, apiKey: string | null = null): S2Source {
  return new S2Source({ delaySeconds: 0 }, { fetchImpl, apiKey, sleep: async () => {} });
}

describe("S2Source.fetch — happy path & field mapping", () => {
  it("returns papers within the window and maps fields", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(resp(200, { data: [item()] }));
    const result = await src(fetchImpl).fetch({
      keywords: ["rag"],
      categories: [],
      sinceDate: daysAgo(7),
      maxResults: 10,
    });
    expect(result.papers).toHaveLength(1);
    const p = result.papers[0];
    expect(p?.title).toBe("RAG Paper");
    expect(p?.arxivId).toBe("2604.01234");
    expect(p?.doi).toBe("10.1/abc");
    expect(p?.pdfUrl).toBe("http://pdf");
    expect(p?.venue).toBe("ICLR");
    expect(p?.source).toBe("s2");
    expect(p?.matchedKeywords).toEqual(["rag"]);
    expect(p?.authors).toEqual(["Alice"]);
    expect(p?.firstAuthorId).toBe("AID");
  });

  it("first_author_id stays null when no author has an authorId (regression, closes #393)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(resp(200, { data: [item({ authors: [{ name: "Bob" }] })] }));
    const result = await src(fetchImpl).fetch({
      keywords: ["rag"],
      categories: [],
      sinceDate: daysAgo(7),
      maxResults: 10,
    });
    expect(result.papers[0]?.firstAuthorId).toBeNull();
  });

  it("first_author_id reflects authors[0] specifically, not any author with an id", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      resp(200, {
        data: [item({ authors: [{ name: "Bob" }, { name: "Alice", authorId: "AID" }] })],
      }),
    );
    const result = await src(fetchImpl).fetch({
      keywords: ["rag"],
      categories: [],
      sinceDate: daysAgo(7),
      maxResults: 10,
    });
    expect(result.papers[0]?.firstAuthorId).toBeNull();
  });

  it("drops items older than since_date", async () => {
    const body = {
      data: [
        item({ paperId: "old", url: "http://s2/old", publicationDate: daysAgo(30) }),
        item({ paperId: "new", url: "http://s2/new", publicationDate: daysAgo(1) }),
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
    expect(result.papers[0]?.url).toBe("http://s2/new");
  });

  it("falls back to a semanticscholar.org URL when the item has none", async () => {
    const raw = item({ publicationDate: TODAY });
    delete raw["url"];
    const fetchImpl = vi.fn().mockResolvedValue(resp(200, { data: [raw] }));
    const result = await src(fetchImpl).fetch({
      keywords: ["x"],
      categories: [],
      sinceDate: daysAgo(7),
      maxResults: 10,
    });
    expect(result.papers[0]?.url).toContain("semanticscholar.org");
  });
});

describe("S2Source.fetch — server-side window bound & truncation", () => {
  it("bounds the window server-side via publicationDateOrYear and reports a full page as truncated", async () => {
    const since = daysAgo(7);
    const body = {
      data: Array.from({ length: 10 }, (_, i) =>
        item({ paperId: `p${i}`, publicationDate: daysAgo(1) }),
      ),
    };
    const fetchImpl = vi.fn().mockResolvedValue(resp(200, body));
    const result = await src(fetchImpl).fetch({
      keywords: ["rag"],
      categories: [],
      sinceDate: since,
      maxResults: 10,
    });
    const calledUrl = fetchImpl.mock.calls[0]?.[0] as string;
    expect(queryParam(calledUrl, "publicationDateOrYear")).toBe(`${since}:`);
    expect(queryParam(calledUrl, "limit")).toBe("10");
    expect(result.papers).toHaveLength(10);
    expect(result.truncatedKeywords).toEqual(["rag"]);
  });

  it("is not truncated when the page has room left", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(resp(200, { data: [item({ paperId: "p0", publicationDate: TODAY })] }));
    const result = await src(fetchImpl).fetch({
      keywords: ["rag"],
      categories: [],
      sinceDate: daysAgo(7),
      maxResults: 10,
    });
    expect(result.papers).toHaveLength(1);
    expect(result.truncatedKeywords).toEqual([]);
  });

  it("tracks the window bound to since_date per run", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(resp(200, { data: [] }));
    await src(fetchImpl).fetch({
      keywords: ["rag"],
      categories: [],
      sinceDate: "2026-01-05",
      maxResults: 10,
    });
    const calledUrl = fetchImpl.mock.calls[0]?.[0] as string;
    expect(queryParam(calledUrl, "publicationDateOrYear")).toBe("2026-01-05:");
  });
});

describe("S2Source.fetch — HTTP failure contracts (COL-07/10)", () => {
  it("raises when every keyword's request fails with a non-200 (regression, closes #387)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(resp(429));
    await expect(
      src(fetchImpl).fetch({ keywords: ["x"], categories: [], sinceDate: TODAY, maxResults: 10 }),
    ).rejects.toThrow(AllKeywordsFailedError);
  });

  it("raises when request_with_retry returns null (e.g. connection error)", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(
      src(fetchImpl).fetch({ keywords: ["x"], categories: [], sinceDate: TODAY, maxResults: 10 }),
    ).rejects.toThrow(AllKeywordsFailedError);
  });

  it("keeps partial results when only some keywords fail", async () => {
    const goodBody = {
      data: [item({ paperId: "P1", title: "Good Paper", publicationDate: TODAY })],
    };
    const fetchImpl = vi.fn(async (url: string) => {
      if (queryParam(url, "query") === "bad") return resp(429);
      return resp(200, goodBody);
    });
    const result = await src(fetchImpl).fetch({
      keywords: ["bad", "good"],
      categories: [],
      sinceDate: daysAgo(7),
      maxResults: 10,
    });
    expect(result.papers.map((p) => p.title)).toEqual(["Good Paper"]);
    expect(result.degradedKeywords).toEqual([
      ["bad", "RuntimeError: s2 search failed for 'bad' (status=429)"],
    ]);
  });
});

describe("S2Source.fetch — unreadable response bodies (COL-11)", () => {
  it("fails the keyword when the body has no 'data' list", async () => {
    const bodies: unknown[] = [{ total: 0, token: "x" }, [1, 2, 3], "an error string", {}];
    for (const body of bodies) {
      const fetchImpl = vi.fn().mockResolvedValue(resp(200, body));
      await expect(
        src(fetchImpl).fetch({ keywords: ["x"], categories: [], sinceDate: TODAY, maxResults: 10 }),
      ).rejects.toThrow(AllKeywordsFailedError);
    }
  });

  it("fails only the unreadable keyword, keeping the other keyword's real papers", async () => {
    const goodBody = {
      data: [item({ paperId: "P1", title: "Good Paper", publicationDate: TODAY })],
    };
    const fetchImpl = vi.fn(async (url: string) => {
      if (queryParam(url, "query") === "bad")
        return resp(200, { code: "unavailable", message: "try later" });
      return resp(200, goodBody);
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
    expect(result.degradedKeywords[0]?.[1]).toContain("no 'data' list");
  });
});

describe("S2Source.search — dropped vs. skipped items (D-1, H-2)", () => {
  it("skips a malformed item and keeps valid siblings", async () => {
    const good = item({ paperId: "P1", title: "Good Paper", publicationDate: TODAY });
    const malformed = { paperId: "P2", title: 12345, publicationDate: TODAY, authors: [] };
    const fetchImpl = vi.fn().mockResolvedValue(resp(200, { data: [malformed, good] }));
    const outcome = await src(fetchImpl).search("kw", daysAgo(7), 2);
    expect(outcome.papers.map((p) => p.title)).toEqual(["Good Paper"]);
    expect(outcome.unreadable).toBe("1 of 2 papers unreadable");
    expect(outcome.pageIsFull).toBe(false);
  });

  it("records a fully dropped page as unreadable, not truncated", async () => {
    const body = {
      data: [0, 1].map((i) => ({
        paperId: `P${i}`,
        title: 12345,
        publicationDate: TODAY,
        authors: [],
      })),
    };
    const fetchImpl = vi.fn().mockResolvedValue(resp(200, body));
    const outcome = await src(fetchImpl).search("kw", daysAgo(7), 2);
    expect(outcome.papers).toEqual([]);
    expect(outcome.pageIsFull).toBe(false);
    expect(outcome.unreadable).toBe("2 of 2 papers unreadable");
  });

  it("reports dropped items as an incomplete keyword through fetch()", async () => {
    const body = {
      data: [
        item({ paperId: "P1", title: "Good Paper", publicationDate: TODAY }),
        { paperId: "P2", title: 12345, publicationDate: TODAY, authors: [] },
      ],
    };
    const fetchImpl = vi.fn().mockResolvedValue(resp(200, body));
    const result = await src(fetchImpl).fetch({
      keywords: ["kw"],
      categories: [],
      sinceDate: daysAgo(7),
      maxResults: 10,
    });
    expect(result.papers.map((p) => p.title)).toEqual(["Good Paper"]);
    expect(result.truncatedKeywords).toEqual([]);
    expect(result.degradedKeywords).toEqual([["kw", "1 of 2 papers unreadable"]]);
  });

  it("does not degrade the keyword for a single skipped (blank-title) record beside a good one", async () => {
    const good = item({ paperId: "P1", title: "Good Paper", publicationDate: TODAY });
    const blank = item({ paperId: "P2", title: "", publicationDate: TODAY });
    const fetchImpl = vi.fn().mockResolvedValue(resp(200, { data: [good, blank] }));
    const outcome = await src(fetchImpl).search("kw", daysAgo(7), 2);
    expect(outcome.papers.map((p) => p.title)).toEqual(["Good Paper"]);
    expect(outcome.unreadable).toBeNull();
    expect(outcome.pageIsFull).toBe(true);
  });

  it("does not degrade a keyword for a single skipped record end-to-end", async () => {
    const good = item({ paperId: "P1", title: "Good Paper", publicationDate: TODAY });
    const unparseable = item({ paperId: "P2", publicationDate: undefined, year: undefined });
    delete (unparseable as Record<string, unknown>)["publicationDate"];
    delete (unparseable as Record<string, unknown>)["year"];
    const fetchImpl = vi.fn().mockResolvedValue(resp(200, { data: [good, unparseable] }));
    const result = await src(fetchImpl).fetch({
      keywords: ["rag"],
      categories: [],
      sinceDate: daysAgo(7),
      maxResults: 10,
    });
    expect(result.papers.map((p) => p.title)).toEqual(["Good Paper"]);
    expect(result.degradedKeywords).toEqual([]);
  });

  it("records a fully skipped page as unreadable (not degraded via dropped)", async () => {
    const body = {
      data: [0, 1].map((i) => ({
        paperId: `P${i}`,
        title: "",
        publicationDate: TODAY,
        authors: [],
      })),
    };
    const fetchImpl = vi.fn().mockResolvedValue(resp(200, body));
    const outcome = await src(fetchImpl).search("kw", daysAgo(7), 2);
    expect(outcome.papers).toEqual([]);
    expect(outcome.unreadable).toBe(
      "2 of 2 papers skipped (blank title or unparseable date); no paper survived this page",
    );
    expect(outcome.pageIsFull).toBe(true);
  });

  it("reports a fully skipped page as a degraded keyword through fetch()", async () => {
    const body = { data: [{ paperId: "P1", title: "", publicationDate: TODAY, authors: [] }] };
    const fetchImpl = vi.fn().mockResolvedValue(resp(200, body));
    const result = await src(fetchImpl).fetch({
      keywords: ["rag"],
      categories: [],
      sinceDate: daysAgo(7),
      maxResults: 10,
    });
    expect(result.papers).toEqual([]);
    expect(result.degradedKeywords).toEqual([
      [
        "rag",
        "1 of 1 papers skipped (blank title or unparseable date); no paper survived this page",
      ],
    ]);
  });

  it("dropped takes priority in the unreadable message when mixed with skipped", async () => {
    const body = {
      data: [
        item({ paperId: "good", title: "Good Paper", publicationDate: TODAY }),
        { paperId: "P2", title: "", publicationDate: TODAY, authors: [] },
        { paperId: "P3", title: 12345, publicationDate: TODAY, authors: [] },
      ],
    };
    const fetchImpl = vi.fn().mockResolvedValue(resp(200, body));
    const outcome = await src(fetchImpl).search("kw", daysAgo(7), 3);
    expect(outcome.papers.map((p) => p.title)).toEqual(["Good Paper"]);
    expect(outcome.unreadable).toBe(
      "1 of 3 papers unreadable (1 further skipped: blank title/unparseable date)",
    );
    expect(outcome.pageIsFull).toBe(false);
  });

  it("degrades the keyword when a date-filtered item sits beside a skipped item and nothing survives (MEDIUM-1)", async () => {
    const since = daysAgo(7);
    const old = item({
      paperId: "old",
      title: "Old Paper",
      publicationDate: undefined,
      year: 2000,
    });
    delete (old as Record<string, unknown>)["publicationDate"];
    const blank = item({ paperId: "blank", title: "  ", publicationDate: TODAY });
    const body = { data: [old, blank] };
    const fetchImpl = vi.fn().mockResolvedValue(resp(200, body));
    const outcome = await src(fetchImpl).search("kw", since, 2);
    expect(outcome.papers).toEqual([]);
    expect(outcome.unreadable).toBe(
      "1 of 2 papers skipped (blank title or unparseable date); no paper survived this page",
    );

    const fetchImpl2 = vi.fn().mockResolvedValue(resp(200, body));
    const result = await src(fetchImpl2).fetch({
      keywords: ["rag"],
      categories: [],
      sinceDate: since,
      maxResults: 10,
    });
    expect(result.papers).toEqual([]);
    expect(result.degradedKeywords).toEqual([
      [
        "rag",
        "1 of 2 papers skipped (blank title or unparseable date); no paper survived this page",
      ],
    ]);
  });

  it("stays clean when every item is a legitimate date-window exclusion", async () => {
    const since = daysAgo(7);
    const old1 = item({
      paperId: "old1",
      title: "Old Paper 1",
      publicationDate: undefined,
      year: 2000,
    });
    delete (old1 as Record<string, unknown>)["publicationDate"];
    const old2 = item({
      paperId: "old2",
      title: "Old Paper 2",
      publicationDate: undefined,
      year: 1999,
    });
    delete (old2 as Record<string, unknown>)["publicationDate"];
    const body = { data: [old1, old2] };
    const fetchImpl = vi.fn().mockResolvedValue(resp(200, body));
    const outcome = await src(fetchImpl).search("kw", since, 2);
    expect(outcome.papers).toEqual([]);
    expect(outcome.unreadable).toBeNull();

    const fetchImpl2 = vi.fn().mockResolvedValue(resp(200, body));
    const result = await src(fetchImpl2).fetch({
      keywords: ["rag"],
      categories: [],
      sinceDate: since,
      maxResults: 10,
    });
    expect(result.papers).toEqual([]);
    expect(result.degradedKeywords).toEqual([]);
  });
});

describe("S2Source.toPaper / parsePubDate", () => {
  it("raises on an empty title", () => {
    const i = item({ title: "", publicationDate: TODAY });
    expect(() => src(vi.fn()).toPaper(i, "kw", daysAgo(30))).toThrow(/no title/);
  });

  it("raises when the date is unparseable", () => {
    const i = item({ publicationDate: undefined, year: undefined });
    delete (i as Record<string, unknown>)["publicationDate"];
    delete (i as Record<string, unknown>)["year"];
    expect(() => src(vi.fn()).toPaper(i, "kw", daysAgo(30))).toThrow(
      /no parseable publication date/,
    );
  });

  it("returns null when published before since_date", () => {
    const i = item({ publicationDate: daysAgo(30) });
    expect(src(vi.fn()).toPaper(i, "kw", daysAgo(7))).toBeNull();
  });

  it("prefers publicationDate over year", () => {
    expect(S2Source.parsePubDate(item({ publicationDate: "2026-03-15", year: 2020 }))).toBe(
      "2026-03-15",
    );
  });
  it("falls back to year", () => {
    expect(S2Source.parsePubDate({ year: 2025 })).toBe("2025-01-01");
  });
  it("returns null when neither parses", () => {
    expect(S2Source.parsePubDate({})).toBeNull();
    expect(S2Source.parsePubDate({ year: "bogus" })).toBeNull();
    expect(S2Source.parsePubDate({ publicationDate: "not-a-date" })).toBeNull();
  });
});

describe("S2Source — auth headers", () => {
  it("sends the API key header when configured", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(resp(200, { data: [] }));
    await src(fetchImpl, "my_key").fetch({
      keywords: ["x"],
      categories: [],
      sinceDate: TODAY,
      maxResults: 5,
    });
    const init = fetchImpl.mock.calls[0]?.[1] as { headers?: Record<string, string> } | undefined;
    expect(init?.headers?.["x-api-key"]).toBe("my_key");
  });

  it("omits the header when no key is configured", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(resp(200, { data: [] }));
    await src(fetchImpl, null).fetch({
      keywords: ["x"],
      categories: [],
      sinceDate: TODAY,
      maxResults: 5,
    });
    const init = fetchImpl.mock.calls[0]?.[1] as { headers?: Record<string, string> } | undefined;
    expect(init?.headers?.["x-api-key"]).toBeUndefined();
  });
});
