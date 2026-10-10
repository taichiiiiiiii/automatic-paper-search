/**
 * Build a real lineage graph for a conference's Oral papers via Semantic
 * Scholar + an LLM — TS port of `paperpilot/scripts/build_lineage.py`
 * (LIN-05, LIN-06, LIN-07, LIN-20, LIN-23, LIN-37 of
 * docs/migration/safety-contracts.md).
 *
 * For each Oral paper in docs/<conference>/papers.json:
 *   1. Resolve to a Semantic Scholar paperId via arXiv ID.
 *   2. Fetch top-N references (parents) and citations (children) from S2.
 *   3. Classify each (focus, related) pair into one of supersedes/successor/
 *      extends/ablation/baseline_only/contrasts/unrelated.
 *   4. Persist results to docs/<conference>/lineage.json.
 *
 * Per absolute rule §12 (family-tree exception): S2 `references`/
 * `citations` fetches are allowed here because the citation graph is not
 * in Stage 2 output. The focus paper's `venue`/`citation_count`/
 * `github_stars` still come from `papers.json` — S2 is used only for edge
 * structure plus neighbour titles/authors.
 *
 * Reuses the shared `build_lineage.py`-family pieces consolidated in
 * `../shared/` per docs/migration/p4-followups.md #23: `toNode`/
 * `venueTierFor` (shared/node.ts), `buildProvider`
 * (shared/providerFactory.ts), `fetchRelated`/`s2Get`/`S2TransientError`
 * (shared/fetchRelated.ts), plus `deriveRelation` + the classification
 * cache (classify/classify.ts, classify/cache.ts).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pyJsonDumps } from "@paperpilot/core";
import {
  IdentityError,
  identityFromUrl,
  isArxivHost,
  normalizeAlias,
} from "@paperpilot/core/identity";
import { layoutFor, lineageCacheDir } from "@paperpilot/core/layout";
import { validateConferenceSlug } from "@paperpilot/core/slug";
import type {
  ClassifyPaperLike,
  LLMProvider,
  RelationClassification,
} from "../../collect/llm/provider.js";
import { atomicWriteText } from "../../collect/state/atomic.js";
import {
  type ClassificationCache,
  loadClassificationCache,
  persistClassifications,
} from "../classify/cache.js";
import { deriveRelation } from "../classify/classify.js";
import {
  CLASSIFICATION_METHODS,
  canonicalJsonSha256,
  LINEAGE_ARTIFACT_VERSION,
  makeProvenance,
  requirePaperId,
  requireValidLineageArtifact,
} from "../contract/v1.js";
import {
  type BuildCompleteness,
  expansionGateBlocks,
  IncompleteFetchError,
} from "../fetch-state/completeness.js";
import {
  buildClassifyPrompt,
  providerModelTag,
  relationClassificationFromDict,
} from "../llm/base.js";
import {
  type BuildCompletenessForExpansion,
  type FetchRelatedDeps,
  fetchRelated as fetchRelatedShared,
  S2TransientError,
  s2Get,
} from "../shared/fetchRelated.js";
import { type ThemeGraphNode, toNode } from "../shared/node.js";
import { filterEdgesByRationale, isDegenerateRationale } from "../shared/rationale.js";
import { s2PaperId, s2PaperShape } from "../theme/payloadShape.js";

export { S2TransientError };

const PRODUCER_NAME = "paperpilot.scripts.build_lineage";
const PRODUCER_VERSION = "p2-v1";
const PROMPT_VERSION = "relation-prompt-v4";
const CLASSIFICATION_SCHEMA_VERSION = "relation-classification-v1";
const CACHE_VERSION = "lineage-classification-cache-v2";
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const TOP_PARENTS = 15;
export const TOP_CHILDREN = 15;
export const S2_RATE_DELAY_MS = 3500;

const S2_FIELDS_PAPER =
  "paperId,title,year,venue,citationCount,referenceCount,authors,abstract,externalIds";

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `_common.py::slug_to_venue_label`. */
export function slugToVenueLabel(conference: string): string {
  return conference.toUpperCase().replace(/-/g, " ");
}

