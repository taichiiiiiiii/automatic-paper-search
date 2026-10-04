/**
 * Port of `paperpilot/tests/test_github_signal.py` and
 * `test_github_signal_flow.py`.
 *
 * ADAPTED: Python's `GitHubSignal.enrich_one` is synchronous (blocking
 * `requests`); this port's HTTP is async, so the Python tests that call
 * `sig.enrich_one(paper)` directly call `sig.enrichOneAsync(paper)` here
 * instead (documented in `signals/github.ts`'s `enrichOne` doc comment).
 */
import { expect, it, vi } from "vitest";
import { createPaper } from "../../../src/collect/model/paper.js";
import { GitHubSignal, MAX_STARS, starsToScore } from "../../../src/collect/signals/github.js";
import * as githubApi from "../../../src/collect/signals/githubApi.js";
import { GitHubUnavailableError } from "../../../src/collect/signals/githubApi.js";

vi.mock("../../../src/collect/signals/githubApi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/collect/signals/githubApi.js")>();
  return { ...actual };
});

function mkPaper(arxivId: string | null, title = "Some Title", suffix = "1") {
  return createPaper({
    title,
    authors: ["A"],
    abstract: "abs",
    url: `http://x/${suffix}`,
    publishedDate: "2026-01-01",
    source: "arxiv",
    arxivId,
  });
}

function newSignal(
  maxLookups = 50,
  githubToken: string | null = null,
  logger?: { warn: (msg: string) => void },
) {
  return new GitHubSignal(
    { enabled: true, max_lookups: maxLookups },
    { fetchImpl: async () => ({ status: 404, json: async () => ({}) }), githubToken, logger },
  );
}

it("test_zero_stars", () => {
  expect(starsToScore(0)).toBe(0.0);
});
it("test_negative_stars_is_zero", () => {
  expect(starsToScore(-1)).toBe(0.0);
});
it("test_max_stars_is_100", () => {
  expect(starsToScore(MAX_STARS)).toBe(100.0);
});
it("test_above_max_still_100", () => {
  expect(starsToScore(MAX_STARS * 10)).toBe(100.0);
});
it("test_log_curve_monotonic", () => {
  const scores = [1, 10, 100, 1000, 5000, 10000].map(starsToScore);
  expect(scores).toEqual([...scores].sort((a, b) => a - b));
  expect(new Set(scores).size).toBe(scores.length);
});
it("test_1000_stars_matches_formula", () => {
  const expected = (Math.log(1001) / Math.log(MAX_STARS + 1)) * 100;
  expect(starsToScore(1000)).toBe(expected);
});

// ---------- per-run failure channel ----------

it("test_repeated_unavailable_lookups_record_one_warning_and_one_entry", async () => {
  const warnings: string[] = [];
  const sig = newSignal(3, null, { warn: (m: string) => warnings.push(m) });
  sig.curated = {};
  vi.spyOn(githubApi, "searchRepoByTitle").mockRejectedValue(
    new GitHubUnavailableError("github repo search failed (status=403)"),
  );
  const papers = [
    mkPaper("2604.0001", "T", "1"),
    mkPaper("2604.0002", "T", "2"),
    mkPaper("2604.0003", "T", "3"),
  ];

  const out = await sig.enrichBatch(papers);
  expect(out.every((p) => p.githubScore === 0.0)).toBe(true);
  expect(sig.runFailures.length).toBe(1);
  expect(sig.runFailures[0]).toContain("3 lookup(s) unavailable");
  expect(sig.runFailures[0]).toContain("status=403");
  expect(warnings.length).toBe(1);
  expect(warnings[0]).toContain("3 lookup(s) degraded this run");
});

it("test_search_miss_is_not_recorded_as_a_failure", async () => {
  const sig = newSignal(2);
  sig.curated = {};
  vi.spyOn(githubApi, "searchRepoByTitle").mockResolvedValue(null);
  await sig.enrichBatch([mkPaper("2604.0001", "T", "1"), mkPaper("2604.0002", "T", "2")]);
  expect(sig.runFailures).toEqual([]);
});

it("test_lookup_exception_is_counted_in_the_same_entry", async () => {
  const sig = newSignal(1);
  sig.curated = { "2604.0001": "owner/repo" };
  vi.spyOn(githubApi, "fetchRepoStars").mockRejectedValue(new Error("boom"));
  await sig.enrichBatch([mkPaper("2604.0001")]);
  expect(sig.runFailures.length).toBe(1);
  expect(sig.runFailures[0]).toContain("1 lookup(s) raised");
});

