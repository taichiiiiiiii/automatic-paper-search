/**
 * PaperPilot CLI entry point — TS port of `paperpilot/collector.py`
 * (COL-16, COL-18, COL-36..38 of docs/migration/safety-contracts.md).
 *
 * Usage:
 *   tsx cli.ts --config config.yaml
 *   tsx cli.ts --days 3 --keyword "diffusion model"
 *   tsx cli.ts --full
 *   tsx cli.ts --fail-on-errors
 *   tsx cli.ts expand-keywords --write
 *
 * `createRunner` (in {@link CliDeps}) is the real seam a production entry
 * point wires to an actual `PipelineRunner`; CLI tests inject a fake
 * (mirroring Python's `unittest.mock.patch.object(collector,
 * "PipelineRunner", _FakeRunner)`) so this module stays decoupled from
 * the runner's own (much larger) dependency graph.
 */

import { writeFileSync } from "node:fs";
import { stringify as stringifyYaml } from "yaml";
import { loadConfig } from "./config/load.js";
import type { Config } from "./config/types.js";
import { expandKeywords } from "./keywordExpand.js";
import type { LLMProvider } from "./llm/provider.js";
import type { Logger } from "./logger.js";

export interface RunnerRunResult {
  outputCount: number;
  outputFiles: string[];
  stageCounts: Record<string, number>;
  durationSeconds: number;
  sourcesStatus: Record<string, { ok: boolean; count: number; error: string | null }>;
  errors: string[];
  truncatedWindows: Record<string, string[]>;
}

export interface RunnerLike {
  llmProvider?: LLMProvider | null;
  run(): Promise<RunnerRunResult>;
}

export interface ParsedArgs {
  config: string;
  days?: number;
  keywords: string[];
  full: boolean;
  skipLlm: boolean;
  failOnErrors: boolean;
  command?: "expand-keywords";
  expandMax: number;
  expandWrite: boolean;
}

export function parseArgs(argv: readonly string[], defaultConfigPath: string): ParsedArgs {
  const args: ParsedArgs = {
    config: defaultConfigPath,
    keywords: [],
    full: false,
    skipLlm: false,
    failOnErrors: false,
    expandMax: 10,
    expandWrite: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    switch (tok) {
      case "--config":
        args.config = argv[++i] as string;
        break;
      case "--days":
        args.days = Number(argv[++i]);
        break;
      case "--keyword":
        args.keywords.push(argv[++i] as string);
        break;
      case "--full":
        args.full = true;
        break;
      case "--skip-llm":
        args.skipLlm = true;
        break;
      case "--fail-on-errors":
        args.failOnErrors = true;
        break;
      case "expand-keywords":
        args.command = "expand-keywords";
        break;
      case "--max":
        args.expandMax = Number(argv[++i]);
        break;
      case "--write":
        args.expandWrite = true;
        break;
      default:
        break;
    }
  }
  return args;
}

export interface CliDeps {
  createRunner: (config: Config) => RunnerLike;
  logger: Logger;
  defaultConfigPath?: string;
  stdout?: (line: string) => void;
  loadConfigFn?: (path: string) => Config;
  expandKeywordsFn?: typeof expandKeywords;
  writeFileFn?: (path: string, text: string) => void;
  stringifyYamlFn?: (obj: unknown) => string;
}

/**
 * Non-zero when the run was degraded, 0 when it was clean. Deliberately
 * fail-safe: a throttled source or a broken webhook already made the run
 * export what it had and exit 0 by default; this is the CI-only strictness
 * `--fail-on-errors` adds. `signal:`/`stage3:`/`stage4:` errors are
 * excluded on purpose (quality degradation, not delivery failure).
 */
export function failureExitCode(
  result: RunnerRunResult,
  logger: Logger,
  stdout: (line: string) => void,
): number {
  const failedSources = Object.entries(result.sourcesStatus)
    .filter(([, st]) => !st.ok)
    .map(([name]) => name);
  const deliveryErrors = result.errors.filter(
    (e) => e.startsWith("source:") || e.startsWith("export:") || e.startsWith("state:"),
  );
  const nothingRan = Object.keys(result.sourcesStatus).length === 0;
  if (!(failedSources.length > 0 || deliveryErrors.length > 0 || nothingRan)) return 0;

  const details: string[] = [];
  if (nothingRan) details.push("no enabled source ran (sources_status is empty)");
  if (failedSources.length > 0) details.push(`sources failed: ${failedSources.join(", ")}`);
  if (deliveryErrors.length > 0) details.push(`errors: ${deliveryErrors.join(", ")}`);
  logger.error(`❌ run reported failures: ${details.join("; ")}`);
  stdout(`❌ degraded run: ${details.join("; ")}`);
  return 1;
}

