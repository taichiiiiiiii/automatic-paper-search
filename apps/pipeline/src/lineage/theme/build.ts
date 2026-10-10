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
import { FallbackProvider, type LabelledUsage, usageOf } from "../llm/fallback.js";
import { fetchRelated } from "../shared/fetchRelated.js";
import {
  addCrossNodeEdges,
  addVersionFamilyEdges,
  applyDeferredS2Relations,
  confirmSupportAdmissions,
  dropReversedEdges,
  runBfsAndDescendants,
} from "./bfs.js";
import {
  type CachedClassifyProviderDeps,
  ThemeCachedClassifyProvider,
  type ThemeProducerIdentity,
  wrapProviderWithThemeCache,
} from "./cachedClassifyProvider.js";
import { DegradedClassificationError, evidenceClassifiedRate } from "./classificationGate.js";
import { dedupNodesByStrongAlias, remapEdgeEndpoints } from "./dedup.js";
import {
  CANONICAL_SEED_REFERENCE_LIMIT,
  CANONICAL_SEED_SURVEY_SOURCES,
  type DiscoverSeedsCompleteness,
  discoverSeeds,
  isSurvey,
  rankCanonicalMethodSeeds,
  selectThemeSeeds,
} from "./discoverSeeds.js";
import type { ThemeEdge } from "./edges.js";
import {
  CLASSIFICATION_SCHEMA_VERSION,
  filterEdgesByRationale,
  PRODUCER_NAME,
  PRODUCER_VERSION,
  PROMPT_VERSION,
} from "./edges.js";
import { enrichGithubStars } from "./github.js";
import {
  type IdentityAliasIndex,
  loadIdentityAliases,
  resolveAndDedupSeeds,
  resolveSeedPaperId,
} from "./identity.js";
import { suspectMergedRecords } from "./nodeIdentityGuard.js";
import type { ThemePaper } from "./openalexWork.js";
import { S2CitationSource } from "./s2Citations.js";
import { S2Expansion } from "./s2Expansion.js";
import { contextLlmSummary, newS2RelationStats, type S2RelationContext } from "./s2Relations.js";
import { aliasesFor } from "./seedFilters.js";
import { sanitizeTheme, themeLineagePath, themeSlug } from "./slug.js";
import type { TopicEmbedder } from "./topicEmbedding.js";
import {
  pickTopicalRoot,
  type TopicPaperLike,
  TopicScope,
  type TopicScopeOptions,
} from "./topicScope.js";

/** R2-17: candidates ranked per requested seed before the final pick. */
export const SEED_POOL_FACTOR = 4;

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
  /** R2-11 (design 41 D7): use `deps.topicEmbedder` for the embedding
   * topic gate (default true; false = term-only rule). Ignored when the
   * gate is off or no embedder is injected. */
  topicEmbedding?: boolean;
  /**
   * R2-6 (design 41 D3): minimum share of edges whose relation is backed
   * by real evidence — LLM, S2 intents, citation context, … (see
   * `classificationGate.ts`; only year/citation guesses are
   * unclassified). Below it, `DegradedClassificationError` is thrown
   * BEFORE the write, like the completeness gates. `null`/omitted
   * disables the gate (library callers and older tests); the CLI always
   * passes a threshold. Provider-agnostic: applies whatever `llmStrict` is.
   */
  minClassifiedRate?: number | null;
  /**
   * R2-20: citation-context pairs per LLM request (batched after the BFS,
   * see `s2Relations.ts`). Default {@link DEFAULT_CONTEXT_BATCH_SIZE};
   * 1 asks each pair inline (pre-R2-20 behaviour).
   */
  contextBatchSize?: number;
}