export function resolveConferencePaths(
  docsRoot: string,
  conference: string,
): { papersPath: string; lineagePath: string } {
  validateConferenceSlug(conference);
  const confDir = join(docsRoot, conference);
  return { papersPath: join(confDir, "papers.json"), lineagePath: join(confDir, "lineage.json") };
}

export function cacheDirFor(repoRoot: string): string {
  return lineageCacheDir(layoutFor(repoRoot));
}

// ---------- S2 focus-paper fetch (LIN-20) ----------

export interface BuildLineageDeps extends FetchRelatedDeps {}

function cacheFilePath(deps: BuildLineageDeps, name: string): string {
  return join(deps.cacheDir, name);
}

function readCachedJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** TS port of `fetch_paper_by_arxiv`. Never caches a transient failure (LIN-20). */
export async function fetchPaperByArxiv(
  arxivId: string,
  deps: BuildLineageDeps,
  completeness?: BuildCompleteness | null,
): Promise<Record<string, unknown> | null> {
  const cachePath = cacheFilePath(deps, `paper_${arxivId}.json`);
  const cached = readCachedJson(cachePath);
  if (s2PaperShape(cached, { requireTitle: true }) !== null) {
    return cached as Record<string, unknown>;
  }
  const url = `https://api.semanticscholar.org/graph/v1/paper/arXiv:${arxivId}?fields=${S2_FIELDS_PAPER}`;
  let data: Record<string, unknown> | null;
  try {
    data = await s2Get(url, deps);
  } catch (exc) {
    if (!(exc instanceof S2TransientError)) throw exc;
    deps.logger?.warn(`s2: ${exc.message}`);
    completeness?.subjectFailed(`arXiv:${arxivId} lookup failed: ${exc.message}`);
    await deps.sleep(S2_RATE_DELAY_MS);
    return null;
  }
  if (data !== null && s2PaperShape(data, { requireTitle: true }) === null) {
    deps.logger?.warn(`s2: arXiv:${arxivId} returned an object with no usable paperId`);
    completeness?.subjectFailed(
      `arXiv:${arxivId} lookup returned an object with no usable paperId`,
    );
    await deps.sleep(S2_RATE_DELAY_MS);
    return null;
  }
  if (data) {
    atomicWriteText(cachePath, pyJsonDumps(data, { ensureAscii: false, indent: 2 }));
  }
  await deps.sleep(S2_RATE_DELAY_MS);
  return data;
}

/** TS port of `select_top` (#50: influential refs first, then high-citation fallback). */
export function selectTop(
  items: readonly Record<string, unknown>[],
  n: number,
): Record<string, unknown>[] {
  const scored = items.filter((it) => Boolean(it.abstract));
  const influential = scored.filter((it) => it._is_influential !== false);
  const nonInfluential = scored.filter((it) => it._is_influential === false);
  const byCitation = (a: Record<string, unknown>, b: Record<string, unknown>): number =>
    (Number(b.citationCount) || 0) - (Number(a.citationCount) || 0);
  influential.sort(byCitation);
  nonInfluential.sort(byCitation);
  return [...influential, ...nonInfluential].slice(0, n);
}

// ---------- Identity gates (LIN-23) ----------

/** TS port of `extract_arxiv_id`: canonical arXiv ID named by an arXiv URL, else `null`. Throws on a malformed arXiv-host URL. */
export function extractArxivId(arxivUrl: string | null | undefined): string | null {
  if (!arxivUrl?.trim()) return null;
  let host = "";
  try {
    host = new URL(arxivUrl.trim()).hostname.toLowerCase();
  } catch {
    host = "";
  }
  if (!isArxivHost(host)) return null;
  try {
    const identity = identityFromUrl(arxivUrl);
    return identity.sourceId;
  } catch (exc) {
    if (!(exc instanceof IdentityError)) throw exc;
    throw new Error(`malformed arXiv URL: ${JSON.stringify(arxivUrl)}`);
  }
}