it("test_clean_run_leaves_the_channel_empty_after_a_degraded_one", async () => {
  const sig = newSignal(1);
  sig.curated = { "2604.0001": "owner/repo" };
  vi.spyOn(githubApi, "fetchRepoStars").mockRejectedValueOnce(new GitHubUnavailableError("down"));
  await sig.enrichBatch([mkPaper("2604.0001")]);
  expect(sig.runFailures.length).toBeGreaterThan(0);

  vi.spyOn(githubApi, "fetchRepoStars").mockResolvedValue(120);
  const out = await sig.enrichBatch([mkPaper("2604.0001")]);
  expect(sig.runFailures).toEqual([]);
  expect(out[0]?.githubStars).toBe(120);
});

// ---------- lookup budget ----------

it("test_budget_exhaustion_is_recorded_as_one_aggregated_entry", async () => {
  const sig = newSignal(1);
  sig.curated = {
    "2604.0001": "owner/repo1",
    "2604.0002": "owner/repo2",
    "2604.0003": "owner/repo3",
  };
  vi.spyOn(githubApi, "fetchRepoStars").mockResolvedValue(100);
  const papers = [
    mkPaper("2604.0001", "T", "1"),
    mkPaper("2604.0002", "T", "2"),
    mkPaper("2604.0003", "T", "3"),
  ];

  const out = await sig.enrichBatch(papers);
  expect(sig.runFailures).toEqual(["budget exhausted after 1 lookups, 2 papers unqueried"]);
  expect(out[0]?.githubScore).toBeGreaterThan(0.0);
  expect(out[1]?.githubScore).toBe(0.0);
  expect(out[2]?.githubScore).toBe(0.0);
});

it("test_budget_entry_and_lookup_failures_are_reported_separately", async () => {
  const sig = newSignal(1);
  sig.curated = {};
  vi.spyOn(githubApi, "searchRepoByTitle").mockRejectedValue(
    new GitHubUnavailableError("github repo search failed (status=403)"),
  );
  await sig.enrichBatch([mkPaper("2604.0001", "T", "1"), mkPaper("2604.0002", "T", "2")]);
  expect(sig.runFailures.length).toBe(2);
  expect(sig.runFailures[0]).toContain("1 lookup(s) unavailable");
  expect(sig.runFailures[1]).toBe("budget exhausted after 1 lookups, 1 papers unqueried");
});

it("test_papers_without_an_arxiv_id_are_not_counted_as_unqueried", async () => {
  const sig = newSignal(1);
  sig.curated = { "2604.0001": "owner/repo" };
  vi.spyOn(githubApi, "fetchRepoStars").mockResolvedValue(100);
  const noId = createPaper({
    title: "T no id",
    authors: ["A"],
    abstract: "abs",
    url: "http://x/no-id",
    publishedDate: "2026-01-01",
    source: "openalex",
  });
  await sig.enrichBatch([mkPaper("2604.0001"), noId]);
  expect(sig.runFailures).toEqual([]);
});

// ---------- enrichOneAsync ----------

it("test_enrich_one_no_arxiv_id_noop", async () => {
  const sig = newSignal();
  const searchSpy = vi.spyOn(githubApi, "searchRepoByTitle");
  const paper = mkPaper(null);
  await sig.enrichOneAsync(paper);
  expect(searchSpy).not.toHaveBeenCalled();
  expect(paper.githubUrl).toBeNull();
  expect(paper.hasCode).toBe(false);
});

it("test_enrich_one_curated_hit_marks_official", async () => {
  const paper = mkPaper("1706.03762", "Attention Is All You Need");
  const sig = newSignal();
  sig.curated = { "1706.03762": "tensorflow/tensor2tensor" };
  const fetchSpy = vi.spyOn(githubApi, "fetchRepoStars").mockResolvedValue(42_000);
  const searchSpy = vi.spyOn(githubApi, "searchRepoByTitle");
  await sig.enrichOneAsync(paper);
  expect(searchSpy).not.toHaveBeenCalled();
  expect(fetchSpy).toHaveBeenCalledWith(
    "tensorflow/tensor2tensor",
    { githubToken: null },
    expect.anything(),
  );
  expect(paper.githubUrl).toBe("https://github.com/tensorflow/tensor2tensor");
  expect(paper.githubStars).toBe(42_000);
  expect(paper.hasCode).toBe(true);
  expect(paper.isOfficialRepo).toBe(true);
  expect(paper.githubScore).toBeGreaterThan(0);
});

