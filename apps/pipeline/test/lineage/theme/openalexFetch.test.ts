/**
 * Vitest port of the OpenAlex-fetch tests in
 * `paperpilot/tests/test_build_theme_lineage.py` (`discover_seeds_via_openalex`,
 * `fetch_related_via_openalex`, `_fetch_openalex_works_by_ids`) — safety
 * contract LIN-20 (a transient OpenAlex failure must never collapse into
 * a cacheable empty answer).
 */
import { describe, expect, it, vi } from "vitest";
import type { FetchInit, HttpResponseLike } from "../../../src/collect/http/requestWithRetry.js";
import type { OpenAlexDeps } from "../../../src/lineage/theme/openalexFetch.js";
import {
  discoverSeedsViaOpenalex,
  fetchOpenAlexWorksByIds,
  fetchRelatedViaOpenalex,
  OpenAlexTransientError,
} from "../../../src/lineage/theme/openalexFetch.js";

function jsonResp(status: number, body: unknown): HttpResponseLike {
  return { status, json: async () => body };
}

function depsFor(
  fetchImpl: (url: string, init: FetchInit) => Promise<HttpResponseLike>,
): OpenAlexDeps {
  return { fetchImpl, sleep: async () => {}, logger: { warn: () => {} } };
}

function mkOaWork(
  shortId: string,
  opts: { title?: string; year?: number; citedByCount?: number } = {},
) {
  return {
    id: `https://openalex.org/${shortId}`,
    title: opts.title ?? "Sample paper",
    display_name: opts.title ?? "Sample paper",
    publication_year: opts.year ?? 2022,
    cited_by_count: opts.citedByCount ?? 100,
    authorships: [],
  };
}

describe("discoverSeedsViaOpenalex", () => {
  it("does not override sort (default relevance), and sends search/mailto/filter", async () => {
    const captured: Array<Record<string, unknown>> = [];
    const deps = depsFor(async (url) => {
      captured.push(Object.fromEntries(new URL(url).searchParams.entries()));
      return jsonResp(200, { results: [] });
    });
    await discoverSeedsViaOpenalex({ query: "Chain of Thought", topN: 5, sinceYear: 2018 }, deps);
    expect(captured).toHaveLength(1);
    const params = captured[0] as Record<string, string>;
    expect(params.sort).toBeUndefined();
    expect(params.search).toBe("Chain of Thought");
    expect(params.filter).toContain("primary_topic.field.id:fields/17");
  });

  it("rejects a result with no usable OpenAlex id", async () => {
    const deps = depsFor(async () => jsonResp(200, { results: [{ title: "No id" }] }));
    expect(await discoverSeedsViaOpenalex({ query: "x", topN: 5, sinceYear: null }, deps)).toEqual(
      [],
    );
  });

  it("accepts works that carry a usable id even without other fields", async () => {
    const deps = depsFor(async () => jsonResp(200, { results: [mkOaWork("W1")] }));
    const results = await discoverSeedsViaOpenalex({ query: "x", topN: 5, sinceYear: null }, deps);
    expect(results).toHaveLength(1);
  });

  it("records a subject failure on a non-200 response", async () => {
    const deps = depsFor(async () => jsonResp(500, {}));
    const failures: string[] = [];
    const completeness = { subjectFailed: (r: string) => failures.push(r) };
    await discoverSeedsViaOpenalex({ query: "x", topN: 5, sinceYear: null, completeness }, deps);
    expect(failures).toHaveLength(1);
  });
});

