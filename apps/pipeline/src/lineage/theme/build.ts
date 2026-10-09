/**
 * Theme-to-family-tree pipeline orchestration — TS port of
 * `paperpilot/scripts/build_theme_lineage.py`'s `ZeroEdgeBuildError`,
 * `_log_classify_summary`, `_pick_root_seed`, `build_theme_lineage`.
 *
 * Pipeline:
 *  1. Sanitise the theme, derive the slug.
 *  2. (skipped: keyword-expansion LLM call — the raw theme is the single
 *     search keyword, matching the Python original's current behaviour.)
 *  3. Discover seeds (`discoverSeeds.ts`), merge theme-alias seeds.
 *  4. Resolve focus identity from exact strong aliases (`identity.ts`).
 *  5. BFS ancestors/descendants (`bfs.ts`), cross-node edges.
 *  6. GitHub stars enrichment (`github.ts`).
 *  7. Final strong-alias node dedup (`dedup.ts`).
 *  8. Drop degenerate-rationale edges, log the classify summary.
 *  9. Prune non-focus nodes no surviving edge touches (`pruneEdgelessNodes`).
 * 10. Serialize lineage-artifact-v1 in graph-ID/wire-key order, validate,
 *     run the completeness gates, then atomically replace the output.
 *
 * Per CLAUDE.md absolute rule §14: this is the sole writer of
 * `docs/themes/<slug>/lineage.json`; the slug is the only thing spliced
 * into the output path (via `themeLineagePath`), and the raw `--theme`
 * string never reaches a `Path`.
 */

import { codepointCompare, pyFloat, pyIsoformat, pyJsonDumps } from "@paperpilot/core";
import type { FetchLike } from "../../collect/http/requestWithRetry.js";
import type { LLMProvider } from "../../collect/llm/provider.js";
import type { GitHubApiDeps } from "../../collect/signals/githubApi.js";
import { atomicWriteText } from "../../collect/state/atomic.js";
import { isPaperId, LINEAGE_ARTIFACT_VERSION, validateLineageArtifact } from "../contract/v1.js";
import {
  BuildCompleteness,
  expansionGateBlocks,
  focusIds,
  IncompleteBuildError,
} from "../fetch-state/completeness.js";
import { addCrossNodeEdges, runBfsAndDescendants } from "./bfs.js";
import {
  type CachedClassifyProviderDeps,
  type ThemeProducerIdentity,
  wrapProviderWithThemeCache,
} from "./cachedClassifyProvider.js";
import { dedupNodesByStrongAlias, remapEdgeEndpoints } from "./dedup.js";
import { type DiscoverSeedsCompleteness, discoverSeeds } from "./discoverSeeds.js";
import type { ThemeEdge } from "./edges.js";
import {
  CLASSIFICATION_SCHEMA_VERSION,
  filterEdgesByRationale,
  PRODUCER_NAME,
  PRODUCER_VERSION,
  PROMPT_VERSION,
} from "./edges.js";
import { enrichGithubStars } from "./github.js";
import { type IdentityAliasIndex, loadIdentityAliases, resolveAndDedupSeeds } from "./identity.js";
import type { ThemePaper } from "./openalexWork.js";
import { aliasesFor } from "./seedFilters.js";
import { sanitizeTheme, themeLineagePath, themeSlug } from "./slug.js";
import {
  pickTopicalRoot,
  type TopicPaperLike,
  TopicScope,
  type TopicScopeOptions,
} from "./topicScope.js";

/** Every full-method logger this pipeline's sub-modules ask for, built
 * once from whatever subset the caller supplies (missing methods
 * default to no-ops) so one logger object can be handed to every
 * sub-module regardless of which methods its own deps type requires. */
interface FullLogger {
  warn: (msg: string) => void;
  info: (msg: string) => void;
  debug: (msg: string) => void;
}

/** Raised instead of publishing when the caller opted out of 0-edge
 * results via `buildThemeLineage({..., allowEdgeless: false})`. See
 * the Python docstring (same name) for why this is opt-in, not
 * automatic: a structurally empty edge set is not itself evidence of
 * an outage. Raised BEFORE the atomic replace, like the completeness
 * gates, so the previously published artifact (if any) is untouched. */
export class ZeroEdgeBuildError extends Error {}

