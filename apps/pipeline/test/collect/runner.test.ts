/**
 * Port of `paperpilot/tests/test_runner.py`.
 *
 * Mirrors the Python tests' approach of patching `runner.sources[0].afetch`
 * directly rather than hitting any real network: here `vi.spyOn(entry.
 * source, "fetch")` replaces the whole `Source.fetch()` (part-1's
 * `FetchResult`-returning contract) the same way.
 *
 * `test_build_llm_provider_ollama/gemini/groq/claude` ARE now ported
 * (#26/#29 of docs/migration/p4-followups.md wired the real factory) —
 * see the "real LLM provider construction" block near the bottom of this
 * file. `test_build_llm_provider_unknown_returns_none` and
 * `_disabled_returns_none` need no factory at all (both pre-date #26) and
 * are unchanged.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Config } from "../../src/collect/config/types.js";
import type { HttpResponseLike } from "../../src/collect/http/requestWithRetry.js";
import { createPaper, type Paper } from "../../src/collect/model/paper.js";
import { PipelineRunner, type RunnerDeps } from "../../src/collect/runner.js";
import { buildLlmProviderFromConfig } from "../../src/collect/runtime/llmProvider.js";
import { ClaudeProvider } from "../../src/lineage/llm/claude.js";
import { GeminiProvider } from "../../src/lineage/llm/gemini.js";
import { GroqProvider } from "../../src/lineage/llm/groq.js";
import { OllamaProvider } from "../../src/lineage/llm/ollama.js";

const NOW = new Date("2026-04-10T09:00:00");

function fakeArxivPapers(): Paper[] {
  return [1, 2, 3].map((i) =>
    createPaper({
      title: `Paper about retrieval augmented generation ${i}`,
      authors: ["Author"],
      abstract: "LLM abstract",
      url: `http://arxiv.org/abs/2604.000${i}`,
      publishedDate: new Date(NOW.getTime() - i * 86_400_000).toISOString().slice(0, 10),
      source: "arxiv",
      arxivId: `2604.000${i}`,
      categories: ["cs.CL"],
      comment: i === 1 ? "Accepted at ICLR 2026" : null,
    }),
  );
}

let dir: string;
let warnings: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "runner-test-"));
  warnings = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

function buildConfig(overrides: Partial<Config> = {}): Config {
  return {
    search: {
      keywords: ["retrieval augmented generation"],
      categories: ["cs.CL"],
      days_back: 7,
      max_results_per_keyword: 10,
      exclude_words: [],
    },
    sources: { arxiv: { enabled: true, delay_seconds: 0 } },
    signals: { venue: { enabled: true } },
    weights: { venue: 3.0, keyword: 0.5 },
    pipeline: { stage2_top_n: 5 },
    output: {
      csv: { enabled: true, dir, encoding: "utf-8" },
      json: { enabled: true, dir },
    },
    incremental: { enabled: true, seen_ids_file: join(dir, "seen_ids.json"), max_age_days: 14 },
    env: {
      githubToken: null,
      s2ApiKey: null,
      openalexEmail: null,
      slackWebhookUrl: null,
      geminiApiKey: null,
      claudeApiKey: null,
      groqApiKey: null,
      groqModel: null,
      geminiModel: null,
      smtp: { server: null, port: 587, user: null, password: null, to: null, useTls: true },
    },
    ...overrides,
  } as Config;
}

function buildRunner(config: Config, overrides: Partial<RunnerDeps> = {}): PipelineRunner {
  const deps: RunnerDeps = {
    arxivFetchText: async () => ({ status: 200, text: async () => "" }),
    fetchImpl: async (): Promise<HttpResponseLike> => ({ status: 200, json: async () => ({}) }),
    emailTransport: {
      connect: async () => ({
        starttls: async () => {},
        login: async () => {},
        sendMessage: async () => {},
        quit: async () => {},
      }),
    },
    sleep: async () => {},
    clock: () => NOW,
    logger: {
      debug: () => {},
      info: () => {},
      warn: (m) => warnings.push(m),
      error: (m) => warnings.push(m),
    },
    ...overrides,
  };
  return new PipelineRunner(config, deps);
}

function lastHistoryRecord(historyPath: string): Record<string, unknown> {
  const lines = readFileSync(historyPath, "utf-8").trim().split("\n");
  return JSON.parse(lines[lines.length - 1] as string);
}

it("test_runner_end_to_end_with_mocked_arxiv", async () => {
  const config = buildConfig();
  const runner = buildRunner(config);
  const papers = fakeArxivPapers();
  vi.spyOn(runner.sources[0]?.source as never, "fetch").mockResolvedValue({
    papers,
    truncatedKeywords: [],
    degradedKeywords: [],
  });

  const result = await runner.run();

  expect(result.outputCount).toBe(3);
  expect(result.stageCounts.stage0_collected).toBe(3);
  expect(result.stageCounts.stage1_filtered).toBe(3);
  expect(result.stageCounts.stage2_scored).toBe(3);
  expect(result.sourcesStatus.arxiv?.ok).toBe(true);
  expect(result.errors).toEqual([]);

  expect(result.outputFiles.length).toBeGreaterThan(0);
  expect(readFileSync(join(dir, "seen_ids.json"), "utf-8")).toBeDefined();
  expect(readFileSync(join(dir, "run_history.jsonl"), "utf-8")).toBeDefined();
});

it("test_runner_incremental_second_run_filters_seen", async () => {
  const config = buildConfig();
  const papers = fakeArxivPapers();

  const runner1 = buildRunner(config);
  vi.spyOn(runner1.sources[0]?.source as never, "fetch").mockResolvedValue({
    papers,
    truncatedKeywords: [],
    degradedKeywords: [],
  });
  const first = await runner1.run();

  const seen = JSON.parse(readFileSync(join(dir, "seen_ids.json"), "utf-8"));
  expect(Object.keys(seen).length).toBe(3);
  expect(new Set(Object.keys(seen))).toEqual(new Set([1, 2, 3].map((i) => `arxiv:2604.000${i}`)));

  const runner2 = buildRunner(config);
  vi.spyOn(runner2.sources[0]?.source as never, "fetch").mockResolvedValue({
    papers,
    truncatedKeywords: [],
    degradedKeywords: [],
  });
  const second = await runner2.run();

  expect(first.outputCount).toBe(3);
  expect(second.outputCount).toBe(0);
});

it("test_runner_handles_source_failure", async () => {
  const config = buildConfig();
  const runner = buildRunner(config);
  vi.spyOn(runner.sources[0]?.source as never, "fetch").mockRejectedValue(
    new Error("network down"),
  );

  const result = await runner.run();

  expect(result.outputCount).toBe(0);
  expect(result.sourcesStatus.arxiv?.ok).toBe(false);
  expect(result.errors.some((e) => e.includes("network down"))).toBe(true);
});

it("test_runner_records_exporter_failure_in_errors", async () => {
  const config = buildConfig({
    output: {
      csv: { enabled: true, dir, encoding: "utf-8" },
      json: { enabled: true, dir },
      slack: { enabled: true, max_items: 10 },
    },
  });
  config.env.slackWebhookUrl = "https://hooks.slack.com/services/T/B/X";
  const runner = buildRunner(config, {
    fetchImpl: async () => ({ status: 500, json: async () => ({}) }),
  });
  vi.spyOn(runner.sources[0]?.source as never, "fetch").mockResolvedValue({
    papers: fakeArxivPapers(),
    truncatedKeywords: [],
    degradedKeywords: [],
  });

  const result = await runner.run();

  expect(result.errors.some((e) => e.includes("export:slack"))).toBe(true);
  expect(result.outputCount).toBe(3);
  expect(result.outputFiles.some((f) => f.endsWith(".csv"))).toBe(true);
});

it("test_runner_reports_degraded_signal_in_errors_and_history", async () => {
  const config = buildConfig({
    signals: { venue: { enabled: true }, citation: { enabled: true } },
    weights: { venue: 3.0, keyword: 0.5, citation: 1.0 },
  });
  const runner = buildRunner(config, {
    fetchImpl: async () => {
      throw new Error("down");
    },
  });
  vi.spyOn(runner.sources[0]?.source as never, "fetch").mockResolvedValue({
    papers: fakeArxivPapers(),
    truncatedKeywords: [],
    degradedKeywords: [],
  });

  const result = await runner.run();

  expect(result.outputCount).toBe(3);
  expect(result.errors.length).toBe(1);
  expect(result.errors[0]?.startsWith("signal:citation:")).toBe(true);
  expect(result.errors[0]).toContain("n=3");
  expect(result.degradedSignals).toEqual(["citation"]);

  const record = lastHistoryRecord(join(dir, "run_history.jsonl"));
  expect(record.degraded_signals).toEqual(["citation"]);
  expect(record.errors).toEqual(result.errors);
  expect("finished_at" in record && "sources_status" in record && "errors" in record).toBe(true);
});

it("test_runner_keeps_a_healthy_run_free_of_signal_degradation", async () => {
  const config = buildConfig({
    signals: { venue: { enabled: true }, citation: { enabled: true } },
  });
  const payload = [0, 1, 2].map((i) => ({
    paperId: `p${i}`,
    citationCount: 0,
    influentialCitationCount: 0,
    publicationDate: NOW.toISOString().slice(0, 10),
    authors: [],
    venue: null,
  }));
  const runner = buildRunner(config, {
    fetchImpl: async () => ({ status: 200, json: async () => payload }),
  });
  vi.spyOn(runner.sources[0]?.source as never, "fetch").mockResolvedValue({
    papers: fakeArxivPapers(),
    truncatedKeywords: [],
    degradedKeywords: [],
  });

  const result = await runner.run();

  expect(result.errors).toEqual([]);
  expect(result.degradedSignals).toEqual([]);
  expect(lastHistoryRecord(join(dir, "run_history.jsonl")).degraded_signals).toEqual([]);
});

it("test_runner_warns_and_records_a_truncated_delivery", async () => {
  const config = buildConfig({
    output: {
      csv: { enabled: true, dir, encoding: "utf-8" },
      json: { enabled: true, dir },
      slack: { enabled: true, max_items: 1 },
    },
  });
  config.env.slackWebhookUrl = "https://hooks.slack.com/services/T/B/X";
  const runner = buildRunner(config, {
    fetchImpl: async () => ({ status: 200, json: async () => ({}) }),
  });
  vi.spyOn(runner.sources[0]?.source as never, "fetch").mockResolvedValue({
    papers: fakeArxivPapers(),
    truncatedKeywords: [],
    degradedKeywords: [],
  });

  const result = await runner.run();

  expect(result.truncatedDeliveries).toEqual([{ exporter: "slack", delivered: 1, given: 3 }]);
  expect(warnings.some((w) => w.includes("exporter 'slack' delivered 1 of 3"))).toBe(true);
  expect(lastHistoryRecord(join(dir, "run_history.jsonl")).truncated_deliveries).toEqual([
    { exporter: "slack", delivered: 1, given: 3 },
  ]);
  expect(result.errors).toEqual([]);
  const seen = JSON.parse(readFileSync(join(dir, "seen_ids.json"), "utf-8"));
  expect(Object.keys(seen).length).toBe(3);
});

it("test_runner_does_not_report_a_full_notification_as_truncated", async () => {
  const config = buildConfig({
    output: {
      csv: { enabled: true, dir, encoding: "utf-8" },
      json: { enabled: true, dir },
      slack: { enabled: true, max_items: 10 },
    },
  });
  config.env.slackWebhookUrl = "https://hooks.slack.com/services/T/B/X";
  const runner = buildRunner(config, {
    fetchImpl: async () => ({ status: 200, json: async () => ({}) }),
  });
  vi.spyOn(runner.sources[0]?.source as never, "fetch").mockResolvedValue({
    papers: fakeArxivPapers(),
    truncatedKeywords: [],
    degradedKeywords: [],
  });

  const result = await runner.run();

  expect(result.truncatedDeliveries).toEqual([]);
  expect(result.errors).toEqual([]);
  expect(lastHistoryRecord(join(dir, "run_history.jsonl")).truncated_deliveries).toEqual([]);
  expect(result.truncatedWindows).toEqual({});
  expect(lastHistoryRecord(join(dir, "run_history.jsonl")).truncated_windows).toEqual({});
});

it("test_runner_skips_seen_ids_when_all_exporters_fail", async () => {
  const config = buildConfig();
  const runner = buildRunner(config);
  vi.spyOn(runner.sources[0]?.source as never, "fetch").mockResolvedValue({
    papers: fakeArxivPapers(),
    truncatedKeywords: [],
    degradedKeywords: [],
  });
  for (const exp of runner.exporters) {
    exp.export = async () => {
      throw new Error(`${exp.name} boom`);
    };
  }

  const result = await runner.run();

  expect(result.outputCount).toBe(3);
  expect(result.errors.some((e) => e.includes("boom"))).toBe(true);
  const seenPath = join(dir, "seen_ids.json");
  if (existsSync(seenPath)) {
    expect(JSON.parse(readFileSync(seenPath, "utf-8"))).toEqual({});
  }

  const runner2 = buildRunner(buildConfig());
  vi.spyOn(runner2.sources[0]?.source as never, "fetch").mockResolvedValue({
    papers: fakeArxivPapers(),
    truncatedKeywords: [],
    degradedKeywords: [],
  });
  const second = await runner2.run();
  expect(second.outputCount).toBe(3);
});

it("test_runner_marks_seen_when_at_least_one_exporter_succeeds", async () => {
  const config = buildConfig();
  const runner = buildRunner(config);
  vi.spyOn(runner.sources[0]?.source as never, "fetch").mockResolvedValue({
    papers: fakeArxivPapers(),
    truncatedKeywords: [],
    degradedKeywords: [],
  });
  const failingExp = runner.exporters[0];
  if (failingExp) {
    failingExp.export = async () => {
      throw new Error("boom");
    };
  }

  const result = await runner.run();

  expect(result.outputCount).toBe(3);
  const seen = JSON.parse(readFileSync(join(dir, "seen_ids.json"), "utf-8"));
  expect(Object.keys(seen).length).toBe(3);
});

it("test_runner_skips_seen_ids_when_failures_and_no_delivery", async () => {
  const config = buildConfig();
  const runner = buildRunner(config);
  vi.spyOn(runner.sources[0]?.source as never, "fetch").mockResolvedValue({
    papers: fakeArxivPapers(),
    truncatedKeywords: [],
    degradedKeywords: [],
  });
  const [raisingExp, noopExp] = runner.exporters;
  if (raisingExp) {
    raisingExp.export = async () => {
      throw new Error("boom");
    };
  }
  if (noopExp) {
    noopExp.export = async () => null;
  }

  const result = await runner.run();

  expect(result.outputCount).toBe(3);
  expect(result.errors.some((e) => e.includes("boom"))).toBe(true);
  const seenPath = join(dir, "seen_ids.json");
  if (existsSync(seenPath)) {
    expect(JSON.parse(readFileSync(seenPath, "utf-8"))).toEqual({});
  }
});

it("test_runner_marks_seen_when_every_exporter_no_ops", async () => {
  const config = buildConfig();
  const runner = buildRunner(config);
  vi.spyOn(runner.sources[0]?.source as never, "fetch").mockResolvedValue({
    papers: fakeArxivPapers(),
    truncatedKeywords: [],
    degradedKeywords: [],
  });
  for (const exp of runner.exporters) exp.export = async () => null;

  const result = await runner.run();

  expect(result.outputCount).toBe(3);
  expect(result.errors).toEqual([]);
  const seen = JSON.parse(readFileSync(join(dir, "seen_ids.json"), "utf-8"));
  expect(Object.keys(seen).length).toBe(3);
});

it("test_runner_reports_an_incomplete_keyword_as_a_source_error", async () => {
  const config = buildConfig();
  const runner = buildRunner(config);
  vi.spyOn(runner.sources[0]?.source as never, "fetch").mockResolvedValue({
    papers: fakeArxivPapers(),
    truncatedKeywords: [],
    degradedKeywords: [["large language model", "1 malformed feed page(s), first: Malformed feed"]],
  });

  const result = await runner.run();

  expect(result.sourcesStatus.arxiv?.ok).toBe(true);
  expect(result.errors).toContain(
    "source:arxiv: incomplete keyword 'large language model' (1 malformed feed page(s), first: Malformed feed)",
  );
  expect(lastHistoryRecord(join(dir, "run_history.jsonl")).errors).toEqual(result.errors);
});

it("test_runner_names_the_source_of_every_incomplete_keyword", async () => {
  const config = buildConfig({
    sources: {
      arxiv: { enabled: true, delay_seconds: 0 },
      s2: { enabled: true, delay_seconds: 0 },
      openalex: { enabled: true, delay_seconds: 0 },
    },
  });
  const runner = buildRunner(config);
  const byName = new Map(runner.sources.map((e) => [e.source.name, e.source]));
  expect(new Set(byName.keys())).toEqual(new Set(["arxiv", "s2", "openalex"]));

  vi.spyOn(byName.get("arxiv") as never, "fetch").mockResolvedValue({
    papers: fakeArxivPapers(),
    truncatedKeywords: [],
    degradedKeywords: [],
  });
  vi.spyOn(byName.get("s2") as never, "fetch").mockResolvedValue({
    papers: fakeArxivPapers(),
    truncatedKeywords: [],
    degradedKeywords: [["moe", "RuntimeError: s2 search failed for 'moe' (status=429)"]],
  });
  vi.spyOn(byName.get("openalex") as never, "fetch").mockResolvedValue({
    papers: fakeArxivPapers(),
    truncatedKeywords: [],
    degradedKeywords: [
      ["rag", "RuntimeError: openalex search for 'rag' has no 'results' list (got NoneType)"],
    ],
  });

  const result = await runner.run();

  expect(result.sourcesStatus.s2?.ok).toBe(true);
  expect(result.sourcesStatus.openalex?.ok).toBe(true);
  expect(result.errors).toContain(
    "source:s2: incomplete keyword 'moe' (RuntimeError: s2 search failed for 'moe' (status=429))",
  );
  expect(result.errors).toContain(
    "source:openalex: incomplete keyword 'rag' (RuntimeError: openalex search for 'rag' has no 'results' list (got NoneType))",
  );
  expect(lastHistoryRecord(join(dir, "run_history.jsonl")).errors).toEqual(result.errors);
});

it("test_runner_records_truncated_windows_in_the_result_and_history", async () => {
  const config = buildConfig();
  const runner = buildRunner(config);
  vi.spyOn(runner.sources[0]?.source as never, "fetch").mockResolvedValue({
    papers: fakeArxivPapers(),
    truncatedKeywords: ["retrieval augmented generation"],
    degradedKeywords: [],
  });

  const result = await runner.run();

  expect(result.truncatedWindows).toEqual({ arxiv: ["retrieval augmented generation"] });
  expect(result.errors).toEqual([]);
  const record = lastHistoryRecord(join(dir, "run_history.jsonl"));
  expect(record.truncated_windows).toEqual({ arxiv: ["retrieval augmented generation"] });
  expect("finished_at" in record && "sources_status" in record && "errors" in record).toBe(true);
});

it("test_runner_does_not_report_incomplete_keywords_for_a_failed_source", async () => {
  const config = buildConfig();
  const runner = buildRunner(config);
  vi.spyOn(runner.sources[0]?.source as never, "fetch").mockRejectedValue(
    Object.assign(new Error("arxiv fetch failed for all 1 keyword(s)"), {}),
  );

  const result = await runner.run();

  expect(result.sourcesStatus.arxiv?.ok).toBe(false);
  expect(result.errors.filter((e) => e.includes("incomplete keyword"))).toEqual([]);
  expect(result.errors.some((e) => e.startsWith("source:arxiv:"))).toBe(true);
});

it("test_runner_reports_a_quarantined_seen_ids_file_as_a_state_error", async () => {
  const config = buildConfig();
  const seenPath = join(dir, "seen_ids.json");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(seenPath, '{"arxiv:2604.0001": "2026-01-01T00:00:00",');
  const runner = buildRunner(config);
  vi.spyOn(runner.sources[0]?.source as never, "fetch").mockResolvedValue({
    papers: fakeArxivPapers(),
    truncatedKeywords: [],
    degradedKeywords: [],
  });

  const result = await runner.run();

  const stateErrors = result.errors.filter((e) => e.startsWith("state:"));
  expect(stateErrors.length).toBe(1);
  expect(
    stateErrors[0]?.startsWith(
      `state:seen_ids: unreadable file quarantined to ${seenPath}.corrupt-`,
    ),
  ).toBe(true);
  expect(stateErrors[0]?.endsWith("; backlog may be re-delivered")).toBe(true);
  expect(result.outputCount).toBe(3);
  expect(lastHistoryRecord(join(dir, "run_history.jsonl")).errors).toEqual(result.errors);
});

it("reports a seen_ids quarantine that happens DURING the merge (not just the early read) as a state:seen_ids error (collect LOW)", async () => {
  // The file is READABLE (in fact missing) at the run's early `loadSeenIds`
  // call, so that one reports nothing. It only turns corrupt mid-run — as
  // a side effect of the Slack exporter's own network call, which runs
  // after Stage 1 but before the final `mergeSeenIds` — so only a caller
  // that forwards quarantine reporting INTO `mergeSeenIds` itself (not
  // just the early read) can ever see this one.
  const seenPath = join(dir, "seen_ids.json");
  const config = buildConfig({
    output: {
      csv: { enabled: true, dir, encoding: "utf-8" },
      json: { enabled: true, dir },
      slack: { enabled: true },
    },
    env: {
      githubToken: null,
      s2ApiKey: null,
      openalexEmail: null,
      slackWebhookUrl: "http://hook.example/webhook",
      geminiApiKey: null,
      claudeApiKey: null,
      groqApiKey: null,
      groqModel: null,
      geminiModel: null,
      smtp: { server: null, port: 587, user: null, password: null, to: null, useTls: true },
    },
  });
  let slackPosted = false;
  const runner = buildRunner(config, {
    fetchImpl: async (url) => {
      if (String(url).includes("hook.example")) {
        slackPosted = true;
        writeFileSync(seenPath, "{ truncated-by-slack-side-effect");
      }
      return { status: 200, json: async () => ({}) };
    },
  });
  vi.spyOn(runner.sources[0]?.source as never, "fetch").mockResolvedValue({
    papers: fakeArxivPapers(),
    truncatedKeywords: [],
    degradedKeywords: [],
  });

  const result = await runner.run();

  expect(slackPosted).toBe(true);
  const stateErrors = result.errors.filter((e) => e.startsWith("state:"));
  expect(stateErrors.length).toBe(1);
  expect(stateErrors[0]).toContain("unreadable file quarantined to");
  expect(stateErrors[0]).toContain("backlog may be re-delivered");
});

it("test_runner_stays_green_when_the_seen_ids_file_is_readable", async () => {
  const config = buildConfig();
  const { writeFileSync } = await import("node:fs");
  writeFileSync(
    join(dir, "seen_ids.json"),
    `{"arxiv:9999.99999": "${NOW.toISOString().slice(0, 10)}"}`,
  );
  const runner = buildRunner(config);
  vi.spyOn(runner.sources[0]?.source as never, "fetch").mockResolvedValue({
    papers: fakeArxivPapers(),
    truncatedKeywords: [],
    degradedKeywords: [],
  });

  const result = await runner.run();

  expect(result.errors).toEqual([]);
});

it("test_runner_uses_its_own_run_history_file_when_configured", async () => {
  const historyPath = join(dir, "nested", "run_history.daily.jsonl");
  const config = buildConfig();
  config.incremental = { ...config.incremental, run_history_file: historyPath };
  const runner = buildRunner(config);
  vi.spyOn(runner.sources[0]?.source as never, "fetch").mockResolvedValue({
    papers: fakeArxivPapers(),
    truncatedKeywords: [],
    degradedKeywords: [],
  });

  await runner.run();

  const { existsSync } = await import("node:fs");
  expect(existsSync(historyPath)).toBe(true);
  expect(lastHistoryRecord(historyPath).errors).toEqual([]);
  expect(existsSync(join(dir, "run_history.jsonl"))).toBe(false);
});

it("test_build_llm_provider_ollama (runner wired through the real factory)", () => {
  const config = buildConfig({ llm: { enabled: true, provider: "ollama", model: "qwen2.5:7b" } });
  const runner = buildRunner(config, {
    llmProviderFactory: (llmCfg, env) =>
      buildLlmProviderFromConfig(llmCfg, env, {
        fetchImpl: async (): Promise<HttpResponseLike> => ({ status: 200, json: async () => ({}) }),
      }),
  });
  expect(runner.llmProvider).toBeInstanceOf(OllamaProvider);
});

it("test_build_llm_provider_gemini (runner wired through the real factory)", () => {
  const config = buildConfig({ llm: { enabled: true, provider: "gemini" } });
  config.env.geminiApiKey = "k";
  const runner = buildRunner(config, {
    llmProviderFactory: (llmCfg, env) =>
      buildLlmProviderFromConfig(llmCfg, env, {
        fetchImpl: async (): Promise<HttpResponseLike> => ({ status: 200, json: async () => ({}) }),
      }),
  });
  expect(runner.llmProvider).toBeInstanceOf(GeminiProvider);
  expect(runner.llmProvider?.enabled).toBe(true); // api key wired through
});

it("test_build_llm_provider_groq (runner wired through the real factory)", () => {
  const config = buildConfig({ llm: { enabled: true, provider: "groq" } });
  config.env.groqApiKey = "gsk_k";
  const runner = buildRunner(config, {
    llmProviderFactory: (llmCfg, env) =>
      buildLlmProviderFromConfig(llmCfg, env, {
        fetchImpl: async (): Promise<HttpResponseLike> => ({ status: 200, json: async () => ({}) }),
      }),
  });
  expect(runner.llmProvider).toBeInstanceOf(GroqProvider);
  expect(runner.llmProvider?.enabled).toBe(true);
});

it("test_build_llm_provider_claude (runner wired through the real factory)", () => {
  const config = buildConfig({ llm: { enabled: true, provider: "claude" } });
  config.env.claudeApiKey = "sk-ant-k";
  const runner = buildRunner(config, {
    llmProviderFactory: (llmCfg, env) =>
      buildLlmProviderFromConfig(llmCfg, env, {
        fetchImpl: async (): Promise<HttpResponseLike> => ({ status: 200, json: async () => ({}) }),
      }),
  });
  expect(runner.llmProvider).toBeInstanceOf(ClaudeProvider);
  expect(runner.llmProvider?.enabled).toBe(true);
});

it("test_build_llm_provider_unknown_returns_none", () => {
  const config = buildConfig({ llm: { enabled: true, provider: "bogus-vendor" } });
  const runner = buildRunner(config);
  expect(runner.llmProvider).toBeNull();
});

it("test_build_llm_provider_disabled_returns_none", () => {
  const config = buildConfig({ llm: { enabled: false, provider: "ollama" } });
  const runner = buildRunner(config);
  expect(runner.llmProvider).toBeNull();
});

it("records a stage4: error when llm.enabled but no usable provider was built (collect LOW)", async () => {
  // Previously: `buildLlmProvider` warned and returned null, but `run()`
  // only ever pushed a `stage4:` error from a THROWN exception inside
  // `llmRerank` — an `llm.enabled: true` misconfiguration (unknown
  // provider name, nothing injected) silently downgraded to "nobody asked
  // for Stage 4" with no entry in `errors`/run_history beyond the WARNING.
  const config = buildConfig({ llm: { enabled: true, provider: "bogus-vendor" } });
  const runner = buildRunner(config);
  expect(runner.llmProvider).toBeNull();
  vi.spyOn(runner.sources[0]?.source as never, "fetch").mockResolvedValue({
    papers: fakeArxivPapers(),
    truncatedKeywords: [],
    degradedKeywords: [],
  });

  const result = await runner.run();

  expect(result.errors.some((e) => e.startsWith("stage4:"))).toBe(true);
  expect(result.errors.find((e) => e.startsWith("stage4:"))).toContain("bogus-vendor");
  // Still Fail-Safe: the run completes and ships papers through unranked.
  expect(result.outputCount).toBeGreaterThan(0);
});

it("does NOT record a stage4: error when Stage 4 was simply never configured (no regression)", async () => {
  const config = buildConfig(); // no `llm` key at all
  const runner = buildRunner(config);
  expect(runner.llmProvider).toBeNull();
  vi.spyOn(runner.sources[0]?.source as never, "fetch").mockResolvedValue({
    papers: fakeArxivPapers(),
    truncatedKeywords: [],
    degradedKeywords: [],
  });

  const result = await runner.run();

  expect(result.errors.some((e) => e.startsWith("stage4:"))).toBe(false);
});

it("records a stage3: error when embedding.enabled but no usable encoder was built (collect LOW)", async () => {
  const config = buildConfig({ embedding: { enabled: true, backend: "bogus-backend" } });
  const runner = buildRunner(config);
  expect(runner.encoder).toBeNull();
  vi.spyOn(runner.sources[0]?.source as never, "fetch").mockResolvedValue({
    papers: fakeArxivPapers(),
    truncatedKeywords: [],
    degradedKeywords: [],
  });

  const result = await runner.run();

  expect(result.errors.some((e) => e.startsWith("stage3:"))).toBe(true);
  expect(result.errors.find((e) => e.startsWith("stage3:"))).toContain("bogus-backend");
});

it("test_build_signals_puts_keyword_before_github", () => {
  const config = buildConfig({ signals: { venue: { enabled: true }, github: { enabled: true } } });
  const runner = buildRunner(config);
  const names = runner.signals.map((s) => s.constructor.name);
  expect(names).toContain("KeywordSignal");
  expect(names).toContain("GitHubSignal");
  expect(names.indexOf("KeywordSignal")).toBeLessThan(names.indexOf("GitHubSignal"));
});

it("test_build_signals_citation_before_author", () => {
  const config = buildConfig({ signals: { citation: {}, author: {} } });
  const runner = buildRunner(config);
  const names = runner.signals.map((s) => s.constructor.name);
  expect(names.indexOf("CitationSignal")).toBeLessThan(names.indexOf("AuthorSignal"));
});
