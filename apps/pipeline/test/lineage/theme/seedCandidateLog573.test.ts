/**
 * #573: the seed candidates (OpenAlex search page per keyword, the
 * velocity re-ranking, and the final seeds) are written to the generate
 * log at `info`, so a rebuild whose seeds changed can be read from its
 * log (#560: MPT sat at rank 29 of a 30-work search window).
 *
 * Logging only: the seed selection with and without an `info` logger
 * must be identical, a logger without `info` (the `{ warn }` shape of
 * the older tests) gets no extra lines, and no line carries a URL, the
 * polite-pool e-mail or an API key. No network: every fetch is faked.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FetchInit, HttpResponseLike } from "../../../src/collect/http/requestWithRetry.js";
import { type BuildThemeLineageDeps, buildThemeLineage } from "../../../src/lineage/theme/build.js";
import {
  discoverSeedsOpenalexPrimary,
  rankAndTruncate,
} from "../../../src/lineage/theme/discoverSeeds.js";
import {
  discoverSeedsViaOpenalex,
  type OpenAlexDeps,
} from "../../../src/lineage/theme/openalexFetch.js";

const tmpDirs: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function jsonResp(status: number, body: unknown): HttpResponseLike {
  return { status, headers: new Headers(), json: async () => body } as HttpResponseLike;
}

const EMAIL = "polite-pool@example.org";
const SECRET = "S2SECRETKEY0123456789";

function work(
  shortId: string,
  title: string,
  year: number,
  cites: number,
  relevance: number | undefined,
): Record<string, unknown> {
  return {
    id: `https://openalex.org/${shortId}`,
    title,
    display_name: title,
    publication_year: year,
    cited_by_count: cites,
    ...(relevance === undefined ? {} : { relevance_score: relevance }),
    abstract_inverted_index: { Prompt: [0], tuning: [1], adapts: [2], models: [3] },
    authorships: [],
  };
}

const LONG_TITLE = `Prompt Tuning ${"with a very long descriptive title ".repeat(6)}`;
const WORKS = [
  work("W101", "The Power of Scale for Parameter-Efficient Prompt Tuning", 2021, 3000, 165.6),
  work("W102", "P-Tuning v2: Prompt Tuning Can Be Comparable to Fine-tuning", 2022, 1200, 120.25),
  work("W103", LONG_TITLE, 2023, 40, 99.5),
  work(
    "W104",
    "Multitask Prompt Tuning Enables Parameter-Efficient Transfer",
    2023,
    300,
    undefined,
  ),
];

function oaFetch(urls: string[]) {
  return async (url: string, _init?: FetchInit): Promise<HttpResponseLike> => {
    urls.push(url);
    return jsonResp(200, { results: WORKS });
  };
}

interface Captured {
  info: string[];
  warn: string[];
}
function capture(): Captured & {
  logger: { info: (m: string) => void; warn: (m: string) => void };
} {
  const c: Captured = { info: [], warn: [] };
  return { ...c, logger: { info: (m) => c.info.push(m), warn: (m) => c.warn.push(m) } };
}

function oaDeps(logger: OpenAlexDeps["logger"], urls: string[] = []): OpenAlexDeps {
  return { fetchImpl: oaFetch(urls), sleep: async () => {}, email: EMAIL, logger };
}

const PRIMARY = {
  keywords: ["Prompt Tuning"],
  topN: 10,
  sinceYear: 2018,
  theme: "Prompt Tuning",
  s2SearchFallback: false,
  rankLimit: 40,
} as const;

describe("#573 (a) OpenAlex seed search lines", () => {
  it("logs one header (query, per-page, returned) and one line per returned work, in relevance order", async () => {
    const c = capture();
    await discoverSeedsViaOpenalex(
      { query: "Prompt Tuning", topN: 10, sinceYear: 2018 },
      oaDeps(c.logger),
    );
    const lines = c.info.filter((l) => l.startsWith("seed search:"));
    expect(lines).toHaveLength(1 + WORKS.length);
    expect(lines[0]).toContain('query="Prompt Tuning"');
    expect(lines[0]).toContain("per-page=30");
    expect(lines[0]).toContain("returned=4");
    expect(lines[1]).toMatch(/#1 W101 year=2021 cites=3000 relevance=165\.6 /);
    expect(lines[2]).toMatch(/#2 W102 year=2022 cites=1200 relevance=120\.25 /);
    expect(lines[4]).toMatch(/#4 W104 year=2023 cites=300 relevance=null /);
    // The title is cut to 80 characters.
    const quoted = /title="(.*)"$/.exec(lines[3] ?? "")?.[1] ?? "";
    expect(quoted.length).toBeLessThanOrEqual(80);
    expect(LONG_TITLE.startsWith(quoted.replace(/…$/, ""))).toBe(true);
    // Never more than per-page + 1 lines for one keyword.
    expect(lines.length).toBeLessThanOrEqual(30 + 1);
  });
});

describe("#573 (a') odd payloads", () => {
  it("does not throw on a work with missing fields or a non-numeric relevance_score", async () => {
    const c = capture();
    // The shape check upstream rejects non-string titles and non-numeric
    // years, so the odd cases left are missing fields and a non-numeric
    // relevance_score (not validated).
    const odd = { id: "https://openalex.org/W9", relevance_score: "high" };
    const deps: OpenAlexDeps = {
      fetchImpl: async () => jsonResp(200, { results: [odd] }),
      sleep: async () => {},
      logger: c.logger,
    };
    const out = await discoverSeedsViaOpenalex({ query: "x", topN: 5, sinceYear: null }, deps);
    expect(out).toEqual([odd]);
    expect(c.info[1]).toBe('seed search: #1 W9 year=null cites=null relevance=null title=""');
  });
});

describe("#573 (b) velocity re-ranking lines", () => {
  it("logs one header and one line per candidate; selected count = topN", () => {
    const log: string[] = [];
    const papers = [
      { paperId: "p1", title: "A", year: 2020, citationCount: 100 },
      { paperId: "p2", title: "B", year: 2024, citationCount: 100 },
      { paperId: "p3", title: "C", year: 2022, citationCount: 10 },
    ];
    const kept = rankAndTruncate(papers, {
      topN: 2,
      sinceYear: null,
      currentYear: 2026,
      weight: (p) => (p.paperId === "p3" ? 0.5 : 1),
      log: (m) => log.push(m),
    });
    const lines = log.filter((l) => l.startsWith("seed rank:"));
    expect(lines).toHaveLength(1 + papers.length);
    expect(lines[0]).toContain("3 candidate(s)");
    expect(lines[0]).toContain("top 2");
    const rows = lines.slice(1);
    // Rank order: p2 (101/2), p1 (101/6), p3 (11/4 x 0.5).
    expect(rows[0]).toMatch(/#1 p2 velocity=50\.50 weight=1\.00 score=50\.50 selected=yes/);
    expect(rows[1]).toMatch(/#2 p1 velocity=16\.83 weight=1\.00 score=16\.83 selected=yes/);
    expect(rows[2]).toMatch(/#3 p3 velocity=2\.75 weight=0\.50 score=1\.38 selected=no/);
    expect(rows.filter((r) => r.includes("selected=yes"))).toHaveLength(kept.length);
    expect(kept.map((p) => p.paperId)).toEqual(["p2", "p1"]);
  });

  it("selects every candidate when there are fewer than topN, and logs the same picks the caller gets", async () => {
    const c = capture();
    const seeds = await discoverSeedsOpenalexPrimary(PRIMARY, oaDeps(c.logger));
    const rows = c.info.filter((l) => l.startsWith("seed rank:")).slice(1);
    expect(rows).toHaveLength(seeds.length);
    expect(rows.every((r) => r.includes("selected=yes"))).toBe(true);
    const loggedIds = rows.map((r) => /#\d+ (\S+) /.exec(r)?.[1]);
    expect(loggedIds).toEqual(seeds.map((s) => s.paperId));
  });
});

describe("#573 (c) logging does not change the selection", () => {
  it("returns the same seeds in the same order with an info logger and without a logger", async () => {
    const c = capture();
    const withLog = await discoverSeedsOpenalexPrimary(PRIMARY, oaDeps(c.logger));
    const without = await discoverSeedsOpenalexPrimary(PRIMARY, oaDeps(undefined));
    expect(withLog.length).toBeGreaterThan(0);
    expect(withLog.map((s) => s.paperId)).toEqual(without.map((s) => s.paperId));
    expect(c.info.length).toBeGreaterThan(0);

    const log: string[] = [];
    const papers = [
      { paperId: "x", title: "X", year: 2021, citationCount: 5 },
      { paperId: "y", title: "Y", year: 2021, citationCount: 5 },
      { paperId: "z", title: "Z", year: 2016, citationCount: 50 },
    ];
    const opts = { topN: 2, sinceYear: 2018, currentYear: 2026 };
    expect(rankAndTruncate(papers, { ...opts, log: (m) => log.push(m) })).toEqual(
      rankAndTruncate(papers, opts),
    );
  });
});

describe("#573 (d) loggers without info", () => {
  it("emits nothing extra and does not throw without a logger or with a warn-only logger", async () => {
    const full = capture();
    await discoverSeedsOpenalexPrimary(PRIMARY, oaDeps(full.logger));

    await expect(discoverSeedsOpenalexPrimary(PRIMARY, oaDeps(undefined))).resolves.toBeDefined();

    const warns: string[] = [];
    const warnOnly = await discoverSeedsOpenalexPrimary(
      PRIMARY,
      oaDeps({ warn: (m) => warns.push(m) }),
    );
    expect(warnOnly.length).toBeGreaterThan(0);
    // No info line is redirected to warn.
    expect(warns).toEqual(full.warn);
    expect(warns.some((w) => w.startsWith("seed search:") || w.startsWith("seed rank:"))).toBe(
      false,
    );
  });
});

describe("#573 (e) no URL, e-mail or key in the log", () => {
  it("keeps request details out of every new line", async () => {
    const c = capture();
    const urls: string[] = [];
    const deps = { ...oaDeps(c.logger, urls), cacheDir: tmp("seedlog-cache-"), s2ApiKey: SECRET };
    await discoverSeedsOpenalexPrimary(PRIMARY, deps);
    // The e-mail IS handed to the code (otherwise this test would be vacuous),
    // and since #558 it reaches neither the request URL nor the log.
    expect(deps.email).toBe(EMAIL);
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) {
      expect(u).not.toContain("mailto");
      expect(u).not.toContain(EMAIL);
      expect(u).not.toContain(encodeURIComponent(EMAIL));
    }
    expect(c.info.length).toBeGreaterThan(0);
    for (const line of c.info) {
      expect(line).not.toMatch(/https?:\/\//);
      expect(line).not.toContain("mailto");
      expect(line).not.toContain(EMAIL);
      expect(line).not.toContain(SECRET);
      expect(line).not.toContain("openalex.org");
    }
  });

  it("keeps the S2 key out of the log when the S2 search fallback actually sends it", async () => {
    const c = capture();
    const sentKeys: string[] = [];
    const sentUrls: string[] = [];
    const s2Hit = {
      paperId: "a".repeat(40),
      title: "Prompt Tuning for Frozen Language Models",
      year: 2021,
      venue: "EMNLP",
      citationCount: 50,
      abstract: "Prompt tuning adapts frozen language models.",
      authors: [],
      externalIds: {},
    };
    const deps = {
      fetchImpl: async (url: string, init?: FetchInit): Promise<HttpResponseLike> => {
        const key = (init?.headers as Record<string, string> | undefined)?.["x-api-key"];
        if (key) sentKeys.push(key);
        sentUrls.push(url);
        if (url.includes("semanticscholar.org")) return jsonResp(200, { data: [s2Hit] });
        return jsonResp(500, {});
      },
      sleep: async () => {},
      email: EMAIL,
      logger: c.logger,
      cacheDir: tmp("seedlog-cache-"),
      s2ApiKey: SECRET,
    };
    await discoverSeedsOpenalexPrimary({ ...PRIMARY, s2SearchFallback: true }, deps);
    expect(sentKeys).toContain(SECRET);
    // #558: the e-mail is in deps but no request (OpenAlex or S2) carries it.
    expect(deps.email).toBe(EMAIL);
    expect(sentUrls.some((u) => u.includes("openalex.org"))).toBe(true);
    for (const u of sentUrls) {
      expect(u).not.toContain("mailto");
      expect(u).not.toContain(EMAIL);
      expect(u).not.toContain(encodeURIComponent(EMAIL));
    }
    expect(c.info.some((l) => l.startsWith("seed rank:"))).toBe(true);
    for (const line of [...c.info, ...c.warn]) {
      expect(line).not.toContain(SECRET);
      expect(line).not.toContain(EMAIL);
    }
  });
});

describe("#573 (f) final seeds line from the build", () => {
  function s2Paper(pid: string, title: string, year: number, cites: number, arxivId: string) {
    return {
      paperId: pid,
      title,
      year,
      venue: "NeurIPS",
      citationCount: cites,
      abstract: "a".repeat(80),
      authors: [],
      externalIds: { ArXiv: arxivId },
    };
  }

  it("logs the final seed ids once, after alias merge, selection and dedup", async () => {
    const docsRoot = tmp("seedlog-docs-");
    const cacheDir = tmp("seedlog-cache-");
    const seed = s2Paper("seedn", "Gate Theme Seed Paper", 2020, 100, "2401.00001");
    const parent = s2Paper("parentn", "An Earlier Gate Theme Parent Paper", 2016, 60, "2016.00010");
    const info: string[] = [];
    const deps: BuildThemeLineageDeps = {
      fetchImpl: async (url) => {
        if (url.includes("/references")) {
          return jsonResp(200, {
            data: [{ citedPaper: parent, isInfluential: true, intents: [] }],
          });
        }
        if (url.includes("/citations")) return jsonResp(200, { data: [] });
        if (url.includes("/paper/batch")) return jsonResp(200, []);
        return jsonResp(200, { data: [seed], results: [] });
      },
      cacheDir,
      sleep: async () => {},
      docsRoot,
      identityAliasesPath: join(docsRoot, "identity-aliases-v1.json"),
      githubCachePath: join(cacheDir, "github_stars.json"),
      logger: { info: (m) => info.push(m), warn: () => {} },
      buildProvider: () => {
        throw new Error("no LLM in this test");
      },
      s2Citations: { cachePath: null },
      s2CitationCounts: { cachePath: null },
    };
    await buildThemeLineage(
      {
        theme: "Gate Theme",
        depth: 1,
        seedsCount: 3,
        width: 4,
        sinceYear: null,
        lineageLlm: "off",
      },
      deps,
    );
    const finals = info.filter((l) => l.startsWith("seeds: final"));
    expect(finals).toHaveLength(1);
    expect(finals[0]).toBe("seeds: final 1/3: seedn");
  });
});
