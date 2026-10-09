/**
 * Offline topic-drift evaluation (R2-2b): re-apply the BFS admission gate
 * from `topicScope.ts` to committed theme lineages and report which nodes
 * the new rule would drop, and which seed it would pick as root. Reads
 * only the given `lineage.json` files — no network, no LLM, writes
 * nothing. The real regeneration runs in CI (`regen-themes.yml`).
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
}

export function evaluateArtifact(
  path: string,
  options: { minSupport?: number; admitFoundational?: boolean } = {},
): ThemeDriftReport {
  const data = JSON.parse(readFileSync(path, "utf-8")) as {
    root?: unknown;
    nodes: ArtifactNodeLike[];
    edges: { src: string; dst: string }[];
    meta?: { theme?: unknown };
  };
  const theme = String(data.meta?.theme ?? "");
  if (!theme) throw new Error(`${path}: meta.theme missing`);
  const scope = TopicScope.forTheme(theme, {
    minSupport: options.minSupport,
    admitFoundational: options.admitFoundational,
  });
  const result = reapplyAdmission(
    { root: data.root, nodes: data.nodes ?? [], edges: data.edges ?? [] },
    scope,
  );
  return {
    path,
    theme,
    terms: scope.terms,
    nodeCountBefore: (data.nodes ?? []).length,
    nodeCountAfter: result.kept.length,
    ...result,
  };
}

export function formatReport(r: ThemeDriftReport): string {
  const lines = [
    `== ${r.theme} (${r.path})`,
    `   terms: ${r.terms.join(" | ")}`,
    `   nodes: ${r.nodeCountBefore} -> ${r.nodeCountAfter} (drop ${r.dropped.length})`,
    `   root:  ${r.previousRoot} -> ${r.root}`,
    "   kept:",
    ...r.kept.map((k) => `     + [${k.reason}] ${k.title.slice(0, 90)}`),
    "   dropped:",
    ...r.dropped.map((d) => `     - (support ${d.support}) ${d.title.slice(0, 90)}`),
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
