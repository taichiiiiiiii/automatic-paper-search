/**
 * BFS ancestor/descendant traversal + cross-node edges — TS port of
 * `paperpilot/scripts/build_theme_lineage.py`'s `_BFSResult`,
 * `_run_bfs_and_descendants`, `_add_cross_node_edges`.
 */

import type { ClassifyPaperLike, LLMProvider } from "../../collect/llm/provider.js";
import { deriveRelation, isFoundationalAncestor } from "../classify/classify.js";
import { isTrending, makeEdge, type ThemeEdge } from "./edges.js";
import type { BuildCompletenessForExpansion } from "./fetchRelated.js";
import { type FetchRelatedDeps, fetchRelated } from "./fetchRelated.js";
import { type ThemeGraphNode, toThemeNode } from "./node.js";
import type { ThemePaper } from "./openalexWork.js";
import { filterOffTopicRefs } from "./seedFilters.js";

type Paper = ThemePaper;

/** Cross-node lookup (#54) only checks for in-graph hits, so 100 refs
 * is more than enough to surface any cohort-internal citation. */
const CROSS_NODE_LIMIT = 100;

function citationCountOf(p: Record<string, unknown>): number {
  return Number(p.citationCount) || 0;
}

function sortByCitationDesc<T extends Record<string, unknown>>(items: T[]): T[] {
  // Stable sort (both V8's Array#sort and Python's list.sort are stable),
  // so ties preserve their original relative order — same as Python's
  // `list.sort(key=..., reverse=True)`.
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => {
      const diff = citationCountOf(b.item) - citationCountOf(a.item);
      return diff !== 0 ? diff : a.i - b.i;
    })
    .map(({ item }) => item);
}

export interface BFSResult {
  nodes: Map<string, ThemeGraphNode>;
  edges: ThemeEdge[];
  seedIds: string[];
  classifyAttempted: number;
  classifySucceeded: number;
}

export interface RunBfsOptions {
  depth: number;
  width: number;
  maxSeedCite: number;
  provider: LLMProvider | null;
  llmStrict: string;
  /** Overrides `new Date().getUTCFullYear()` for deterministic tests (#68 trending badge). */
  currentYear?: number;
}

/** BFS ancestor traversal up to `depth` hops, then a 1-hop descendants
 * pass from each seed (#55).
 *
 * BFS direction conventions:
 *  - ancestors: parent (cited, carries intents) -> current (citing)
 *  - descendants: seed (older, focus) -> child (newer, carries intents)
 */
export async function runBfsAndDescendants(
  seeds: readonly Paper[],
  options: RunBfsOptions,
  deps: FetchRelatedDeps,
  completeness?: BuildCompletenessForExpansion | null,
): Promise<BFSResult> {
  const { depth, width, maxSeedCite, provider, llmStrict } = options;
  const currentYear = options.currentYear ?? new Date().getUTCFullYear();

  const nodes = new Map<string, ThemeGraphNode>();
  const edges: ThemeEdge[] = [];

  const seedIds: string[] = [];
  const frontier: [Paper, number][] = [];
  for (const seed of seeds) {
    const sid = seed.paperId;
    nodes.set(sid, toThemeNode(seed, { focus: true, trending: isTrending(seed, currentYear) }));
    seedIds.push(sid);
    frontier.push([seed, 0]);
  }

  let classifyAttempted = 0;
  let classifySucceeded = 0;

  const visited = new Set<string>(seedIds);
  while (frontier.length > 0) {
    const [current, currentDepth] = frontier.shift()!;
    if (currentDepth >= depth) continue;

    let allParents = await fetchRelated(
      current.paperId,
      "references",
      width * 4,
      deps,
      completeness,
    );
    allParents = allParents.filter((p) => p.abstract);
    allParents = filterOffTopicRefs(allParents, { maxSeedCite });

    const influential = allParents.filter((p) => p._is_influential !== false);
    const nonInfluential = allParents.filter((p) => p._is_influential === false);
    const ranked = [...sortByCitationDesc(influential), ...sortByCitationDesc(nonInfluential)];
    const foundationalParents = ranked.filter((p) =>
      isFoundationalAncestor(p as ClassifyPaperLike),
    );
    const nonFoundational = ranked.filter((p) => !isFoundationalAncestor(p as ClassifyPaperLike));
    const fill = Math.max(0, width - foundationalParents.length);
    const parents = [...foundationalParents, ...nonFoundational.slice(0, fill)];

    for (const parent of parents) {
      const pid = parent.paperId;
      if (!pid) continue;
      if (!nodes.has(pid)) {
        nodes.set(pid, toThemeNode(parent, { trending: isTrending(parent, currentYear) }));
      }
      classifyAttempted += 1;
      const cls = await deriveRelation(parent as ClassifyPaperLike, {
        parent: parent as ClassifyPaperLike,
        child: current as ClassifyPaperLike,
        classifyRelation: provider ? (a, b) => provider.classifyRelation(a, b) : undefined,
        strictMode: llmStrict as "off" | "ambiguous" | "all",
      });
      if (cls !== null) {
        classifySucceeded += 1;
        edges.push(
          makeEdge(cls, {
            srcId: pid,
            dstId: current.paperId,
            parent,
            child: current,
            intentRecord: parent,
            provider,
          }),
        );
      }
      if (!visited.has(pid)) {
        visited.add(pid);
        frontier.push([parent, currentDepth + 1]);
      }
    }
  }

  // #55: descendants direction.
  let descAdded = 0;
  const descWidth = Math.max(Math.floor(width / 2), 4);
  for (const seed of seeds) {
    const sid = seed.paperId;
    let allChildren = await fetchRelated(sid, "citations", descWidth * 4, deps, completeness);
    allChildren = allChildren.filter((c) => c.abstract);
    allChildren = filterOffTopicRefs(allChildren, { maxSeedCite });
    const influential = allChildren.filter((c) => c._is_influential !== false);
    const nonInfluential = allChildren.filter((c) => c._is_influential === false);
    const children = [
      ...sortByCitationDesc(influential),
      ...sortByCitationDesc(nonInfluential),
    ].slice(0, descWidth);

    for (const child of children) {
      const cid = child.paperId;
      if (!cid || cid === sid) continue;
      if (!nodes.has(cid)) {
        nodes.set(cid, toThemeNode(child, { trending: isTrending(child, currentYear) }));
      }
      const cls = await deriveRelation(child as ClassifyPaperLike, {
        parent: seed as ClassifyPaperLike,
        child: child as ClassifyPaperLike,
        classifyRelation: provider ? (a, b) => provider.classifyRelation(a, b) : undefined,
        strictMode: llmStrict as "off" | "ambiguous" | "all",
      });
      if (cls === null) continue;
      if (edges.some((e) => e.src === sid && e.dst === cid)) continue;
      edges.push(
        makeEdge(cls, {
          srcId: sid,
          dstId: cid,
          parent: seed,
          child,
          intentRecord: child,
          provider,
        }),
      );
      descAdded += 1;
    }
  }
  if (descAdded > 0) {
    deps.logger?.warn(`descendants pass added ${descAdded} edges (seed -> newer citing papers)`);
  }

  return { nodes, edges, seedIds, classifyAttempted, classifySucceeded };
}