async function runExpandKeywords(
  config: Config,
  args: ParsedArgs,
  deps: CliDeps,
  stdout: (line: string) => void,
): Promise<number> {
  const runner = deps.createRunner(config);
  const provider = runner.llmProvider ?? null;
  if (provider === null || !provider.enabled) {
    deps.logger.error(
      `expand-keywords: no LLM provider is enabled — configure llm.* in ${args.config}`,
    );
    return 2;
  }
  const keywords = [...(config.search?.keywords ?? [])];
  const expandFn = deps.expandKeywordsFn ?? expandKeywords;
  const expanded = await expandFn(keywords, provider, {
    maxExpansions: args.expandMax,
    logger: deps.logger,
  });
  const added = expanded.filter((k) => !keywords.includes(k));
  stdout(`\u{1F4DD} ${keywords.length} original → ${expanded.length} expanded (+${added.length})`);
  for (const kw of added) stdout(`   + ${kw}`);

  if (args.expandWrite) {
    // `env` holds secrets injected from the environment (COL-36) and must
    // never be persisted back into config.yaml.
    const toWrite: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(config)) {
      if (k === "env") continue;
      toWrite[k] = v;
    }
    toWrite.search = {
      ...(toWrite.search as Record<string, unknown> | undefined),
      keywords: expanded,
    };
    const yamlText = (deps.stringifyYamlFn ?? stringifyYaml)(toWrite);
    (deps.writeFileFn ?? ((p, t) => writeFileSync(p, t, "utf-8")))(args.config, yamlText);
    stdout(`✅ wrote ${args.config}`);
  } else {
    stdout("ℹ️  pass --write to persist the expansion");
  }
  return 0;
}

export async function main(argv: readonly string[], deps: CliDeps): Promise<number> {
  const args = parseArgs(argv, deps.defaultConfigPath ?? "config.yaml");
  const loadCfg = deps.loadConfigFn ?? loadConfig;
  const config = loadCfg(args.config);
  const stdout = deps.stdout ?? ((line: string) => console.log(line));

  if (args.command === "expand-keywords") {
    return runExpandKeywords(config, args, deps, stdout);
  }

  if (args.days !== undefined) {
    config.search = { ...(config.search ?? {}), days_back: args.days };
  }
  if (args.keywords.length > 0) {
    config.search = {
      ...(config.search ?? {}),
      keywords: [...(config.search?.keywords ?? []), ...args.keywords],
    };
  }
  if (args.full) {
    config.incremental = { ...(config.incremental ?? {}), enabled: false };
  }
  if (args.skipLlm) {
    config.llm = { ...(config.llm ?? {}), enabled: false };
  }

  const runner = deps.createRunner(config);
  const result = await runner.run();

  // A source that filled its requested window shipped papers, so this is a
  // warning, not an error — read from the result so the run summary and
  // run_history can never disagree about which keywords were cut short.
  const truncated: string[] = [];
  for (const [name, keywords] of Object.entries(result.truncatedWindows)) {
    for (const kw of keywords) truncated.push(`${name}:${kw}`);
  }
  if (truncated.length > 0) {
    deps.logger.warn(
      `⚠️ truncated fetch windows (matching papers beyond the window were never fetched): ${truncated.join(", ")}`,
    );
  }

  deps.logger.info(
    `✅ done: ${result.outputCount} papers in ${result.durationSeconds.toFixed(1)}s -> ${
      result.outputFiles.length > 0 ? result.outputFiles.join(", ") : "(no exporters enabled)"
    }`,
  );
  stdout(`✅ ${result.outputCount} papers exported in ${result.durationSeconds.toFixed(1)}s`);
  for (const f of result.outputFiles) stdout(`   -> ${f}`);

  if (args.failOnErrors) return failureExitCode(result, deps.logger, stdout);
  return 0;
}
