/**
 * Build a depth-N family tree focused on a single paper — TS port of
 * `paperpilot/scripts/build_deep_lineage.py` (LIN-12, LIN-13, LIN-14,
 * LIN-24, LIN-36 of docs/migration/safety-contracts.md).
 *
 * Where `buildLineage.ts` produces shallow subtrees (one per Oral paper,
 * depth 1), this module produces ONE deep subtree for a single focus
 * paper. BFS strategy, bounded by depth and per-level width:
 *   ancestors:   focus -> parents -> grandparents -> ... (up to depth)
 *   descendants: focus -> children -> grandchildren -> ...
 *
 * Each (parent, child) pair is classified the same way `buildLineage.ts`
 * classifies edges, except this module's own lenient cache wrapper
 * (`classifyCachedLenient`, LIN-36) synthesizes a slot-filled rationale
 * when the LLM returns a non-`unrelated` relation with an empty
 * rationale — a deliberate relaxation of the strict "empty rationale ->
 * drop edge" policy so a thin-but-real edge survives at depth 2+.
 */

import { normalizeAlias } from "../../catalog/identity.js";
import type {
  ClassifyPaperLike,
  LLMProvider,
  RelationClassification,
} from "../../collect/llm/provider.js";
import {
  type ClassificationCache,
  loadClassificationCache,
  persistClassifications,
} from "../classify/cache.js";
import { slotFillRationale } from "../classify/classify.js";
import {
  type BuildLineageDeps,
  fetchPaperByArxiv,
  requireS2FocusIdentity,
  selectTop,
} from "../conference/buildLineage.js";
import {
  ARXIV_ID_RE,
  canonicalJsonSha256,
  LINEAGE_ARTIFACT_VERSION,
  makeProvenance,
  requirePaperId,
  requireValidLineageArtifact,
} from "../contract/v1.js";
import { type BuildCompleteness, expansionGateBlocks } from "../fetch-state/completeness.js";
import {
  buildClassifyPrompt,
  providerModelTag,
  relationClassificationFromDict,
} from "../llm/base.js";
import {
  type BuildCompletenessForExpansion,
  type FetchRelatedDeps,
  fetchRelated as fetchRelatedShared,
} from "../theme/fetchRelated.js";
import { type ThemeGraphNode, toNode } from "../theme/node.js";

const PRODUCER_NAME = "paperpilot.scripts.build_deep_lineage";
const PRODUCER_VERSION = "p2-v1";
const PROMPT_VERSION = "relation-prompt-v1";
const CLASSIFICATION_SCHEMA_VERSION = "relation-classification-v1";
const CACHE_VERSION = "lineage-classification-cache-v2";
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
  return !Number.isNaN(parsed) && parsed > nowMs;
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

export interface ClassifiedDeepEdge {
  relation: string;
  confidence: number;
  rationale: string;
  provenance: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * `_classify_cached_lenient` (LIN-36): classifyRelation + cache, but
 * synthesizes a slot-filled rationale fallback when the LLM returns a
 * non-`unrelated` relation with an empty rationale, so a thin-but-real
 * edge survives at depth 2+ instead of being dropped by the strict
 * `relationClassificationFromDict` floor.
 */
export async function classifyCachedLenient(
  provider: LLMProvider,
  a: ClassifyPaperLike,
  b: ClassifyPaperLike,
  options: {
    srcId: string;
    dstId: string;
    classifications: ClassificationCache;
    cachePath: string;
    rateDelayMs: number;
    sleep: (ms: number) => Promise<void>;
  },
): Promise<ClassifiedDeepEdge | null> {
  const { srcId, dstId, classifications, cachePath, rateDelayMs, sleep } = options;
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
  if (
    cacheEntryIsFresh(cached, nowMs) &&
    deepEqual((cached as Record<string, unknown>).cache_identity, cacheIdentity) &&
    deepEqual((cached as Record<string, unknown>).provenance, provenance)
  ) {
    const cachedClassification = relationClassificationFromDict(cached);
    if (cachedClassification !== null) return cached as unknown as ClassifiedDeepEdge;
  }

  const text = await provider.completeJson(system, user);
  await sleep(rateDelayMs);
  if (text === null) return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    const rc: RelationClassification | null = relationClassificationFromDict(safeJsonExtract(text));
    if (rc === null) return null;
    parsed = { relation: rc.relation, confidence: rc.confidence, rationale: rc.rationale };
  }

