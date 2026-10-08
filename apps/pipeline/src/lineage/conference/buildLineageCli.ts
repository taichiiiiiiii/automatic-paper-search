/**
 * CLI entry point mirroring `build_lineage.py`'s `main()` (`--limit`,
 * `--conference`, `--venue-override`, `--allow-incomplete`). LIN-05,
 * LIN-06, LIN-07, LIN-44.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pyFloat, pyJsonDumps } from "@paperpilot/core";
import { LAYOUT_MODE, type LayoutMode, layoutFor } from "@paperpilot/core/layout";
import { loadEnv } from "../../collect/config/env.js";
import type { LLMProvider } from "../../collect/llm/provider.js";
import { atomicWriteText } from "../../collect/state/atomic.js";
import { CliUsageError, parseArgs as parseFlags } from "../../shared/cli/argparse.js";
import { isMain } from "../../shared/cli/isMain.js";
import { requireValidLineageArtifact } from "../contract/v1.js";
import { BuildCompleteness } from "../fetch-state/completeness.js";
import { buildProvider } from "../shared/providerFactory.js";
import {
  type BuildLineageDeps,
  build,
  cacheDirFor,
  expansionGateBlocks,
  resolveConferencePaths,
} from "./buildLineage.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// apps/pipeline/src/lineage/conference -> repo root (5 levels up).
const DEFAULT_REPO_ROOT = resolve(HERE, "..", "..", "..", "..", "..");

export interface BuildLineageCliArgs {
  limit: number | null;
  conference: string;
  venueOverride: string | null;
  allowIncomplete: boolean;
}

/**
 * M3 of the P4 review: mirrors `build_lineage.py`'s argparse flags
 * through the shared strict parser instead of a hand-rolled `switch`
 * (which let `--limit x` silently become `NaN`).
 */
export function parseArgs(argv: readonly string[]): BuildLineageCliArgs {
  const parsed = parseFlags(argv, {
    limit: { type: "int" },
    conference: { type: "string", default: "iclr-2026" },
    "venue-override": { type: "string" },
    "allow-incomplete": { type: "boolean" },
  });
  return {
    limit: (parsed.limit as number | undefined) ?? null,
    conference: parsed.conference as string,
    venueOverride: (parsed["venue-override"] as string | undefined) ?? null,
    allowIncomplete: parsed["allow-incomplete"] as boolean,
  };
}

/**
 * Where `.env` lives, as a function of the layout mode — p5-plan.md §2
 * A2 follow-up #19 ("load .env from layout.config"). Mirrors
 * `layoutFor`'s own `collectConfig()` quirk for `config.yaml`
 * (`packages/core/src/layout/index.ts`): under `"legacy"` it lives one
 * level ABOVE `layout.config` (`paperpilot/.env`, parallel to
 * `paperpilot/data` — byte-identical to this CLI's old hard-coded
 * `join(repoRoot, "paperpilot", ".env")`, so tier A stays inert), and
 * only moves INSIDE `layout.config` under `"p5"` (`data/config/.env`,
 * alongside `config.yaml` — p5-plan.md §5.1: "`.env` is now looked up in
 * `data/config/` by `loadConfig`"). Kept as a local helper (not a new
 * `layoutFor` export) per this task's edit-scope limits; duplicated in
 * `buildDeepLineageCli.ts` for the same "each CLI's wiring stays
 * independently readable" reason `defaultDeps` itself already is.
 */
export function envFilePath(repoRoot: string, mode: LayoutMode = LAYOUT_MODE): string {
  if (mode === "legacy") {
    return join(repoRoot, "paperpilot", ".env");
  }
  return join(layoutFor(repoRoot, mode).config, ".env");
}

/**
 * Real `buildProvider`/`fetchImpl`/`cacheDir` wiring for the CLI entry
 * point (M2 of the P4 review: this used to be a stub that always printed
 * "not yet connected" and exited 1, regardless of argv — a CLI that
 * never does the thing it's named for). Mirrors
 * `buildDeepLineageCli.ts`'s `defaultDeps` (same `BuildLineageDeps`
 * shape); kept as a separate copy rather than a shared helper so each
 * CLI's wiring stays independently readable/testable, same as
 * `lineage/theme/cli.ts`'s own `defaultDeps`.
 */
export function defaultDeps(repoRoot: string = DEFAULT_REPO_ROOT): RunBuildLineageCliDeps {
  const env = loadEnv(envFilePath(repoRoot));
  const fetchImpl: BuildLineageDeps["fetchImpl"] = async (url, init) => {
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
    return {
      status: resp.status,
      json: async () => {
        try {
          return await resp.json();
        } finally {
          clearTimeout(timer);
        }
      },
    };
  };
  return {
    fetchImpl,
    cacheDir: cacheDirFor(repoRoot),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    email: env.openalexEmail,
    logger: {
      warn: (msg) => process.stderr.write(`${msg}\n`),
    },
    buildProvider: () =>
      buildProvider({
        env,
        ambientEnv: process.env,
        fetchImpl,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      }),
  };
}

