/**
 * CLI entry point for `buildThemeLineage` — TS port of
 * `paperpilot/scripts/build_theme_lineage.py`'s `_build_arg_parser`,
 * `SPARSE_NODES`/`SPARSE_EDGES`, `_expand_params`, `main`.
 *
 * Safety contracts: LIN-18 (auto-expand retry keeps the first result on
 * a worse/failed retry), LIN-19 (exit 2 for bad input / unreadable
 * just-written file, exit 3 for zero edges — decided here from the same
 * condition the builder's write-order gate already enforced BEFORE any
 * write, per `ZeroEdgeBuildError`'s doc comment).
 *
 * R2-6 (design 41 D3): exit 5 ({@link EXIT_DEGRADED_CLASSIFICATION}) when
 * fewer than `--min-classified-rate` (default:
 * `theme_min_evidence_classified_rate` in `lineage-quality-policy-v1.json`,
 * else 0.8) of the edges carry an evidence-backed relation (LLM, S2
 * intents, citation context, …; only year/citation guesses are
 * unclassified) — nothing is written and a `::error::` line names the
 * rate, the evidence mix, every LLM provider's usage and whether a daily
 * quota was hit. `--result-json <path>` records the outcome of every run for the
 * regen workflow's pending-retry state (`regenPending.ts`).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classificationsCache,
  LAYOUT_MODE,
  type LayoutMode,
  layoutFor,
  lineageCacheDir,
  qualityPolicy,
} from "@paperpilot/core/layout";
import { loadEnv } from "../../collect/config/env.js";
import { installOpenAlexGate } from "../../collect/http/openalexGate.js";
import type { FetchInit, HttpResponseLike } from "../../collect/http/requestWithRetry.js";
import { CliUsageError, parseArgs as parseFlags } from "../../shared/cli/argparse.js";
import { isMain } from "../../shared/cli/isMain.js";
import { IncompleteBuildError } from "../fetch-state/completeness.js";
import { buildProvider } from "../shared/providerFactory.js";
import { type BuildThemeLineageDeps, buildThemeLineage, ZeroEdgeBuildError } from "./build.js";
import {
  DEFAULT_MIN_CLASSIFIED_RATE,
  DegradedClassificationError,
  EXIT_DEGRADED_CLASSIFICATION,
} from "./classificationGate.js";
import { S2_REFERENCES_FILENAME } from "./s2Citations.js";
import { sanitizeTheme } from "./slug.js";
import { CachedTopicEmbedder, createTransformersEmbedder } from "./topicEmbedding.js";
import { DEFAULT_TOPIC_SCOPE_OPTIONS } from "./topicScope.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** R2-20: `PAPERPILOT_CONTEXT_BATCH_SIZE` (pairs per context-LLM request, 1-20); unset/invalid -> build default. */
export function contextBatchSizeFromEnv(raw: string | undefined): number | undefined {
  const n = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 20 ? n : undefined;
}
// apps/pipeline/src/lineage/theme -> repo root (5 levels up).
const DEFAULT_REPO_ROOT = resolve(HERE, "..", "..", "..", "..", "..");

export interface ThemeCliArgs {
  theme: string;
  depth: number;
  seedsCount: number;
  width: number;
  sinceYear: number | null;
  output: string | null;
  useOpenalexFallback: boolean;
  llmStrict: "off" | "ambiguous" | "all";
  primarySource: "s2" | "openalex";
  allowIncomplete: boolean;
  autoExpand: boolean;
  /** R2-2b: BFS admission gate on/off (`--no-topic-gate`). */
  topicGate: boolean;
  /** R2-2b: on-topic links needed to admit a candidate without a theme
   * match (`--topic-min-support`; default 0 = support admission off,
   * R2-11). */
  topicMinSupport: number;
  /** R2-11: embedding topic gate on/off (`--no-topic-embedding`). */
  topicEmbedding: boolean;
  /** R2-6: `--min-classified-rate` (0..1); `null` = take the policy/default. */
  minClassifiedRate: number | null;
  /** R2-6: `--result-json` path for the machine-readable outcome. */
  resultJson: string | null;
}

