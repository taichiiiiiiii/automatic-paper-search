/**
 * BFS ancestor/descendant traversal + cross-node edges — TS port of
 * `paperpilot/scripts/build_theme_lineage.py`'s `_BFSResult`,
 * `_run_bfs_and_descendants`, `_add_cross_node_edges`.
 */

import type {
  ClassifyPaperLike,
  LLMProvider,
  RelationClassification,
} from "../../collect/llm/provider.js";
import {
  type DerivedEdge,
  deriveRelation,
  isFoundationalAncestor,
  isVersionIncrement,
  titleVersionEdge,
  titleVersionOf,
} from "../classify/classify.js";
import type { BuildCompletenessForExpansion } from "../shared/fetchRelated.js";
import { type FetchRelatedDeps, fetchRelated } from "../shared/fetchRelated.js";
import type { ThemeGraphNode } from "../shared/node.js";
import { TitleIdentity } from "./dedup.js";
import { demoteLowInformationEdge, isTrending, makeEdge, type ThemeEdge } from "./edges.js";
import { toThemeNode } from "./node.js";
import type { ThemePaper } from "./openalexWork.js";
import { guardRelation } from "./relationGuard.js";
import type { S2Expansion } from "./s2Expansion.js";
import { deriveS2Relation, type S2RelationContext } from "./s2Relations.js";
import { filterOffTopicRefs } from "./seedFilters.js";
import { prepareTopicGate, type TopicEmbedder, type TopicGateMeta } from "./topicEmbedding.js";
import type { TopicScope } from "./topicScope.js";

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
  /** R2-2b: LLM `classifyRelation` calls made / calls that returned
   * nothing usable (null). A null makes `deriveRelation` keep its
   * heuristic, which this module then demotes to `citation_heuristic`. */
  llmCalls: number;
  llmUnusable: number;
  /** R2-2b: candidates the topic gate kept out of the graph, and the
   * ones it let in only because >= `minSupport` on-topic nodes link to
   * them (deferred pass). Both 0 when no `topicScope` is given. */
  topicRejected: number;
  topicAdmittedBySupport: number;
  /** R2-2d: provisional admissions, to be confirmed by
   * {@link confirmSupportAdmissions} after the cross-node pass — nodes
   * admitted by support in the deferred pass, and citing papers whose
   * title is not about the theme but that mention it elsewhere. Plus the
   * IDs admitted because they match the theme (seeds included): the
   * nodes that may lend support. */
  provisional: Set<string>;
  onTopicIds: Set<string>;
  /** R2-2d: candidates the BFS identified as another ID of a node already
   * in the graph (same title, preprint vs venue version) and folded into it. */
  titleMerged: number;
  /** R2-11: how the topic gate judged candidates (`meta.topic_gate`);
   * `null` when the gate is off / no scope. */
  topicGate: TopicGateMeta | null;
}

export interface RunBfsOptions {
  depth: number;
  width: number;
  maxSeedCite: number;
  provider: LLMProvider | null;
  llmStrict: string;
  /** Overrides `new Date().getUTCFullYear()` for deterministic tests (#68 trending badge). */
  currentYear?: number;
  /** R2-2b admission gate. `null`/omitted = admit every candidate (the
   * pre-R2-2b behaviour, kept for library callers and old tests). */
  topicScope?: TopicScope | null;
  /** R2-10 (design 41 D6): classify edges from Semantic Scholar citation
   * evidence first. `null`/omitted = the pre-R2-10 path only. */
  s2Relations?: S2RelationContext | null;
  /** R2-11 (design 41 D7): embedding relevance for the topic gate. With
   * an embedder the seeds' references/citations are prefetched once
   * (the same cached `fetchRelated` calls the BFS makes) and embedded as
   * the z-score pool; on any failure the term-only rule applies.
   * `null`/omitted = term-only rule. */
  topicEmbedder?: TopicEmbedder | null;
  /** R2-14: Semantic Scholar fallback for expansion when OpenAlex has
   * (almost) no references / no citing papers (`s2Expansion.ts`).
   * `null`/omitted = OpenAlex (`fetchRelated`) only. */
  s2Expansion?: S2Expansion | null;
}

/** Counts LLM calls / unusable answers around a provider. */
interface LlmCounter {
  calls: number;
  unusable: number;
  classify?: (a: ClassifyPaperLike, b: ClassifyPaperLike) => Promise<RelationClassification | null>;
}