it("test_enrich_one_search_fallback_marks_non_official", async () => {
  const paper = mkPaper("9999.99", "A Paper Not In The Curated Map");
  const sig = newSignal();
  sig.curated = {};
  vi.spyOn(githubApi, "searchRepoByTitle").mockResolvedValue("someone/their-repo");
  vi.spyOn(githubApi, "fetchRepoStars").mockResolvedValue(123);
  await sig.enrichOneAsync(paper);
  expect(paper.githubUrl).toBe("https://github.com/someone/their-repo");
  expect(paper.githubStars).toBe(123);
  expect(paper.isOfficialRepo).toBe(false);
  expect(paper.hasCode).toBe(true);
});

it("test_enrich_one_search_miss_keeps_unenriched", async () => {
  const paper = mkPaper("9999.99", "A Paper");
  const sig = newSignal();
  sig.curated = {};
  vi.spyOn(githubApi, "searchRepoByTitle").mockResolvedValue(null);
  const fetchSpy = vi.spyOn(githubApi, "fetchRepoStars");
  await sig.enrichOneAsync(paper);
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(paper.githubUrl).toBeNull();
  expect(paper.hasCode).toBe(false);
});

it("test_enrich_one_zero_stars_keeps_unenriched", async () => {
  const paper = mkPaper("9999.99", "A Paper");
  const sig = newSignal();
  sig.curated = { "9999.99": "owner/empty-repo" };
  vi.spyOn(githubApi, "fetchRepoStars").mockResolvedValue(0);
  await sig.enrichOneAsync(paper);
  expect(paper.githubUrl).toBeNull();
  expect(paper.hasCode).toBe(false);
});

it("test_enrich_one_fetch_failure_keeps_unenriched", async () => {
  const paper = mkPaper("9999.99", "A Paper");
  const sig = newSignal();
  sig.curated = { "9999.99": "owner/repo" };
  vi.spyOn(githubApi, "fetchRepoStars").mockResolvedValue(null);
  await sig.enrichOneAsync(paper);
  expect(paper.githubUrl).toBeNull();
});

it("test_enrich_one_swallows_exceptions", async () => {
  const paper = mkPaper("2604.001");
  const sig = newSignal();
  sig.curated = { "2604.001": "owner/repo" };
  vi.spyOn(githubApi, "fetchRepoStars").mockRejectedValue(new Error("network down"));
  await sig.enrichOneAsync(paper);
  expect(paper.githubUrl).toBeNull();
});

// ---------- enrichBatch ----------

it("test_enrich_batch_respects_max_lookups", async () => {
  const papers = Array.from({ length: 5 }, (_, i) =>
    mkPaper(`2604.00${i}`, `Paper ${i}`, String(i)),
  );
  papers.forEach((p, i) => {
    p.keywordScore = i * 10;
  });
  const sig = newSignal(2);
  sig.curated = {};
  const lookedUp: string[] = [];
  vi.spyOn(githubApi, "searchRepoByTitle").mockImplementation(async (title) => {
    lookedUp.push(title);
    return null;
  });
  await sig.enrichBatch(papers);
  expect(lookedUp.length).toBe(2);
  expect(lookedUp).toContain("Paper 4");
  expect(lookedUp).toContain("Paper 3");
});

it("test_enrich_batch_skips_papers_without_arxiv_id_for_free", async () => {
  const papers = [
    mkPaper(null, "T", "0"),
    mkPaper("2604.001", "T", "1"),
    mkPaper("2604.002", "T", "2"),
  ];
  const sig = newSignal(2);
  sig.curated = {};
  const lookedUp: string[] = [];
  vi.spyOn(githubApi, "searchRepoByTitle").mockImplementation(async (title) => {
    lookedUp.push(title);
    return null;
  });
  await sig.enrichBatch(papers);
  expect(lookedUp.length).toBe(2);
});

// ---------- token plumbing ----------

it("test_github_token_passed_to_resolvers", async () => {
  const paper = mkPaper("2604.001", "A Paper Title");
  const sig = newSignal(50, "ghp_xyz");
  sig.curated = {};
  const searchSpy = vi.spyOn(githubApi, "searchRepoByTitle").mockResolvedValue("owner/repo");
  const fetchSpy = vi.spyOn(githubApi, "fetchRepoStars").mockResolvedValue(10);
  await sig.enrichOneAsync(paper);
  expect(searchSpy).toHaveBeenCalledWith(
    "A Paper Title",
    { githubToken: "ghp_xyz" },
    expect.anything(),
  );
  expect(fetchSpy).toHaveBeenCalledWith(
    "owner/repo",
    { githubToken: "ghp_xyz" },
    expect.anything(),
  );
});
