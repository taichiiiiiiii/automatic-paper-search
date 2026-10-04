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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify as stringifyYaml } from "yaml";
import { CliUsageError, parseArgs as parseFlags } from "../shared/cli/argparse.js";
import { isMain } from "../shared/cli/isMain.js";
import { loadConfig } from "./config/load.js";
import type { Config } from "./config/types.js";
import { expandKeywords } from "./keywordExpand.js";
import type { LLMProvider } from "./llm/provider.js";
import { createLogger, type Logger } from "./logger.js";
import { PipelineRunner } from "./runner.js";
import { createRunnerDeps } from "./runtime/createRunnerDeps.js";

export { CliUsageError } from "../shared/cli/argparse.js";

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

/** Top-level flags, valid before the `expand-keywords` subcommand (if any). */
const TOP_LEVEL_SPEC = {
  config: { type: "string" as const },
  days: { type: "int" } as const,
  keyword: { type: "repeated-string" } as const,
  full: { type: "boolean" } as const,
  "skip-llm": { type: "boolean" } as const,
  "fail-on-errors": { type: "boolean" } as const,
};

/** `expand-keywords` subcommand flags — Python's own sub-parser. */
const EXPAND_KEYWORDS_SPEC = {
  max: { type: "int", default: 10 } as const,
  write: { type: "boolean" } as const,
};

/**
 * M3 of the P4 review: mirrors `collector.py`'s `argparse` parser
 * (including its `expand-keywords` subparser) through the shared strict
 * engine. An unrecognized/typo'd flag (the old `switch`'s `default:
 * break` silently ignored one) or a non-integer `--days` now throws
 * {@link CliUsageError}; `--fail-on-error` resolves to `--fail-on-errors`
 * via unique-prefix abbreviation, matching `allow_abbrev=True`.
 *
 * The `expand-keywords` subcommand is Python's own sub-parser: once that
 * bare token appears, every argv entry up to it is parsed against the
 * top-level spec, and everything after it against the subcommand's own
 * spec — mirroring argparse's own all-remaining-args-go-to-the-subparser
 * behaviour (a top-level flag typed AFTER `expand-keywords` is not
 * recognized by the subparser either, just like the real CLI).
 */
const TOP_LEVEL_BOOLEAN_FLAGS = Object.keys(TOP_LEVEL_SPEC).filter(
  (name) => TOP_LEVEL_SPEC[name as keyof typeof TOP_LEVEL_SPEC].type === "boolean",
);

/** Same exact/unique-prefix resolution the shared parser itself uses, just
 * to decide — while scanning for the `expand-keywords` boundary below —
 * whether a flag token consumes the next argv entry as its value. */
function topLevelFlagConsumesValue(rawName: string): boolean {
  if (TOP_LEVEL_BOOLEAN_FLAGS.includes(rawName)) return false;
  if (rawName in TOP_LEVEL_SPEC) return true;
  const candidates = Object.keys(TOP_LEVEL_SPEC).filter((name) => name.startsWith(rawName));
  if (candidates.length === 1) return !TOP_LEVEL_BOOLEAN_FLAGS.includes(candidates[0] as string);
  // Unknown/ambiguous — let the real parser raise the precise error later;
  // don't consume a value here so the split location isn't skewed by it.
  return false;
}

const EXPAND_KEYWORDS_BOOLEAN_FLAGS = Object.keys(EXPAND_KEYWORDS_SPEC).filter(
  (name) => EXPAND_KEYWORDS_SPEC[name as keyof typeof EXPAND_KEYWORDS_SPEC].type === "boolean",
);

/** Same resolution as {@link topLevelFlagConsumesValue}, against the
 * `expand-keywords` subparser's own (much smaller) flag spec. */
function expandKeywordsFlagConsumesValue(rawName: string): boolean {
  if (EXPAND_KEYWORDS_BOOLEAN_FLAGS.includes(rawName)) return false;
  if (rawName in EXPAND_KEYWORDS_SPEC) return true;
  const candidates = Object.keys(EXPAND_KEYWORDS_SPEC).filter((name) => name.startsWith(rawName));
  if (candidates.length === 1) {
    return !EXPAND_KEYWORDS_BOOLEAN_FLAGS.includes(candidates[0] as string);
  }
  return false;
}

