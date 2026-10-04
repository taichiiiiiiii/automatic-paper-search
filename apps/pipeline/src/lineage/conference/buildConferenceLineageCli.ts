/**
 * CLI entry point mirroring `build_conference_lineage.py`'s `main()`
 * (`--conference`, `--display`, `--max-orals`, `--refs`, `--citers`,
 * `--email`, `--allow-incomplete`). LIN-08, LIN-09, LIN-10, LIN-11.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pyJsonDumps } from "@paperpilot/core";
import { validateConferenceSlug } from "../../catalog/slug.js";
import { atomicWriteText } from "../../collect/state/atomic.js";
import { requireValidLineageArtifact } from "../contract/v1.js";
import { BuildCompleteness, expansionGateBlocks } from "../fetch-state/completeness.js";
import { buildGraph, loadOrals, type OpenAlexDeps } from "./buildConferenceLineage.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// apps/pipeline/src/lineage/conference -> repo root (5 levels up).
const DEFAULT_REPO_ROOT = resolve(HERE, "..", "..", "..", "..", "..");

export interface BuildConferenceLineageCliArgs {
  conference: string;
  display: string | null;
  maxOrals: number;
  refs: number;
  citers: number;
  email: string | null;
  allowIncomplete: boolean;
}

export function parseArgs(argv: readonly string[]): BuildConferenceLineageCliArgs {
  let conference: string | undefined;
  let display: string | null = null;
  let maxOrals = 20;
  let refs = 4;
  let citers = 2;
  let email: string | null = null;
  let allowIncomplete = false;
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    switch (tok) {
      case "--conference":
        conference = argv[++i];
        break;
      case "--display":
        display = argv[++i] as string;
        break;
      case "--max-orals":
        maxOrals = Number(argv[++i]);
        break;
      case "--refs":
        refs = Number(argv[++i]);
        break;
      case "--citers":
        citers = Number(argv[++i]);
        break;
      case "--email":
        email = argv[++i] as string;
        break;
      case "--allow-incomplete":
        allowIncomplete = true;
        break;
      default:
        throw new Error(`unrecognized argument: ${tok}`);
    }
  }
  if (conference === undefined) throw new Error("--conference is required");
  return { conference, display, maxOrals, refs, citers, email, allowIncomplete };
}

export async function runBuildConferenceLineageCli(
  args: BuildConferenceLineageCliArgs,
  deps: OpenAlexDeps,
  repoRoot: string = DEFAULT_REPO_ROOT,
): Promise<number> {
  const docsRoot = join(repoRoot, "docs");
  validateConferenceSlug(args.conference);
  const display = args.display || args.conference.toUpperCase().replace(/-/g, " ");
  const orals = loadOrals(docsRoot, args.conference, args.maxOrals);
  if (orals.length === 0) {
    process.stdout.write(`⚠️  no Oral papers in docs/${args.conference}/papers.json\n`);
    return 1;
  }

  const completeness = new BuildCompleteness();
  const graph = await buildGraph(
    orals,
    { display, refsPer: args.refs, citersPer: args.citers, email: args.email, completeness },
    deps,
  );
  const out = join(docsRoot, args.conference, "lineage.json");

  if (!completeness.subjectComplete) {
    process.stderr.write(
      `incomplete build; published lineage left untouched: ${completeness.subjectGateMessage()}\n`,
    );
    return 4;
  }
  if (!args.allowIncomplete) {
    const nodes = graph.nodes as unknown[];
    const edges = (graph.edges as unknown[]) ?? [];
    const blocked = expansionGateBlocks(completeness, {
      newNodeCount: nodes.length,
      newEdgeCount: edges.length,
      publishedPath: out,
      newNodes: nodes,
      newEdges: edges,
    });
    if (blocked) {
      process.stderr.write(`incomplete build; published lineage left untouched: ${blocked}\n`);
      return 4;
    }
  }

  requireValidLineageArtifact(graph, { kind: "conference" });
  atomicWriteText(out, pyJsonDumps(graph, { ensureAscii: false, indent: 0 }));
  const nodesArr = graph.nodes as Record<string, unknown>[];
  const focus = nodesArr.filter((n) => n.is_focus).length;
  process.stdout.write(
    `✅ ${nodesArr.length} nodes (${focus} orals), ${(graph.edges as unknown[]).length} edges -> ${out}\n`,
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { fetch } = globalThis as unknown as { fetch: OpenAlexDeps["fetchImpl"] };
  runBuildConferenceLineageCli(parseArgs(process.argv.slice(2)), { fetchImpl: fetch }).then(
    (code) => {
      process.exitCode = code;
    },
  );
}
