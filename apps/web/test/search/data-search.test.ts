import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSearchIdBlock, loadSearchIndex } from "../../lib/data-search";

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

describe("loadSearchIndex", () => {
  it("rejects the whole index when one row's paper_ref is wrong, even though lib/data.ts's zod schema alone would accept it (SCR-05)", async () => {
    // lib/data.ts's SearchIndexEntrySchema checks each field's shape but
    // not that row[2] (paper_ref) equals the row's own position --
    // loadSearchIndex must still catch it.
    mockFetchOnce([["Title", "iclr-2026", 7, [], [], 2026, "Oral"]]);
    const result = await loadSearchIndex();
    expect(result.status).toBe("error");
  });

  it("returns ok for a well-formed index", async () => {
    const entry = ["Title", "iclr-2026", 0, [], [], 2026, "Oral"];
    mockFetchOnce([entry]);
    const result = await loadSearchIndex();
    expect(result).toEqual({ status: "ok", data: [entry] });
  });

  it("propagates a fetch/schema error untouched", async () => {
    mockFetchOnce(null, { ok: false, status: 404 });
    const result = await loadSearchIndex();
    expect(result.status).toBe("error");
  });
});

describe("fetchSearchIdBlock", () => {
  it("fetches and validates a well-formed block", async () => {
    const paperIds = Array.from({ length: 2 }, (_, i) => String(i).repeat(40).slice(0, 40));
    mockFetchOnce({
      schema_version: "search-paper-ids-v1",
      block: 0,
      start: 0,
      paper_ids: paperIds,
    });
    const result = await fetchSearchIdBlock(0, 2);
    expect(result).toEqual({
      status: "ok",
      data: { schema_version: "search-paper-ids-v1", block: 0, start: 0, paper_ids: paperIds },
    });
    expect(fetch).toHaveBeenCalledWith("/search-paper-ids-v1/0000.json", { cache: "no-cache" });
  });

  it("fails closed on an HTTP error", async () => {
    mockFetchOnce(null, { ok: false, status: 404 });
    const result = await fetchSearchIdBlock(0, 2);
    expect(result.status).toBe("error");
  });

  it("fails closed on a block address mismatch", async () => {
    mockFetchOnce({
      schema_version: "search-paper-ids-v1",
      block: 1,
      start: 256,
      paper_ids: ["0".repeat(40)],
    });
    const result = await fetchSearchIdBlock(0, 257);
    expect(result.status).toBe("error");
  });
});