function llmCounter(provider: LLMProvider | null): LlmCounter {
  const counter: LlmCounter = { calls: 0, unusable: 0 };
  if (provider) {
    counter.classify = async (a, b) => {
      counter.calls += 1;
      const result = await provider.classifyRelation(a, b);
      if (result === null) counter.unusable += 1;
      return result;
    };
  }
  return counter;
}

/** `deriveRelation` + the R2-2b demotion of `year_cite` guesses + the
 * R2-2d survey/dataset `contrasts` guard.
 *
 * Order (R2-13):
 *  1. an explicit version increment (`FlashAttention` -> `FlashAttention-2`)
 *     is `title_version` supersedes, before anything else — S2 intents or
 *     the foundational allowlist would otherwise turn a new version of a
 *     work into a plain `extends`;
 *  2. with `s2`, Semantic Scholar evidence decides (R2-10) — now also when
 *     the cited paper is on the foundational allowlist: the allowlist was
 *     added because OpenAlex references carry no citation intents, so where
 *     S2 does have the citation sentences they say more than "a canonical
 *     paper was cited" (a downstream paper that cites FlashAttention as
 *     motivation is not an `extends` of it);
 *  3. pairs S2 has nothing on fall through to `deriveRelation` (allowlist,
 *     abstract LLM, heuristic). */
async function classifyPair(
  intentRecord: Record<string, unknown>,
  parent: Record<string, unknown>,
  child: Record<string, unknown>,
  counter: LlmCounter,
  llmStrict: string,
  s2: S2RelationContext | null = null,
): Promise<DerivedEdge | null> {
  if (isVersionIncrement(parent as ClassifyPaperLike, child as ClassifyPaperLike)) {
    return guardRelation(
      titleVersionEdge(parent as ClassifyPaperLike, child as ClassifyPaperLike),
      parent,
      child,
    );
  }
  if (s2 !== null) {
    const fromS2 = await deriveS2Relation(parent, child, s2, (usable) => {
      counter.calls += 1;
      if (!usable) counter.unusable += 1;
    });
    if (fromS2 !== null) return guardRelation(fromS2, parent, child);
  }
  const cls = await deriveRelation(intentRecord as ClassifyPaperLike, {
    parent: parent as ClassifyPaperLike,
    child: child as ClassifyPaperLike,
    classifyRelation: counter.classify,
    strictMode: llmStrict as "off" | "ambiguous" | "all",
  });
  return cls === null
    ? null
    : guardRelation(demoteLowInformationEdge(cls, parent, child), parent, child);
}

/** A candidate the topic gate turned away, with every on-topic admitted
 * node that linked to it — admitted later if that reaches `minSupport`. */
interface PendingCandidate {
  paper: Paper;
  /** anchor id -> direction ("parent": candidate is cited by anchor;
   * "child": candidate cites anchor) and the anchor paper. */
  links: Map<string, { direction: "parent" | "child"; anchor: Paper }>;
}

/** BFS ancestor traversal up to `depth` hops, then a 1-hop descendants
 * pass from each seed (#55).
 *
 * BFS direction conventions:
 *  - ancestors: parent (cited, carries intents) -> current (citing)
 *  - descendants: seed (older, focus) -> child (newer, carries intents)
 *
 * R2-2b topic gate (only with `options.topicScope`): a candidate joins
 * the graph only if it mentions the theme (title/abstract/TL;DR), is on
 * the foundational allowlist, or — in a deferred pass after the BFS —
 * at least `minSupport` distinct already-admitted on-topic nodes link to
 * it. Support-admitted nodes get their edges but are not expanded
 * further, so they cannot open a new off-topic neighbourhood. The gate
 * runs before the width cut, so on-topic candidates fill the width.
 *
 * R2-2d: a newer paper citing a seed (descendants pass) joins when its
 * title is about the theme, provisionally when it mentions the theme only
 * in its abstract or as a tool, and never otherwise
 * (`TopicScope.admitsDescendant`; no co-citation support, no allowlist).
 * Provisional and support admissions are confirmed by
 * {@link confirmSupportAdmissions} after the cross-node pass. A candidate with the same title as a
 * node already in (or pending for) the graph is folded into that node
 * (`TitleIdentity`), so one work never appears twice.
 *
 * R2-11 (design 41 D7): by default neither the allowlist nor support
 * admits on its own and there are no provisional citing papers; with
 * `options.topicEmbedder` each candidate also gets an embedding z-score
 * (`topicEmbedding.ts`) and `TopicScope.admits` applies the
 * embedding+terms rule. `BFSResult.topicGate` records which rule ran.
 */