export class CliArgError extends Error {}

const THEME_CLI_SPEC = {
  theme: { type: "string" as const, required: true },
  depth: { type: "int" as const, default: 2 },
  seeds: { type: "int" as const, default: 8 },
  width: { type: "int" as const, default: 8 },
  "since-year": { type: "int" as const },
  output: { type: "string" as const },
  "no-openalex-fallback": { type: "boolean" as const },
  "llm-strict": {
    type: "string" as const,
    choices: ["off", "ambiguous", "all"] as const,
    default: "off",
  },
  "primary-source": {
    type: "string" as const,
    choices: ["s2", "openalex"] as const,
    default: "s2",
  },
  "allow-incomplete": { type: "boolean" as const },
  "auto-expand": { type: "boolean" as const },
  "no-topic-gate": { type: "boolean" as const },
  "no-topic-embedding": { type: "boolean" as const },
  "topic-min-support": { type: "int" as const, default: DEFAULT_TOPIC_SCOPE_OPTIONS.minSupport },
  "min-classified-rate": { type: "float" as const },
  "result-json": { type: "string" as const },
};

/**
 * Parse CLI argv into `ThemeCliArgs` — M3 of the P4 review: mirrors
 * `_build_arg_parser`'s flag set through the shared strict parser
 * (unique-prefix abbreviation, `--flag=value`, `--depth x` exiting
 * instead of becoming `NaN`) instead of a hand-rolled `switch`.
 * `--theme` is required. `CliArgError` (this file's own public error
 * type, pinned by existing tests) now wraps the shared parser's
 * {@link CliUsageError}.
 */
export function parseArgs(argv: readonly string[]): ThemeCliArgs {
  let parsed: Record<string, unknown>;
  try {
    parsed = parseFlags(argv, THEME_CLI_SPEC);
  } catch (e) {
    if (e instanceof CliUsageError) throw new CliArgError(e.message);
    throw e;
  }
  return {
    theme: parsed.theme as string,
    depth: parsed.depth as number,
    seedsCount: parsed.seeds as number,
    width: parsed.width as number,
    sinceYear: (parsed["since-year"] as number | undefined) ?? null,
    output: (parsed.output as string | undefined) ?? null,
    useOpenalexFallback: !(parsed["no-openalex-fallback"] as boolean),
    llmStrict: parsed["llm-strict"] as "off" | "ambiguous" | "all",
    primarySource: parsed["primary-source"] as "s2" | "openalex",
    allowIncomplete: parsed["allow-incomplete"] as boolean,
    autoExpand: parsed["auto-expand"] as boolean,
    topicGate: !(parsed["no-topic-gate"] as boolean),
    topicMinSupport: parsed["topic-min-support"] as number,
    topicEmbedding: !(parsed["no-topic-embedding"] as boolean),
    minClassifiedRate: (parsed["min-classified-rate"] as number | undefined) ?? null,
    resultJson: (parsed["result-json"] as string | undefined) ?? null,
  };
}

/** Policy key holding the default `--min-classified-rate`. */
export const POLICY_MIN_CLASSIFIED_RATE_KEY = "theme_min_evidence_classified_rate";

/**
 * The classification-rate threshold: the flag, else the policy file's
 * {@link POLICY_MIN_CLASSIFIED_RATE_KEY}, else 0.8. A missing/unreadable policy
 * falls back to the default; a present but out-of-range value is an error
 * (a typo must not silently disable the gate).
 */