/**
 * Non-mutating JSON-safe view of `edge` for `pyJsonDumps`: `conf`/
 * `confidence` are a Python `float` in the source (p4-followups #24), so
 * an exactly-1.0/0.0 value must serialize as `1.0`/`0.0`, not `1`/`0`.
 * Applied only right before serialization (the duplicate-elimination
 * byte-comparison below, and the final write) — not at `ThemeEdge`
 * construction (`edges.ts::makeEdge`) or anywhere `edge.confidence` is
 * still read as a plain `number` (arithmetic, `typeof` checks,
 * `validateLineageArtifact`), since `PyFloat` has no numeric coercion.
 */
export function edgeForJson(edge: ThemeEdge): Record<string, unknown> {
  return { ...edge, conf: pyFloat(edge.conf), confidence: pyFloat(edge.confidence) };
}

export interface LogClassifySummaryDeps {
  logger?: { info?: (msg: string) => void; warn: (msg: string) => void };
}

/** Emit the post-build LLM-failure-rate summary + the three distinct
 * degraded-data warnings (#45). */
export function logClassifySummary(
  classifyAttempted: number,
  classifySucceeded: number,
  options: { hasExtraNodes: boolean; hasEdges: boolean },
  deps: LogClassifySummaryDeps = {},
): void {
  const classifyFailed = classifyAttempted - classifySucceeded;
  const failRate = classifyAttempted ? classifyFailed / classifyAttempted : 0.0;
  deps.logger?.info?.(
    `classify summary: attempted=${classifyAttempted}, success=${classifySucceeded}, failed=${classifyFailed} (${(failRate * 100).toFixed(1)}% failure)`,
  );
  if (classifyAttempted && failRate > 0.3) {
    deps.logger?.warn(
      `high LLM failure rate (${(failRate * 100).toFixed(1)}%) — likely Groq RPM/daily quota; consider re-running after quota resets`,
    );
  }
  if (classifyAttempted === 0 && options.hasExtraNodes) {
    deps.logger?.warn(
      "no classify calls attempted — every parent was filtered out (non-influential per S2). Theme may be too narrow.",
    );
  }
  if (!options.hasEdges) {
    deps.logger?.warn(
      "produced 0 edges — data quality is degraded. A direct library call still publishes this (a lone seed, " +
        "every parent filtered, or a genuinely empty theme are all valid facts); the CLI refuses to publish an " +
        "edgeless artifact (exit 3, nothing written; any previously published lineage.json is left untouched). See issue #45.",
    );
  }
}

/**
 * Drop every non-focus node that no edge touches (R2: the lineage
 * quality audit's `orphan_node_count` must be 0 for a publicly eligible
 * lineage). Focus/seed nodes — and therefore the root, which is always
 * picked among them — are kept even when edge-less, so a lone-seed or
 * genuinely edge-less theme still publishes its seeds. Order of the
 * surviving nodes is preserved. `clusters` is always `[]` for themes and
 * `meta.seeds` lists only focus ids, so nothing else references a pruned
 * node; edges are not touched.
 */
export function pruneEdgelessNodes<T extends { id: string; is_focus?: boolean }>(
  nodes: readonly T[],
  edges: readonly { src: string; dst: string }[],
): T[] {
  const touched = new Set<string>();
  for (const edge of edges) {
    touched.add(edge.src);
    touched.add(edge.dst);
  }
  return nodes.filter((node) => node.is_focus === true || touched.has(node.id));
}

/** Pick degree-desc / graph-ID-asc; never use input-order fallback.
 *
 * R2-2b: with `topical`, the root is instead the most central seed among
 * those whose main subject is the theme (`pickTopicalRoot`: topic role
 * first, then edges to on-topic nodes, then all edges, then graph ID).
 * Raw degree alone rewarded the seed that dragged in the largest
 * off-topic neighbourhood — SuperGlue (GNNs as a component of feature
 * matching) became the GNN root through its SLAM/SfM/ScanNet references. */
