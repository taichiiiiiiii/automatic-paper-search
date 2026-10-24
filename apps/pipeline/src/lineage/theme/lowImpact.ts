/**
 * R2-45: drop low-impact leaves.
 *
 * A requested field (Retrieval-Augmented Generation, 2026-10-23: 84 papers)
 * collects many niche application papers that match the topic terms but
 * that nobody in the graph cites and that nobody outside it cites much
 * either — a chatbot for a university, a manufacturing quality system. They
 * dilute the lineage without being part of it. A non-seed node goes when it
 *  - has fewer than `minCitations` citations,
 *  - is at least one full year old (recent papers have not had time),
 *  - is cited by no other node of the graph, and
 *  - carries no lineage relation (extends / supersedes / contrasts /
 *    successor) on any edge.
 * Seeds and focus nodes stay. One pass: removing a leaf can turn another
 * node into a leaf, which is left for the next build (the rule must stay
 * predictable). Edge direction: `src` is the cited paper, `dst` the citing
 * one.
 */

import type { ThemeGraphNode } from "../shared/node.js";
import type { ThemeEdge } from "./edges.js";

export const LOW_IMPACT_MIN_CITATIONS = 30;

const LINEAGE = new Set(["extends", "supersedes", "contrasts", "successor"]);

export interface LowImpactDrop {
  id: string;
  year: number;
  citations: number;
}

export function pruneLowImpactLeaves(
  nodes: Map<string, ThemeGraphNode>,
  edges: readonly ThemeEdge[],
  options: { seedIds: ReadonlySet<string>; currentYear: number; minCitations?: number },
): { edges: ThemeEdge[]; dropped: LowImpactDrop[] } {
  const min = options.minCitations ?? LOW_IMPACT_MIN_CITATIONS;
  const citedByGraph = new Set<string>();
  const inLineage = new Set<string>();
  for (const e of edges) {
    citedByGraph.add(e.src);
    if (typeof e.relation === "string" && LINEAGE.has(e.relation)) {
      inLineage.add(e.src);
      inLineage.add(e.dst);
    }
  }
  const dropped: LowImpactDrop[] = [];
  for (const [id, node] of nodes) {
    if (options.seedIds.has(id) || node.is_focus === true) continue;
    const year = node.year;
    if (typeof year !== "number" || year > options.currentYear - 1) continue;
    const citations = Number(node.citation_count) || 0;
    if (citations >= min) continue;
    if (citedByGraph.has(id) || inLineage.has(id)) continue;
    dropped.push({ id, year, citations });
  }
  if (dropped.length === 0) return { edges: edges as ThemeEdge[], dropped };
  const gone = new Set(dropped.map((d) => d.id));
  for (const id of gone) nodes.delete(id);
  return { edges: edges.filter((e) => !gone.has(e.src) && !gone.has(e.dst)), dropped };
}
