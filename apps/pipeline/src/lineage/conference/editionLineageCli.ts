/**
 * R2-32 (design 41): CLI of the LLM-free conference ("edition") lineage
 * (`editionLineage.ts`). Same evidence pipeline, gates and publish guard as
 * the theme CLI:
 *
 *   pnpm exec tsx apps/pipeline/src/lineage/conference/editionLineageCli.ts \
 *     --conference icml-2025 [--seeds 12 --parents 6 --children 6]
 *
 * Exit codes (theme CLI parity):
 *   0 written; 2 usage; 3 build error / no edges;
 *   4 incomplete fetch (venue search failed, or a shrink after failed
 *     expansions) — published file untouched;
 *   5 evidence-classified rate under the policy threshold — untouched;
 *   6 R2-37 publish guard: the build would hide (blocked) or shrink
 *     (< 50% nodes, `--allow-shrink`) a published conference lineage —
 *     untouched.
 * Opt-in evidence (env, like the theme CLI): `PAPERPILOT_ARXIV_HTML=on`
 * (+ `PAPERPILOT_ARXIV_HTML_MAX_FETCHES`). No LLM is ever used.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pyFloat, pyJsonDumps } from "@paperpilot/core";
import { auditFixtures, layoutFor, lineageCacheDir, qualityPolicy } from "@paperpilot/core/layout";
import { loadEnv } from "../../collect/config/env.js";
import type { FetchLike } from "../../collect/http/requestWithRetry.js";
import { atomicWriteText } from "../../collect/state/atomic.js";
import { CliUsageError, parseArgs as parseFlags } from "../../shared/cli/argparse.js";
import { isMain } from "../../shared/cli/isMain.js";
import { BuildCompleteness, expansionGateBlocks } from "../fetch-state/completeness.js";
import {
  ARXIV_HTML_FILENAME,
  ArxivHtmlContextSource,
  DEFAULT_MAX_FETCHES,
} from "../theme/arxivHtmlSource.js";
import {
  DEFAULT_MIN_CLASSIFIED_RATE,
  EXIT_DEGRADED_CLASSIFICATION,
  evidenceClassifiedRate,
} from "../theme/classificationGate.js";
import { envFilePath, fetchTextImpl, resolveMinClassifiedRate } from "../theme/cli.js";
import {
  EXIT_REGRESSION_REFUSED,
  evaluateTheme,
  type GuardTarget,
  loadGuardContext,
  publishedTheme,
  regressionRefusal,
} from "../theme/publishGuard.js";
import { S2_REFERENCES_FILENAME, S2CitationSource } from "../theme/s2Citations.js";
import {
  buildEditionLineage,
  DEFAULT_CHILDREN,
  DEFAULT_PARENTS,
  DEFAULT_SEEDS,
  SEED_CACHE_FILENAME,
} from "./editionLineage.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// apps/pipeline/src/lineage/conference -> repo root (5 levels up).
const DEFAULT_REPO_ROOT = resolve(HERE, "..", "..", "..", "..", "..");

export const HELP_TEXT =
  "usage: editionLineageCli --conference SLUG [--seeds N] [--parents N] [--children N] " +
  "[--s2-venue VENUE] [--allow-shrink] [--allow-incomplete] [--now ISO]";

export interface EditionCliArgs {
  conference: string;
  seeds: number;
  parents: number;
  children: number;
  s2Venue: string | null;
  allowShrink: boolean;
  allowIncomplete: boolean;
  now: string | null;
}

export function parseArgs(argv: readonly string[]): EditionCliArgs {
  const p = parseFlags(argv, {
    conference: { type: "string", required: true },
    seeds: { type: "int", default: DEFAULT_SEEDS },
    parents: { type: "int", default: DEFAULT_PARENTS },
    children: { type: "int", default: DEFAULT_CHILDREN },
    "s2-venue": { type: "string" },
    "allow-shrink": { type: "boolean" },
    "allow-incomplete": { type: "boolean" },
    now: { type: "string" },
  });
  const args: EditionCliArgs = {
    conference: p.conference as string,
    seeds: p.seeds as number,
    parents: p.parents as number,
    children: p.children as number,
    s2Venue: (p["s2-venue"] as string | undefined) ?? null,
    allowShrink: p["allow-shrink"] as boolean,
    allowIncomplete: p["allow-incomplete"] as boolean,
    now: (p.now as string | undefined) ?? null,
  };
  for (const k of ["seeds", "parents", "children"] as const) {
    if (!(args[k] >= 1 && args[k] <= 50)) throw new CliUsageError(`--${k} must be 1..50`);
  }
  if (args.now !== null && Number.isNaN(Date.parse(args.now))) {
    throw new CliUsageError("--now must be an ISO timestamp");
  }
  return args;
}

function switchOn(env: NodeJS.ProcessEnv, name: string): boolean {
  const v = (env[name] ?? "").trim().toLowerCase();
  if (v === "on") return true;
  if (v !== "" && v !== "off") process.stderr.write(`warning: ${name}=${v} is not on/off; off\n`);
  return false;
}

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const n = Number.parseInt(env[name] ?? "", 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

const fetchJsonImpl: FetchLike = async (url, init) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs);
  timer.unref?.();
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

function readBytesOrNull(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

export async function runEditionCli(
  argv: readonly string[],
  repoRoot: string = DEFAULT_REPO_ROOT,
): Promise<number> {
  let args: EditionCliArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (e instanceof CliUsageError) {
      process.stderr.write(`error: ${e.message}\n`);
      return 2;
    }
    throw e;
  }
  const layout = layoutFor(repoRoot);
  const docsRoot = layout.published;
  const cacheDir = lineageCacheDir(layout);
  const env = loadEnv(envFilePath(repoRoot));
  const fixedNow = args.now === null ? null : new Date(args.now);
  const now = (): Date => fixedNow ?? new Date();
  const warn = (msg: string): void => {
    process.stderr.write(`${msg}\n`);
  };
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const s2 = new S2CitationSource(join(cacheDir, S2_REFERENCES_FILENAME), {
    fetchImpl: fetchJsonImpl,
    sleep,
    now,
    apiKey: env.s2ApiKey,
    logger: { warn },
  });
  const arxivHtml = switchOn(process.env, "PAPERPILOT_ARXIV_HTML")
    ? new ArxivHtmlContextSource(join(cacheDir, ARXIV_HTML_FILENAME), {
        fetchText: fetchTextImpl,
        sleep,
        now,
        contact: env.openalexEmail,
        maxFetches: positiveInt(
          process.env,
          "PAPERPILOT_ARXIV_HTML_MAX_FETCHES",
          DEFAULT_MAX_FETCHES,
        ),
        logger: { warn },
      })
    : null;
  const policyPath = qualityPolicy(layout);
  let minRate = DEFAULT_MIN_CLASSIFIED_RATE;
  try {
    minRate = resolveMinClassifiedRate(null, policyPath);
  } catch (e) {
    process.stderr.write(`error: ${(e as Error).message}\n`);
    return 2;
  }

  const completeness = new BuildCompleteness();
  let artifact: Record<string, unknown>;
  try {
    ({ artifact } = await buildEditionLineage(
      {
        conference: args.conference,
        docsRoot,
        seeds: args.seeds,
        parents: args.parents,
        children: args.children,
        s2Venue: args.s2Venue,
        completeness,
      },
      { s2, arxivHtml, seedCachePath: join(cacheDir, SEED_CACHE_FILENAME), now, logger: { warn } },
    ));
  } catch (exc) {
    s2.flush();
    arxivHtml?.flush();
    process.stderr.write(`error: ${(exc as Error).message}\n`);
    return completeness.subjectComplete ? 3 : 4;
  }
  s2.flush();
  arxivHtml?.flush();
  warn(s2.summary());
  if (arxivHtml !== null) warn(arxivHtml.summary());

  const lineagePath = join(docsRoot, args.conference, "lineage.json");
  const nodes = artifact.nodes as unknown[];
  const edges = artifact.edges as Record<string, unknown>[];
  if (edges.length === 0) {
    process.stderr.write("error: no edges; published lineage left untouched\n");
    return 3;
  }
  if (!args.allowIncomplete) {
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
  const meta = artifact.meta as Record<string, unknown>;
  meta.completeness = completeness.asMeta();
  const rate = evidenceClassifiedRate(meta.provenance_breakdown as Record<string, number>);
  if (rate.ratio !== null && rate.ratio < minRate) {
    process.stderr.write(
      `::error::evidence-classified rate ${(rate.ratio * 100).toFixed(1)}% < ${(minRate * 100).toFixed(0)}% ` +
        `(guessed ${rate.guessed}/${rate.total}); published lineage left untouched\n`,
    );
    return EXIT_DEGRADED_CLASSIFICATION;
  }

  const edgesForJson = edges.map((e) => ({
    ...e,
    conf: pyFloat(e.conf as number),
    confidence: pyFloat(e.confidence as number),
  }));
  const text = pyJsonDumps({ ...artifact, edges: edgesForJson }, { ensureAscii: false, indent: 2 });

  // R2-37 parity: never replace a published conference lineage with one the
  // quality table would block, or with < 50% of its nodes.
  const catalog = JSON.parse(
    readFileSync(join(docsRoot, args.conference, "papers.json"), "utf8"),
  ) as Record<string, unknown>[];
  const target: GuardTarget = {
    kind: "conference",
    catalogIds: new Set(
      catalog.map((r) => r.paper_id).filter((x): x is string => typeof x === "string"),
    ),
  };
  const ctx = loadGuardContext({
    policyPath,
    fixturesPath: auditFixtures(layout),
    minClassifiedRate: minRate,
    now,
  });
  const published = publishedTheme(readBytesOrNull(lineagePath), args.conference, ctx, target);
  const candidate = evaluateTheme(Buffer.from(text, "utf8"), args.conference, ctx, {
    target,
    withAudit: true,
  });
  warn(
    `publish guard: candidate ${candidate.tier} (${candidate.nodeCount} nodes / ${candidate.edgeCount} edges)` +
      (candidate.failed.length > 0 ? `; failed: ${candidate.failed.join("; ")}` : "") +
      (published === null ? "; nothing published" : `; published ${published.tier}`),
  );
  const refusal = regressionRefusal(published, candidate, {
    allowShrink: args.allowShrink,
    allowReaudit: true,
    noun: "conference lineage",
  });
  if (refusal !== null) {
    process.stderr.write(`::error::${refusal}\n`);
    return EXIT_REGRESSION_REFUSED;
  }

  atomicWriteText(lineagePath, text);
  process.stdout.write(
    `\n✓ Wrote ${lineagePath}\n  conference: ${args.conference}\n  nodes: ${nodes.length}\n  edges: ${edges.length}\n  tier (without audit): ${candidate.tier}\n`,
  );
  const rels = new Map<string, number>();
  for (const e of edges) rels.set(e.relation as string, (rels.get(e.relation as string) ?? 0) + 1);
  for (const [k, v] of [...rels.entries()].sort((a, b) => b[1] - a[1])) {
    process.stdout.write(`    ${k}: ${v}\n`);
  }
  return 0;
}

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP_TEXT);
  } else {
    runEditionCli(argv).then(
      (code) => {
        process.exitCode = code;
      },
      (err) => {
        process.stderr.write(`error: ${(err as Error).message}\n`);
        process.exitCode = 3;
      },
    );
  }
}