export function pickRootSeed(
  seedIds: readonly string[],
  cleanedEdges: readonly ThemeEdge[],
  topical?: { scope: TopicScope; papers: ReadonlyMap<string, TopicPaperLike> },
): string | null {
  if (seedIds.length === 0) return null;
  if (topical) return pickTopicalRoot(seedIds, cleanedEdges, topical.papers, topical.scope);
  const edgeCount = new Map<string, number>();
  for (const e of cleanedEdges) {
    edgeCount.set(e.src, (edgeCount.get(e.src) ?? 0) + 1);
    edgeCount.set(e.dst, (edgeCount.get(e.dst) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestKey: [number, string] | null = null;
  for (const nid of new Set(seedIds)) {
    const key: [number, string] = [-(edgeCount.get(nid) ?? 0), nid];
    if (
      bestKey === null ||
      key[0] < bestKey[0] ||
      (key[0] === bestKey[0] && codepointCompare(key[1], bestKey[1]) < 0)
    ) {
      best = nid;
      bestKey = key;
    }
  }
  return best;
}

export interface BuildThemeLineageOptions {
  theme: string;
  depth: number;
  seedsCount: number;
  width: number;
  sinceYear: number | null;
  /** Override output path (bypasses the `themeSlug()` gate — do not use
   * with untrusted input; CI/test only, matching the Python `--output`). */
  output?: string | null;
  useOpenalexFallback?: boolean;
  llmStrict?: "off" | "ambiguous" | "all";
  primarySource?: "s2" | "openalex";
  allowIncomplete?: boolean;
  /** When `false`, a 0-edge result throws `ZeroEdgeBuildError` instead of
   * being written. Defaults to `true` (today's library-caller default). */
  allowEdgeless?: boolean;
  /** R2-2b topic-scope tunables (seed weighting, root choice, BFS
   * admission gate); omitted fields take `DEFAULT_TOPIC_SCOPE_OPTIONS`.
   * `{ gate: false }` turns the BFS admission gate off. */
  topicScope?: Partial<TopicScopeOptions>;
}

/** All injected dependencies for one `buildThemeLineage` call. Not a
 * naive `extends` of each sub-module's deps type: `OpenAlexDeps`/
 * `FetchRelatedDeps`'s `now` is a MONOTONIC clock (`() => number`, for
 * HTTP-retry backoff timing) while `EnrichGithubStarsDeps`'s `now` is a
 * WALL clock (`() => Date`, for cache TTL / `generated_at`) — same field
 * name, deliberately different meaning in Python too
 * (`time.monotonic()` vs `datetime.now(timezone.utc)`). Kept as two
 * separate fields here (`monotonicNow`, `wallClockNow`) and mapped onto
 * each sub-module's own `now` parameter name at its call site below,
 * rather than forcing one field to serve both contracts. */
export interface BuildThemeLineageDeps {
  fetchImpl: FetchLike;
  cacheDir: string;
  sleep: (ms: number) => Promise<void>;
  monotonicNow?: () => number;
  wallClockNow?: () => Date;
  logger?: {
    warn?: (msg: string) => void;
    info?: (msg: string) => void;
    debug?: (msg: string) => void;
  };
  /** OpenAlex polite-pool email. */
  email?: string | null;
  docsRoot: string;
  identityAliasesPath: string;
  /** Only required when `llmStrict !== "off"`. */
  buildProvider?: () => { provider: LLMProvider; rateDelay: number };
  classificationCachePath?: string | null;
  cachedClassifyProviderDeps?: Omit<CachedClassifyProviderDeps, "cachePath" | "now">;
  githubCachePath: string;
  githubToken?: string | null;
  curatedGithubMap?: Record<string, string>;
  githubApiDeps?: GitHubApiDeps;
}

function fullLogger(partial?: BuildThemeLineageDeps["logger"]): FullLogger {
  return {
    warn: partial?.warn ?? (() => {}),
    info: partial?.info ?? (() => {}),
    debug: partial?.debug ?? (() => {}),
  };
}

/** Run the full theme-to-family-tree pipeline; return the output path. */
export async function buildThemeLineage(
  options: BuildThemeLineageOptions,
  deps: BuildThemeLineageDeps,
): Promise<string> {
  const {
    theme,
    depth,
    seedsCount,
    width,
    sinceYear,
    output = null,
    useOpenalexFallback = true,
    llmStrict = "off",
    primarySource = "s2",
    allowIncomplete = false,
    allowEdgeless = true,
    topicScope: topicScopeOptions = {},
  } = options;

  const sanitised = sanitizeTheme(theme);
  const slug = themeSlug(sanitised);
  const wallClockNow = deps.wallClockNow ?? (() => new Date());
  const logger = fullLogger(deps.logger);

  // The deps shape every network-touching sub-module (discoverSeeds,
  // fetchRelated, the BFS) actually asks for — monotonic `now` for HTTP
  // backoff timing, never the wall clock. See `BuildThemeLineageDeps`'s
  // doc comment for why these are two separate fields upstream.
  const netDeps = {
    fetchImpl: deps.fetchImpl,
    cacheDir: deps.cacheDir,
    sleep: deps.sleep,
    now: deps.monotonicNow,
    logger,
    email: deps.email,
  };

  let provider: LLMProvider | null = null;
  if (llmStrict !== "off") {
    if (!deps.buildProvider) {
      throw new Error("buildThemeLineage: deps.buildProvider is required when llmStrict !== 'off'");
    }
    const { provider: innerProvider } = deps.buildProvider();
    const identityInfo: ThemeProducerIdentity = {
      producerName: PRODUCER_NAME,
      producerVersion: PRODUCER_VERSION,
      promptVersion: PROMPT_VERSION,
      classificationSchemaVersion: CLASSIFICATION_SCHEMA_VERSION,
    };
    const cacheDeps: CachedClassifyProviderDeps = {
      cachePath: deps.classificationCachePath ?? null,
      now: wallClockNow,
      ...deps.cachedClassifyProviderDeps,
    };
    const wrapped = wrapProviderWithThemeCache(innerProvider, identityInfo, cacheDeps);
    provider = wrapped.provider;
  }

  const keywords = [sanitised];
  const topicScope = TopicScope.forTheme(sanitised, topicScopeOptions);

  const completeness: DiscoverSeedsCompleteness & BuildCompleteness =
    new BuildCompleteness() as unknown as DiscoverSeedsCompleteness & BuildCompleteness;

  let seeds = await discoverSeeds(
    {
      keywords,
      topN: seedsCount,
      sinceYear,
      useOpenalexFallback,
      theme: sanitised,
      primarySource,
      topicScope,
    },
    netDeps,
    completeness,
  );

  const aliases = aliasesFor(sanitised);
  if (aliases.length > 0) {
    const mergedById = new Map<string, ThemePaper>();
    for (const s of seeds) if (s.paperId) mergedById.set(s.paperId, s);
    for (const altKw of aliases) {
      const aliasLedger = new BuildCompleteness();
      const altSeeds = await discoverSeeds(
        {
          keywords: [altKw],
          topN: seedsCount,
          sinceYear,
          useOpenalexFallback,
          theme: sanitised,
          primarySource,
          topicScope,
        },
        netDeps,
        aliasLedger as unknown as DiscoverSeedsCompleteness,
      );
      for (const reason of aliasLedger.subjectFailures)
        completeness.supplementFailed(`alias ${JSON.stringify(altKw)}: ${reason}`);
      for (const reason of aliasLedger.supplementFailures)
        completeness.supplementFailed(`alias ${JSON.stringify(altKw)}: ${reason}`);
      completeness.expansionsAttempted += aliasLedger.expansionsAttempted;
      completeness.expansionsFailed += aliasLedger.expansionsFailed;
      for (const s of altSeeds) {
        const pid = s.paperId;
        if (pid && !mergedById.has(pid)) mergedById.set(pid, s);
      }
    }
    // R2-2b: citation count weighted by topic role, so an alias search
    // cannot re-promote a seed that only uses the theme as a component.
    const weighted = (p: ThemePaper): number =>
      (Number(p.citationCount) || 0) * topicScope.seedWeight(p);
    const ranked = [...mergedById.values()].sort((a, b) => weighted(b) - weighted(a));
    seeds = ranked.slice(0, seedsCount);
  }

  const aliasIndex: IdentityAliasIndex = loadIdentityAliases(deps.identityAliasesPath);
  const [resolvedSeeds, seedByGraphId] = resolveAndDedupSeeds(seeds, aliasIndex);
  seeds = resolvedSeeds;

  const maxSeedCite = seeds.reduce((max, s) => Math.max(max, Number(s.citationCount) || 0), 0);

  const bfsResult = await runBfsAndDescendants(
    seeds,
    // Python's `_run_bfs_and_descendants` stamps `datetime.now(timezone.utc).year`
    // directly (a DIFFERENT clock read from `_rank_and_truncate`'s local
    // `datetime.now().year` inside seed discovery/ranking, which is not
    // plumbed here — see that function's own doc comment).
    {
      depth,
      width,
      maxSeedCite,
      provider,
      llmStrict,
      currentYear: wallClockNow().getUTCFullYear(),
      topicScope,
    },
    netDeps,
    completeness,
  );
  let nodes = bfsResult.nodes;
  let edges: ThemeEdge[] = bfsResult.edges;
  let seedIds = bfsResult.seedIds;
  const { classifyAttempted, classifySucceeded } = bfsResult;
  if (provider !== null && bfsResult.llmCalls > 0 && bfsResult.llmUnusable > 0) {
    logger.warn(
      `LLM classifier returned nothing usable for ${bfsResult.llmUnusable}/${bfsResult.llmCalls} BFS pair(s); ` +
        "those pairs keep only their heuristic signal and year/citation guesses are emitted as " +
        "citation_heuristic successor edges (confidence 0.4), never as contrasts",
    );
  }

  const crossAdded = await addCrossNodeEdges(
    nodes,
    edges,
    { provider, strictMode: llmStrict },
    netDeps,
    completeness,
  );
  if (crossAdded > 0) {
    logger.warn(`cross-node pass added ${crossAdded} edges (in-graph citations not seen by BFS)`);
  }

  await enrichGithubStars(nodes, {
    cachePath: deps.githubCachePath,
    githubToken: deps.githubToken,
    curated: deps.curatedGithubMap,
    apiDeps: deps.githubApiDeps,
    now: wallClockNow,
    logger,
  });

  const [dedupedNodes, nodeRemap, dedupedSeedByGraphId] = dedupNodesByStrongAlias(
    nodes,
    seedByGraphId,
    aliasIndex,
  );
  nodes = dedupedNodes;
  if (nodeRemap.size > 0) {
    edges = remapEdgeEndpoints(edges, nodeRemap);
    seedIds = [...new Set(seedIds.map((sid) => nodeRemap.get(sid) ?? sid))].sort(codepointCompare);
  }

  const cleanedEdges = filterEdgesByRationale(edges);

  logClassifySummary(
    classifyAttempted,
    classifySucceeded,
    { hasExtraNodes: nodes.size > seedIds.length, hasEdges: cleanedEdges.length > 0 },
    { logger },
  );

  // Wire aliases + deterministic duplicate elimination/order.
  const edgeGroups = new Map<string, ThemeEdge[]>();
  const groupKeys: [string, string, string][] = [];
  for (const edge of cleanedEdges) {
    if (
      !(
        typeof edge.relation === "string" &&
        typeof edge.confidence === "number" &&
        edge.provenance !== null &&
        typeof edge.provenance === "object"
      )
    ) {
      throw new RangeError("legacy or incomplete theme edge cannot be serialized");
    }
    const key = `${edge.src}\u0000${edge.dst}\u0000${edge.relation}`;
    const list = edgeGroups.get(key);
    if (list) {
      list.push(edge);
    } else {
      edgeGroups.set(key, [edge]);
      groupKeys.push([edge.src, edge.dst, edge.relation]);
    }
  }
  groupKeys.sort(
    (a, b) =>
      codepointCompare(a[0], b[0]) || codepointCompare(a[1], b[1]) || codepointCompare(a[2], b[2]),
  );
  const orderedEdges = groupKeys.map(([src, dst, relation]) => {
    const group = edgeGroups.get(`${src}\u0000${dst}\u0000${relation}`)!;
    let best = group[0]!;
    let bestJson = pyJsonDumps(edgeForJson(best), {
      ensureAscii: false,
      sortKeys: true,
      separators: [",", ":"],
    });
    for (const candidate of group.slice(1)) {
      const candidateJson = pyJsonDumps(edgeForJson(candidate), {
        ensureAscii: false,
        sortKeys: true,
        separators: [",", ":"],
      });
      if (codepointCompare(candidateJson, bestJson) < 0) {
        best = candidate;
        bestJson = candidateJson;
      }
    }
    return best;
  });

  const focusIdSet = new Set(seedIds);
  for (const node of nodes.values()) {
    // Unlike `toNode`'s own conditional-omit behaviour (only sets the key
    // when true), this final pass ALWAYS sets `is_focus` explicitly —
    // matching Python's `node["is_focus"] = node["id"] in focus_ids`,
    // which runs unconditionally over every node here.
    node.is_focus = focusIdSet.has(node.id);
    delete (node as Record<string, unknown>).seed_paper_id;
    if (node.is_focus) {
      const seedPaperId = dedupedSeedByGraphId.get(node.id);
      if (!isPaperId(seedPaperId)) {
        throw new RangeError(`theme focus node ${JSON.stringify(node.id)} lacks canonical seed`);
      }
      node.seed_paper_id = seedPaperId;
    }
  }
  const orderedNodes = pruneEdgelessNodes(
    [...nodes.values()].sort((a, b) => codepointCompare(a.id, b.id)),
    orderedEdges,
  );

  const rootId = pickRootSeed([...focusIdSet].sort(codepointCompare), orderedEdges, {
    scope: topicScope,
    papers: nodes as ReadonlyMap<string, TopicPaperLike>,
  });

  const provenanceBreakdown: Record<string, number> = {};
  for (const e of orderedEdges) {
    const method = (e.provenance as Record<string, Record<string, unknown>>).classification
      ?.method as string;
    provenanceBreakdown[method] = (provenanceBreakdown[method] ?? 0) + 1;
  }

  const payload = {
    schema_version: LINEAGE_ARTIFACT_VERSION,
    root: rootId,
    nodes: orderedNodes,
    edges: orderedEdges,
    clusters: [] as unknown[],
    meta: {
      kind: "theme",
      generator: PRODUCER_NAME,
      source: "build_theme_lineage.py",
      theme: sanitised,
      slug,
      keywords,
      seeds: seedIds,
      depth,
      since_year: sinceYear,
      // Python's `_iso_z` is `isoformat().replace("+00:00", "Z")`, which
      // (unlike `Date.toISOString()`) omits `.000` for a whole-second
      // clock — use `pyIsoformat` for byte-identical output.
      generated_at: pyIsoformat(wallClockNow()).replace("+00:00", "Z"),
      provenance_breakdown: provenanceBreakdown,
      completeness: completeness.asMeta(),
    },
  };

  for (const node of orderedNodes) {
    if (node.is_focus === true && !isPaperId(node.seed_paper_id)) {
      throw new RangeError(`theme focus node ${JSON.stringify(node.id)} lacks canonical seed`);
    }
  }
  const issues = validateLineageArtifact(payload, { kind: "theme" });
  if (issues.length > 0) {
    const detail = issues
      .slice(0, 8)
      .map((issue) => `${issue.code}:${issue.path}`)
      .join("; ");
    throw new RangeError(`generated theme violates ${LINEAGE_ARTIFACT_VERSION}: ${detail}`);
  }

  const outPath = output !== null ? output : themeLineagePath(deps.docsRoot, slug);

  if (completeness.supplementFailures.length > 0 && focusIds(orderedNodes).size === 0) {
    for (const reason of completeness.supplementFailures) {
      completeness.subjectFailed(
        `no focus paper survived; supplementary failure promoted: ${reason}`,
      );
    }
    completeness.supplementFailures.length = 0;
  }
  if (!completeness.subjectComplete) {
    throw new IncompleteBuildError(completeness.subjectGateMessage());
  }
  if (!allowIncomplete) {
    const blocked = expansionGateBlocks(completeness, {
      newNodeCount: orderedNodes.length,
      newEdgeCount: orderedEdges.length,
      publishedPath: outPath,
      newNodes: orderedNodes,
      newEdges: orderedEdges,
    });
    if (blocked) throw new IncompleteBuildError(blocked);
  }

  if (!allowEdgeless && orderedEdges.length === 0) {
    throw new ZeroEdgeBuildError(
      `0 edges produced for theme ${JSON.stringify(sanitised)} (slug ${JSON.stringify(slug)}) over ${orderedNodes.length} node(s); refusing to write ${outPath}`,
    );
  }

  // `payload` itself keeps plain-number edge confidence (already validated
  // above, and read again below by `expansionGateBlocks`); only the bytes
  // written to disk need the float marker (p4-followups #24).
  const payloadForJson = { ...payload, edges: orderedEdges.map(edgeForJson) };
  atomicWriteText(outPath, `${pyJsonDumps(payloadForJson, { ensureAscii: false, indent: 2 })}\n`);
  logger.warn(
    `wrote ${outPath} (nodes=${orderedNodes.length} edges=${orderedEdges.length} root=${rootId})`,
  );
  return outPath;
}