export async function runBfsAndDescendants(
  seeds: readonly Paper[],
  options: RunBfsOptions,
  deps: FetchRelatedDeps,
  completeness?: BuildCompletenessForExpansion | null,
): Promise<BFSResult> {
  const { depth, width, maxSeedCite, provider, llmStrict } = options;
  const s2 = options.s2Relations ?? null;
  const scope = options.topicScope ?? null;
  const currentYear = options.currentYear ?? new Date().getUTCFullYear();
  const counter = llmCounter(provider);
  const expansion = options.s2Expansion ?? null;
  /** `fetchRelated`, with the R2-14 S2 fallback when configured. */
  const related = (
    paper: Paper,
    kind: "references" | "citations",
    limit: number,
    ledger: BuildCompletenessForExpansion | null | undefined,
  ): Promise<Paper[]> =>
    expansion === null
      ? fetchRelated(paper.paperId, kind, limit, deps, ledger)
      : expansion.expand(
          paper,
          kind,
          limit,
          (l) => fetchRelated(paper.paperId, kind, limit, deps, l),
          ledger,
        );

  const nodes = new Map<string, ThemeGraphNode>();
  const edges: ThemeEdge[] = [];

  const seedIds: string[] = [];
  const frontier: [Paper, number][] = [];
  const titles = new TitleIdentity();
  let titleMerged = 0;
  /** Admitted nodes that may lend support (on-topic seeds + nodes
   * admitted because they match the theme). */
  const onTopic = new Set<string>();
  for (const seed of seeds) {
    const sid = seed.paperId;
    nodes.set(sid, toThemeNode(seed, { focus: true, trending: isTrending(seed, currentYear) }));
    seedIds.push(sid);
    titles.register(sid, seed);
    frontier.push([seed, 0]);
    if (scope === null || scope.isOnTopic(seed)) onTopic.add(sid);
  }

  // R2-11: embedding z-scores over the depth-1 pool (all seeds, their
  // references and citing papers), computed once before any admission.
  const descWidth = Math.max(Math.floor(width / 2), 4);
  let relevance: Awaited<ReturnType<typeof prepareTopicGate>>["relevance"] = null;
  let topicGate: TopicGateMeta | null = null;
  if (scope?.options.gate) {
    const embedder = options.topicEmbedder ?? null;
    const pool: Paper[] = [];
    if (embedder !== null) {
      for (const seed of seeds) {
        for (const [kind, limit] of [
          ["references", width * 4],
          ["citations", descWidth * 4],
        ] as const) {
          try {
            // No completeness ledger here: the BFS call below records it.
            const got = await related(seed, kind, limit, null);
            pool.push(...got.filter((p) => p.abstract));
          } catch {
            // The BFS fetch below retries and records the failure.
          }
        }
      }
    }
    ({ relevance, meta: topicGate } = await prepareTopicGate({
      scope,
      seeds,
      pool,
      embedder,
      logger: deps.logger,
    }));
    deps.logger?.warn(
      `topic gate: method=${topicGate.method} pool=${topicGate.pool_size}` +
        (topicGate.fallback_reason ? ` (fallback: ${topicGate.fallback_reason})` : ""),
    );
  }

  let classifyAttempted = 0;
  let classifySucceeded = 0;
  const pending = new Map<string, PendingCandidate>();
  const provisional = new Set<string>();

  /** Fold a candidate that is another ID of a node already in (or pending
   * for) the graph into that node, and drop repeats within one list. */
  const canonicalise = (list: Paper[], selfId: string): Paper[] => {
    const out: Paper[] = [];
    const seen = new Set<string>();
    for (const p of list) {
      let paper = p;
      if (p.paperId && !nodes.has(p.paperId) && !pending.has(p.paperId)) {
        const hit = titles.resolve(p);
        if (hit !== null && (nodes.has(hit) || pending.has(hit))) {
          paper = { ...p, paperId: hit };
          titleMerged += 1;
        }
      }
      if (!paper.paperId || paper.paperId === selfId || seen.has(paper.paperId)) continue;
      seen.add(paper.paperId);
      out.push(paper);
    }
    return out;
  };

  /** Gate one candidate seen from `anchor`. Returns true when it may be
   * used now (already in the graph, or admitted). */
  const gate = (candidate: Paper, anchor: Paper, direction: "parent" | "child"): boolean => {
    const cid = candidate.paperId;
    if (scope === null || nodes.has(cid)) return true;
    let entry = pending.get(cid);
    if (onTopic.has(anchor.paperId)) {
      if (!entry) {
        entry = { paper: candidate, links: new Map() };
        pending.set(cid, entry);
        titles.register(cid, candidate);
      }
      if (!entry.links.has(anchor.paperId)) {
        entry.links.set(anchor.paperId, { direction, anchor });
      }
    }
    // Support is only granted in the deferred pass, so that a candidate's
    // edges are created exactly once, from every supporting anchor.
    const why = scope.admits(candidate, 0, relevance?.z(cid));
    if (why === null) return false;
    pending.delete(cid);
    titles.register(cid, candidate);
    if (why === "topic" || why === "embedding") onTopic.add(cid);
    return true;
  };

  let descendantsRejected = 0;
  /** Descendants pass (R2-2d): a theme title admits; a theme mention
   * only in the abstract / as a tool admits provisionally. */
  const gateDescendant = (candidate: Paper): boolean => {
    const cid = candidate.paperId;
    if (scope === null || nodes.has(cid)) return true;
    const why = scope.admitsDescendant(candidate, relevance?.z(cid));
    if (why === null) {
      descendantsRejected += 1;
      return false;
    }
    pending.delete(cid);
    titles.register(cid, candidate);
    if (why === "topic") onTopic.add(cid);
    else provisional.add(cid);
    return true;
  };

  const visited = new Set<string>(seedIds);
  while (frontier.length > 0) {
    const [current, currentDepth] = frontier.shift()!;
    if (currentDepth >= depth) continue;

    let allParents = await related(current, "references", width * 4, completeness);
    allParents = allParents.filter((p) => p.abstract);
    allParents = filterOffTopicRefs(allParents, { maxSeedCite });
    allParents = canonicalise(allParents, current.paperId);
    if (relevance !== null) await relevance.ensure(allParents);
    if (scope !== null) allParents = allParents.filter((p) => gate(p, current, "parent"));

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
        titles.register(pid, parent);
      }
      classifyAttempted += 1;
      const cls = await classifyPair(parent, parent, current, counter, llmStrict, s2);
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
  for (const seed of seeds) {
    const sid = seed.paperId;
    let allChildren = await related(seed, "citations", descWidth * 4, completeness);
    allChildren = allChildren.filter((c) => c.abstract);
    allChildren = filterOffTopicRefs(allChildren, { maxSeedCite });
    allChildren = canonicalise(allChildren, sid);
    if (relevance !== null) await relevance.ensure(allChildren);
    if (scope !== null) {
      allChildren = allChildren.filter((c) => c.paperId === sid || gateDescendant(c));
    }
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
        titles.register(cid, child);
      }
      const cls = await classifyPair(child, seed, child, counter, llmStrict, s2);
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

  // R2-2b deferred pass: candidates without a theme match that enough
  // on-topic nodes link to. Iterated in first-seen order (deterministic).
  let topicAdmittedBySupport = 0;
  let topicRejected = 0;
  if (scope !== null) {
    for (const [cid, entry] of pending) {
      if (nodes.has(cid)) continue;
      if (scope.admits(entry.paper, entry.links.size, relevance?.z(cid)) === null) {
        topicRejected += 1;
        continue;
      }
      nodes.set(cid, toThemeNode(entry.paper, { trending: isTrending(entry.paper, currentYear) }));
      provisional.add(cid);
      topicAdmittedBySupport += 1;
      for (const { direction, anchor } of entry.links.values()) {
        const [parent, child] =
          direction === "parent" ? [entry.paper, anchor] : [anchor, entry.paper];
        if (direction === "parent") classifyAttempted += 1;
        const cls = await classifyPair(entry.paper, parent, child, counter, llmStrict, s2);
        if (cls === null) continue;
        if (direction === "parent") classifySucceeded += 1;
        if (edges.some((e) => e.src === parent.paperId && e.dst === child.paperId)) continue;
        edges.push(
          makeEdge(cls, {
            srcId: parent.paperId,
            dstId: child.paperId,
            parent,
            child,
            intentRecord: entry.paper,
            provider,
          }),
        );
      }
    }
    topicRejected += descendantsRejected;
    deps.logger?.warn(
      `topic gate: kept ${topicRejected} off-topic candidate(s) out (${descendantsRejected} citing paper(s) whose title is not about the theme); ` +
        (scope.options.minSupport > 0
          ? `admitted ${topicAdmittedBySupport} by support (>= ${scope.options.minSupport} on-topic links, confirmed after the cross-node pass)`
          : "support admission off"),
    );
    if (topicGate !== null && relevance !== null && relevance.unscored > 0) {
      topicGate = { ...topicGate, unscored: relevance.unscored };
    }
  }
  if (titleMerged > 0) {
    deps.logger?.warn(
      `title identity: folded ${titleMerged} duplicate-ID candidate(s) into existing nodes`,
    );
  }

  return {
    nodes,
    edges,
    seedIds,
    classifyAttempted,
    classifySucceeded,
    llmCalls: counter.calls,
    llmUnusable: counter.unusable,
    topicRejected,
    topicAdmittedBySupport,
    provisional,
    onTopicIds: onTopic,
    titleMerged,
    topicGate,
  };
}

