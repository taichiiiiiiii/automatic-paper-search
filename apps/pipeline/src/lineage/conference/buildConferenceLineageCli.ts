/**
 * CLI entry point mirroring `build_conference_lineage.py`'s `main()`
 * (`--conference`, `--display`, `--max-orals`, `--refs`, `--citers`,
 * `--email`, `--allow-incomplete`). LIN-08, LIN-09, LIN-10, LIN-11.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pyJsonDumps } from "@paperpilot/core";
import { layoutFor } from "@paperpilot/core/layout";
import { validateConferenceSlug } from "@paperpilot/core/slug";
import type { FetchInit, HttpResponseLike } from "../../collect/http/requestWithRetry.js";
import { atomicWriteText } from "../../collect/state/atomic.js";
import { parseArgs as parseFlags } from "../../shared/cli/argparse.js";
import { isMain } from "../../shared/cli/isMain.js";
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

/**
 * M3 of the P4 review: mirrors `build_conference_lineage.py`'s argparse
 * flags through the shared strict parser instead of a hand-rolled
 * `switch` (which silently became `NaN` for a bad `--max-orals`/`--refs`/
 * `--citers` via `Number(argv[++i])`).
 */
export function parseArgs(argv: readonly string[]): BuildConferenceLineageCliArgs {
  const parsed = parseFlags(argv, {
    conference: { type: "string", required: true },
    display: { type: "string" },
    "max-orals": { type: "int", default: 20 },
    refs: { type: "int", default: 4 },
    citers: { type: "int", default: 2 },
    email: { type: "string" },
    "allow-incomplete": { type: "boolean" },
  });
  return {
    conference: parsed.conference as string,
    display: (parsed.display as string | undefined) ?? null,
    maxOrals: parsed["max-orals"] as number,
    refs: parsed.refs as number,
    citers: parsed.citers as number,
    email: (parsed.email as string | undefined) ?? null,
    allowIncomplete: parsed["allow-incomplete"] as boolean,
  };
}

export async function runBuildConferenceLineageCli(
  args: BuildConferenceLineageCliArgs,
  deps: OpenAlexDeps,
  repoRoot: string = DEFAULT_REPO_ROOT,
): Promise<number> {
  const docsRoot = layoutFor(repoRoot).published;
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

/**
 * M6 (review): the raw global `fetch` has no timeout of its own — an
 * OpenAlex request that never resolves (hung TCP connection, a load
 * balancer that accepts the connection but never responds) would hang
 * this CLI run forever. Wraps every call with the same AbortController +
 * timer pattern `lineage/theme/cli.ts`'s `defaultDeps` uses, including
 * that same fix's lesson (see its comment): the timer must stay armed
 * through `resp.json()`, not just until `fetch()` resolves with headers,
 * or a server that sends headers promptly and then stalls the body would
 * still hang indefinitely.
 */
export function defaultFetchImpl(
  fetchFn: typeof fetch = fetch,
): (url: string, init: FetchInit) => Promise<HttpResponseLike> {
  return async (url, init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), init.timeoutMs);
    let resp: Response;
    try {
      resp = await fetchFn(url, {
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
}

if (isMain(import.meta.url)) {
  let parsed: BuildConferenceLineageCliArgs | undefined;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`error: ${(e as Error).message}\n`);
    process.exitCode = 2;
  }
  if (parsed !== undefined) {
    runBuildConferenceLineageCli(parsed, {
      fetchImpl: defaultFetchImpl(),
    }).then((code) => {
      process.exitCode = code;
    });
  }
}
