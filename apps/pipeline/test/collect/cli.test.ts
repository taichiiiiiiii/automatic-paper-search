/**
 * Port of `paperpilot/tests/test_collector_cli.py`.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  type CliDeps,
  main,
  type RunnerLike,
  type RunnerRunResult,
} from "../../src/collect/cli.js";
import type { Config } from "../../src/collect/config/types.js";
import type { Logger } from "../../src/collect/logger.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cli-test-"));
});

function writeConfig(): string {
  const path = join(dir, "config.yaml");
  writeFileSync(
    path,
    "search:\n" +
      "  keywords: [rag]\n" +
      "  days_back: 7\n" +
      "incremental:\n" +
      "  enabled: true\n" +
      "  seen_ids_file: seen.json\n" +
      "llm:\n" +
      "  enabled: true\n" +
      "  provider: ollama\n" +
      "logging:\n" +
      "  level: INFO\n",
  );
  return path;
}

function fakeResult(overrides: Partial<RunnerRunResult> = {}): RunnerRunResult {
  return {
    outputCount: 0,
    outputFiles: [],
    stageCounts: {},
    durationSeconds: 0.1,
    sourcesStatus: {},
    errors: [],
    truncatedWindows: {},
    ...overrides,
  };
}

function noopLogger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

async function runMain(
  argv: string[],
  options: { result?: RunnerRunResult; llmProvider?: RunnerLike["llmProvider"] } = {},
): Promise<{ rc: number; stdout: string[]; builtConfigs: Config[]; logger: Logger }> {
  const builtConfigs: Config[] = [];
  const stdout: string[] = [];
  const result = options.result ?? fakeResult({ outputCount: 3, outputFiles: ["x.csv"] });
  const createRunner = (config: Config): RunnerLike => {
    builtConfigs.push(config);
    return {
      llmProvider: options.llmProvider,
      run: async () => result,
    };
  };
  const deps: CliDeps = {
    createRunner,
    logger: noopLogger(),
    stdout: (line) => stdout.push(line),
  };
  const rc = await main(argv, deps);
  return { rc, stdout, builtConfigs, logger: deps.logger };
}

it("test_cli_days_override", async () => {
  const configPath = writeConfig();
  const { rc, builtConfigs } = await runMain(["--config", configPath, "--days", "3"]);
  expect(rc).toBe(0);
  expect(builtConfigs.length).toBe(1);
  expect(builtConfigs[0]?.search?.days_back).toBe(3);
});

// M3 of the P4 review: the shared parser's unique-prefix abbreviation
// (argparse's `allow_abbrev=True` default) — `--fail-on-error` is a
// prefix of only `--fail-on-errors`, so it must resolve the same way the
// fully-spelled flag does.
it("--fail-on-error (unambiguous prefix) resolves to --fail-on-errors", async () => {
  const configPath = writeConfig();
  const { rc, builtConfigs } = await runMain(["--config", configPath, "--fail-on-error"], {
    result: fakeResult({ sourcesStatus: { arxiv: { ok: false, count: 0, error: "boom" } } }),
  });
  expect(builtConfigs.length).toBe(1);
  expect(rc).toBe(1); // failureExitCode path only runs when --fail-on-errors was actually set
});

// M3: `--days` is `type=int` in collector.py; a non-numeric value must
// exit 2 (CliUsageError), not silently become NaN the way the old
// `Number(argv[++i])` did.
it("--days x (non-integer) exits 2 without building a config/runner", async () => {
  const configPath = writeConfig();
  const { rc, builtConfigs } = await runMain(["--config", configPath, "--days", "x"]);
  expect(rc).toBe(2);
  expect(builtConfigs.length).toBe(0);
});

it("test_cli_keyword_append", async () => {
  const configPath = writeConfig();
  const { builtConfigs } = await runMain([
    "--config",
    configPath,
    "--keyword",
    "llm",
    "--keyword",
    "moe",
  ]);
  expect(builtConfigs[0]?.search?.keywords).toEqual(["rag", "llm", "moe"]);
});

it("test_cli_full_disables_incremental", async () => {
  const configPath = writeConfig();
  const { builtConfigs } = await runMain(["--config", configPath, "--full"]);
  expect(builtConfigs[0]?.incremental?.enabled).toBe(false);
});

it("test_cli_skip_llm_disables_stage4", async () => {
  const configPath = writeConfig();
  const { builtConfigs } = await runMain(["--config", configPath, "--skip-llm"]);
  expect(builtConfigs[0]?.llm?.enabled).toBe(false);
});

it("test_cli_defaults_no_overrides", async () => {
  const configPath = writeConfig();
  const { builtConfigs } = await runMain(["--config", configPath]);
  expect(builtConfigs[0]?.search?.days_back).toBe(7);
  expect(builtConfigs[0]?.search?.keywords).toEqual(["rag"]);
  expect(builtConfigs[0]?.incremental?.enabled).toBe(true);
  expect(builtConfigs[0]?.llm?.enabled).toBe(true);
});

it("test_expand_keywords_write_excludes_env_secrets", async () => {
  process.env.PAPERPILOT_SLACK_WEBHOOK_URL =
    "https://hooks.slack.com/services/T000/B000/SUPERSECRETTOKEN";
  process.env.PAPERPILOT_GITHUB_TOKEN = "ghp_supersecrettoken1234567890";
  const configPath = writeConfig();

  const rc = await main(["--config", configPath, "expand-keywords", "--write"], {
    createRunner: () => ({
      llmProvider: {
        name: "fake",
        enabled: true,
        batchSize: 1,
        evaluateBatch: async () => [],
        chat: async () => null,
        classifyRelation: async () => null,
        completeJson: async () => {
          throw new Error("fake provider has no JSON-mode completion");
        },
      },
      run: async () => fakeResult(),
    }),
    logger: noopLogger(),
    expandKeywordsFn: async () => ["rag", "retrieval augmented generation"],
    stdout: () => {},
  });

  delete process.env.PAPERPILOT_SLACK_WEBHOOK_URL;
  delete process.env.PAPERPILOT_GITHUB_TOKEN;

  expect(rc).toBe(0);
  const writtenText = readFileSync(configPath, "utf-8");
  expect(writtenText).not.toContain("SUPERSECRETTOKEN");
  expect(writtenText).not.toContain("ghp_supersecrettoken");
  expect(writtenText).not.toContain("hooks.slack.com");

  const writtenConfig = parseYaml(writtenText) as Config;
  expect(writtenConfig.env).toBeUndefined();
  expect(writtenConfig.search?.keywords).toEqual(["rag", "retrieval augmented generation"]);
});

// ---- --fail-on-errors: a degraded CI run must not read as success ----

function degraded(): RunnerRunResult {
  return fakeResult({
    outputCount: 0,
    sourcesStatus: { s2: { ok: false, count: 0, error: "429" } },
    errors: ["source:s2:429"],
  });
}

it("test_fail_on_errors_is_off_by_default", async () => {
  const configPath = writeConfig();
  const { rc } = await runMain(["--config", configPath], { result: degraded() });
  expect(rc).toBe(0);
});

it("test_fail_on_errors_exits_non_zero_when_a_source_failed", async () => {
  const configPath = writeConfig();
  const { rc } = await runMain(["--config", configPath, "--fail-on-errors"], {
    result: degraded(),
  });
  expect(rc).not.toBe(0);
});

it("test_fail_on_errors_exits_non_zero_when_every_source_failed", async () => {
  const configPath = writeConfig();
  const result = fakeResult({
    outputCount: 0,
    sourcesStatus: {
      arxiv: { ok: false, count: 0, error: "timeout" },
      s2: { ok: false, count: 0, error: "429" },
    },
  });
  const { rc } = await runMain(["--config", configPath, "--fail-on-errors"], { result });
  expect(rc).not.toBe(0);
});

it("test_fail_on_errors_exits_non_zero_when_an_exporter_failed", async () => {
  const configPath = writeConfig();
  const result = fakeResult({
    outputCount: 3,
    outputFiles: ["x.csv"],
    sourcesStatus: { arxiv: { ok: true, count: 3, error: null } },
    errors: ["export:slack:webhook 500"],
  });
  const { rc } = await runMain(["--config", configPath, "--fail-on-errors"], { result });
  expect(rc).not.toBe(0);
});

it("test_fail_on_errors_leaves_a_clean_run_green", async () => {
  const configPath = writeConfig();
  const result = fakeResult({
    outputCount: 3,
    outputFiles: ["x.csv"],
    sourcesStatus: { arxiv: { ok: true, count: 3, error: null } },
  });
  const { rc } = await runMain(["--config", configPath, "--fail-on-errors"], { result });
  expect(rc).toBe(0);
});

it("test_fail_on_errors_ignores_stage_quality_errors", async () => {
  const configPath = writeConfig();
  const result = fakeResult({
    outputCount: 3,
    outputFiles: ["x.csv"],
    sourcesStatus: { arxiv: { ok: true, count: 3, error: null } },
    errors: ["stage4:llm timeout"],
  });
  const { rc } = await runMain(["--config", configPath, "--fail-on-errors"], { result });
  expect(rc).toBe(0);
});

it("test_fail_on_errors_ignores_degraded_signals", async () => {
  const configPath = writeConfig();
  const result = fakeResult({
    outputCount: 3,
    outputFiles: ["x.csv"],
    sourcesStatus: { arxiv: { ok: true, count: 3, error: null } },
    errors: ["signal:author: batch returned 1 of 1 entries without a usable authorId"],
  });
  const { rc } = await runMain(["--config", configPath, "--fail-on-errors"], { result });
  expect(rc).toBe(0);
});

it("test_fail_on_errors_exits_non_zero_when_no_source_ran", async () => {
  const configPath = writeConfig();
  const result = fakeResult({ outputCount: 0 });
  expect(result.sourcesStatus).toEqual({});
  const { rc } = await runMain(["--config", configPath, "--fail-on-errors"], { result });
  expect(rc).not.toBe(0);
});

it("test_fail_on_errors_exits_non_zero_for_an_incomplete_keyword", async () => {
  const configPath = writeConfig();
  const result = fakeResult({
    outputCount: 12,
    outputFiles: ["x.csv"],
    sourcesStatus: { arxiv: { ok: true, count: 12, error: null } },
    errors: [
      "source:arxiv: incomplete keyword 'large language model' (1 malformed feed page(s), first: Malformed feed)",
    ],
  });
  const { rc } = await runMain(["--config", configPath, "--fail-on-errors"], { result });
  expect(rc).not.toBe(0);
});

it("test_fail_on_errors_exits_non_zero_for_a_quarantined_state_file", async () => {
  const configPath = writeConfig();
  const result = fakeResult({
    outputCount: 12,
    outputFiles: ["x.csv"],
    sourcesStatus: { arxiv: { ok: true, count: 12, error: null } },
    errors: [
      "state:seen_ids: unreadable file quarantined to /data/seen_ids.json.corrupt-20261003T010203; backlog may be re-delivered",
    ],
  });
  const { rc } = await runMain(["--config", configPath, "--fail-on-errors"], { result });
  expect(rc).not.toBe(0);
});

it("test_truncated_fetch_windows_are_reported_in_the_run_summary", async () => {
  const configPath = writeConfig();
  const result = fakeResult({
    outputCount: 30,
    sourcesStatus: { arxiv: { ok: true, count: 30, error: null } },
    truncatedWindows: { arxiv: ["large language model", "moe"], s2: ["rag"] },
  });
  const warnings: string[] = [];
  const createRunner = (): RunnerLike => ({ run: async () => result });
  const rc = await main(["--config", configPath, "--fail-on-errors"], {
    createRunner,
    logger: { debug: () => {}, info: () => {}, warn: (m) => warnings.push(m), error: () => {} },
    stdout: (line) => warnings.push(line),
  });

  const out = warnings.join("\n");
  expect(rc).toBe(0);
  expect(out).toContain("truncated fetch windows");
  expect(out).toContain("arxiv:large language model");
  expect(out).toContain("arxiv:moe");
  expect(out).toContain("s2:rag");
});