/**
 * R2-2d second stage of support admission, run after the cross-node pass
 * has linked in-graph citations: a provisional node (support-admitted
 * reference, or a citing paper that names the theme only in its abstract)
 * stays only if at least `minSupport` distinct on-topic NON-seed nodes
 * link to it.
 * At the CI depth of 1 the deferred pass only ever sees seeds citing a
 * candidate, and two seeds citing the same generic paper (an init
 * scheme, a dataset) says nothing about the theme; on-topic papers
 * beyond the seeds citing it does. Mutates `nodes`; returns the
 * remaining edges and the dropped IDs.
 */
export function confirmSupportAdmissions(
  nodes: Map<string, ThemeGraphNode>,
  edges: readonly ThemeEdge[],
  options: {
    seedIds: ReadonlySet<string>;
    provisional: ReadonlySet<string>;
    onTopicIds: ReadonlySet<string>;
    minSupport: number;
  },
): { edges: ThemeEdge[]; dropped: string[] } {
  const { seedIds, provisional, onTopicIds, minSupport } = options;
  const lenders = (id: string): number => {
    const set = new Set<string>();
    for (const e of edges) {
      const other = e.src === id ? e.dst : e.dst === id ? e.src : null;
      if (other === null || other === id) continue;
      if (seedIds.has(other) || provisional.has(other) || !onTopicIds.has(other)) continue;
      set.add(other);
    }
    return set.size;
  };
  const dropped = [...provisional].filter(
    (id) => nodes.has(id) && !seedIds.has(id) && lenders(id) < minSupport,
  );
  if (dropped.length === 0) return { edges: [...edges], dropped };
  const gone = new Set(dropped);
  for (const id of dropped) nodes.delete(id);
  return { edges: edges.filter((e) => !gone.has(e.src) && !gone.has(e.dst)), dropped };
}