export interface AddCrossNodeEdgesOptions {
  seedIds?: ReadonlySet<string>;
  cohortMinYear?: number | null;
  provider: LLMProvider | null;
  strictMode: string;
}

/** Find citation links between nodes already in the graph (#54/#55).
 * Returns the number of edges added; mutates `edges` in place. */
export async function addCrossNodeEdges(
  nodes: ReadonlyMap<string, ThemeGraphNode>,
  edges: ThemeEdge[],
  options: AddCrossNodeEdgesOptions,
  deps: FetchRelatedDeps,
  completeness?: BuildCompletenessForExpansion | null,
): Promise<number> {
  const { provider, strictMode, cohortMinYear = null } = options;
  const seedIds = options.seedIds ?? new Set<string>();
  const existing = new Set(edges.map((e) => `${e.src}\u0000${e.dst}`));
  const nodeIds = new Set(nodes.keys());
  let added = 0;

  const isAnchor = (nid: string): boolean => {
    if (seedIds.has(nid)) return true;
    if (cohortMinYear === null) return true;
    const year = nodes.get(nid)?.year;
    return typeof year === "number" && Number.isInteger(year) && year >= cohortMinYear;
  };

  for (const citingId of [...nodeIds]) {
    let refs: Paper[];
    try {
      refs = await fetchRelated(citingId, "references", CROSS_NODE_LIMIT, deps, completeness);
    } catch (exc) {
      deps.logger?.warn(`cross-node: fetch_related failed for ${citingId}: ${String(exc)}`);
      continue;
    }
    for (const ref of refs) {
      const refId = ref.paperId;
      if (!nodeIds.has(refId)) continue;
      if (refId === citingId) continue; // S2 self-loop anomaly
      if (!(isAnchor(citingId) || isAnchor(refId))) continue;
      const edgeKey = `${refId}\u0000${citingId}`;
      if (existing.has(edgeKey)) continue;
      const citingNode = nodes.get(citingId);
      const cls = await deriveRelation(ref as ClassifyPaperLike, {
        parent: ref as ClassifyPaperLike,
        child: citingNode as unknown as ClassifyPaperLike,
        classifyRelation: provider ? (a, b) => provider.classifyRelation(a, b) : undefined,
        strictMode: strictMode as "off" | "ambiguous" | "all",
      });
      if (cls === null) continue;
      edges.push(
        makeEdge(cls, {
          srcId: refId,
          dstId: citingId,
          parent: ref,
          child: citingNode as unknown as Record<string, unknown>,
          intentRecord: ref,
          provider,
        }),
      );
      existing.add(edgeKey);
      added += 1;
    }
  }
  return added;
}
