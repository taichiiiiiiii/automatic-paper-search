/**
 * Vitest port of the `_enrich_github_stars` tests in
 * `paperpilot/tests/test_build_theme_lineage.py`.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { enrichGithubStars } from "../../../src/lineage/theme/github.js";
import type { ThemeGraphNode } from "../../../src/lineage/theme/node.js";

const GITHUB_CACHE_VERSION = "github-stars-cache-v1";

function ghCacheJson(data: unknown): string {
  return JSON.stringify({ schema_version: GITHUB_CACHE_VERSION, data });
}

function readCache(path: string): Record<string, unknown> {
  const raw = JSON.parse(readFileSync(path, "utf-8"));
  expect(new Set(Object.keys(raw))).toEqual(new Set(["schema_version", "data"]));
  return raw.data;
}

function makeFakeResolvers(opts: {
  reposByAx?: Record<string, string>;
  reposByTitle?: Record<string, string>;
  starsByRepo?: Record<string, number>;
}) {
  const reposByTitle = opts.reposByTitle ?? {};
  const starsByRepo = opts.starsByRepo ?? {};
  const curated = opts.reposByAx ?? {};
  const search = vi.fn(async (title: string) => {
    const t = (title || "").toLowerCase();
    for (const [needle, repo] of Object.entries(reposByTitle)) {
      if (t.includes(needle.toLowerCase())) return repo;
    }
    return null;
  });
  const fetch = vi.fn(async (repo: string) => starsByRepo[repo] ?? null);
  return { curated, search, fetch };
}

function node(id: string, extra: Partial<ThemeGraphNode> = {}): ThemeGraphNode {
  return {
    id,
    title: "",
    year: null,
    venue: "arXiv",
    venue_tier: "preprint",
    authors: [],
    kinds: [],
    citation_count: 0,
    github_stars: 0,
    tldr: "",
    ...extra,
  };
}

let cacheDir: string;
let cachePath: string;
beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "gh-cache-"));
  cachePath = join(cacheDir, "github_stars.json");
});

describe("enrichGithubStars", () => {
  it("skips nodes without an arxiv_id (no resolver call at all)", async () => {
    const nodes = new Map([
      ["p1", node("p1")],
      ["p2", node("p2", { arxiv_id: "" })],
    ]);
    const search = vi.fn(async () => null);
    const fetch = vi.fn(async () => null);
    const enriched = await enrichGithubStars(nodes, {
      cachePath,
      curated: {},
      searchRepo: search,
      fetchStars: fetch,
    });
    expect(enriched).toBe(0);
    expect(search).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses the curated map first, skipping search entirely", async () => {
    const nodes = new Map([
      ["p1", node("p1", { arxiv_id: "2304.02643", title: "Segment Anything" })],
    ]);
    const { curated, search, fetch } = makeFakeResolvers({
      reposByAx: { "2304.02643": "facebookresearch/segment-anything" },
      starsByRepo: { "facebookresearch/segment-anything": 46000 },
    });
    const enriched = await enrichGithubStars(nodes, {
      cachePath,
      curated,
      searchRepo: search,
      fetchStars: fetch,
    });
    expect(enriched).toBe(1);
    expect(nodes.get("p1")?.github_stars).toBe(46000);
    expect(nodes.get("p1")?.github_url).toBe(
      "https://github.com/facebookresearch/segment-anything",
    );
    expect(search).not.toHaveBeenCalled();
  });

  it("falls back to search when the arxiv_id is not curated", async () => {
    const nodes = new Map([
      ["p1", node("p1", { arxiv_id: "9999.99999", title: "Some Niche Paper" })],
    ]);
    const { curated, search, fetch } = makeFakeResolvers({
      reposByTitle: { "some niche paper": "owner/some-niche-paper" },
      starsByRepo: { "owner/some-niche-paper": 12 },
    });
    const enriched = await enrichGithubStars(nodes, {
      cachePath,
      curated,
      searchRepo: search,
      fetchStars: fetch,
    });
    expect(enriched).toBe(1);
    expect(nodes.get("p1")?.github_stars).toBe(12);
    expect(nodes.get("p1")?.github_url).toBe("https://github.com/owner/some-niche-paper");
  });

  it("persists arxiv_id -> stars/url with a fetched_at timestamp", async () => {
    const nodes = new Map([["p1", node("p1", { arxiv_id: "1610.04256" })]]);
    const { curated, search, fetch } = makeFakeResolvers({
      reposByAx: { "1610.04256": "x/y" },
      starsByRepo: { "x/y": 42 },
    });
    await enrichGithubStars(nodes, { cachePath, curated, searchRepo: search, fetchStars: fetch });
    const cache = readCache(cachePath) as Record<string, any>;
    expect(cache["1610.04256"].stars).toBe(42);
    expect(cache["1610.04256"].url).toBe("https://github.com/x/y");
    expect(cache["1610.04256"].fetched_at).toBeTruthy();
  });

  it("uses a fresh (within-TTL) cache hit without resolving", async () => {
    const freshTs = new Date().toISOString();
    writeFileSync(
      cachePath,
      ghCacheJson({
        "2103.00020": { stars: 999, url: "https://github.com/cached/repo", fetched_at: freshTs },
      }),
    );
    const nodes = new Map([["p1", node("p1", { arxiv_id: "2103.00020" })]]);
    const search = vi.fn(async () => null);
    const fetch = vi.fn(async () => null);
    const enriched = await enrichGithubStars(nodes, {
      cachePath,
      curated: {},
      searchRepo: search,
      fetchStars: fetch,
    });
    expect(enriched).toBe(1);
    expect(nodes.get("p1")?.github_stars).toBe(999);
    expect(nodes.get("p1")?.github_url).toBe("https://github.com/cached/repo");
    expect(search).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("drops a poisoned cache URL (non-github / javascript:) but keeps the stars value", async () => {
    const freshTs = new Date().toISOString();
    writeFileSync(
      cachePath,
      ghCacheJson({
        "1234.5678": { stars: 42, url: "javascript:alert('xss')", fetched_at: freshTs },
        "9999.99": { stars: 99, url: "https://evil.example.com/owner/repo", fetched_at: freshTs },
      }),
    );
    const nodes = new Map([
      ["a", node("a", { arxiv_id: "1234.5678" })],
      ["b", node("b", { arxiv_id: "9999.99" })],
    ]);
    const enriched = await enrichGithubStars(nodes, {
      cachePath,
      curated: {},
      searchRepo: vi.fn(async () => null),
      fetchStars: vi.fn(async () => null),
    });
    expect(enriched).toBe(2);
    expect(nodes.get("a")?.github_stars).toBe(42);
    expect(nodes.get("a")?.github_url).toBeUndefined();
    expect(nodes.get("b")?.github_stars).toBe(99);
    expect(nodes.get("b")?.github_url).toBeUndefined();
  });

  it("refreshes a stale (past-TTL) cache entry instead of using it", async () => {
    const staleTs = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(
      cachePath,
      ghCacheJson({
        "1706.03762": { stars: 100, url: "https://github.com/old/repo", fetched_at: staleTs },
      }),
    );
    const nodes = new Map([["p1", node("p1", { arxiv_id: "1706.03762" })]]);
    const { curated, search, fetch } = makeFakeResolvers({
      reposByAx: { "1706.03762": "new/repo" },
      starsByRepo: { "new/repo": 5000 },
    });
    const enriched = await enrichGithubStars(nodes, {
      cachePath,
      curated,
      searchRepo: search,
      fetchStars: fetch,
    });
    expect(enriched).toBe(1);
    expect(nodes.get("p1")?.github_stars).toBe(5000);
    expect(nodes.get("p1")?.github_url).toBe("https://github.com/new/repo");
  });

  it("caches stars=0 for a paper resolved nowhere, so it isn't re-queried weekly", async () => {
    const nodes = new Map([["p1", node("p1", { arxiv_id: "1234.5678" })]]);
    const { curated, search, fetch } = makeFakeResolvers({});
    const enriched = await enrichGithubStars(nodes, {
      cachePath,
      curated,
      searchRepo: search,
      fetchStars: fetch,
    });
    expect(enriched).toBe(0);
    const cache = readCache(cachePath) as Record<string, any>;
    expect(cache["1234.5678"].stars).toBe(0);
    expect(cache["1234.5678"].url).toBeNull();
  });
});