export function resolveMinClassifiedRate(flag: number | null, policyPath: string | null): number {
  const check = (v: number, where: string): number => {
    if (!(Number.isFinite(v) && v >= 0 && v <= 1)) {
      throw new CliArgError(`${where} must be a number in [0, 1], got ${v}`);
    }
    return v;
  };
  if (flag !== null) return check(flag, "--min-classified-rate");
  if (policyPath !== null) {
    let policy: unknown;
    try {
      policy = JSON.parse(readFileSync(policyPath, "utf-8"));
    } catch {
      policy = null;
    }
    if (policy !== null && typeof policy === "object" && POLICY_MIN_CLASSIFIED_RATE_KEY in policy) {
      const raw = (policy as Record<string, unknown>)[POLICY_MIN_CLASSIFIED_RATE_KEY];
      return check(typeof raw === "number" ? raw : Number.NaN, `${POLICY_MIN_CLASSIFIED_RATE_KEY}`);
    }
  }
  return DEFAULT_MIN_CLASSIFIED_RATE;
}

/** Machine-readable outcome of one CLI run (`--result-json`). */
export interface ThemeRunResult {
  schema_version: "theme-run-result-v1";
  theme: string;
  exit_code: number;
  status: "ok" | "degraded_classification" | "zero_edges" | "incomplete" | "error";
  /** Degraded runs only: did any LLM provider report its daily quota exhausted? */
  daily_limit_hit: boolean;
  classified_rate: number | null;
  classified_edges: number | null;
  total_edges: number | null;
  threshold: number | null;
  message: string;
}

