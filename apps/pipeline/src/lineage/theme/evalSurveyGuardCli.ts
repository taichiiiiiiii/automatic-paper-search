/**
 * Offline survey-citing relation guard report (R2-15).
 *
 * Re-applies `relationGuard.ts::guardRelation` to committed theme
 * lineages and lists every edge whose relation it would change — above
 * all edges whose CITING paper (`dst`, newer) is a survey/review
 * (`shared/surveyLike.ts`: publication type, title, abstract/TL;DR) but
 * was published as extends/successor/supersedes/contrasts. Reads only the
 * given `lineage.json` files — no network, no LLM. With `--out DIR` it
 * also writes guarded copies as `DIR/<slug>/lineage.json` (refuses to
 * write under `data/published`); otherwise it writes nothing.
 *
 *   pnpm exec tsx apps/pipeline/src/lineage/theme/evalSurveyGuardCli.ts \
 *     data/published/themes/* /lineage.json [--json] [--out DIR]
 *
 * Exit 0 on readable input (a report, not a gate); 2 on bad input/flags.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { isMain } from "../../shared/cli/isMain.js";
import type { DerivedEdge } from "../classify/classify.js";
import { isSurveyLike } from "../shared/surveyLike.js";
import { classificationMethodOf, promptVersionOf } from "./evalTopicDriftCli.js";
import { guardRelation } from "./relationGuard.js";

interface NodeLike {
  id: string;
  title?: unknown;
  year?: unknown;
  [k: string]: unknown;
}

interface EdgeLike {
  src: string;
  dst: string;
  rel?: unknown;
  relation?: unknown;
  conf?: unknown;
  confidence?: unknown;
  rationale?: unknown;
  provenance?: unknown;
  [k: string]: unknown;
}

export interface SurveyGuardChange {
  src: string;
  dst: string;
  srcTitle: string;
  dstTitle: string;
  method: string;
  before: { relation: string; confidence: number };
  after: { relation: string; confidence: number };
  /** Why: the citing paper is survey-like, or a survey/dataset endpoint of a contrasts. */
  reason: "citing_survey" | "contrasts_endpoint" | "contrasts_no_context";
  rationale: string;
}

export interface SurveyGuardReport {
  path: string;
  theme: string;
  edgeCount: number;
  surveyLikeNodes: { id: string; title: string }[];
  changes: SurveyGuardChange[];
}

/** Apply the guard to one parsed artifact; returns the report and the
 * guarded artifact (a new object; the input is not mutated). */
export function guardArtifact(
  path: string,
  data: { nodes?: NodeLike[]; edges?: EdgeLike[]; meta?: { theme?: unknown } } & Record<
    string,
    unknown
  >,
): { report: SurveyGuardReport; guarded: Record<string, unknown> } {
  const nodes = data.nodes ?? [];
  const edges = data.edges ?? [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const changes: SurveyGuardChange[] = [];
  const newEdges = edges.map((e) => {
    const parent = byId.get(e.src) ?? { id: e.src };
    const child = byId.get(e.dst) ?? { id: e.dst };
    const relation = String(e.relation ?? e.rel ?? "");
    const cls: DerivedEdge = {
      relation: relation as DerivedEdge["relation"],
      confidence: Number(e.confidence ?? e.conf ?? 0),
      rationale: String(e.rationale ?? ""),
      provenance: classificationMethodOf(e),
    };
    const pv = promptVersionOf(e);
    if (pv !== undefined) cls.promptVersion = pv;
    const g = guardRelation(cls, parent, child);
    if (g === cls) return e;
    changes.push({
      src: e.src,
      dst: e.dst,
      srcTitle: String(parent.title ?? ""),
      dstTitle: String(child.title ?? ""),
      method: cls.provenance,
      before: { relation: cls.relation, confidence: cls.confidence },
      after: { relation: g.relation, confidence: g.confidence },
      reason: g.rationale.startsWith("引用側")
        ? "citing_survey"
        : g.rationale.startsWith("引用文に")
          ? "contrasts_no_context"
          : "contrasts_endpoint",
      rationale: g.rationale,
    });
    return {
      ...e,
      rel: g.relation,
      relation: g.relation,
      conf: g.confidence,
      confidence: g.confidence,
      rationale: g.rationale,
    };
  });
  return {
    report: {
      path,
      theme: String(data.meta?.theme ?? ""),
      edgeCount: edges.length,
      surveyLikeNodes: nodes
        .filter((n) => isSurveyLike(n))
        .map((n) => ({ id: n.id, title: String(n.title ?? "") })),
      changes,
    },
    guarded: { ...data, edges: newEdges },
  };
}

export function formatSurveyGuardReport(r: SurveyGuardReport): string {
  return [
    `== ${r.theme} (${r.path}) edges=${r.edgeCount} changed=${r.changes.length}`,
    `   survey-like nodes: ${r.surveyLikeNodes.map((n) => n.title.slice(0, 70)).join(" | ") || "-"}`,
    ...r.changes.map(
      (c) =>
        `   ~ [${c.reason}/${c.method}] ${c.before.relation}@${c.before.confidence} -> ` +
        `${c.after.relation}@${c.after.confidence}: ${c.srcTitle.slice(0, 50)} -> ${c.dstTitle.slice(0, 60)}`,
    ),
  ].join("\n");
}

export function runSurveyGuardCli(argv: readonly string[]): number {
  const paths: string[] = [];
  let json = false;
  let out: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--json") json = true;
    else if (a === "--out") {
      const v = argv[++i];
      if (!v) {
        process.stderr.write("error: --out needs a directory\n");
        return 2;
      }
      out = v;
    } else if (a.startsWith("--")) {
      process.stderr.write(`error: unknown flag ${a}\n`);
      return 2;
    } else paths.push(a);
  }
  if (paths.length === 0) {
    process.stderr.write("usage: evalSurveyGuardCli.ts <lineage.json>... [--json] [--out DIR]\n");
    return 2;
  }
  if (out !== null && `${resolve(out)}${sep}`.includes(`${sep}data${sep}published${sep}`)) {
    process.stderr.write("error: --out must not point into data/published\n");
    return 2;
  }
  const reports: SurveyGuardReport[] = [];
  for (const p of paths) {
    try {
      const data = JSON.parse(readFileSync(p, "utf-8"));
      const { report, guarded } = guardArtifact(p, data);
      reports.push(report);
      if (out !== null) {
        const dir = join(out, basename(dirname(resolve(p))));
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "lineage.json"), `${JSON.stringify(guarded, null, 2)}\n`);
      }
    } catch (e) {
      process.stderr.write(`error: ${p}: ${(e as Error).message}\n`);
      return 2;
    }
  }
  process.stdout.write(
    json
      ? `${JSON.stringify(reports, null, 2)}\n`
      : `${reports.map(formatSurveyGuardReport).join("\n\n")}\n`,
  );
  return 0;
}

if (isMain(import.meta.url)) {
  process.exitCode = runSurveyGuardCli(process.argv.slice(2));
}
