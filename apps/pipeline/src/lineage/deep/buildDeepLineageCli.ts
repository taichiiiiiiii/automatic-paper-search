/**
 * CLI entry point mirroring `build_deep_lineage.py`'s `main()`
 * (`--arxiv-id`, `--seed-paper-id`, `--depth`, `--top-parents`,
 * `--top-children`, `--venue-override`, `--tier-override`,
 * `--allow-incomplete`, `--output`). LIN-12, LIN-13, LIN-14.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pyJsonDumps } from "@paperpilot/core";
import type { LLMProvider } from "../../collect/llm/provider.js";
import { atomicWriteText } from "../../collect/state/atomic.js";
import type { BuildLineageDeps } from "../conference/buildLineage.js";
import { requireValidLineageArtifact } from "../contract/v1.js";
import { BuildCompleteness } from "../fetch-state/completeness.js";
import {
  buildDeep,
  DeepSubjectIncompleteError,
  DeepSubjectNotFoundError,
  expansionGateBlocks,
} from "./buildDeepLineage.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// apps/pipeline/src/lineage/deep -> repo root (5 levels up).
const DEFAULT_REPO_ROOT = resolve(HERE, "..", "..", "..", "..", "..");

export interface BuildDeepLineageCliArgs {
  arxivId: string;
  seedPaperId: string;
  depth: number;
  topParents: number;
  topChildren: number;
  venueOverride: string;
  tierOverride: string;
  allowIncomplete: boolean;
  output: string | null;
}

export function parseArgs(argv: readonly string[]): BuildDeepLineageCliArgs {
  let arxivId: string | undefined;
  let seedPaperId: string | undefined;
  let depth = 2;
  let topParents = 20;
  let topChildren = 20;
  let venueOverride = "ICLR 2026";
  let tierOverride = "A+";
  let allowIncomplete = false;
  let output: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    switch (tok) {
      case "--arxiv-id":
        arxivId = argv[++i];
        break;
      case "--seed-paper-id":
        seedPaperId = argv[++i];
        break;
      case "--depth":
        depth = Number(argv[++i]);
        break;
      case "--top-parents":
        topParents = Number(argv[++i]);
        break;
      case "--top-children":
        topChildren = Number(argv[++i]);
        break;
      case "--venue-override":
        venueOverride = argv[++i] as string;
        break;
      case "--tier-override":
        tierOverride = argv[++i] as string;
        break;
      case "--allow-incomplete":
        allowIncomplete = true;
        break;
      case "--output":
        output = argv[++i] as string;
        break;
      default:
        throw new Error(`unrecognized argument: ${tok}`);
    }
  }
  if (arxivId === undefined) throw new Error("--arxiv-id is required");
  if (seedPaperId === undefined) throw new Error("--seed-paper-id is required");
  return {
    arxivId,
    seedPaperId,
    depth,
    topParents,
    topChildren,
    venueOverride,
    tierOverride,
    allowIncomplete,
    output,
  };
}

export interface RunBuildDeepLineageCliDeps extends BuildLineageDeps {
  buildProvider: () => { provider: LLMProvider; rateDelay: number };
}

export async function runBuildDeepLineageCli(
  args: BuildDeepLineageCliArgs,
  deps: RunBuildDeepLineageCliDeps,
  repoRoot: string = DEFAULT_REPO_ROOT,
): Promise<number> {
  const completeness = new BuildCompleteness();
  const { provider, rateDelay } = deps.buildProvider();
  let result: Record<string, unknown>;
  try {
    result = await buildDeep(
      args.arxivId,
      {
        seedPaperId: args.seedPaperId,
        depth: args.depth,
        topParents: args.topParents,
        topChildren: args.topChildren,
        venueOverride: args.venueOverride,
        tierOverride: args.tierOverride,
        completeness,
        provider,
        rateDelayMs: rateDelay * 1000,
      },
      deps,
    );
  } catch (exc) {
    if (exc instanceof DeepSubjectIncompleteError) {
      process.stderr.write(`${exc.message}\n`);
      return 4;
    }
    if (exc instanceof DeepSubjectNotFoundError) {
      process.stderr.write(`${exc.message}\n`);
      return 1;
    }
    throw exc;
  }
  const meta = result.meta as Record<string, unknown>;
  meta.completeness = completeness.asMeta();

  const out =
    args.output ?? join(repoRoot, "docs", "iclr-2026", `deep-${meta.arxiv_id as string}.json`);

  if (!args.allowIncomplete) {
    const nodes = result.nodes as unknown[];
    const edges = (result.edges as unknown[]) ?? [];
    const blocked = expansionGateBlocks(completeness, {
      newNodeCount: nodes.length,
      newEdgeCount: edges.length,
      publishedPath: out,
      newNodes: nodes,
      newEdges: edges,
    });
    if (blocked) {
      process.stderr.write(`incomplete build; published artifact left untouched: ${blocked}\n`);
      return 4;
    }
  }

  requireValidLineageArtifact(result, {
    kind: "deep",
    catalogIds: new Set([meta.seed_paper_id as string]),
    expectedSeedPaperId: meta.seed_paper_id as string,
  });
  atomicWriteText(out, pyJsonDumps(result, { ensureAscii: false, indent: 2 }));

  const nodesArr = result.nodes as unknown[];
  const edgesArr = result.edges as Record<string, unknown>[];
  process.stdout.write(`\n✓ Wrote ${out}\n`);
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