  const rel = parsed.relation;
  if (typeof rel !== "string") return null;
  let rationale = typeof parsed.rationale === "string" ? parsed.rationale.trim() : "";
  if (!rationale && rel !== "unrelated") {
    rationale = slotFillRationale(rel as never, a, b);
  }
  parsed.rationale = rationale;
  const classification = relationClassificationFromDict(parsed);
  if (classification === null) return null;
  const entry: ClassifiedDeepEdge = {
    cache_identity: cacheIdentity,
    status: "success",
    expires_at: isoZ(nowMs + CACHE_TTL_MS),
    src: srcId,
    dst: dstId,
    relation: classification.relation,
    confidence: classification.confidence,
    rationale: classification.rationale,
    model,
    provenance,
  };
  classifications[cacheKey] = entry;
  await persistClassifications(classifications, cachePath);
  return entry;
}

/** Best-effort fallback JSON extraction (fenced code block / embedded object), mirroring
 * `utils/json_parser.py::parse_llm_response`'s later stages closely enough for this call site:
 * strip a markdown code fence, then try to locate the first `{...}` object. */
function safeJsonExtract(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced ? fenced[1]! : text;
  try {
    return JSON.parse(candidate);
  } catch {
    const m = /\{[\s\S]*\}/.exec(candidate);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

/** `fetch_related_by_id`: mirrors `buildLineage.ts`'s `fetchRelated` + `selectTop`. */
export async function fetchRelatedById(
  s2Id: string,
  kind: string,
  topN: number,
  deps: FetchRelatedDeps,
  completeness?: BuildCompletenessForExpansion | null,
): Promise<Record<string, unknown>[]> {
  const items = await fetchRelatedShared(s2Id, kind, topN * 4, deps, completeness);
  return selectTop(items as unknown as Record<string, unknown>[], topN);
}

export interface BuildDeepOptions {
  seedPaperId: string;
  depth?: number;
  topParents?: number;
  topChildren?: number;
  venueOverride?: string | null;
  tierOverride?: string | null;
  completeness?: BuildCompleteness | null;
  provider: LLMProvider;
  rateDelayMs: number;
  generatedAtOverride?: string | null;
}

/** Raised instead of publishing when the focus paper could not be resolved for a reason that does not prove absence (LIN-12). */
export class DeepSubjectIncompleteError extends Error {}
/** Raised when the focus paper's arXiv id genuinely does not exist in S2 (LIN-12's "confirmed absence" branch; exit 1, not 4). */
export class DeepSubjectNotFoundError extends Error {}

/** TS port of `build_deep`: BFS from the focus paper up to `depth` hops in each direction. */
export async function buildDeep(
  arxivIdInput: string,
  options: BuildDeepOptions,
  deps: BuildLineageDeps,
): Promise<Record<string, unknown>> {
  const {
    depth = 2,
    topParents = 20,
    topChildren = 20,
    venueOverride = null,
    tierOverride = null,
    completeness = null,
    provider,
    rateDelayMs,
    generatedAtOverride = null,
  } = options;
  const seedPaperId = requirePaperId(options.seedPaperId, "seed_paper_id");
  const [, arxivId] = normalizeAlias("arxiv", arxivIdInput);
  if (!ARXIV_ID_RE.test(arxivId)) {
    throw new Error("deep lineage requires a modern arXiv ID");
  }

  const focus = await fetchPaperByArxiv(arxivId, deps, completeness);
  if (focus === null) {
    if (completeness !== null && !completeness.subjectComplete) {
      throw new DeepSubjectIncompleteError(
        `incomplete build; published artifact left untouched: ${completeness.subjectGateMessage()}`,
      );
    }
    throw new DeepSubjectNotFoundError(`S2 lookup failed for arXiv:${arxivId}`);
  }
  const focusId = requireS2FocusIdentity(focus, arxivId);
  const aliases = [
    ["arxiv", arxivId],
    ["semantic_scholar", focusId],
  ];

  const nodes = new Map<string, ThemeGraphNode>();
  const edges: Record<string, unknown>[] = [];
  const focusNode = toNode(focus as never, {
    focus: true,
    kinds: ["focus"],
    overrideVenue: venueOverride ?? undefined,
    overrideTier: tierOverride ?? undefined,
  });
  (focusNode as Record<string, unknown>).seed_paper_id = seedPaperId;
  (focusNode as Record<string, unknown>).aliases = aliases;
  nodes.set(focusId, focusNode);

  const classificationsPath = `${deps.cacheDir}/classifications.json`;
  const classifications: ClassificationCache = loadClassificationCache(classificationsPath);

  async function expand(
    srcPaper: Record<string, unknown>,
    direction: "up" | "down",
    topN: number,
  ): Promise<[Record<string, unknown>, Record<string, unknown>][]> {
    const s2Id = srcPaper.paperId as string;
    const kind = direction === "up" ? "references" : "citations";
    const related = await fetchRelatedById(s2Id, kind, topN, deps, completeness ?? undefined);
    const out: [Record<string, unknown>, Record<string, unknown>][] = [];
    for (const rel of related) {
      const relId = rel.paperId as string;
      if (rel._is_influential === false) continue;
      let a: Record<string, unknown>;
      let b: Record<string, unknown>;
      let edgeSrc: string;
      let edgeDst: string;
      if (direction === "up") {
        a = rel;
        b = srcPaper;
        edgeSrc = relId;
        edgeDst = s2Id;
      } else {
        a = srcPaper;
        b = rel;
        edgeSrc = s2Id;
        edgeDst = relId;
      }
      const cls = await classifyCachedLenient(provider, a, b, {
        srcId: edgeSrc,
        dstId: edgeDst,
        classifications,
        cachePath: classificationsPath,
        rateDelayMs,
        sleep: deps.sleep,
      });
      if (cls === null || cls.relation === "unrelated") continue;
      out.push([
        rel,
        {
          src: edgeSrc,
          dst: edgeDst,
          rel: cls.relation,
          relation: cls.relation,
          conf: cls.confidence,
          confidence: cls.confidence,
          rationale: cls.rationale,
          provenance: cls.provenance,
        },
      ]);
    }
    return out;
  }

  let frontierUp = [focus];
  for (let d = 1; d <= depth; d++) {
    const nextFrontier: Record<string, unknown>[] = [];
    for (const seed of frontierUp) {
      const width = d === 1 ? topParents : Math.max(Math.floor(topParents / 2), 6);
      for (const [relPaper, edge] of await expand(seed, "up", width)) {
        const rid = relPaper.paperId as string;
        if (!nodes.has(rid)) nodes.set(rid, toNode(relPaper as never));
        if (!edges.some((e) => e.src === edge.src && e.dst === edge.dst)) edges.push(edge);
        nextFrontier.push(relPaper);
      }
    }
    frontierUp = nextFrontier;
  }

  let frontierDown = [focus];
  for (let d = 1; d <= depth; d++) {
    const nextFrontier: Record<string, unknown>[] = [];
    for (const seed of frontierDown) {
      const width = d === 1 ? topChildren : Math.max(Math.floor(topChildren / 2), 6);
      for (const [relPaper, edge] of await expand(seed, "down", width)) {
        const rid = relPaper.paperId as string;
        if (!nodes.has(rid)) nodes.set(rid, toNode(relPaper as never));
        if (!edges.some((e) => e.src === edge.src && e.dst === edge.dst)) edges.push(edge);
        nextFrontier.push(relPaper);
      }
    }
    frontierDown = nextFrontier;
  }

  const cleanedEdges = edges.filter((e) => String(e.rationale ?? "").trim());

  for (const node of nodes.values()) {
    if (node.is_focus === undefined) (node as Record<string, unknown>).is_focus = false;
  }
  const orderedNodes = Array.from(nodes.values()).sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const orderedEdges = [...cleanedEdges].sort((a, b) => {
    const ak = `${a.src}\u0000${a.dst}\u0000${a.relation}`;
    const bk = `${b.src}\u0000${b.dst}\u0000${b.relation}`;
    return ak < bk ? -1 : ak > bk ? 1 : 0;
  });

  const result: Record<string, unknown> = {
    schema_version: LINEAGE_ARTIFACT_VERSION,
    root: focusId,
    nodes: orderedNodes,
    edges: orderedEdges,
    clusters: [],
    meta: {
      source: "build_deep_lineage.py",
      kind: "deep",
      generator: PRODUCER_NAME,
      arxiv_id: arxivId,
      seed_paper_id: seedPaperId,
      aliases,
      depth,
      generated_at: generatedAtOverride ?? isoZ(utcNowMs()),
    },
  };
  requireValidLineageArtifact(result, {
    kind: "deep",
    catalogIds: new Set([seedPaperId]),
    expectedSeedPaperId: seedPaperId,
  });
  return result;
}

export { expansionGateBlocks };