/** TS port of `_normalize_oral_arxiv_id`: one canonical explicit arXiv alias, or `null` when absent. */
export function normalizeOralArxivId(paper: Record<string, unknown>): string | null {
  const declared = paper.arxiv_id;
  const arxivUrl = paper.arxiv_url;
  if (
    arxivUrl !== null &&
    arxivUrl !== undefined &&
    arxivUrl !== "" &&
    typeof arxivUrl !== "string"
  ) {
    throw new Error("oral arxiv_url must be a string");
  }
  const urlAlias = extractArxivId(typeof arxivUrl === "string" ? arxivUrl : "");
  let raw: unknown;
  if (declared !== null && declared !== undefined && declared !== "") {
    raw = declared;
  } else {
    raw = urlAlias;
    if (raw === null) return null;
  }
  if (typeof raw !== "string") throw new Error("oral arxiv_id must be a string");
  let normalized: string;
  try {
    [, normalized] = normalizeAlias("arxiv", raw);
  } catch (exc) {
    if (!(exc instanceof IdentityError)) throw exc;
    throw new Error(`oral has invalid arXiv identity: ${JSON.stringify(raw)}`);
  }
  if (declared !== null && declared !== undefined && declared !== "" && urlAlias !== null) {
    const [, normalizedUrlAlias] = normalizeAlias("arxiv", urlAlias);
    if (normalizedUrlAlias !== normalized) {
      throw new Error("oral arxiv_id and arxiv_url identities do not match");
    }
  }
  return normalized;
}

/** TS port of `_require_s2_focus_identity`: the graph-local S2 ID only for an exact normalized alias match. */
export function requireS2FocusIdentity(focus: unknown, requestedArxivId: string): string {
  if (!isMapping(focus)) throw new Error("Semantic Scholar focus response must be an object");
  const paperId = s2PaperId(focus);
  const externalIds = focus.externalIds;
  const rawArxivId = isMapping(externalIds) ? externalIds.ArXiv : undefined;
  if (paperId === null || typeof rawArxivId !== "string") {
    throw new Error("Semantic Scholar focus is missing paperId or externalIds.ArXiv");
  }
  let resolvedArxivId: string;
  try {
    [, resolvedArxivId] = normalizeAlias("arxiv", rawArxivId);
  } catch (exc) {
    if (!(exc instanceof IdentityError)) throw exc;
    throw new Error("Semantic Scholar returned an invalid arXiv identity");
  }
  if (resolvedArxivId !== requestedArxivId) {
    throw new Error("Semantic Scholar arXiv identity does not match the requested paper");
  }
  return paperId;
}

// ---------- Final-output rationale filter (LIN-37) ----------
//
// Consolidated per docs/migration/p4-followups.md #23: this file used
// to carry its own verbatim copy (`MIN_RATIONALE_LEN = 10`,
// `Array.from(rationale.trim()).length`) independently of
// `lineage/theme/edges.ts`'s byte-for-byte-identical copy. Both are now
// the one implementation in `../shared/rationale.ts`.
export { filterEdgesByRationale, isDegenerateRationale };

// ---------- classify_cached_v2 ----------

function utcNowMs(): number {
  return Date.now();
}

