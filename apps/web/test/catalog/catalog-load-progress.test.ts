/**
 * `fetchConferencePapers(slug, { onProgress })` (design doc 53): the
 * catalog's loading state reports bytes received while a large
 * papers.json streams in, and the parsed result is the same as without
 * a progress callback.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchConferencePapers } from "../../lib/data";

const ROW = {
  title: "T",
  type: "Poster",
  tags: [],
  venue: "X",
  authors: [],
  abstract: "",
  arxiv_id: "",
  citation_count: 0,
  venue_tier: 1,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function streamingResponse(text: string, chunkSize: number): Response {
  const bytes = new TextEncoder().encode(text);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) {
        controller.enqueue(bytes.slice(i, i + chunkSize));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

describe("fetchConferencePapers progress", () => {
  it("reports cumulative bytes and parses the streamed JSON (incl. multi-byte text)", async () => {
    const body = JSON.stringify([ROW, { ...ROW, title: "拡散モデル" }]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => streamingResponse(body, 7)),
    );
    const seen: number[] = [];
    const result = await fetchConferencePapers("icml-2026", { onProgress: (b) => seen.push(b) });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.data[1]?.title).toBe("拡散モデル");
    expect(seen.length).toBeGreaterThan(3);
    expect(seen.at(-1)).toBe(new TextEncoder().encode(body).byteLength);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  });

  it("still fails cleanly on HTTP errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );
    const result = await fetchConferencePapers("icml-2026", { onProgress: () => {} });
    expect(result.status).toBe("error");
  });
});