/**
 * Which help text (if any) `argv` asks for — i.e. a literal `--help`/`-h`
 * token in a FLAG position, not one that is itself the VALUE of a
 * preceding value-consuming flag (collect LOW, P4 review round 2: `main()`
 * used to do a bare `argv.includes("--help")`, which also matched e.g.
 * `--keyword --help` — a mistyped invocation where `--help` was meant as
 * `--keyword`'s value — and short-circuited to printing the usage text
 * instead of letting `parseArgs` report the real problem (argparse itself
 * would report `--config: expected one argument`, not print help, for
 * `--config --help`). Reuses the same value-consuming walk `parseArgs`
 * does to find the `expand-keywords` boundary, so the two stay in sync.
 *
 * `argparse` gives EVERY (sub)parser its own auto-added `-h`/`--help`
 * (collect LOW, P4 review round 3: this used to assume "the sub-parser has
 * no --help of its own" and always return `null` once `expand-keywords`
 * appeared, so `collector expand-keywords --help` fell through to
 * `parseArgs`'s normal handling of an unrecognized `--help` flag for that
 * subcommand instead of printing its usage and exiting 0). Once the
 * `expand-keywords` boundary is found, the rest of `argv` is scanned the
 * same value-consuming way, but against the SUBCOMMAND's own flag spec
 * (`--max` takes a value, `--write` does not) — mirroring how a top-level
 * flag typed after `expand-keywords` is invisible to the subparser (see
 * `parseArgs` below) and must not skew this scan either.
 */
function helpRequest(argv: readonly string[]): "top" | "expand-keywords" | null {
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "expand-keywords") {
      for (let j = i + 1; j < argv.length; j++) {
        const subTok = argv[j];
        if (subTok === "--help" || subTok === "-h") return "expand-keywords";
        if (subTok?.startsWith("--") && !subTok.includes("=")) {
          const rawName = subTok.slice(2);
          if (expandKeywordsFlagConsumesValue(rawName)) j++;
        }
      }
      return null;
    }
    if (tok === "--help" || tok === "-h") return "top";
    if (tok?.startsWith("--") && !tok.includes("=")) {
      const rawName = tok.slice(2);
      if (topLevelFlagConsumesValue(rawName)) i++; // this token's value is not a flag position
    }
  }
  return null;
}