function isoZ(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function cacheEntryIsFresh(entry: unknown, nowMs: number): boolean {
  if (!isMapping(entry) || entry.status !== "success") return false;
  const expiresAt = entry.expires_at;
  if (typeof expiresAt !== "string") return false;
  const parsed = Date.parse(expiresAt);
  if (Number.isNaN(parsed)) return false;
  return parsed > nowMs;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  if (isMapping(a) && isMapping(b)) {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    return ak.length === bk.length && ak.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

/** The closed evidence input actually read by `deriveRelation`'s heuristic (`_heuristic_evidence_input`). */
function heuristicEvidenceInput(options: {
  srcId: string;
  dstId: string;
  parent: Record<string, unknown>;
  child: Record<string, unknown>;
  intentRecord: Record<string, unknown>;
}): Record<string, unknown> {
  const { srcId, dstId, parent, child, intentRecord } = options;
  const paperFields = (paper: Record<string, unknown>) => ({
    title: paper.title ?? null,
    year: paper.year ?? null,
    citationCount: paper.citationCount ?? null,
    citation_count: paper.citation_count ?? null,
  });
  return {
    src: srcId,
    dst: dstId,
    parent: paperFields(parent),
    child: paperFields(child),
    intent_record: {
      ...paperFields(intentRecord),
      _is_influential: intentRecord._is_influential ?? null,
      _intents: intentRecord._intents ?? null,
      _contexts: intentRecord._contexts ?? null,
    },
  };
}

export interface ClassifiedEdge {
  src: string;
  dst: string;
  relation: string;
  confidence: number;
  rationale: string;
  provenance: Record<string, unknown>;
}

/**
 * P2 build-path classifier with exact provider/evidence cache identity —
 * TS port of `_classify_cached_v2`. On an LLM miss, degrades to the
 * deterministic heuristic (`deriveRelation(strictMode: "off")`, no LLM
 * call); heuristic results are NOT written to the persistent cache so a
 * later run with a live LLM re-derives a richer paper-specific rationale.
 */
export async function classifyCachedV2(
  provider: LLMProvider,
  a: ClassifyPaperLike,
  b: ClassifyPaperLike,
  options: {
    srcId: string;
    dstId: string;
    classifications: ClassificationCache;
    cachePath: string;
    rateDelayMs: number;
    intentRecord?: Record<string, unknown> | null;
    sleep: (ms: number) => Promise<void>;
  },
): Promise<ClassifiedEdge | null> {
  const {
    srcId,
    dstId,
    classifications,
    cachePath,
    rateDelayMs,
    intentRecord = null,
    sleep,
  } = options;

  const [system, user] = buildClassifyPrompt(a, b);
  const evidenceSha256 = canonicalJsonSha256({ src: srcId, dst: dstId, system, user });
  const providerName = typeof provider.name === "string" ? provider.name : "unknown";
  const model = providerModelTag(provider);
  const provenance = makeProvenance({
    producerName: PRODUCER_NAME,
    producerVersion: PRODUCER_VERSION,
    evidenceSource: "semantic_scholar",
    evidenceKind: "relation-input",
    evidenceSha256,
    method: "llm",
    provider: providerName,
    model: model ?? null,
    promptVersion: PROMPT_VERSION,
    classificationSchemaVersion: CLASSIFICATION_SCHEMA_VERSION,
  });
  const cacheIdentity = {
    version: CACHE_VERSION,
    src: srcId,
    dst: dstId,
    producer: { name: PRODUCER_NAME, version: PRODUCER_VERSION },
    evidence_sha256: evidenceSha256,
    provider: providerName,
    model,
    prompt_version: PROMPT_VERSION,
    schema_version: CLASSIFICATION_SCHEMA_VERSION,
  };
  const cacheKey = `v2:${canonicalJsonSha256(cacheIdentity)}`;
  const cached = classifications[cacheKey];
  const nowMs = utcNowMs();
  const cachedClassification = isMapping(cached) ? relationClassificationFromDict(cached) : null;
  if (
    cacheEntryIsFresh(cached, nowMs) &&
    cachedClassification !== null &&
    deepEqual((cached as Record<string, unknown>).cache_identity, cacheIdentity) &&
    deepEqual((cached as Record<string, unknown>).provenance, provenance)
  ) {
    return cached as unknown as ClassifiedEdge;
  }

  const rc: RelationClassification | null = await provider.classifyRelation(a, b);
  await sleep(rateDelayMs);
  if (rc !== null) {
    const entry = {
      cache_identity: cacheIdentity,
      status: "success",
      expires_at: isoZ(nowMs + CACHE_TTL_MS),
      src: srcId,
      dst: dstId,
      relation: rc.relation,
      confidence: rc.confidence,
      rationale: rc.rationale,
      model,
      provenance,
    };
    classifications[cacheKey] = entry;
    await persistClassifications(classifications, cachePath);
    return entry as unknown as ClassifiedEdge;
  }

  if (intentRecord === null) return null;
  const heuristic = await deriveRelation(intentRecord, { parent: a, child: b, strictMode: "off" });
  if (heuristic === null) return null;
  const method = heuristic.provenance;
  if (!CLASSIFICATION_METHODS.has(method) || method === "llm") {
    throw new Error(`unsupported heuristic provenance method: ${JSON.stringify(method)}`);
  }
  const heuristicSha256 = canonicalJsonSha256(
    heuristicEvidenceInput({
      srcId,
      dstId,
      parent: a as Record<string, unknown>,
      child: b as Record<string, unknown>,
      intentRecord,
    }),
  );
  const source = method === "context_pattern" ? "unarxive" : "semantic_scholar";
  return {
    src: srcId,
    dst: dstId,
    relation: heuristic.relation,
    confidence: heuristic.confidence,
    rationale: heuristic.rationale,
    provenance: makeProvenance({
      producerName: PRODUCER_NAME,
      producerVersion: PRODUCER_VERSION,
      evidenceSource: source,
      evidenceKind: method === "context_pattern" ? "citation-context" : "citation-metadata",
      evidenceSha256: heuristicSha256,
      method,
      provider: null,
      model: null,
      promptVersion: null,
      classificationSchemaVersion: CLASSIFICATION_SCHEMA_VERSION,
    }),
  };
}

// ---------- build() ----------

const UNCATEGORIZED_ID = "uncategorized";
const UNCATEGORIZED_LABEL = "その他";

function clusterSlug(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || UNCATEGORIZED_ID;
}

export interface ClusterEntry {
  id: string;
  label: string;
  focus_ids: string[];
}

/** TS port of `build_clusters`: group focus papers by their primary tag into subfield clusters. */
export function buildClusters(nodes: readonly ThemeGraphNode[]): ClusterEntry[] {
  const byLabel = new Map<string, string[]>();
  for (const n of nodes) {
    if (!n.is_focus) continue;
    const kinds = n.kinds ?? [];
    const label = kinds.length > 0 ? kinds[0]! : UNCATEGORIZED_LABEL;
    if (!byLabel.has(label)) byLabel.set(label, []);
    byLabel.get(label)!.push(n.id);
  }
  const labels = Array.from(byLabel.keys()).sort((a, b) => {
    const diff = byLabel.get(b)!.length - byLabel.get(a)!.length;
    return diff !== 0 ? diff : a < b ? -1 : a > b ? 1 : 0;
  });
  const entries: ClusterEntry[] = [];
  const usedIds = new Set<string>();
  for (const label of labels) {
    const base = label === UNCATEGORIZED_LABEL ? UNCATEGORIZED_ID : clusterSlug(label);
    let cid = base;
    let suffix = 2;
    while (usedIds.has(cid)) {
      cid = `${base}-${suffix}`;
      suffix += 1;
    }
    usedIds.add(cid);
    entries.push({ id: cid, label, focus_ids: [...byLabel.get(label)!].sort() });
  }
  return entries;
}

export interface BuildLineageOptions {
  docsRoot: string;
  repoRoot: string;
  limit?: number | null;
  conference?: string;
  venueOverride?: string | null;
  generatedAt?: string | null;
  completeness?: BuildCompleteness | null;
  provider: LLMProvider;
  rateDelayMs: number;
}

/** TS port of `build()`. */
export async function build(
  options: BuildLineageOptions,
  deps: BuildLineageDeps,
): Promise<Record<string, unknown>> {
  const {
    docsRoot,
    limit = null,
    conference = "iclr-2026",
    venueOverride = null,
    generatedAt = null,
    completeness = null,
    provider,
    rateDelayMs,
  } = options;
  const { papersPath } = resolveConferencePaths(docsRoot, conference);
  const venueLabel = venueOverride || slugToVenueLabel(conference);

  const papers = JSON.parse(readFileSync(papersPath, "utf8")) as Record<string, unknown>[];
  let orals = papers.filter((p) => p.type === "Oral");
  if (limit) orals = orals.slice(0, limit);
  const seeds = orals.map((paper, i) => requirePaperId(paper.paper_id, `oral[${i}].paper_id`));
  if (new Set(seeds).size !== seeds.length) {
    throw new Error("duplicate canonical paper_id among Oral catalog rows");
  }

  const oralIdentities: { paper: Record<string, unknown>; seed: string; arxivId: string | null }[] =
    [];
  const seedByArxivId = new Map<string, string>();
  orals.forEach((paper, i) => {
    const seed = seeds[i]!;
    const arxivId = normalizeOralArxivId(paper);
    if (arxivId !== null) {
      const previousSeed = seedByArxivId.get(arxivId);
      if (previousSeed !== undefined) {
        throw new Error(`duplicate normalized arXiv identity among Oral catalog rows: ${arxivId}`);
      }
      seedByArxivId.set(arxivId, seed);
    }
    oralIdentities.push({ paper, seed, arxivId });
  });

  const nodes = new Map<string, ThemeGraphNode>();
  const edges: Record<string, unknown>[] = [];
  const focusSeedByGraphId = new Map<string, string>();
  const classificationCachePath = join(deps.cacheDir, "classifications.json");
  const classifications: ClassificationCache = loadClassificationCache(classificationCachePath);

  const resolvedOrals: {
    paper: Record<string, unknown>;
    seed: string;
    arxivId: string;
    focusPaper: Record<string, unknown>;
    focusId: string;
  }[] = [];
  for (const { paper, seed, arxivId } of oralIdentities) {
    if (arxivId === null) continue;
    const focusPaper = await fetchPaperByArxiv(arxivId, deps, completeness);
    if (!focusPaper) continue;
    const focusId = requireS2FocusIdentity(focusPaper, arxivId);
    const previousSeed = focusSeedByGraphId.get(focusId);
    if (previousSeed !== undefined && previousSeed !== seed) {
      throw new Error(
        `distinct catalog papers resolve to the same Semantic Scholar paper: ${focusId}`,
      );
    }
    focusSeedByGraphId.set(focusId, seed);
    resolvedOrals.push({ paper, seed, arxivId, focusPaper, focusId });
  }

  const completenessForExpansion: BuildCompletenessForExpansion | undefined =
    completeness ?? undefined;

  for (const { paper, seed, arxivId, focusPaper, focusId } of resolvedOrals) {
    const catalogKinds =
      Array.isArray(paper.tags) && paper.tags.length > 0
        ? (paper.tags as string[]).slice(0, 3)
        : ["empirical"];
    const catalogCitations =
      typeof paper.citation_count === "number" ? paper.citation_count : undefined;
    const catalogStars = typeof paper.github_stars === "number" ? paper.github_stars : undefined;
    const focusNode = toNode(focusPaper as never, {
      focus: true,
      kinds: catalogKinds,
      overrideVenue: venueLabel,
      overrideTier: "A+",
      catalogCitations,
      catalogStars,
    });
    (focusNode as Record<string, unknown>).seed_paper_id = seed;
    (focusNode as Record<string, unknown>).aliases = [
      ["arxiv", arxivId],
      ["semantic_scholar", focusId],
    ];
    nodes.set(focusId, focusNode);

    const rawParents = await fetchRelatedShared(
      focusId,
      "references",
      TOP_PARENTS * 4,
      deps,
      completenessForExpansion,
    );
    const parents = selectTop(rawParents, TOP_PARENTS);
    const rawChildren = await fetchRelatedShared(
      focusId,
      "citations",
      TOP_CHILDREN * 4,
      deps,
      completenessForExpansion,
    );
    const children = selectTop(rawChildren, TOP_CHILDREN);

    for (const parent of parents) {
      const pid = parent.paperId as string;
      if (!nodes.has(pid)) nodes.set(pid, toNode(parent as never));
      if (parent._is_influential === false) continue;
      const cls = await classifyCachedV2(provider, parent, focusPaper, {
        srcId: pid,
        dstId: focusId,
        classifications,
        cachePath: classificationCachePath,
        rateDelayMs,
        intentRecord: parent,
        sleep: deps.sleep,
      });
      if (cls && cls.relation !== "unrelated") {
        edges.push({
          src: pid,
          dst: focusId,
          rel: cls.relation,
          relation: cls.relation,
          conf: cls.confidence,
          confidence: cls.confidence,
          rationale: cls.rationale,
          provenance: cls.provenance,
        });
      }
    }

    for (const child of children) {
      const cid = child.paperId as string;
      if (!nodes.has(cid)) nodes.set(cid, toNode(child as never));
      if (child._is_influential === false) continue;
      const cls = await classifyCachedV2(provider, focusPaper, child, {
        srcId: focusId,
        dstId: cid,
        classifications,
        cachePath: classificationCachePath,
        rateDelayMs,
        intentRecord: child,
        sleep: deps.sleep,
      });
      if (cls && cls.relation !== "unrelated") {
        edges.push({
          src: focusId,
          dst: cid,
          rel: cls.relation,
          relation: cls.relation,
          conf: cls.confidence,
          confidence: cls.confidence,
          rationale: cls.rationale,
          provenance: cls.provenance,
        });
      }
    }
  }

  const cleanedEdges = filterEdgesByRationale(edges);

  const edgeByKey = new Map<string, Record<string, unknown>>();
  for (const edge of cleanedEdges) {
    const key = `${edge.src}\u0000${edge.dst}\u0000${edge.relation}`;
    if (!edgeByKey.has(key)) edgeByKey.set(key, edge);
  }
  const orderedEdges = Array.from(edgeByKey.keys())
    .sort()
    .map((k) => edgeByKey.get(k)!);

  for (const node of nodes.values()) {
    if (node.is_focus === undefined) (node as Record<string, unknown>).is_focus = false;
  }
  const orderedNodes = Array.from(nodes.values()).sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );

  const edgeCount = new Map<string, number>();
  for (const edge of orderedEdges) {
    const src = edge.src as string;
    const dst = edge.dst as string;
    edgeCount.set(src, (edgeCount.get(src) ?? 0) + 1);
    edgeCount.set(dst, (edgeCount.get(dst) ?? 0) + 1);
  }
  const focusIds = orderedNodes
    .filter((n) => n.is_focus === true)
    .map((n) => n.id)
    .sort();
  const rootId =
    focusIds.length > 0
      ? focusIds.reduce((best, candidate) => {
          const bestDeg = -(edgeCount.get(best) ?? 0);
          const candDeg = -(edgeCount.get(candidate) ?? 0);
          if (candDeg < bestDeg) return candidate;
          if (candDeg > bestDeg) return best;
          return candidate < best ? candidate : best;
        }, focusIds[0]!)
      : null;

  const result: Record<string, unknown> = {
    schema_version: LINEAGE_ARTIFACT_VERSION,
    root: rootId,
    nodes: orderedNodes,
    edges: orderedEdges,
    clusters: buildClusters(orderedNodes),
    meta: {
      kind: "conference",
      generator: PRODUCER_NAME,
      generated_at: generatedAt || isoZ(utcNowMs()),
    },
  };
  requireValidLineageArtifact(result, { kind: "conference", catalogIds: new Set(seeds) });
  return result;
}

export { expansionGateBlocks, IncompleteFetchError };