export interface AddCrossNodeEdgesOptions {
  seedIds?: ReadonlySet<string>;
  cohortMinYear?: number | null;
  provider: LLMProvider | null;
  strictMode: string;
  /** R2-10: see {@link RunBfsOptions.s2Relations}. */
  s2Relations?: S2RelationContext | null;
}

/** A graph node as the paper dict the classifiers take (`paperId` = id). */
function nodeAsPaper(id: string, node: ThemeGraphNode | undefined): Paper {
  return { ...(node as unknown as Record<string, unknown>), paperId: id } as unknown as Paper;
}

function yearOf(node: ThemeGraphNode | undefined): number | null {
  const y = node?.year;
  return typeof y === "number" && Number.isInteger(y) ? y : null;
}

/** Find citation links between nodes already in the graph (#54/#55).
 * Returns the number of edges added; mutates `edges` in place.
 *
 * R2-13: a citing node whose OpenAlex reference list is empty (OpenAlex
 * has no `referenced_works` for many arXiv-only records, e.g. all three
 * FlashAttention papers) is also checked against its Semantic Scholar
 * reference list (`s2Relations.source`, cached in `s2_references.json`):
 * every other in-graph node that is not newer than it is looked up there,
 * seed-to-seed pairs included, and each pair S2 confirms is classified
 * like any other pair. Without `s2Relations` nothing changes. */