export function parseArgs(argv: readonly string[], defaultConfigPath: string): ParsedArgs {
  let splitIndex = -1;
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "expand-keywords") {
      splitIndex = i;
      break;
    }
    if (tok?.startsWith("--") && !tok.includes("=")) {
      const rawName = tok.slice(2);
      if (topLevelFlagConsumesValue(rawName)) i++; // skip this flag's value token
    }
  }
  const topArgv = splitIndex >= 0 ? argv.slice(0, splitIndex) : argv;
  const subArgv = splitIndex >= 0 ? argv.slice(splitIndex + 1) : [];

  const top = parseFlags(topArgv, TOP_LEVEL_SPEC);
  const args: ParsedArgs = {
    config: (top.config as string | undefined) ?? defaultConfigPath,
    days: top.days as number | undefined,
    keywords: top.keyword as string[],
    full: top.full as boolean,
    skipLlm: top["skip-llm"] as boolean,
    failOnErrors: top["fail-on-errors"] as boolean,
    expandMax: 10,
    expandWrite: false,
  };

  if (splitIndex >= 0) {
    args.command = "expand-keywords";
    const sub = parseFlags(subArgv, EXPAND_KEYWORDS_SPEC);
    args.expandMax = sub.max as number;
    args.expandWrite = sub.write as boolean;
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

/**
 * Simplified analogue of `collector.py`'s argparse-generated `--help`
 * output. The shared strict parser (`shared/cli/argparse.ts`) has no
 * built-in `-h`/`--help` support (M3 of the P4 review intentionally kept
 * it to the subset argparse features this port's CLIs actually used), so
 * `main()` checks for it itself, before `parseArgs` — a typo'd
 * `--totally-bogus-flag` still falls through to `parseArgs` and exits 2
 * exactly as before; only the literal `-h`/`--help` token short-circuits.
 */
export const HELP_TEXT = `usage: collector [--config CONFIG] [--days DAYS] [--keyword KEYWORD]
                  [--full] [--skip-llm] [--fail-on-errors]
                  [expand-keywords [--max MAX] [--write]]

PaperPilot — AI/ML paper auto-collector

options:
  --config CONFIG     Path to config.yaml (default: paperpilot/config.yaml)
  --days DAYS         Override search.days_back
  --keyword KEYWORD   Append additional search keyword (repeatable)
  --full              Ignore seen-ids (re-output papers from previous runs)
  --skip-llm          Skip Stage 4 (LLM rerank) even if configured
  --fail-on-errors    Exit non-zero when the run was degraded
  -h, --help          Show this help message and exit

subcommand:
  expand-keywords     Use the configured LLM provider to add synonyms to search.keywords
    --max MAX         Maximum number of LLM-suggested additions (default: 10)
    --write           Rewrite config.yaml with the expanded keywords in place
`;

/**
 * Simplified analogue of the `expand-keywords` SUBPARSER's own
 * argparse-generated `--help` output (P4 review round 3 LOW: argparse
 * gives every subparser its own `-h`/`--help`, same as the top level —
 * see {@link helpRequest}).
 */
export const EXPAND_KEYWORDS_HELP_TEXT = `usage: collector expand-keywords [-h] [--max MAX] [--write]

options:
  -h, --help   Show this help message and exit
  --max MAX    Maximum number of LLM-suggested additions (default: 10)
  --write      Rewrite config.yaml with the expanded keywords in place
`;

export async function main(argv: readonly string[], deps: CliDeps): Promise<number> {
  const help = helpRequest(argv);
  if (help !== null) {
    const stdoutFn = deps.stdout ?? ((line: string) => console.log(line));
    stdoutFn(help === "top" ? HELP_TEXT : EXPAND_KEYWORDS_HELP_TEXT);
    return 0;
  }
  let args: ParsedArgs;
  try {
    args = parseArgs(argv, deps.defaultConfigPath ?? "config.yaml");
  } catch (e) {
    if (e instanceof CliUsageError) {
      deps.logger.error(`collector: error: ${e.message}`);
      return 2;
    }
    throw e;
  }
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

// ---- real entry point (#26/#29 of docs/migration/p4-followups.md) ----

const HERE = dirname(fileURLToPath(import.meta.url));
// apps/pipeline/src/collect/cli.ts -> repo root is 4 levels up (one less
// than lineage/theme/cli.ts's 5, since collect/ sits one level shallower).
const DEFAULT_REPO_ROOT = resolve(HERE, "..", "..", "..", "..");
const DEFAULT_CONFIG_PATH = join(DEFAULT_REPO_ROOT, "paperpilot", "config.yaml");

/**
 * Builds the `CliDeps` a real (non-test) run uses: `createRunner` wires a
 * real `PipelineRunner` through `createRunnerDeps()` (real fetch, the real
 * LLM provider factory, the SMTP-unavailable transport — see that
 * module's and `collect/runtime/*`'s doc comments), and `logger` is a
 * console(+file) logger built from `config.logging` — mirroring
 * `collector.py::main`'s `load_config` -> `setup_logging` ordering: Python
 * reads `logging.level`/`logging.file` from the SAME loaded config object
 * before doing anything else, so this peeks the config once up front for
 * that purpose. `main()` itself still calls `loadConfig` again internally
 * (`deps.loadConfigFn` is not overridden) — an extra cheap YAML+`.env`
 * read, not a behavior difference, since `loadConfig` has no side effects
 * and `args.config` cannot differ between the two reads (this function
 * only reads `--config`, which `parseArgs`'s own exact logic below
 * reproduces just enough of to find).
 */
export function createDefaultCliDeps(argv: readonly string[]): CliDeps {
  let logger: Logger;
  try {
    const peeked = parseArgs(argv, DEFAULT_CONFIG_PATH);
    const cfg = loadConfig(peeked.config);
    const logCfg = cfg.logging ?? {};
    logger = createLogger("paperpilot", { level: logCfg.level, file: logCfg.file });
  } catch {
    // A bad `--config` value or a missing config file is `main()`'s own
    // job to report (via a thrown CliUsageError/ConfigNotFoundError this
    // peek must not swallow) — fall back to a plain console logger so
    // that report still has somewhere to go.
    logger = createLogger("paperpilot", { level: "INFO" });
  }
  return {
    createRunner: (config) => new PipelineRunner(config, createRunnerDeps()),
    logger,
    defaultConfigPath: DEFAULT_CONFIG_PATH,
  };
}

/** Runs the real CLI; never throws — every failure path maps to a logged
 * message and a non-zero `process.exitCode` (mirrors Python's uncaught-
 * exception-exits-1 contract for e.g. a missing config file, which
 * `main()` itself does not catch). */
export async function runRealCli(argv: readonly string[]): Promise<number> {
  const deps = createDefaultCliDeps(argv);
  try {
    return await main(argv, deps);
  } catch (e) {
    deps.logger.error(`collector: fatal: ${(e as Error).message}`);
    return 1;
  }
}

if (isMain(import.meta.url)) {
  runRealCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
