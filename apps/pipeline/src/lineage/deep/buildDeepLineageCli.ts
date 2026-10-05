/**
 * CLI entry point mirroring `build_deep_lineage.py`'s `main()`
 * (`--arxiv-id`, `--seed-paper-id`, `--depth`, `--top-parents`,
 * `--top-children`, `--venue-override`, `--tier-override`,
 * `--allow-incomplete`, `--output`). LIN-12, LIN-13, LIN-14.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pyFloat, pyJsonDumps } from "@paperpilot/core";
import { layoutFor } from "@paperpilot/core/layout";
import { loadEnv } from "../../collect/config/env.js";
import type { LLMProvider } from "../../collect/llm/provider.js";
import { atomicWriteText } from "../../collect/state/atomic.js";
import { CliUsageError, parseArgs as parseFlags } from "../../shared/cli/argparse.js";
import { isMain } from "../../shared/cli/isMain.js";
import { type BuildLineageDeps, cacheDirFor } from "../conference/buildLineage.js";
import { requireValidLineageArtifact } from "../contract/v1.js";
import { BuildCompleteness } from "../fetch-state/completeness.js";
import { buildProvider } from "../shared/providerFactory.js";
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

/**
 * M3 of the P4 review: mirrors `build_deep_lineage.py`'s argparse flags
 * through the shared strict parser instead of a hand-rolled `switch`
 * (which let `--depth`/`--top-parents`/`--top-children` silently become
 * `NaN` on a bad value).
 */
export function parseArgs(argv: readonly string[]): BuildDeepLineageCliArgs {
  const parsed = parseFlags(argv, {
    "arxiv-id": { type: "string", required: true },
    "seed-paper-id": { type: "string", required: true },
    depth: { type: "int", default: 2 },
    "top-parents": { type: "int", default: 20 },
    "top-children": { type: "int", default: 20 },
    "venue-override": { type: "string", default: "ICLR 2026" },
    "tier-override": { type: "string", default: "A+" },
    "allow-incomplete": { type: "boolean" },
    output: { type: "string" },
  });
  return {
    arxivId: parsed["arxiv-id"] as string,
    seedPaperId: parsed["seed-paper-id"] as string,
    depth: parsed.depth as number,
    topParents: parsed["top-parents"] as number,
    topChildren: parsed["top-children"] as number,
    venueOverride: parsed["venue-override"] as string,
    tierOverride: parsed["tier-override"] as string,
    allowIncomplete: parsed["allow-incomplete"] as boolean,
    output: (parsed.output as string | undefined) ?? null,
  };
}

/**
 * Real `buildProvider`/`fetchImpl`/`cacheDir` wiring for the CLI entry
 * point (M2 of the P4 review: this file used to have NO entry block at
 * all, so running it for real did nothing). `LLM-24` note: the thunk is
 * passed through uncalled — `buildDeep` invokes it only once the arXiv
 * identity check has already succeeded, same as `runBuildDeepLineageCli`
 * requires of every caller.
 */
export function defaultDeps(repoRoot: string = DEFAULT_REPO_ROOT): RunBuildDeepLineageCliDeps {
  const env = loadEnv(join(repoRoot, "paperpilot", ".env"));
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

export interface RunBuildDeepLineageCliDeps extends BuildLineageDeps {
  buildProvider: () => { provider: LLMProvider; rateDelay: number };
}

export async function runBuildDeepLineageCli(
  args: BuildDeepLineageCliArgs,
  deps: RunBuildDeepLineageCliDeps,
  repoRoot: string = DEFAULT_REPO_ROOT,
): Promise<number> {
  const completeness = new BuildCompleteness();
  // LIN-24: do NOT call `deps.buildProvider()` here. `buildDeep` must
  // confirm the S2 response's arXiv id matches the requested one BEFORE
  // any provider is constructed; passing the thunk (rather than calling
  // it eagerly) lets `buildDeep` invoke it at the right point, only once
  // the identity check has already succeeded.
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
        buildProvider: deps.buildProvider,
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
    args.output ??
    join(layoutFor(repoRoot).published, "iclr-2026", `deep-${meta.arxiv_id as string}.json`);

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
  // `edge.confidence`/`conf` are a Python float; wrap only for the bytes
  // written to disk, not `result` itself (already validated above as a
  // plain number), so an exactly-1.0/0.0 LLM confidence serializes as
  // "1.0"/"0.0", not "1"/"0" (p4-followups #24).
  const edgesForJson = ((result.edges as Record<string, unknown>[]) ?? []).map((e) => ({
    ...e,
    conf: pyFloat(e.conf as number),
    confidence: pyFloat(e.confidence as number),
  }));
  const resultForJson = { ...result, edges: edgesForJson };
  atomicWriteText(out, pyJsonDumps(resultForJson, { ensureAscii: false, indent: 2 }));

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

if (isMain(import.meta.url)) {
  let parsed: BuildDeepLineageCliArgs | undefined;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (e) {
    if (e instanceof CliUsageError) {
      process.stderr.write(`error: ${e.message}\n`);
      process.exitCode = 2;
    } else {
      throw e;
    }
  }
  if (parsed !== undefined) {
    runBuildDeepLineageCli(parsed, defaultDeps()).then(
      (code) => {
        process.exitCode = code;
      },
      // `buildProvider()` throwing (no LLM key configured, LLM-44) or any
      // other dependency-construction failure must exit non-zero with a
      // clear message — never leave the process to exit 0 having done
      // nothing (the exact failure mode `buildLineageCli.ts`'s old stub
      // guard avoided only by refusing to run at all).
      (err) => {
        process.stderr.write(`error: ${(err as Error).message}\n`);
        process.exitCode = 3;
      },
    );
  }
}