export interface RunBuildLineageCliDeps extends BuildLineageDeps {
  buildProvider: () => { provider: LLMProvider; rateDelay: number };
}

export async function runBuildLineageCli(
  args: BuildLineageCliArgs,
  deps: RunBuildLineageCliDeps,
  repoRoot: string = DEFAULT_REPO_ROOT,
): Promise<number> {
  const docsRoot = layoutFor(repoRoot).published;
  const completeness = new BuildCompleteness();
  let result: Record<string, unknown>;
  try {
    const { provider, rateDelay } = deps.buildProvider();
    result = await build(
      {
        docsRoot,
        repoRoot,
        limit: args.limit,
        conference: args.conference,
        venueOverride: args.venueOverride,
        completeness,
        provider,
        rateDelayMs: rateDelay * 1000,
      },
      deps,
    );
  } catch (exc) {
    process.stderr.write(`error: ${(exc as Error).message}\n`);
    return 3;
  }
  const { lineagePath } = resolveConferencePaths(docsRoot, args.conference);

  if (!completeness.subjectComplete) {
    process.stderr.write(
      `incomplete build; published lineage left untouched: ${completeness.subjectGateMessage()}\n`,
    );
    return 4;
  }
  if (!args.allowIncomplete) {
    const nodes = result.nodes as unknown[];
    const edges = (result.edges as unknown[]) ?? [];
    const blocked = expansionGateBlocks(completeness, {
      newNodeCount: nodes.length,
      newEdgeCount: edges.length,
      publishedPath: lineagePath,
      newNodes: nodes,
      newEdges: edges,
    });
    if (blocked) {
      process.stderr.write(`incomplete build; published lineage left untouched: ${blocked}\n`);
      return 4;
    }
  }

  const meta = (result.meta ?? {}) as Record<string, unknown>;
  meta.completeness = completeness.asMeta();
  result.meta = meta;
  requireValidLineageArtifact(result, { kind: "conference" });
  // `edge.confidence`/`conf` are a Python float; wrap only for the bytes
  // written to disk (not `result` itself, already validated above as a
  // plain number and read again below for the stdout summary) so an
  // exactly-1.0/0.0 LLM confidence serializes as "1.0"/"0.0", not "1"/"0"
  // (p4-followups #24).
  const edgesForJson = ((result.edges as Record<string, unknown>[]) ?? []).map((e) => ({
    ...e,
    conf: pyFloat(e.conf as number),
    confidence: pyFloat(e.confidence as number),
  }));
  const resultForJson = { ...result, edges: edgesForJson };
  atomicWriteText(lineagePath, pyJsonDumps(resultForJson, { ensureAscii: false, indent: 2 }));

  const nodesArr = result.nodes as Record<string, unknown>[];
  const edgesArr = result.edges as Record<string, unknown>[];
  process.stdout.write(`\n✓ Wrote ${lineagePath}\n`);
  process.stdout.write(`  conference: ${args.conference}\n`);
  process.stdout.write(`  nodes: ${nodesArr.length}\n`);
  process.stdout.write(`  edges: ${edgesArr.length}\n`);
  const rels = new Map<string, number>();
  for (const e of edgesArr) {
    const rel = e.rel as string;
    rels.set(rel, (rels.get(rel) ?? 0) + 1);
  }
  for (const [k, v] of Array.from(rels.entries()).sort((a, b) => b[1] - a[1])) {
    process.stdout.write(`    ${k}: ${v}\n`);
  }
  return 0;
}

/**
 * Simplified analogue of argparse's auto-generated `--help` (same
 * documented simplification as `collect/cli.ts`'s own `HELP_TEXT`: a
 * bare token scan, not argparse's "value-consuming walk" — none of this
 * CLI's flags take a literal `--help`/`-h` as a legitimate value, so the
 * gap doesn't matter here). Required so the spawn test's "--help exits
 * 0" case doesn't fall through to `parseArgs` and get rejected as an
 * unrecognized flag (exit 2).
 */
export const HELP_TEXT = `usage: build_lineage [--limit N] [--conference SLUG] [--venue-override VENUE] [--allow-incomplete]`;

export function isHelpRequest(argv: readonly string[]): boolean {
  return argv.includes("--help") || argv.includes("-h");
}

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (isHelpRequest(argv)) {
    console.log(HELP_TEXT);
    process.exitCode = 0;
  } else {
    let parsed: BuildLineageCliArgs | undefined;
    try {
      parsed = parseArgs(argv);
    } catch (e) {
      if (e instanceof CliUsageError) {
        process.stderr.write(`error: ${e.message}\n`);
        process.exitCode = 2;
      } else {
        throw e;
      }
    }
    if (parsed !== undefined) {
      runBuildLineageCli(parsed, defaultDeps()).then(
        (code) => {
          process.exitCode = code;
        },
        // A dependency-construction failure (no LLM key configured,
        // LLM-44) must exit non-zero with a clear message — never leave
        // the process to exit 0 having done nothing.
        (err) => {
          process.stderr.write(`error: ${(err as Error).message}\n`);
          process.exitCode = 3;
        },
      );
    }
  }
}
