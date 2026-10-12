/**
 * R2-36: publish max(OpenAlex, Semantic Scholar) citation counts.
 * No network: a stubbed `fetchImpl` answers `/paper/batch`.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FetchInit, HttpResponseLike } from "../../../src/collect/http/requestWithRetry.js";
import type { ThemeGraphNode } from "../../../src/lineage/shared/node.js";
import { toThemeNode } from "../../../src/lineage/theme/node.js";
import type { ThemePaper } from "../../../src/lineage/theme/openalexWork.js";
import {
  applyS2CitationCounts,
  applyS2Count,
  mergeCitationCounts,
  S2_COUNT_CACHE_VERSION,
  s2LookupId,
} from "../../../src/lineage/theme/s2CitationCounts.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "s2counts-"));
  dirs.push(d);
  return d;
}

function node(id: string, cites: number, ids: Partial<ThemeGraphNode> = {}): ThemeGraphNode {
  return {
    id,
    title: id,
    year: 2021,
    venue: "arXiv",
    venue_tier: "preprint",
    authors: [],
    kinds: [],
    citation_count: cites,
    github_stars: 0,
    tldr: "",
    ...ids,
  };
}

function stubFetch(counts: Record<string, number | null>, status = 200) {
  const calls: { url: string; body: { ids: string[] } }[] = [];
  const fetchImpl = async (url: string, init?: FetchInit): Promise<HttpResponseLike> => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { ids: string[] };
    calls.push({ url, body });
    return {
      status,
      headers: new Headers(),
      json: async () =>
        body.ids.map((i) => (counts[i] === undefined ? null : { citationCount: counts[i] })),
      text: async () => "",
    } as unknown as HttpResponseLike;
  };
  return { fetchImpl: fetchImpl as never, calls };
}

describe("mergeCitationCounts", () => {
  it("takes the larger count and names its source", () => {
    expect(mergeCitationCounts(2510, 24206)).toEqual({ count: 24206, source: "semantic_scholar" });
    expect(mergeCitationCounts(500, 5951)).toEqual({ count: 5951, source: "semantic_scholar" });
    expect(mergeCitationCounts(100, 40)).toEqual({ count: 100, source: "openalex" });
  });
  it("keeps OpenAlex on a tie or a missing / invalid S2 count", () => {
    expect(mergeCitationCounts(7, 7).source).toBe("openalex");
    expect(mergeCitationCounts(7, null).count).toBe(7);
    expect(mergeCitationCounts(7, undefined).count).toBe(7);
    expect(mergeCitationCounts(7, Number.NaN).count).toBe(7);
    expect(mergeCitationCounts(0, 0)).toEqual({ count: 0, source: "openalex" });
  });
});

describe("s2LookupId", () => {
  it("prefers the arXiv id (version stripped), then the DOI", () => {
    expect(s2LookupId({ arxiv_id: "2106.09685v2", doi: "10.48550/arxiv.2106.09685" })).toBe(
      "ARXIV:2106.09685",
    );
    expect(s2LookupId({ doi: "https://doi.org/10.1/x" })).toBe("DOI:10.1/x");
    expect(s2LookupId({})).toBeNull();
  });
});

describe("toThemeNode (S2 count carried by the expansion)", () => {
  const paper = (extra: Record<string, unknown>): ThemePaper =>
    ({
      paperId: "openalex:W1",
      title: "LoRA",
      year: 2021,
      venue: "",
      abstract: "",
      authors: [],
      citationCount: 2510,
      externalIds: { ArXiv: "2106.09685" },
      ...extra,
    }) as unknown as ThemePaper;
  it("publishes the larger _s2_citation_count and the source", () => {
    const n = toThemeNode(paper({ _s2_citation_count: 24206 }));
    expect(n.citation_count).toBe(24206);
    expect(n.citation_count_source).toBe("semantic_scholar");
  });
  it("leaves OpenAlex-only nodes untouched (no source field)", () => {
    const n = toThemeNode(paper({}));
    expect(n.citation_count).toBe(2510);
    expect(n).not.toHaveProperty("citation_count_source");
  });
});

describe("applyS2CitationCounts", () => {
  it("raises under-counted nodes (seeds/root included), by arXiv id or DOI", async () => {
    const nodes = new Map<string, ThemeGraphNode>([
      ["lora", node("lora", 2510, { arxiv_id: "2106.09685", is_focus: true })],
      ["qlora", node("qlora", 500, { doi: "10.48550/arxiv.2305.14314" })],
      ["big", node("big", 9000, { arxiv_id: "1706.03762" })],
      ["noid", node("noid", 5)],
    ]);
    const { fetchImpl, calls } = stubFetch({
      "ARXIV:2106.09685": 24206,
      "DOI:10.48550/arxiv.2305.14314": 5951,
      "ARXIV:1706.03762": 100,
    });
    const stats = await applyS2CitationCounts(nodes, { cachePath: null, fetchImpl });
    expect(nodes.get("lora")?.citation_count).toBe(24206);
    expect(nodes.get("lora")?.citation_count_source).toBe("semantic_scholar");
    expect(nodes.get("qlora")?.citation_count).toBe(5951);
    expect(nodes.get("big")?.citation_count).toBe(9000);
    expect(nodes.get("big")).not.toHaveProperty("citation_count_source");
    expect(nodes.get("noid")?.citation_count).toBe(5);
    expect(stats).toMatchObject({ eligible: 3, fetched: 3, raised: 2, failedChunks: 0 });
    // one batch, sorted ids, only nodes with an identifier
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("fields=citationCount");
    expect(calls[0]?.body.ids).toEqual([
      "ARXIV:1706.03762",
      "ARXIV:2106.09685",
      "DOI:10.48550/arxiv.2305.14314",
    ]);
  });

  it("falls back silently to OpenAlex when S2 fails", async () => {
    const nodes = [node("a", 10, { arxiv_id: "1.1" })];
    const { fetchImpl } = stubFetch({ "ARXIV:1.1": 99 }, 500);
    const warns: string[] = [];
    const stats = await applyS2CitationCounts(nodes, {
      cachePath: null,
      fetchImpl,
      sleep: async () => {},
      logger: { warn: (m) => warns.push(m) },
    });
    expect(nodes[0]?.citation_count).toBe(10);
    expect(stats.failedChunks).toBe(1);
    expect(stats.raised).toBe(0);
  });

  it("falls back when the fetch throws", async () => {
    const nodes = [node("a", 10, { arxiv_id: "1.1" })];
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as never;
    await applyS2CitationCounts(nodes, { cachePath: null, fetchImpl, sleep: async () => {} });
    expect(nodes[0]?.citation_count).toBe(10);
  });

  it("is cache-backed: a replay makes no request and publishes the same counts", async () => {
    const dir = tmp();
    const cachePath = join(dir, "s2_citation_counts.json");
    const now = () => new Date("2026-10-12T00:00:00Z");
    const make = () => [
      node("lora", 2510, { arxiv_id: "2106.09685" }),
      node("unk", 4, { arxiv_id: "9999.9999" }),
    ];
    const first = stubFetch({ "ARXIV:2106.09685": 24206 });
    const a = make();
    await applyS2CitationCounts(a, { cachePath, fetchImpl: first.fetchImpl, now });
    expect(first.calls).toHaveLength(1);
    const cacheText = readFileSync(cachePath, "utf8");
    const parsed = JSON.parse(cacheText);
    expect(parsed.schema_version).toBe(S2_COUNT_CACHE_VERSION);
    expect(Object.keys(parsed.data)).toEqual(["ARXIV:2106.09685", "ARXIV:9999.9999"]);
    expect(parsed.data["ARXIV:9999.9999"].n).toBeNull();

    const second = stubFetch({ "ARXIV:2106.09685": 1 });
    const b = make();
    await applyS2CitationCounts(b, {
      cachePath,
      fetchImpl: second.fetchImpl,
      now: () => new Date("2026-10-15T00:00:00Z"),
    });
    expect(second.calls).toHaveLength(0);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(readFileSync(cachePath, "utf8")).toBe(cacheText);
  });

  it("refetches an expired entry and ignores a corrupt cache file", async () => {
    const dir = tmp();
    const cachePath = join(dir, "c.json");
    writeFileSync(cachePath, "not json");
    const s = stubFetch({ "ARXIV:1.1": 50 });
    const nodes = [node("a", 10, { arxiv_id: "1.1" })];
    await applyS2CitationCounts(nodes, { cachePath, fetchImpl: s.fetchImpl });
    expect(nodes[0]?.citation_count).toBe(50);
    const later = stubFetch({ "ARXIV:1.1": 60 });
    const again = [node("a", 10, { arxiv_id: "1.1" })];
    await applyS2CitationCounts(again, {
      cachePath,
      fetchImpl: later.fetchImpl,
      now: () => new Date(Date.now() + 60 * 24 * 3600 * 1000),
    });
    expect(later.calls).toHaveLength(1);
    expect(again[0]?.citation_count).toBe(60);
  });

  it("applyS2Count never lowers a count", () => {
    const n = node("a", 100);
    expect(applyS2Count(n, 50)).toBe(false);
    expect(n.citation_count).toBe(100);
  });
});