describe("fetchRelatedViaOpenalex", () => {
  it("references: GET /works/{id} -> referenced_works -> batch fetch", async () => {
    const parentShort = "W999";
    const deps = depsFor(async (url) => {
      if (url.includes("/works/W123")) {
        return jsonResp(200, {
          id: "https://openalex.org/W123",
          referenced_works: [`https://openalex.org/${parentShort}`],
        });
      }
      if (url.includes("filter=openalex")) {
        return jsonResp(200, {
          results: [
            mkOaWork(parentShort, {
              title: "Earlier foundational work",
              year: 2015,
              citedByCount: 20000,
            }),
          ],
        });
      }
      throw new Error(`unexpected url ${url}`);
    });
    const parents = await fetchRelatedViaOpenalex("W123", "references", 10, deps);
    expect(parents).toHaveLength(1);
    expect(parents[0]?.paperId).toBe(`openalex:${parentShort}`);
    expect(parents[0]?._intents).toBeNull();
    expect(parents[0]?._contexts).toEqual([]);
  });

  it("citations: GET /works?filter=cites:W{id}&sort=cited_by_count:desc", async () => {
    const childShort = "W777";
    const deps = depsFor(async (url) => {
      const params = new URL(url).searchParams;
      if (params.get("filter") === "cites:W123") {
        return jsonResp(200, {
          results: [mkOaWork(childShort, { title: "Later citing paper", year: 2024 })],
        });
      }
      throw new Error("unexpected call");
    });
    const children = await fetchRelatedViaOpenalex("W123", "citations", 10, deps);
    expect(children).toHaveLength(1);
    expect(children[0]?.paperId).toBe(`openalex:${childShort}`);
    expect(children[0]?._intents).toBeNull();
  });

  it("returns [] for a non-W-prefixed id without calling the network", async () => {
    const fetchImpl = vi.fn();
    const result = await fetchRelatedViaOpenalex(
      "not-an-openalex-id",
      "references",
      10,
      depsFor(fetchImpl),
    );
    expect(result).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns [] for an unknown kind", async () => {
    const result = await fetchRelatedViaOpenalex("W123", "bogus-kind", 10, depsFor(vi.fn()));
    expect(result).toEqual([]);
  });

  it("raises on a work-fetch network failure (never collapses to empty)", async () => {
    const deps = depsFor(async () => {
      throw new Error("network down");
    });
    await expect(fetchRelatedViaOpenalex("W123", "references", 10, deps)).rejects.toBeInstanceOf(
      OpenAlexTransientError,
    );
  });

  it("raises on a malformed (unparseable) work body", async () => {
    const deps = depsFor(async () => ({
      status: 200,
      json: async () => {
        throw new Error("not json");
      },
    }));
    await expect(fetchRelatedViaOpenalex("W123", "references", 10, deps)).rejects.toBeInstanceOf(
      OpenAlexTransientError,
    );
  });

  it("raises on a cites-query failure (503 exhausted)", async () => {
    const deps = depsFor(async () => jsonResp(503, {}));
    await expect(fetchRelatedViaOpenalex("W123", "citations", 10, deps)).rejects.toBeInstanceOf(
      OpenAlexTransientError,
    );
  });

  it("treats 410 as a real, cacheable empty for both directions", async () => {
    const deps = depsFor(async () => jsonResp(410, {}));
    expect(await fetchRelatedViaOpenalex("W410", "references", 5, deps)).toEqual([]);
    expect(await fetchRelatedViaOpenalex("W410", "citations", 5, deps)).toEqual([]);
  });

  it("does not freeze a 404 as empty (raises instead)", async () => {
    const deps = depsFor(async () => jsonResp(404, {}));
    await expect(fetchRelatedViaOpenalex("W404", "references", 5, deps)).rejects.toBeInstanceOf(
      OpenAlexTransientError,
    );
  });

  it("raises on an exhausted 429", async () => {
    const deps = depsFor(async () => jsonResp(429, {}));
    await expect(fetchRelatedViaOpenalex("W123", "references", 5, deps)).rejects.toBeInstanceOf(
      OpenAlexTransientError,
    );
  });

  it("raises on a non-object body (bare list)", async () => {
    const deps = depsFor(async () => jsonResp(200, ["not", "an", "object"]));
    await expect(fetchRelatedViaOpenalex("W123", "references", 5, deps)).rejects.toBeInstanceOf(
      OpenAlexTransientError,
    );
  });

  it("raises on a malformed referenced_works (wrong type)", async () => {
    const deps = depsFor(async () => jsonResp(200, { referenced_works: "W1,W2" }));
    await expect(fetchRelatedViaOpenalex("W123", "references", 5, deps)).rejects.toBeInstanceOf(
      OpenAlexTransientError,
    );
  });

  it("allows a genuinely empty reference list", async () => {
    const deps = depsFor(async () => jsonResp(200, { referenced_works: [] }));
    expect(await fetchRelatedViaOpenalex("W123", "references", 5, deps)).toEqual([]);
  });

  it("treats a null referenced_works as empty (not malformed)", async () => {
    const deps = depsFor(async () => jsonResp(200, { referenced_works: null }));
    expect(await fetchRelatedViaOpenalex("W123", "references", 5, deps)).toEqual([]);
  });
});

describe("fetchOpenAlexWorksByIds", () => {
  it("raises when every chunk fails (never returns [] silently)", async () => {
    const deps = depsFor(async () => {
      throw new Error("down");
    });
    await expect(fetchOpenAlexWorksByIds(["W1", "W2"], deps)).rejects.toBeInstanceOf(
      OpenAlexTransientError,
    );
  });

  it("reports a partial chunk failure via .partial, not as a complete answer", async () => {
    const ids = Array.from({ length: 79 }, (_, i) => `W${i + 1}`); // 2 chunks at chunkSize=50
    let calls = 0;
    const deps = depsFor(async () => {
      calls += 1;
      if (calls === 1) throw new Error("first chunk down");
      return jsonResp(200, {
        results: [mkOaWork("W9", { title: "Survivor", year: 2020, citedByCount: 1 })],
      });
    });
    try {
      await fetchOpenAlexWorksByIds(ids, deps);
      expect.fail("expected OpenAlexTransientError");
    } catch (exc) {
      expect(exc).toBeInstanceOf(OpenAlexTransientError);
      expect((exc as OpenAlexTransientError).partial).toHaveLength(1);
    }
  });

  it("does not raise when every chunk is a real absence (410)", async () => {
    const deps = depsFor(async () => jsonResp(410, {}));
    expect(await fetchOpenAlexWorksByIds(["W1", "W2"], deps)).toEqual([]);
  });

  it("counts a malformed work in the page as a lost chunk", async () => {
    const deps = depsFor(async () => jsonResp(200, { results: [{ bogus: true }] }));
    await expect(fetchOpenAlexWorksByIds(["W1"], deps)).rejects.toBeInstanceOf(
      OpenAlexTransientError,
    );
  });

  it("accepts a genuinely empty page", async () => {
    const deps = depsFor(async () => jsonResp(200, { results: [] }));
    expect(await fetchOpenAlexWorksByIds(["W1"], deps)).toEqual([]);
  });

  it("normalizes the ids it sends (strips a URL form down to the short id)", async () => {
    const captured: string[] = [];
    const deps = depsFor(async (url) => {
      captured.push(new URL(url).searchParams.get("filter") ?? "");
      return jsonResp(200, { results: [] });
    });
    await fetchOpenAlexWorksByIds(["https://openalex.org/W5", " W6 "], deps);
    expect(captured[0]).toBe("openalex:W5|W6");
  });
});
