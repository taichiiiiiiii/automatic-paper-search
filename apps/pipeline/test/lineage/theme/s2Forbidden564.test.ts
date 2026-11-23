// #564: a keyed S2 answering 403 (invalid key or a temporary block) used
// to be indistinguishable from any other failure in the logs, and the
// classify summary blamed "Groq RPM/daily quota" even when no LLM ran.
// 403 is now counted (`forbidden`, `403=<n>` in the summary, one
// `::warning::` line) while its handling stays as before: one request, no
// retry, no breaker, the pair is `fetch-failed` (unreachable), never
// "citing-not-in-s2" — the completeness gate depends on that.
import { describe, expect, it } from "vitest";
import type { HttpResponseLike } from "../../../src/collect/http/requestWithRetry.js";
import { logClassifySummary } from "../../../src/lineage/theme/build.js";
import type { ThemePaper } from "../../../src/lineage/theme/openalexWork.js";
import { S2CitationSource } from "../../../src/lineage/theme/s2Citations.js";

const resp = (status: number, body: unknown): HttpResponseLike =>
  ({ status, json: async () => body }) as HttpResponseLike;

const paper = (i: number): ThemePaper => ({
  paperId: `openalex:W${i}`,
  title: `Paper ${i}`,
  year: 2024,
  venue: "",
  citationCount: 1,
  abstract: "",
  authors: [],
  externalIds: { ArXiv: `2401.0000${i}` },
});
const CITED = paper(0);

function harness(statusFor: () => number) {
  let requests = 0;
  let now = 0;
  const src = new S2CitationSource(null, {
    fetchImpl: async () => {
      requests += 1;
      const s = statusFor();
      return s === 200 ? resp(200, { data: [] }) : resp(s, null);
    },
    sleep: async (ms: number) => {
      now += ms;
    },
    monotonicNow: () => now,
    apiKey: "test-key",
  });
  return {
    src,
    get requests() {
      return requests;
    },
  };
}

describe("S2 403 accounting (#564)", () => {
  it("(a) counts every 403, puts 403=<n> in the summary and yields one ::warning:: line", async () => {
    const h = harness(() => 403);
    for (let i = 1; i <= 5; i++) await h.src.lookup(paper(i), CITED);
    expect(h.src.stats.forbidden).toBe(5);
    expect(h.src.stats.forbidden).toBe(h.requests);
    expect(h.src.summary()).toContain("403=5");
    const warning = h.src.forbiddenWarning();
    expect(warning).not.toBeNull();
    expect(warning).toMatch(/^::warning::/);
    expect(warning).toContain("403");
    expect(warning).toContain("key=yes");
    expect(warning?.split("\n")).toHaveLength(1);
  });

  it("(a') no 403 → forbidden=0, 403=0 in the summary and no warning", async () => {
    const h = harness(() => 200);
    await h.src.lookup(paper(1), CITED);
    expect(h.src.stats.forbidden).toBe(0);
    expect(h.src.summary()).toContain("403=0");
    expect(h.src.forbiddenWarning()).toBeNull();
  });

  it("(b) 403 stays unreachable: fetch-failed, one request each, no retry, no breaker", async () => {
    const h = harness(() => 403);
    const looks = [];
    for (let i = 1; i <= 5; i++) looks.push(await h.src.lookup(paper(i), CITED));
    for (const look of looks) {
      expect(look).toMatchObject({ kind: "no_s2_data", reason: "fetch-failed" });
    }
    expect(h.src.stats.forbidden).toBe(5);
    expect(h.src.stats.citingFailed).toBe(5);
    expect(h.src.stats.citingNotInS2).toBe(0);
    expect(h.requests).toBe(5);
    expect(h.src.stats.retries).toBe(0);
    expect(h.src.stats.rateLimited).toBe(0);
    expect(h.src.breaker.trips).toBe(0);
  });
});

function capture() {
  const lines: string[] = [];
  return {
    lines,
    logger: { info: (m: string) => lines.push(m), warn: (m: string) => lines.push(m) },
  };
}

describe("logClassifySummary wording (#564)", () => {
  it("(c) LLM disabled: a high failure rate never mentions Groq and points at evidence fetching", () => {
    const c = capture();
    logClassifySummary(
      100,
      3,
      { hasExtraNodes: true, hasEdges: true, llmEnabled: false },
      { logger: c.logger },
    );
    const all = c.lines.join("\n");
    expect(all).not.toMatch(/groq/i);
    expect(all).not.toMatch(/LLM failure/i);
    const warn = c.lines.find((l) => l.includes("97.0%") && l !== c.lines[0]);
    expect(warn).toBeDefined();
    expect(warn).toMatch(/evidence/i);
    expect(warn).toContain("s2 citations summary");
  });

  it("(d) LLM enabled: the Groq quota warning is kept", () => {
    const c = capture();
    logClassifySummary(
      100,
      3,
      { hasExtraNodes: true, hasEdges: true, llmEnabled: true },
      { logger: c.logger },
    );
    expect(c.lines.some((l) => l.includes("likely Groq RPM/daily quota"))).toBe(true);
  });

  it("(d') at or below 30% neither warning is emitted", () => {
    for (const llmEnabled of [true, false]) {
      const c = capture();
      logClassifySummary(
        10,
        7,
        { hasExtraNodes: true, hasEdges: true, llmEnabled },
        { logger: c.logger },
      );
      expect(c.lines).toHaveLength(1);
    }
  });
});
