/**
 * CLI entry point mirroring `build_lineage.py`'s `main()` (`--limit`,
 * `--conference`, `--venue-override`, `--allow-incomplete`). LIN-05,
 * LIN-06, LIN-07, LIN-44.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pyJsonDumps } from "@paperpilot/core";
import type { LLMProvider } from "../../collect/llm/provider.js";
import { atomicWriteText } from "../../collect/state/atomic.js";
import { requireValidLineageArtifact } from "../contract/v1.js";
import { BuildCompleteness } from "../fetch-state/completeness.js";
import {
  type BuildLineageDeps,
  build,
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

export function parseArgs(argv: readonly string[]): BuildLineageCliArgs {
  let limit: number | null = null;
  let conference = "iclr-2026";
  let venueOverride: string | null = null;
  let allowIncomplete = false;
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    switch (tok) {
      case "--limit":
        limit = Number(argv[++i]);
        break;
      case "--conference":
        conference = argv[++i] as string;
        break;
      case "--venue-override":
        venueOverride = argv[++i] as string;
        break;
      case "--allow-incomplete":
        allowIncomplete = true;
        break;
      default:
        throw new Error(`unrecognized argument: ${tok}`);
    }
  }
  return { limit, conference, venueOverride, allowIncomplete };
}

export interface RunBuildLineageCliDeps extends BuildLineageDeps {
  buildProvider: () => { provider: LLMProvider; rateDelay: number };
}

export async function runBuildLineageCli(
  args: BuildLineageCliArgs,
  deps: RunBuildLineageCliDeps,
  repoRoot: string = DEFAULT_REPO_ROOT,
): Promise<number> {
  const docsRoot = join(repoRoot, "docs");
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
  atomicWriteText(lineagePath, pyJsonDumps(result, { ensureAscii: false, indent: 2 }));

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

if (import.meta.url === `file://${process.argv[1]}`) {
  // Intentionally left for a future wiring pass: constructing the real
  // `buildProvider`/`fetchImpl`/`cacheDir` deps here needs the ambient
  // `.env` loader (packages/core config, P1) wired the same way the
  // Python CLI's `setup_logging()` + `load_env()` are. Programmatic
  // callers (tests, the eventual promoter) should call
  // `runBuildLineageCli` directly with explicit deps.
  process.stderr.write(
    "build_lineage CLI wiring (env/provider construction) is not yet connected.\n",
  );
  process.exitCode = 1;
}
