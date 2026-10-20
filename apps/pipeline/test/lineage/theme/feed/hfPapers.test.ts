/**
 * R4-3 (design 48 P1-2): Hugging Face Papers lookups for the "コード" /
 * "HF" badges — recorded HF answers, the cache (TTL, 404 = absent,
 * failures never cached), the per-theme `theme-code-links-v1` document,
 * and the rule that HF's LLM-generated fields never leave the payload.
 * Also runs the CLI end to end on a temporary repo with faked network.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateArtifact } from "@paperpilot/core/schemas";
import { describe, expect, it } from "vitest";
import type { FetchInit, HttpResponseLike } from "../../../../src/collect/http/requestWithRetry.js";
import {
  buildCodeLinks,
  canonicalGithubRepo,
  emptyHfCache,
  entryFromHfPayload,
  type HfCache,
  isFresh,
  parseHfCache,
  refreshHfCache,
  serializeHfCache,
} from "../../../../src/lineage/theme/feed/hfPapers.js";
import {
  parseThemeFeedsArgs,
  runThemeFeeds,
} from "../../../../src/lineage/theme/feed/themeFeedsCli.js";

const FIXTURES = join(import.meta.dirname, "fixtures");
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
const NOW = Date.parse("2026-10-11T12:00:00Z");
const noSleep = async () => {};

type Route = { status: number; body: unknown };
function routedFetch(routes: Record<string, Route>) {
  const calls: string[] = [];
  const fetchImpl = async (url: string, _init: FetchInit): Promise<HttpResponseLike> => {
    calls.push(url);
    const key = Object.keys(routes).find((k) => url.includes(k));
    const r = key ? routes[key]! : { status: 404, body: fixture("hf-paper-404.json") };
    return { status: r.status, json: async () => r.body };
  };
  return { fetchImpl, calls };
}

describe("HF payload -> cache entry", () => {
  it("keeps only counters and the repo URL (never ai_summary / ai_keywords / summary)", () => {
    const raw = fixture("hf-paper-2205.14135.json") as Record<string, unknown>;
    expect(raw.ai_summary).toBeTypeOf("string");
    const entry = entryFromHfPayload(raw, "2026-10-11T12:00:00Z");
    expect(entry).toEqual({
      status: "ok",
      fetched_at: "2026-10-11T12:00:00Z",
      github_repo: null,
      github_stars: null,
      upvotes: 16,
      models: 338,
      datasets: 2,
      spaces: 2268,
    });
    const text = JSON.stringify(entry);
    expect(text).not.toMatch(/ai_summary|ai_keywords|Qwen|IO-aware/);
  });

  it("reads githubRepo / githubStars from a Daily Papers entry", () => {
    const entry = entryFromHfPayload(fixture("hf-paper-2610.11216.json"), "t");
    expect(entry?.github_repo).toBe(
      "https://github.com/TSUITUENYUE/The-Lattice-of-Transition-Laws",
    );
    expect(entry?.github_stars).toBe(0);
  });

  it("ignores a repository HF linked automatically (githubRepoAddedBy: auto)", () => {
    const raw = fixture("hf-paper-2101.03961.json") as Record<string, unknown>;
    expect(raw.githubRepoAddedBy).toBe("auto");
    expect(raw.githubRepo).toBe("https://github.com/pwc-1/Paper-10");
    const entry = entryFromHfPayload(raw, "t");
    expect(entry?.github_repo).toBeNull();
    expect(entry?.github_stars).toBeNull();
    expect(entry?.upvotes).toBeGreaterThan(0);
  });

  it("canonicalGithubRepo accepts repo URLs and owner/repo only", () => {
    expect(canonicalGithubRepo("https://github.com/Dao-AILab/flash-attention")).toBe(
      "https://github.com/Dao-AILab/flash-attention",
    );
    expect(canonicalGithubRepo("http://www.github.com/a/b.git/")).toBe("https://github.com/a/b");
    expect(canonicalGithubRepo("google-research/vision_transformer")).toBe(
      "https://github.com/google-research/vision_transformer",
    );
    for (const bad of [
      "https://gitlab.com/a/b",
      "https://github.com/a",
      "https://github.com/a/b/tree/main",
      "https://github.com/a/b?x=1",
      "javascript:alert(1)",
      "../..",
      null,
    ]) {
      expect(canonicalGithubRepo(bad)).toBeNull();
    }
  });
});

describe("refreshHfCache", () => {
  it("caches 200 and 404 (absent), never a failure, and honours TTL and the request cap", async () => {
    const cache = emptyHfCache();
    cache.entries["1111.11111"] = {
      ...entryFromHfPayload({ id: "1111.11111", upvotes: 1 }, "2026-10-10T00:00:00Z")!,
    };
    cache.entries["2222.22222"] = {
      ...entryFromHfPayload({ id: "2222.22222", upvotes: 7 }, "2026-09-01T00:00:00Z")!,
    };
    const { fetchImpl, calls } = routedFetch({
      "/2205.14135": { status: 200, body: fixture("hf-paper-2205.14135.json") },
      "/2222.22222": { status: 503, body: {} },
      "/0000.00001": { status: 404, body: fixture("hf-paper-404.json") },
    });
    const stats = await refreshHfCache(
      cache,
      ["2205.14135", "1111.11111", "2222.22222", "0000.00001", "2205.14135"],
      { nowMs: NOW, ttlDays: 7, maxRequests: 10, paceMs: 0 },
      { fetchImpl, sleep: noSleep },
    );
    expect(stats).toEqual({
      requested: 3,
      fresh: 1,
      fetched: 1,
      absent: 1,
      failed: 1,
      skipped_budget: 0,
    });
    expect(calls.every((u) => u.startsWith("https://huggingface.co/api/papers/"))).toBe(true);
    expect(cache.entries["0000.00001"]?.status).toBe("absent");
    // 503: previous (stale) entry kept, not replaced.
    expect(cache.entries["2222.22222"]?.upvotes).toBe(7);
    const text = serializeHfCache(cache);
    expect(text).not.toMatch(/ai_summary|ai_keywords/);
    expect(parseHfCache(JSON.parse(text))).toEqual(cache);

    const capped = await refreshHfCache(
      emptyHfCache(),
      ["2205.14135", "0000.00001"],
      { nowMs: NOW, maxRequests: 1, paceMs: 0 },
      { fetchImpl, sleep: noSleep },
    );
    expect(capped.skipped_budget).toBe(1);
  });

  it("a malformed cache file is ignored", () => {
    expect(parseHfCache({ schema_version: "other", entries: { x: 1 } })).toEqual(emptyHfCache());
    expect(parseHfCache(null)).toEqual(emptyHfCache());
  });
});

describe("buildCodeLinks", () => {
  function cacheWith(): HfCache {
    const c = emptyHfCache();
    c.entries["2205.14135"] = entryFromHfPayload(fixture("hf-paper-2205.14135.json"), "t")!;
    c.entries["2610.11216"] = entryFromHfPayload(fixture("hf-paper-2610.11216.json"), "t")!;
    c.entries["1609.02907"] = entryFromHfPayload({ id: "1609.02907" }, "t")!; // all zero
    c.entries["2010.11929"] = {
      ...entryFromHfPayload({ id: "2010.11929", upvotes: 24 }, "t")!,
    };
    return c;
  }

  it("prefers HF's repo, falls back to paper_repos.json, and skips empty HF pages", () => {
    const doc = buildCodeLinks(
      "demo",
      [
        { id: "openalex:W1", arxiv_id: "2205.14135" },
        { id: "openalex:W2", arxiv_id: "2610.11216" },
        { id: "openalex:W3", arxiv_id: "1609.02907" },
        { id: "openalex:W4", arxiv_id: "2010.11929", github_stars: 12739 },
        { id: "openalex:W5", arxiv_id: null },
        { id: "openalex:W6", arxiv_id: "cs/0101001" },
      ],
      cacheWith(),
      { "2010.11929": "google-research/vision_transformer", "2205.14135": "evil/../x" },
      NOW,
    );
    expect(Object.keys(doc.nodes)).toEqual(["openalex:W1", "openalex:W2", "openalex:W4"]);
    expect(doc.nodes["openalex:W1"]).toEqual({
      arxiv_id: "2205.14135",
      code: null,
      hf: {
        url: "https://huggingface.co/papers/2205.14135",
        upvotes: 16,
        models: 338,
        datasets: 2,
        spaces: 2268,
      },
    });
    expect(doc.nodes["openalex:W2"]?.code).toEqual({
      url: "https://github.com/TSUITUENYUE/The-Lattice-of-Transition-Laws",
      stars: 0,
      source: "huggingface-papers",
    });
    expect(doc.nodes["openalex:W4"]?.code).toEqual({
      url: "https://github.com/google-research/vision_transformer",
      stars: 12739,
      source: "paper_repos",
    });
    expect(doc.sources).toEqual(["huggingface-papers", "paper_repos"]);
    const res = validateArtifact("theme-code-links-v1", doc);
    expect(res.errors).toBeNull();
    expect(JSON.stringify(doc)).not.toMatch(/ai_summary|ai_keywords/);
  });
});

describe("themeFeedsCli (temporary repo, faked network)", () => {
  function tempRepo(): string {
    const root = mkdtempSync(join(tmpdir(), "theme-feeds-"));
    const themes = join(root, "data", "published", "themes");
    mkdirSync(join(themes, "graph-neural-network"), { recursive: true });
    mkdirSync(join(root, "data", "config"), { recursive: true });
    mkdirSync(join(root, "data", "state"), { recursive: true });
    writeFileSync(
      join(themes, "themes-manifest.json"),
      JSON.stringify([{ slug: "graph-neural-network", theme: "Graph Neural Network" }]),
    );
    writeFileSync(
      join(themes, "graph-neural-network", "lineage.json"),
      JSON.stringify({
        schema_version: "lineage-artifact-v1",
        nodes: [
          { id: "openalex:W1", title: "Graph Neural Networks: A Review", arxiv_id: "2205.14135" },
          { id: "openalex:W2", title: "Graph Convolutional Networks", arxiv_id: "1609.02907" },
        ],
        edges: [],
        meta: { theme: "Graph Neural Network", seeds: ["openalex:W1"], generated_at: "x" },
      }),
    );
    writeFileSync(join(root, "data", "config", "paper_repos.json"), "{}");
    writeFileSync(join(root, "data", "config", "theme_aliases.json"), "{}");
    return root;
  }

  const citing = {
    id: "https://openalex.org/W9",
    title: "Message Passing Graph Neural Networks at Scale",
    publication_date: "2026-10-02",
    publication_year: 2026,
    type: "preprint",
    primary_location: { landing_page_url: "https://arxiv.org/abs/2610.00001", source: null },
    authorships: [],
    referenced_works: ["https://openalex.org/W1", "https://openalex.org/W2"],
  };

  it("writes new-papers.json, feed.xml, code-links.json and the HF cache", async () => {
    const root = tempRepo();
    const { fetchImpl } = routedFetch({
      "api.openalex.org": { status: 200, body: { meta: { next_cursor: null }, results: [citing] } },
      "/2205.14135": { status: 200, body: fixture("hf-paper-2205.14135.json") },
    });
    const lines: string[] = [];
    const code = await runThemeFeeds(
      parseThemeFeedsArgs([
        "--repo-root",
        root,
        "--now",
        "2026-10-11T12:00:00Z",
        "--no-topic-embedding",
      ]),
      { fetchImpl, embedder: null, sleep: noSleep, log: (l) => lines.push(l) },
    );
    expect(code).toBe(0);
    const dir = join(root, "data", "published", "themes", "graph-neural-network");
    const np = JSON.parse(readFileSync(join(dir, "new-papers.json"), "utf8"));
    expect(np.items.map((i: { id: string }) => i.id)).toEqual(["openalex:W9"]);
    expect(np.items[0].url).toBe("https://arxiv.org/abs/2610.00001");
    expect(readFileSync(join(dir, "feed.xml"), "utf8")).toContain(
      "<title>Message Passing Graph Neural Networks at Scale</title>",
    );
    const cl = JSON.parse(readFileSync(join(dir, "code-links.json"), "utf8"));
    expect(Object.keys(cl.nodes)).toEqual(["openalex:W1"]);
    const cache = readFileSync(join(root, "data", "state", "hf-papers", "papers.json"), "utf8");
    expect(cache).toContain('"1609.02907"');
    expect(cache).not.toMatch(/ai_summary/);
    expect(lines.join("\n")).toContain("kept=1");
  });

  it("an OpenAlex failure keeps the previous files and exits 4", async () => {
    const root = tempRepo();
    const dir = join(root, "data", "published", "themes", "graph-neural-network");
    writeFileSync(join(dir, "new-papers.json"), "PREVIOUS");
    const { fetchImpl } = routedFetch({ "api.openalex.org": { status: 500, body: {} } });
    const code = await runThemeFeeds(
      parseThemeFeedsArgs(["--repo-root", root, "--what", "new-papers", "--no-topic-embedding"]),
      { fetchImpl, embedder: null, sleep: noSleep, log: () => {} },
    );
    expect(code).toBe(4);
    expect(readFileSync(join(dir, "new-papers.json"), "utf8")).toBe("PREVIOUS");
    expect(existsSync(join(dir, "feed.xml"))).toBe(false);
  });

  it("--max-credits 0 spends nothing on OpenAlex", async () => {
    const root = tempRepo();
    const { fetchImpl, calls } = routedFetch({});
    const code = await runThemeFeeds(
      parseThemeFeedsArgs(["--repo-root", root, "--what", "new-papers", "--max-credits", "0"]),
      { fetchImpl, embedder: null, sleep: noSleep, log: () => {} },
    );
    expect(code).toBe(4);
    expect(calls).toEqual([]);
  });

  it("rejects bad arguments", () => {
    expect(() => parseThemeFeedsArgs(["--theme", "../x"])).toThrow(/slug/);
    expect(() => parseThemeFeedsArgs(["--days", "0"])).toThrow(/days/);
  });
});

describe("isFresh (cache fetched after --now)", () => {
  const day = 86_400_000;
  const now = Date.parse("2026-10-12T00:00:00Z");
  const entry = (iso: string) => ({ fetched_at: iso }) as unknown as Parameters<typeof isFresh>[0];
  it("a future-dated entry is never fresh", () => {
    expect(isFresh(entry("2026-10-19T00:00:00Z"), now, 7)).toBe(false);
    expect(isFresh(entry("2026-10-19T00:00:00Z"), now, 0)).toBe(false);
  });
  it("a recent past entry within the TTL is fresh", () => {
    expect(isFresh(entry(new Date(now - day).toISOString()), now, 7)).toBe(true);
    expect(isFresh(entry(new Date(now - day).toISOString()), now, 0)).toBe(false);
  });
});
