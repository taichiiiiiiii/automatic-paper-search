/**
 * Offline topic-drift evaluation (R2-2b, R2-2d): re-apply the generation
 * rules that can be applied without a network to committed theme
 * lineages — same-title node merge (`dedup.ts::mergeDuplicateTitleNodes`),
 * the BFS admission gate (`topicScope.ts`) and the survey/dataset
 * `contrasts` guard (`relationGuard.ts`) — and report which nodes the
 * rules would drop, which seed they would pick as root, and the relation
 * histogram before/after. Reads only the given `lineage.json` files — no
 * network, no LLM, writes nothing. A classifier PROMPT change cannot be
 * evaluated here (the edges keep the relations the old prompt produced);
 * the real regeneration runs in CI (`regen-themes.yml`).
 *
 *   pnpm exec tsx apps/pipeline/src/lineage/theme/evalTopicDriftCli.ts \
 *     data/published/themes/graph-neural-network/lineage.json [...] [--json]
 *     [--min-support N] [--no-foundational]
 *
 * Exit 0 always on readable input (it is a report, not a gate); exit 2
 * on unreadable input or bad flags.
 */

import { readFileSync } from "node:fs";
import { isMain } from "../../shared/cli/isMain.js";
import type { DerivedEdge } from "../classify/classify.js";
import { mergeDuplicateTitleNodes } from "./dedup.js";
import { guardRelation } from "./relationGuard.js";
import {
  type ArtifactNodeLike,
  type OfflineAdmission,
  reapplyAdmission,
  TopicScope,
} from "./topicScope.js";

export interface ThemeDriftReport extends OfflineAdmission {
  path: string;
  theme: string;
  terms: readonly string[];
  nodeCountBefore: number;
  nodeCountAfter: number;
  /** Same-title duplicates folded into one node (preprint vs venue ID). */
  merged: { survivor: string; dropped: string; title: string }[];
  edgeCountBefore: number;
  edgeCountAfter: number;
  /** Relation histograms of the input edges and of the edges that
   * survive the merge + gate, after the relation guard. */
  relationsBefore: Record<string, number>;
  relationsAfter: Record<string, number>;
  /** Surviving `contrasts` edges the guard rewrote to `baseline_only`. */
  contrastsGuarded: { src: string; dst: string }[];
}

interface ArtifactEdgeLike {
  src: string;
  dst: string;
  rel?: unknown;
  relation?: unknown;
  conf?: unknown;
  confidence?: unknown;
  rationale?: unknown;
}

function relationOf(e: ArtifactEdgeLike): string {
  return String(e.relation ?? e.rel ?? "?");
}

function histogram(edges: readonly ArtifactEdgeLike[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of edges) out[relationOf(e)] = (out[relationOf(e)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export function evaluateArtifact(
  path: string,
  options: { minSupport?: number; admitFoundational?: boolean } = {},
): ThemeDriftReport {
  const data = JSON.parse(readFileSync(path, "utf-8")) as {
    root?: unknown;
    nodes: ArtifactNodeLike[];
    edges: ArtifactEdgeLike[];
    meta?: { theme?: unknown };
  };
  const theme = String(data.meta?.theme ?? "");
  if (!theme) throw new Error(`${path}: meta.theme missing`);
  const scope = TopicScope.forTheme(theme, {
    minSupport: options.minSupport,
    admitFoundational: options.admitFoundational,
  });
  const nodes = data.nodes ?? [];
  const edges = data.edges ?? [];
  const merged = mergeDuplicateTitleNodes(nodes, edges);
  const result = reapplyAdmission(
    { root: data.root, nodes: merged.nodes, edges: merged.edges },
    scope,
  );
  const keptIds = new Set(result.kept.map((k) => k.id));
  const byId = new Map(merged.nodes.map((n) => [n.id, n]));
  const contrastsGuarded: { src: string; dst: string }[] = [];
  const keptEdges = merged.edges
    .filter((e) => keptIds.has(e.src) && keptIds.has(e.dst))
    .map((e) => {
      const cls: DerivedEdge = {
        relation: relationOf(e) as DerivedEdge["relation"],
        confidence: Number(e.confidence ?? e.conf ?? 0),
        rationale: String(e.rationale ?? ""),
        provenance: "llm",
      };
      const guarded = guardRelation(cls, byId.get(e.src) ?? {}, byId.get(e.dst) ?? {});
      if (guarded === cls) return e;
      contrastsGuarded.push({ src: e.src, dst: e.dst });
      return { ...e, rel: guarded.relation, relation: guarded.relation };
    });
  return {
    path,
    theme,
    terms: scope.terms,
    nodeCountBefore: nodes.length,
    nodeCountAfter: result.kept.length,
    merged: merged.merged,
    edgeCountBefore: edges.length,
    edgeCountAfter: keptEdges.length,
    relationsBefore: histogram(edges),
    relationsAfter: histogram(keptEdges),
    contrastsGuarded,
    ...result,
  };
}

function fmtHist(h: Record<string, number>): string {
  return Object.entries(h)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
}

export function formatReport(r: ThemeDriftReport): string {
  const lines = [
    `== ${r.theme} (${r.path})`,
    `   terms: ${r.terms.join(" | ")}`,
    `   nodes: ${r.nodeCountBefore} -> ${r.nodeCountAfter} (merged ${r.merged.length}, drop ${r.dropped.length})`,
    `   edges: ${r.edgeCountBefore} -> ${r.edgeCountAfter} (contrasts guarded ${r.contrastsGuarded.length})`,
    `   relations before: ${fmtHist(r.relationsBefore)}`,
    `   relations after:  ${fmtHist(r.relationsAfter)}`,
    `   root:  ${r.previousRoot} -> ${r.root}`,
    ...r.merged.map((m) => `   merged: ${m.dropped} -> ${m.survivor} ${m.title.slice(0, 70)}`),
    "   kept:",
    ...r.kept.map((k) => `     + [${k.reason}] ${k.title.slice(0, 90)}`),
    "   dropped:",
    ...r.dropped.map(
      (d) => `     - [${d.rule}] (non-seed support ${d.support}) ${d.title.slice(0, 90)}`,
    ),
  ];
  return lines.join("\n");
}

export function runEvalCli(argv: readonly string[]): number {
  const paths: string[] = [];
  let json = false;
  let minSupport: number | undefined;
  let admitFoundational: boolean | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--json") json = true;
    else if (a === "--no-foundational") admitFoundational = false;
    else if (a === "--min-support") {
      const v = Number(argv[++i]);
      if (!Number.isInteger(v) || v < 1) {
        process.stderr.write("error: --min-support needs a positive integer\n");
        return 2;
      }
      minSupport = v;
    } else if (a.startsWith("--")) {
      process.stderr.write(`error: unknown flag ${a}\n`);
      return 2;
    } else paths.push(a);
  }
  if (paths.length === 0) {
    process.stderr.write(
      "usage: evalTopicDriftCli.ts <lineage.json>... [--json] [--min-support N]\n",
    );
    return 2;
  }
  const reports: ThemeDriftReport[] = [];
  for (const p of paths) {
    try {
      reports.push(evaluateArtifact(p, { minSupport, admitFoundational }));
    } catch (e) {
      process.stderr.write(`error: ${(e as Error).message}\n`);
      return 2;
    }
  }
  process.stdout.write(
    json ? `${JSON.stringify(reports, null, 2)}\n` : `${reports.map(formatReport).join("\n\n")}\n`,
  );
  return 0;
}

if (isMain(import.meta.url)) {
  process.exitCode = runEvalCli(process.argv.slice(2));
}
