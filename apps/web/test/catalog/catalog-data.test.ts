/**
 * Ported from paperpilot/tests/viewer/test_catalog_viewer_medium.mjs §3/4
 * (a failed or empty catalog load is a distinct error state, never
 * rendered as "0 papers") and
 * test_catalog_full_abstract_app.mjs (abort propagates, a resolved
 * fetch after abort is not surfaced as data).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchCatalogPapers, fetchFullAbstract } from "../../lib/catalog-data";

function mockFetchOnce(body: unknown, init?: { ok?: boolean; status?: number }): void {
  const ok = init?.ok ?? true;
  const status = init?.status ?? (ok ? 200 : 500);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok, status, json: async () => body })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const validPaper = {
  title: "A paper",
  type: "Poster",
  tags: ["LLM"],
  venue: "CVPR",
  authors: ["Ada Lovelace"],
  abstract: "preview",
  arxiv_id: "2506.00001",
  citation_count: 0,
  venue_tier: 2,
  paper_id: "a".repeat(40),
};

describe("fetchCatalogPapers", () => {
  it("returns ok with the validated catalog for a well-formed papers.json", async () => {
    mockFetchOnce([validPaper]);
    const result = await fetchCatalogPapers("cvpr-2026");
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.papers).toHaveLength(1);
      expect(result.byId.get(validPaper.paper_id)).toBeDefined();
    }
  });

  it("returns an error state on HTTP failure (not an empty list)", async () => {
    mockFetchOnce(null, { ok: false, status: 404 });
    const result = await fetchCatalogPapers("cvpr-2026");
    expect(result.status).toBe("error");
  });

  it("returns an error state on a published-but-empty papers.json", async () => {
    mockFetchOnce([]);
    const result = await fetchCatalogPapers("cvpr-2026");
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error).toMatch(/empty/);
  });

  it("returns an error state when a row fails validateCatalog (e.g. a bad paper_id)", async () => {
    mockFetchOnce([{ ...validPaper, paper_id: "not-an-id" }]);
    const result = await fetchCatalogPapers("cvpr-2026");
    expect(result.status).toBe("error");
  });
});

describe("fetchFullAbstract", () => {
  const paperId = "b".repeat(40);
  const shard = (text: string) => ({
    schema_version: "paper-details-v1",
    prefix: paperId.slice(0, 2),
    papers: [[paperId, text]],
  });

  it("returns the ready text for a well-formed shard", async () => {
    mockFetchOnce(shard("fresh <em>full</em> abstract"));
    const result = await fetchFullAbstract(paperId);
    expect(result).toEqual({ status: "ready", text: "fresh <em>full</em> abstract" });
  });

  it("returns failed (not throw) on an HTTP error", async () => {
    mockFetchOnce(null, { ok: false, status: 500 });
    const result = await fetchFullAbstract(paperId);
    expect(result).toEqual({ status: "failed" });
  });

  it("propagates AbortError so the caller can distinguish cancelled from failed", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise((_resolve, reject) => {
            controller.signal.addEventListener("abort", () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            });
          }),
      ),
    );
    const promise = fetchFullAbstract(paperId, controller.signal);
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });
});
