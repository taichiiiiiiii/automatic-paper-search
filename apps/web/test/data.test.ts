import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ConferenceSummary,
  fetchConferencePapers,
  fetchConferences,
  fetchSearchIndex,
} from "../lib/data";

function mockFetchOnce(body: unknown, init?: { ok?: boolean; status?: number }): void {
  const ok = init?.ok ?? true;
  const status = init?.status ?? (ok ? 200 : 500);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok,
      status,
      json: async () => body,
    })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const validConference: ConferenceSummary = {
  name: "cvpr-2026",
  papers: 2,
  types: { Oral: 1, Poster: 1 },
  top_tags: [["LLM", 2]],
  generated: "2026-06-28",
};

describe("fetchConferences", () => {
  it("returns ok with parsed data for a well-formed conferences.json", async () => {
    mockFetchOnce([validConference]);
    const result = await fetchConferences();
    expect(result).toEqual({ status: "ok", data: [validConference] });
  });

  it("fetches /conferences.json", async () => {
    mockFetchOnce([validConference]);
    await fetchConferences();
    expect(fetch).toHaveBeenCalledWith("/conferences.json", { cache: "no-cache" });
  });

  it("returns an error state (not empty data) on HTTP failure", async () => {
    mockFetchOnce(null, { ok: false, status: 404 });
    const result = await fetchConferences();
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toContain("404");
    }
  });

  it("drops a malformed row instead of rejecting the whole response (SCR-09 extended to the full row shape)", async () => {
    mockFetchOnce([validConference, { name: "cvpr-2026" /* missing required fields */ }]);
    const result = await fetchConferences();
    expect(result).toEqual({ status: "ok", data: [validConference] });
  });

  it("returns ok with no rows (not an error) when every row is malformed", async () => {
    mockFetchOnce([{ name: "cvpr-2026" /* missing required fields */ }]);
    const result = await fetchConferences();
    expect(result).toEqual({ status: "ok", data: [] });
  });

  it("returns an error state when the top-level response is not an array", async () => {
    mockFetchOnce({ not: "an array" });
    const result = await fetchConferences();
    expect(result.status).toBe("error");
  });

  it("returns an error state when fetch itself rejects (network failure)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network error");
      }),
    );
    const result = await fetchConferences();
    expect(result).toEqual({ status: "error", error: "network error" });
  });
});

describe("fetchConferencePapers", () => {
  const validPaper = {
    title: "Example Paper",
    type: "Oral",
    tags: ["LLM"],
    venue: "CVPR",
    authors: ["A. Author"],
    abstract: "An abstract.",
    arxiv_id: "",
    citation_count: 0,
    venue_tier: 2,
  };

  it("fetches /<slug>/papers.json", async () => {
    mockFetchOnce([validPaper]);
    const result = await fetchConferencePapers("cvpr-2026");
    expect(fetch).toHaveBeenCalledWith("/cvpr-2026/papers.json", { cache: "no-cache" });
    expect(result).toEqual({ status: "ok", data: [validPaper] });
  });

  it("rejects a slug that cannot be a safe path segment, without fetching", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await fetchConferencePapers("../../etc/passwd");
    expect(result.status).toBe("error");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("accepts a null citation_count/venue_tier (build_pages.py's _maybe_int() can return None)", async () => {
    const paper = { ...validPaper, citation_count: null, venue_tier: null };
    mockFetchOnce([paper]);
    const result = await fetchConferencePapers("cvpr-2026");
    expect(result).toEqual({ status: "ok", data: [paper] });
  });
});

describe("fetchSearchIndex", () => {
  it("parses a well-formed 7-tuple entry", async () => {
    const entry = ["Some Title", "aaai-2026", 0, ["Author"], ["LLM"], 2026, "Oral"];
    mockFetchOnce([entry]);
    const result = await fetchSearchIndex();
    expect(result).toEqual({ status: "ok", data: [entry] });
  });

  it("rejects an entry whose type is not Oral/Poster", async () => {
    const entry = ["Some Title", "aaai-2026", 0, ["Author"], ["LLM"], 2026, "Workshop"];
    mockFetchOnce([entry]);
    const result = await fetchSearchIndex();
    expect(result.status).toBe("error");
  });

  it("accepts a null year", async () => {
    const entry = ["Some Title", "aaai-2026", 0, ["Author"], ["LLM"], null, "Poster"];
    mockFetchOnce([entry]);
    const result = await fetchSearchIndex();
    expect(result.status).toBe("ok");
  });
});

describe("fetchConferences — null generated", () => {
  it("keeps a row whose generated date is null (build_pages._generated_date may return None)", async () => {
    const row = {
      name: "cvpr-2026",
      papers: 10,
      types: { Oral: 1, Poster: 9 },
      top_tags: [["LLM", 3]],
      generated: null,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify([row]), { status: 200 })),
    );
    const result = await fetchConferences();
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.data.map((r) => r.name)).toContain("cvpr-2026");
    vi.unstubAllGlobals();
  });
});
