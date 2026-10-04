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
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "../../collect/config/env.js";
import type { FetchInit, HttpResponseLike } from "../../collect/http/requestWithRetry.js";
import { IncompleteBuildError } from "../fetch-state/completeness.js";
import { type BuildThemeLineageDeps, buildThemeLineage, ZeroEdgeBuildError } from "./build.js";
import { buildProvider } from "./providerFactory.js";
import { sanitizeTheme } from "./slug.js";

const HERE = dirname(fileURLToPath(import.meta.url));
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
}

export class CliArgError extends Error {}

const LLM_STRICT_VALUES = new Set(["off", "ambiguous", "all"]);
const PRIMARY_SOURCE_VALUES = new Set(["s2", "openalex"]);

/** Parse CLI argv into `ThemeCliArgs`. Mirrors `_build_arg_parser`'s
 * flag set; `--theme` is required. */
export function parseArgs(argv: readonly string[]): ThemeCliArgs {
  let theme: string | undefined;
  let depth = 2;
  let seedsCount = 8;
  let width = 8;
  let sinceYear: number | null = null;
  let output: string | null = null;
  let useOpenalexFallback = true;
  let llmStrict: "off" | "ambiguous" | "all" = "off";
  let primarySource: "s2" | "openalex" = "s2";
  let allowIncomplete = false;
  let autoExpand = false;

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    switch (tok) {
      case "--theme":
        theme = argv[++i];
        break;
      case "--depth":
        depth = Number(argv[++i]);
        break;
      case "--seeds":
        seedsCount = Number(argv[++i]);
        break;
      case "--width":
        width = Number(argv[++i]);
        break;
      case "--since-year":
        sinceYear = Number(argv[++i]);
        break;
      case "--output":
        output = argv[++i] ?? null;
        break;
      case "--no-openalex-fallback":
        useOpenalexFallback = false;
        break;
      case "--llm-strict": {
        const v = argv[++i];
        if (!v || !LLM_STRICT_VALUES.has(v)) {
          throw new CliArgError(
            `--llm-strict must be one of off, ambiguous, all (got ${JSON.stringify(v)})`,
          );
        }
        llmStrict = v as "off" | "ambiguous" | "all";
        break;
      }
      case "--primary-source": {
        const v = argv[++i];
        if (!v || !PRIMARY_SOURCE_VALUES.has(v)) {
          throw new CliArgError(
            `--primary-source must be one of s2, openalex (got ${JSON.stringify(v)})`,
          );
        }
        primarySource = v as "s2" | "openalex";
        break;
      }
      case "--allow-incomplete":
        allowIncomplete = true;
        break;
      case "--auto-expand":
        autoExpand = true;
        break;
      default:
        throw new CliArgError(`unrecognized argument: ${tok}`);
    }
  }
  if (theme === undefined) {
    throw new CliArgError("--theme is required");
  }
  return {
    theme,
    depth,
    seedsCount,
    width,
    sinceYear,
    output,
    useOpenalexFallback,
    llmStrict,
    primarySource,
    allowIncomplete,
    autoExpand,
  };
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

function defaultDeps(repoRoot: string = DEFAULT_REPO_ROOT): BuildThemeLineageDeps {
  const docsRoot = join(repoRoot, "docs");
  const env = loadEnv(join(repoRoot, "paperpilot", ".env"));
  const fetchImpl: (url: string, init: FetchInit) => Promise<HttpResponseLike> = async (
    url,
    init,
  ) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), init.timeoutMs);
    try {
      const resp = await fetch(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        signal: controller.signal,
      });
      return { status: resp.status, json: () => resp.json() };
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    fetchImpl,
    cacheDir: join(repoRoot, "paperpilot", "data", "lineage-cache"),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    email: env.openalexEmail,
    docsRoot,
    identityAliasesPath: join(docsRoot, "identity-aliases-v1.json"),
    githubCachePath: join(repoRoot, "paperpilot", "data", "lineage-cache", "github_stars.json"),
    githubToken: env.githubToken,
    classificationCachePath: join(
      repoRoot,
      "paperpilot",
      "data",
      "lineage-cache",
      "classifications.json",
    ),
    githubApiDeps: { fetchImpl },
    buildProvider: () =>
      buildProvider({
        env,
        ambientEnv: process.env,
        fetchImpl,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      }),
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

  try {
    sanitizeTheme(args.theme);
  } catch (exc) {
    process.stderr.write(`error: ${(exc as Error).message}\n`);
    return 2;
  }

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
      },
      deps,
    );

  let usedZeroEdgeRetry = false;
  let outPath: string;
  try {
    outPath = await attempt(args.depth, args.seedsCount, args.width);
  } catch (exc) {
    if (exc instanceof ZeroEdgeBuildError) {
      if (!args.autoExpand) {
        process.stderr.write(
          `0 edges produced; published artifact left untouched: ${exc.message}\n`,
        );
        return 3;
      }
      usedZeroEdgeRetry = true;
      const [d2, s2, w2] = expandParams(args.depth, args.seedsCount, args.width);
      process.stderr.write(
        `auto-expand: first pass produced 0 edges; retrying with --depth ${d2} --seeds ${s2} --width ${w2}\n`,
      );
      try {
        outPath = await attempt(d2, s2, w2);
      } catch (exc2) {
        if (exc2 instanceof ZeroEdgeBuildError) {
          process.stderr.write(
            `auto-expand retry also produced 0 edges; published artifact left untouched: ${(exc2 as Error).message}\n`,
          );
          return 3;
        }
        if (exc2 instanceof IncompleteBuildError) {
          process.stderr.write(
            `incomplete build; published artifact left untouched: ${(exc2 as Error).message}\n`,
          );
          return 4;
        }
        process.stderr.write(`error: ${(exc2 as Error).message}\n`);
        return 2;
      }
    } else if (exc instanceof IncompleteBuildError) {
      process.stderr.write(
        `incomplete build; published artifact left untouched: ${(exc as Error).message}\n`,
      );
      return 4;
    } else {
      process.stderr.write(`error: ${(exc as Error).message}\n`);
      return 2;
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
        if (exc instanceof ZeroEdgeBuildError) {
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
    return 2;
  }
  if (!payload.edges || payload.edges.length === 0) {
    process.stderr.write(
      "warning: 0 edges produced; published artifact left untouched. Re-run after LLM quota resets (see issue #45).\n",
    );
    return 3;
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runThemeCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