/** R2-20: default pairs per citation-context request. */
export const DEFAULT_CONTEXT_BATCH_SIZE = 6;

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
  buildProvider?: () => {
    provider: LLMProvider;
    rateDelay: number;
    /** R2-20: provider for the citation-context prompt (cheaper model first). */
    contextProvider?: LLMProvider;
  };
  classificationCachePath?: string | null;
  cachedClassifyProviderDeps?: Omit<CachedClassifyProviderDeps, "cachePath" | "now">;
  githubCachePath: string;
  githubToken?: string | null;
  curatedGithubMap?: Record<string, string>;
  githubApiDeps?: GitHubApiDeps;
  /**
   * R2-10 (design 41 D6): classify edges from Semantic Scholar citation
   * contexts first. Omitted/null = the pre-R2-10 path (library callers and
   * offline fixtures); the CLI enables it. `cachePath` is
   * `lineage-cache/s2_references.json`.
   */
  s2Citations?: {
    cachePath: string | null;
    apiKey?: string | null;
    minIntervalMs?: number | null;
    /** Defaults to `fetchImpl` / `sleep` above. */
    fetchImpl?: FetchLike;
  } | null;
  /** R2-11: embedder for the topic gate (`topicEmbedding.ts`); omitted =
   * term-only rule (library callers and tests). */
  topicEmbedder?: TopicEmbedder | null;
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
    topicEmbedding = true,
    minClassifiedRate = null,
    contextBatchSize = DEFAULT_CONTEXT_BATCH_SIZE,
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
    // R2-14: the S2 seed-search fallback uses the S2 key when there is one.
    s2ApiKey: deps.s2Citations?.apiKey ?? null,
  };

  let provider: LLMProvider | null = null;
  let contextProvider: LLMProvider | null = null;
  let innerProviderForSummary: LLMProvider | null = null;
  let innerContextProvider: LLMProvider | null = null;
  if (llmStrict !== "off") {
    if (!deps.buildProvider) {
      throw new Error("buildThemeLineage: deps.buildProvider is required when llmStrict !== 'off'");
    }
    const { provider: innerProvider, contextProvider: innerCtx } = deps.buildProvider();
    innerProviderForSummary = innerProvider;
    innerContextProvider = innerCtx ?? null;
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
    // R2-20: the context chain shares the same in-memory cache.
    contextProvider =
      innerContextProvider === null
        ? null
        : new ThemeCachedClassifyProvider(
            innerContextProvider,
            wrapped.cache,
            identityInfo,
            cacheDeps,
          );
  }
  /** Usage of every provider instance (context-only members included once). */
  const allUsage = (): LabelledUsage[] => {
    const main = usageOf(innerProviderForSummary);
    if (!(innerContextProvider instanceof FallbackProvider)) return main;
    const mainMembers =
      innerProviderForSummary instanceof FallbackProvider
        ? innerProviderForSummary.members
        : [innerProviderForSummary];
    const extra = innerContextProvider.members.filter((m) => !mainMembers.includes(m));
    return [...extra.flatMap((m) => usageOf(m)), ...main];
  };

  const keywords = [sanitised];
  const topicScope = TopicScope.forTheme(sanitised, topicScopeOptions);

  const completeness: DiscoverSeedsCompleteness & BuildCompleteness =
    new BuildCompleteness() as unknown as DiscoverSeedsCompleteness & BuildCompleteness;

  // R2-17: rank a wider pool, then pick the seeds (identity, survey cap,
  // canonical method papers from the surveys' references) below.
  const seedPool = seedsCount * SEED_POOL_FACTOR;
  let seeds = await discoverSeeds(
    {
      keywords,
      topN: seedsCount,
      sinceYear,
      useOpenalexFallback,
      theme: sanitised,
      primarySource,
      topicScope,
      rankLimit: seedPool,
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
          rankLimit: seedPool,
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
    seeds = ranked.slice(0, seedPool);
  }

  const aliasIndex: IdentityAliasIndex = loadIdentityAliases(deps.identityAliasesPath);

  // R2-10: Semantic Scholar citation evidence first (design 41 D6).
  const s2Source =
    deps.s2Citations == null
      ? null
      : new S2CitationSource(deps.s2Citations.cachePath, {
          fetchImpl: deps.s2Citations.fetchImpl ?? deps.fetchImpl,
          sleep: deps.sleep,
          now: wallClockNow,
          monotonicNow: deps.monotonicNow,
          apiKey: deps.s2Citations.apiKey ?? null,
          minIntervalMs: deps.s2Citations.minIntervalMs ?? null,
          logger,
        });
  const s2Relations: S2RelationContext | null =
    s2Source === null
      ? null
      : {
          source: s2Source,
          provider,
          stats: newS2RelationStats(),
          contextProvider: contextProvider ?? provider,
          batchSize: contextBatchSize,
        };
  // R2-14: the same S2 reference lists fill in expansion where OpenAlex
  // has (almost) no references / citing papers.
  const s2Expansion =
    s2Source === null
      ? null
      : new S2Expansion({
          source: s2Source,
          openalex: netDeps,
          cacheDir: deps.cacheDir,
          logger,
        });

  // R2-17 (ERROR_PATTERNS 10): seeds = canonical method papers cited by
  // the theme's surveys + non-survey search hits; a survey only when no
  // method paper exists. Only candidates with a canonical identity can be
  // focus nodes (`resolveAndDedupSeeds`), so the pick tests each one.
  const resolvable = (p: ThemePaper): boolean => {
    try {
      return resolveSeedPaperId(p, aliasIndex)[0] !== null;
    } catch {
      return false;
    }
  };
  const acceptSeed = (selected: readonly ThemePaper[], candidate: ThemePaper): boolean => {
    if (!resolvable(candidate)) return false;
    try {
      return resolveAndDedupSeeds([...selected, candidate], aliasIndex)[0].length > selected.length;
    } catch {
      return false;
    }
  };
  const surveySources = seeds.filter((p) => isSurvey(p)).slice(0, CANONICAL_SEED_SURVEY_SOURCES);
  const refLists: ThemePaper[][] = [];
  for (const survey of surveySources) {
    const lists: ThemePaper[] = [];
    if (s2Expansion !== null) {
      lists.push(
        ...((await s2Expansion.referencesForSeeding(survey, CANONICAL_SEED_REFERENCE_LIMIT)) ?? []),
      );
    }
    if (survey.paperId.startsWith("openalex:")) {
      try {
        // Same limit as the BFS, which shares this (limit-agnostic) cache.
        lists.push(...(await fetchRelated(survey.paperId, "references", width * 4, netDeps, null)));
      } catch (exc) {
        logger.warn(`canonical seeds: references of ${survey.paperId} unavailable: ${String(exc)}`);
      }
    }
    refLists.push(lists);
  }
  const seedIdsSoFar = new Set(seeds.map((p) => p.paperId));
  const canonical = rankCanonicalMethodSeeds(refLists, {
    scope: topicScope,
    limit: seedsCount,
    // BFS-expandable OpenAlex ids only (an S2-id seed would expand through
    // the slow S2 path), with a canonical identity.
    accept: (p) =>
      p.paperId.startsWith("openalex:") && !seedIdsSoFar.has(p.paperId) && resolvable(p),
  });
  const pickedSeeds = selectThemeSeeds(seeds, canonical, {
    topN: seedsCount,
    canonicalSlots: Math.ceil(seedsCount / 2),
    accept: acceptSeed,
    preferred: (p) => topicScope.role(p) === "subject",
  });
  const canonicalIds = new Set(canonical.map((p) => p.paperId));
  logger.warn(
    `seeds: picked ${pickedSeeds.length}/${seedsCount} from ${seeds.length} ranked candidate(s) and ` +
      `${canonical.length} canonical method paper(s) cited by ${surveySources.length} survey(s): ` +
      pickedSeeds
        .map(
          (p) =>
            `${canonicalIds.has(p.paperId) ? "canonical" : isSurvey(p) ? "survey" : "search"}:${p.paperId}`,
        )
        .join(", "),
  );
  const [resolvedSeeds, seedByGraphId] = resolveAndDedupSeeds(pickedSeeds, aliasIndex);
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
      s2Relations,
      topicEmbedder: topicEmbedding ? (deps.topicEmbedder ?? null) : null,
      s2Expansion,
    },
    netDeps,
    completeness,
  );
  if (s2Expansion !== null) logger.info?.(s2Expansion.summary());
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
    { provider, strictMode: llmStrict, s2Relations },
    netDeps,
    completeness,
  );
  if (crossAdded > 0) {
    logger.warn(`cross-node pass added ${crossAdded} edges (in-graph citations not seen by BFS)`);
  }
  // R2-20: batched context-LLM answers for the pairs deferred above.
  const deferredChanged = await applyDeferredS2Relations(edges, s2Relations, provider);
  if (deferredChanged > 0) {
    logger.info?.(`context-llm: ${deferredChanged} deferred edge(s) refined by batched answers`);
  }
  // R2-13: explicit versions of one work (FlashAttention -> -2 -> -3)
  // that no citation in the data connects.
  const versionAdded = addVersionFamilyEdges(nodes, edges);
  if (versionAdded > 0) {
    logger.warn(
      `version-family pass added ${versionAdded} title_version edge(s) between explicit versions with no citation in the data`,
    );
  }
  if (s2Source !== null && s2Relations !== null) {
    // Persist before any gate can fail the build: the next run reuses it.
    s2Source.flush();
    const st = s2Relations.stats;
    logger.info?.(s2Source.summary());
    logger.info?.(
      `s2 relations summary: rule=${st.rule}, context-llm asked=${st.llmAsked} answered=${st.llmAnswered}, ` +
        `left to the abstract/heuristic path: cites_unspecified=${st.unspecified} no-s2-data=${st.noS2Data}`,
    );
    logger.info?.(contextLlmSummary(st));
  }

  // R2-2d: provisional admissions (co-citation support, abstract-only
  // citing papers) need on-topic NON-seed papers linking to them, which
  // only the cross-node pass can reveal at depth 1.
  if (topicScope.options.gate && bfsResult.provisional.size > 0) {
    const confirmed = confirmSupportAdmissions(nodes, edges, {
      seedIds: new Set(seedIds),
      provisional: bfsResult.provisional,
      onTopicIds: bfsResult.onTopicIds,
      minSupport: topicScope.options.minSupport,
    });
    edges = confirmed.edges;
    if (confirmed.dropped.length > 0) {
      logger.warn(
        `topic gate: dropped ${confirmed.dropped.length}/${bfsResult.provisional.size} provisional node(s) with < ${topicScope.options.minSupport} on-topic non-seed links after the cross-node pass`,
      );
    }
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

  // R2-17: 2-cycles from revised preprints (PVT <-> PVT v2) keep only the
  // direction consistent with the years.
  const reversed = dropReversedEdges(nodes, edges);
  edges = reversed.edges;
  for (const d of reversed.dropped) {
    logger.warn(`reversed edge: dropped ${d.src} -> ${d.dst} (${d.relation}; ${d.reason})`);
  }
  if (reversed.loneInverted > 0) {
    logger.info(
      `reversed edge: kept ${reversed.loneInverted} year-inverted edge(s) with no reverse edge (preprint vs venue year)`,
    );
  }

  // R2-22: mis-merged bibliographic records (an OpenAlex slide-deck record
  // carrying ChebNet's citations). Dropped non-focus nodes take their edges
  // with them; flagged ones stay and are listed in meta for the audit.
  const suspects = suspectMergedRecords(
    nodes.values() as Iterable<Record<string, unknown> & { id: string }>,
    {
      focusIds: new Set(seedIds),
      currentYear: wallClockNow().getUTCFullYear(),
    },
  );
  const droppedRecords = new Set(suspects.filter((s) => s.action === "dropped").map((s) => s.id));
  if (droppedRecords.size > 0) {
    for (const id of droppedRecords) nodes.delete(id);
    edges = edges.filter((e) => !droppedRecords.has(e.src) && !droppedRecords.has(e.dst));
  }
  for (const s of suspects) {
    logger.warn(
      `suspect record: ${s.action} ${s.id} (${s.reasons.join(", ")}) ${JSON.stringify(s.title)}`,
    );
  }

  const cleanedEdges = filterEdgesByRationale(edges);

  logClassifySummary(
    classifyAttempted,
    classifySucceeded,
    { hasExtraNodes: nodes.size > seedIds.length, hasEdges: cleanedEdges.length > 0 },
    { logger },
  );
  // No LLM calls happen after this point: report the provider's own
  // rate-limit accounting (calls / 429s / waits / breaker) next to it.
  const usage = innerProviderForSummary?.usageSummary?.();
  if (usage) logger.info?.(usage);
  // R2-20: the context-model member(s) that only the context chain holds.
  for (const u of allUsage()) {
    if (u.summary && !(usage ?? "").includes(u.summary)) logger.info?.(u.summary);
  }

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

  const sortedFocus = [...focusIdSet].sort(codepointCompare);
  const topicalRoot = pickRootSeed(sortedFocus, orderedEdges, {
    scope: topicScope,
    papers: nodes as ReadonlyMap<string, TopicPaperLike>,
  });
  // R2-13: the artifact contract (`contract/v1.ts` root_deterministic, and
  // the web parser) requires the highest-degree focus node as root. The
  // R2-2b topical rule can pick another seed (a foundational seed ranks
  // first: FlashAttention over the better-connected FlashAttention-2 once
  // the versions are linked), which made the build throw. Keep the
  // contract's root and log the disagreement.
  const rootId = pickRootSeed(sortedFocus, orderedEdges);
  if (topicalRoot !== rootId) {
    logger.warn(
      `root: topical choice ${topicalRoot} differs from the contract's highest-degree focus ${rootId}; using ${rootId}`,
    );
  }

  const provenanceBreakdown: Record<string, number> = {};
  for (const e of orderedEdges) {
    const method = (e.provenance as Record<string, Record<string, unknown>>).classification
      ?.method as string;
    provenanceBreakdown[method] = (provenanceBreakdown[method] ?? 0) + 1;
  }

  const canonicalSeedIds = seedIds.filter((id) => canonicalIds.has(id)).sort(codepointCompare);
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
      // R2-11 (design 41 D7): which topic rule admitted the nodes.
      ...(bfsResult.topicGate !== null ? { topic_gate: bfsResult.topicGate } : {}),
      // R2-17: seeds taken from the theme surveys' reference lists (canonical
      // method papers). Their titles often omit the theme words (GraphSAGE:
      // "Inductive Representation Learning on Large Graphs"), so the
      // seed-topic audit accepts them on this provenance instead.
      ...(canonicalSeedIds.length > 0 ? { canonical_seeds: canonicalSeedIds } : {}),
      // R2-22: records the identity guard dropped or flagged.
      ...(suspects.length > 0 ? { suspect_records: suspects } : {}),
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

  // R2-6 (design 41 D3): refuse to publish a lineage whose relations are
  // mostly year/citation guesses (no evidence source answered).
  const classifiedRate = evidenceClassifiedRate(provenanceBreakdown);
  logger.info(
    `evidence-classified rate: ${classifiedRate.ratio === null ? "n/a" : `${(classifiedRate.ratio * 100).toFixed(1)}%`} ` +
      `(classified=${classifiedRate.classified}/${classifiedRate.total}, year/citation guesses=${classifiedRate.guessed})` +
      (minClassifiedRate !== null
        ? `, threshold=${(minClassifiedRate * 100).toFixed(1)}%`
        : ", gate disabled"),
  );
  if (
    minClassifiedRate !== null &&
    classifiedRate.ratio !== null &&
    classifiedRate.ratio < minClassifiedRate
  ) {
    throw new DegradedClassificationError(sanitised, classifiedRate, minClassifiedRate, allUsage());
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