function writeResult(path: string | null, result: ThemeRunResult): void {
  if (path === null) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`, "utf-8");
  } catch (e) {
    process.stderr.write(`warning: cannot write --result-json ${path}: ${(e as Error).message}\n`);
  }
}

/** `--auto-expand` thresholds: fewer than `SPARSE_NODES` nodes OR fewer
 * than `SPARSE_EDGES` edges triggers the retry. */
export const SPARSE_NODES = 15;
export const SPARSE_EDGES = 5;

/** Compute the larger BFS parameters used on the auto-expand retry.
 * Each axis bumps independently: depth never exceeds 3, seeds at least
 * doubles but caps at 12, width adds +4 with a 12 cap. */
export function expandParams(
  depth: number,
  seedsCount: number,
  width: number,
): [number, number, number] {
  return [
    Math.min(3, depth + 1),
    Math.min(12, Math.max(10, seedsCount * 2)),
    Math.min(12, width + 4),
  ];
}

/**
 * Where `.env` lives, as a function of the layout mode — p5-plan.md §2
 * A2 follow-up #19 ("load .env from layout.config"), L10 of the P5
 * tier-A review. Mirrors `layoutFor`'s own `collectConfig()` quirk for
 * `config.yaml` (`packages/core/src/layout/index.ts`): under
 * `"legacy"` it lives one level ABOVE `layout.config`
 * (`paperpilot/.env`, parallel to `paperpilot/data` — byte-identical to
 * this CLI's old hard-coded `join(repoRoot, "paperpilot", ".env")`, so
 * tier A stays inert), and only moves INSIDE `layout.config` under
 * `"p5"` (`data/config/.env`, alongside `config.yaml`). Kept as a local
 * helper (not a new `layoutFor` export) per this task's edit-scope
 * limits; duplicated from `lineage/conference/buildLineageCli.ts`'s own
 * `envFilePath` for the same "each CLI's wiring stays independently
 * readable" reason that module's own doc comment gives.
 */
export function envFilePath(repoRoot: string, mode: LayoutMode = LAYOUT_MODE): string {
  if (mode === "legacy") {
    return join(repoRoot, "paperpilot", ".env");
  }
  return join(layoutFor(repoRoot, mode).config, ".env");
}

/** Exported for tests (the M6 fetch-timeout-covers-body-read fix lives in
 * the `fetchImpl` this builds); production callers rely on the
 * `runThemeCli` default. */
export function defaultDeps(repoRoot: string = DEFAULT_REPO_ROOT): BuildThemeLineageDeps {
  const layout = layoutFor(repoRoot);
  const docsRoot = layout.published;
  const env = loadEnv(envFilePath(repoRoot));
  const rawFetchImpl: (url: string, init: FetchInit) => Promise<HttpResponseLike> = async (
    url,
    init,
  ) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), init.timeoutMs);
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
    // M6 (review, LOW): `json()` is lazy — the caller reads the body
    // AFTER this function returns. Clearing the abort timer here (right
    // after the response HEADERS arrive, in a `finally` around only the
    // `fetch()` call above) would leave the body read with no timeout at
    // all: a server that sends headers promptly and then stalls the body
    // stream could hang the build forever. The timer must stay armed —
    // and the same `AbortController` still cover — the body read too, so
    // it's cleared from INSIDE the `json()` thunk once that read settles,
    // not before the caller even gets a chance to call it.
    return {
      status: resp.status,
      // Exposed so 429 handling can honour Retry-After / x-ratelimit-reset-*.
      headers: resp.headers,
      json: async () => {
        try {
          return await resp.json();
        } finally {
          clearTimeout(timer);
        }
      },
    };
  };
  // R2-19: OpenAlex key + daily-budget breaker; one summary line on exit.
  const { fetchImpl } = installOpenAlexGate(rawFetchImpl, { apiKey: env.openalexApiKey });
  return {
    fetchImpl,
    cacheDir: lineageCacheDir(layout),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    email: env.openalexEmail,
    docsRoot,
    identityAliasesPath: join(docsRoot, "identity-aliases-v1.json"),
    githubCachePath: join(lineageCacheDir(layout), "github_stars.json"),
    githubToken: env.githubToken,
    classificationCachePath: classificationsCache(layout),
    githubApiDeps: { fetchImpl },
    // R2-10 (design 41 D6): Semantic Scholar citation contexts first.
    // PAPERPILOT_S2_RELATIONS=off restores the pre-R2-10 path.
    s2Citations:
      (process.env.PAPERPILOT_S2_RELATIONS ?? "").toLowerCase() === "off"
        ? null
        : {
            cachePath: join(lineageCacheDir(layout), S2_REFERENCES_FILENAME),
            apiKey: env.s2ApiKey,
          },
    // R2-11: vectors and model files live under the (git-ignored) lineage
    // cache; CI keeps both in the Actions cache (regen-themes.yml,
    // theme-on-demand.yml).
    topicEmbedder: new CachedTopicEmbedder(
      createTransformersEmbedder({
        modelCacheDir: join(lineageCacheDir(layout), "models"),
      }),
      join(lineageCacheDir(layout), "embeddings"),
    ),
    buildProvider: () =>
      buildProvider(
        {
          env,
          ambientEnv: process.env,
          fetchImpl,
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
          // Surface why an LLM call failed (status code) in the CI log;
          // without it every failure silently falls back to the heuristic.
          logger: { warn: (msg) => process.stderr.write(`${msg}\n`) },
        },
        // R2-6 (design 41 D2): Groq first, Gemini when Groq latches or
        // returns nothing for a pair — whichever keys are configured.
        // R2-20: the citation-context prompt asks the cheaper Groq context
        // model first (PAPERPILOT_GROQ_CONTEXT_MODEL, default gpt-oss-20b).
        { fallback: true, contextModelRouting: true },
      ),
    logger: {
      warn: (msg) => process.stderr.write(`${msg}\n`),
      info: (msg) => process.stderr.write(`${msg}\n`),
    },
  };
}

export interface RunThemeCliOptions {
  deps?: BuildThemeLineageDeps;
  /** Test-only override for `buildThemeLineage` itself (mirrors the
   * Python test suite's `monkeypatch.setattr(build_theme_lineage,
   * "build_theme_lineage", fake_build)` — lets auto-expand/retry tests
   * control exactly what each of the (up to two) build attempts
   * returns/throws without driving the full pipeline through fake
   * network fixtures). Defaults to the real `buildThemeLineage`. */
  buildFn?: typeof buildThemeLineage;
  /** Policy file holding the default `--min-classified-rate`; `null` = built-in default. Defaults to the repo's `lineage-quality-policy-v1.json`. */
  policyPath?: string | null;
}

/** Run the theme-lineage CLI; returns the process exit code. Never
 * throws — every failure path is mapped to a stderr message + exit
 * code, mirroring Python `main()`'s `try`/`except` ladder. */
export async function runThemeCli(
  argv: readonly string[],
  options: RunThemeCliOptions = {},
): Promise<number> {
  let args: ThemeCliArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (e instanceof CliArgError) {
      process.stderr.write(`error: ${e.message}\n`);
      return 2;
    }
    throw e;
  }

  if (args.topicMinSupport < 0) {
    process.stderr.write("error: --topic-min-support must be >= 0 (0 = support admission off)\n");
    return 2;
  }

  try {
    sanitizeTheme(args.theme);
  } catch (exc) {
    process.stderr.write(`error: ${(exc as Error).message}\n`);
    return 2;
  }

  let minClassifiedRate: number;
  try {
    minClassifiedRate = resolveMinClassifiedRate(
      args.minClassifiedRate,
      options.policyPath === undefined
        ? qualityPolicy(layoutFor(DEFAULT_REPO_ROOT))
        : options.policyPath,
    );
  } catch (e) {
    process.stderr.write(`error: ${(e as Error).message}\n`);
    return 2;
  }

  const result = (
    exitCode: number,
    status: ThemeRunResult["status"],
    message: string,
    degraded?: DegradedClassificationError,
  ): number => {
    writeResult(args.resultJson, {
      schema_version: "theme-run-result-v1",
      theme: args.theme,
      exit_code: exitCode,
      status,
      daily_limit_hit: degraded?.dailyLimitHit ?? false,
      classified_rate: degraded?.rate.ratio ?? null,
      classified_edges: degraded?.rate.classified ?? null,
      total_edges: degraded?.rate.total ?? null,
      threshold: degraded ? degraded.threshold : null,
      message: message.slice(0, 500),
    });
    return exitCode;
  };
  const degradedExit = (exc: DegradedClassificationError): number => {
    // stdout so the `::error::` annotation reaches the Actions log as a
    // workflow command; the detail lines follow it.
    process.stdout.write(`${exc.report()}\n`);
    return result(EXIT_DEGRADED_CLASSIFICATION, "degraded_classification", exc.message, exc);
  };

  const deps = options.deps ?? defaultDeps();
  const build = options.buildFn ?? buildThemeLineage;

  const attempt = (depth: number, seedsCount: number, width: number): Promise<string> =>
    build(
      {
        theme: args.theme,
        depth,
        seedsCount,
        width,
        sinceYear: args.sinceYear,
        output: args.output,
        useOpenalexFallback: args.useOpenalexFallback,
        llmStrict: args.llmStrict,
        primarySource: args.primarySource,
        allowIncomplete: args.allowIncomplete,
        // The CLI is the one caller that treats 0 edges as a failure.
        allowEdgeless: false,
        topicScope: { gate: args.topicGate, minSupport: args.topicMinSupport },
        topicEmbedding: args.topicEmbedding,
        minClassifiedRate,
        contextBatchSize: contextBatchSizeFromEnv(process.env.PAPERPILOT_CONTEXT_BATCH_SIZE),
      },
      deps,
    );

  let usedZeroEdgeRetry = false;
  let outPath: string;
  try {
    outPath = await attempt(args.depth, args.seedsCount, args.width);
  } catch (exc) {
    if (exc instanceof DegradedClassificationError) {
      // No auto-expand retry: a bigger graph needs MORE classifications
      // from the evidence source that just failed.
      return degradedExit(exc);
    }
    if (exc instanceof ZeroEdgeBuildError) {
      if (!args.autoExpand) {
        process.stderr.write(
          `0 edges produced; published artifact left untouched: ${exc.message}\n`,
        );
        return result(3, "zero_edges", exc.message);
      }
      usedZeroEdgeRetry = true;
      const [d2, s2, w2] = expandParams(args.depth, args.seedsCount, args.width);
      process.stderr.write(
        `auto-expand: first pass produced 0 edges; retrying with --depth ${d2} --seeds ${s2} --width ${w2}\n`,
      );
      try {
        outPath = await attempt(d2, s2, w2);
      } catch (exc2) {
        if (exc2 instanceof DegradedClassificationError) return degradedExit(exc2);
        if (exc2 instanceof ZeroEdgeBuildError) {
          process.stderr.write(
            `auto-expand retry also produced 0 edges; published artifact left untouched: ${(exc2 as Error).message}\n`,
          );
          return result(3, "zero_edges", (exc2 as Error).message);
        }
        if (exc2 instanceof IncompleteBuildError) {
          process.stderr.write(
            `incomplete build; published artifact left untouched: ${(exc2 as Error).message}\n`,
          );
          return result(4, "incomplete", (exc2 as Error).message);
        }
        process.stderr.write(`error: ${(exc2 as Error).message}\n`);
        return result(2, "error", (exc2 as Error).message);
      }
    } else if (exc instanceof IncompleteBuildError) {
      process.stderr.write(
        `incomplete build; published artifact left untouched: ${(exc as Error).message}\n`,
      );
      return result(4, "incomplete", (exc as Error).message);
    } else {
      process.stderr.write(`error: ${(exc as Error).message}\n`);
      return result(2, "error", (exc as Error).message);
    }
  }

  // Auto-expand: detect a sparse (but non-zero-edge) lineage and rebuild
  // with larger BFS parameters. Skipped when the ZeroEdgeBuildError
  // branch above already spent the one retry --auto-expand grants.
  if (args.autoExpand && !usedZeroEdgeRetry) {
    let initial: { nodes?: unknown[]; edges?: unknown[] };
    try {
      initial = JSON.parse(readFileSync(outPath, "utf-8"));
    } catch {
      initial = { nodes: [], edges: [] };
    }
    const nNodes = (initial.nodes ?? []).length;
    const nEdges = (initial.edges ?? []).length;
    if (nNodes < SPARSE_NODES || nEdges < SPARSE_EDGES) {
      const [d2, s2, w2] = expandParams(args.depth, args.seedsCount, args.width);
      process.stderr.write(
        `auto-expand: first pass ${nNodes} nodes / ${nEdges} edges below (${SPARSE_NODES} / ${SPARSE_EDGES}); retrying with --depth ${d2} --seeds ${s2} --width ${w2}\n`,
      );
      try {
        outPath = await attempt(d2, s2, w2);
      } catch (exc) {
        if (exc instanceof DegradedClassificationError) {
          process.stderr.write(
            `auto-expand retry was classification-degraded; keeping the initial lineage: ${exc.message}\n`,
          );
        } else if (exc instanceof ZeroEdgeBuildError) {
          process.stderr.write(
            `auto-expand retry produced 0 edges; keeping the initial lineage: ${(exc as Error).message}\n`,
          );
        } else if (exc instanceof IncompleteBuildError) {
          process.stderr.write(
            `auto-expand retry hit an incomplete fetch; keeping the initial lineage: ${(exc as Error).message}\n`,
          );
        } else {
          process.stderr.write(
            `auto-expand retry failed; keeping initial lineage: ${(exc as Error).message}\n`,
          );
        }
      }
    }
  }

  let payload: { edges?: unknown[] };
  try {
    payload = JSON.parse(readFileSync(outPath, "utf-8"));
  } catch (exc) {
    process.stderr.write(
      `error: cannot re-read just-written ${outPath}: ${(exc as Error).message}\n`,
    );
    return result(2, "error", `cannot re-read just-written ${outPath}`);
  }
  if (!payload.edges || payload.edges.length === 0) {
    process.stderr.write(
      "warning: 0 edges produced; published artifact left untouched. Re-run after LLM quota resets (see issue #45).\n",
    );
    return result(3, "zero_edges", "0 edges produced");
  }
  return result(0, "ok", `wrote ${outPath}`);
}

if (isMain(import.meta.url)) {
  runThemeCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