export async function addCrossNodeEdges(
  nodes: ReadonlyMap<string, ThemeGraphNode>,
  edges: ThemeEdge[],
  options: AddCrossNodeEdgesOptions,
  deps: FetchRelatedDeps,
  completeness?: BuildCompletenessForExpansion | null,
): Promise<number> {
  const { provider, strictMode, cohortMinYear = null } = options;
  const counter = llmCounter(provider);
  const seedIds = options.seedIds ?? new Set<string>();
  const existing = new Set(edges.map((e) => `${e.src}\u0000${e.dst}`));
  const nodeIds = new Set(nodes.keys());
  const titles = new TitleIdentity();
  for (const [id, node] of nodes) titles.register(id, node as unknown as Record<string, unknown>);
  let added = 0;

  const isAnchor = (nid: string): boolean => {
    if (seedIds.has(nid)) return true;
    if (cohortMinYear === null) return true;
    const year = nodes.get(nid)?.year;
    return typeof year === "number" && Number.isInteger(year) && year >= cohortMinYear;
  };

  for (const citingId of [...nodeIds]) {
    // R2-14: a node kept under its S2 id (S2 expansion fallback) is
    // checked against its S2 reference list, like an OpenAlex node with
    // no references — never through `fetchRelated`'s slow S2 path.
    if (options.s2Relations && !citingId.startsWith("openalex:")) {
      added += await addS2ReferenceEdges(citingId, {
        nodes,
        edges,
        existing,
        isAnchor,
        counter,
        strictMode,
        provider,
        s2: options.s2Relations,
      });
      continue;
    }
    let refs: Paper[];
    try {
      refs = await fetchRelated(citingId, "references", CROSS_NODE_LIMIT, deps, completeness);
    } catch (exc) {
      deps.logger?.warn(`cross-node: fetch_related failed for ${citingId}: ${String(exc)}`);
      continue;
    }
    if (refs.length === 0 && options.s2Relations) {
      added += await addS2ReferenceEdges(citingId, {
        nodes,
        edges,
        existing,
        isAnchor,
        counter,
        strictMode,
        provider,
        s2: options.s2Relations,
      });
      continue;
    }
    for (const rawRef of refs) {
      // R2-2d: another ID of an in-graph work (preprint vs venue version).
      const alias = nodeIds.has(rawRef.paperId) ? null : titles.resolve(rawRef);
      const ref = alias === null ? rawRef : { ...rawRef, paperId: alias };
      const refId = ref.paperId;
      if (!nodeIds.has(refId)) continue;
      if (refId === citingId) continue; // S2 self-loop anomaly
      if (!(isAnchor(citingId) || isAnchor(refId))) continue;
      const edgeKey = `${refId}\u0000${citingId}`;
      if (existing.has(edgeKey)) continue;
      const citingNode = nodes.get(citingId);
      const cls = await classifyPair(
        ref,
        ref,
        citingNode as unknown as Record<string, unknown>,
        counter,
        strictMode,
        options.s2Relations ?? null,
      );
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

/** R2-13: in-graph references of `citingId` from its Semantic Scholar
 * reference list (used when OpenAlex has none). Returns edges added. */
async function addS2ReferenceEdges(
  citingId: string,
  ctx: {
    nodes: ReadonlyMap<string, ThemeGraphNode>;
    edges: ThemeEdge[];
    existing: Set<string>;
    isAnchor: (id: string) => boolean;
    counter: LlmCounter;
    strictMode: string;
    provider: LLMProvider | null;
    s2: S2RelationContext;
  },
): Promise<number> {
  const citingNode = ctx.nodes.get(citingId);
  const citing = nodeAsPaper(citingId, citingNode);
  const citingYear = yearOf(citingNode);
  let added = 0;
  for (const [refId, refNode] of ctx.nodes) {
    if (refId === citingId) continue;
    const refYear = yearOf(refNode);
    // A paper cannot cite a newer one (preprint dates aside): skip the
    // lookup rather than store a guaranteed miss.
    if (citingYear !== null && refYear !== null && refYear > citingYear) continue;
    if (!(ctx.isAnchor(citingId) || ctx.isAnchor(refId))) continue;
    const edgeKey = `${refId}\u0000${citingId}`;
    if (ctx.existing.has(edgeKey) || ctx.existing.has(`${citingId}\u0000${refId}`)) continue;
    const ref = nodeAsPaper(refId, refNode);
    const lookup = await ctx.s2.source.lookup(citing, ref);
    if (lookup.kind === "no_s2_data") return added; // whole list unavailable
    if (!lookup.signals.found) continue; // S2: citing does not cite ref
    const cls = await classifyPair(ref, ref, citing, ctx.counter, ctx.strictMode, ctx.s2);
    if (cls === null) continue;
    ctx.edges.push(
      makeEdge(cls, {
        srcId: refId,
        dstId: citingId,
        parent: ref,
        child: citing,
        intentRecord: ref,
        provider: ctx.provider,
      }),
    );
    ctx.existing.add(edgeKey);
    added += 1;
  }
  return added;
}

/**
 * R2-13: link explicit versions of the same work that the citation data
 * left unconnected. For every node whose title is version N of a work
 * ("FlashAttention-3: …"), the in-graph node with the nearest LOWER
 * version of the same title family ("FlashAttention-2", else the
 * unnumbered "FlashAttention") gets a `title_version` supersedes edge to
 * it — only when both years are known and the newer version is not
 * older, and only when no edge already joins the two in either direction
 * (a citation-backed pair was already classified by `classifyPair`).
 * Only the nearest predecessor is linked, so a family becomes a chain
 * (v1 -> v2 -> v3), not a clique. Same family = same lower-cased short
 * title (before the colon) after stripping a trailing `-N`/` N`/` vN`
 * (`isVersionIncrement`: base >= 4 chars, version <= 20), so "GPT-4" or
 * "YOLOv4" style names are never matched by this rule. These edges carry
 * confidence 0.6 and say in the rationale that the citation is missing.
 * Mutates `edges`; returns the number added.
 */
export function addVersionFamilyEdges(
  nodes: ReadonlyMap<string, ThemeGraphNode>,
  edges: ThemeEdge[],
): number {
  const linked = new Set<string>();
  for (const e of edges) {
    linked.add(`${e.src}\u0000${e.dst}`);
    linked.add(`${e.dst}\u0000${e.src}`);
  }
  const versions = new Map<string, { base: string; version: number | null; year: number }>();
  for (const [id, node] of nodes) {
    const v = titleVersionOf(node as unknown as ClassifyPaperLike);
    const year = yearOf(node);
    if (v !== null && year !== null) versions.set(id, { ...v, year });
  }
  let added = 0;
  for (const [childId, child] of [...versions].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (child.version === null) continue;
    let best: string | null = null;
    let bestVersion = -1;
    for (const [parentId, parent] of versions) {
      if (parentId === childId || parent.base !== child.base) continue;
      if (parent.year > child.year) continue;
      const childNode = nodes.get(childId);
      const parentNode = nodes.get(parentId);
      if (
        !isVersionIncrement(
          parentNode as unknown as ClassifyPaperLike,
          childNode as unknown as ClassifyPaperLike,
        )
      ) {
        continue;
      }
      const pv = parent.version ?? 1;
      if (pv > bestVersion || (pv === bestVersion && best !== null && parentId < best)) {
        best = parentId;
        bestVersion = pv;
      }
    }
    if (best === null || linked.has(`${best}\u0000${childId}`)) continue;
    const parent = nodeAsPaper(best, nodes.get(best));
    const childPaper = nodeAsPaper(childId, nodes.get(childId));
    const cls = titleVersionEdge(
      parent as unknown as ClassifyPaperLike,
      childPaper as unknown as ClassifyPaperLike,
      { citationBacked: false },
    );
    edges.push(
      makeEdge(cls, {
        srcId: best,
        dstId: childId,
        parent,
        child: childPaper,
        intentRecord: parent,
        provider: null,
      }),
    );
    linked.add(`${best}\u0000${childId}`);
    linked.add(`${childId}\u0000${best}`);
    added += 1;
  }
  return added;
}
