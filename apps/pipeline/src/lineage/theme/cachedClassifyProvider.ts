/**
 * Theme-only classification cache v2 adapter — TS port of
 * `paperpilot/scripts/build_theme_lineage.py`'s `_ThemeCachedClassifyProvider`
 * / `_wrap_provider_with_cache`.
 *
 * Distinct from the generic v1 cache in `apps/pipeline/src/lineage/classify/
 * cache.ts` (`CachedClassifyProvider`, ported from `build_lineage.py`'s
 * `_classify_cached`, key `f"{a.paperId}->{b.paperId}"`): this adapter binds
 * the cache entry's identity to the FULL evidence (system+user prompt,
 * endpoints) and the exact producer/provider/model/prompt-version, via a
 * `"v2:<sha256>"` key, plus a 30-day TTL. Both versions read/write the SAME
 * `classifications.json` file (CLAUDE.md §14's "classification cache 共有")
 * — they simply never collide on key shape, so `loadClassificationCache`/
 * `persistClassifications` from `classify/cache.ts` are reused as-is for
 * the on-disk mechanics (atomic write + exclusive lock, #402).
 *
 * Safety contract LIN-41 (via the v1 module's sibling contract): a failed
 * or `null` inner classification is never cached; missing paperIds on
 * either side skip the cache entirely; a read that fails the freshness/
 * identity/provenance check is treated as a miss, never as a poisoned hit.
 */

import { existsSync } from "node:fs";
import { pyIsoformat } from "@paperpilot/core";
import type {
  ClassifyPaperLike,
  LLMProvider,
  PaperEvaluation,
  RelationClassification,
} from "../../collect/llm/provider.js";
import type { Paper } from "../../collect/model/paper.js";
import {
  type ClassificationCache,
  loadClassificationCache,
  persistClassifications,
} from "../classify/cache.js";
import { canonicalJsonSha256, makeProvenance } from "../contract/v1.js";
import {
  buildClassifyPrompt,
  providerModelTag,
  relationClassificationFromDict,
} from "../llm/base.js";

type Provenance = Record<string, unknown>;

const CACHE_VERSION = "lineage-classification-cache-v2";
/** 30 days, in milliseconds. */
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface ThemeCacheIdentity {
  version: string;
  src: string;
  dst: string;
  evidence_sha256: string;
  producer: { name: string; version: string };
  provider: string;
  model: string;
  prompt_version: string;
  schema_version: string;
}

export interface ThemeProducerIdentity {
  producerName: string;
  producerVersion: string;
  promptVersion: string;
  classificationSchemaVersion: string;
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

export interface CachedClassifyProviderDeps {
  cachePath: string | null;
  now?: () => Date;
  /** Injected for tests; defaults to `fs.existsSync(dirname(cachePath))`-gated real persistence via `persistClassifications`. */
  persist?: (cache: ClassificationCache, cachePath: string) => Promise<void>;
  existsSync?: (path: string) => boolean;
  logger?: { warn: (msg: string) => void };
}

/** Theme-only cache-v2 adapter with exact evidence/provider identity. */
export class ThemeCachedClassifyProvider implements LLMProvider {
  readonly name: string;
  enabled: boolean;
  batchSize: number;
  readonly model?: string;
  private readonly inner: LLMProvider;
  private readonly cache: ClassificationCache;
  private readonly cachePath: string | null;
  private readonly identityInfo: ThemeProducerIdentity;
  private readonly now: () => Date;
  private readonly persist: (cache: ClassificationCache, cachePath: string) => Promise<void>;
  private readonly existsSyncFn: (path: string) => boolean;

  constructor(
    inner: LLMProvider,
    cache: ClassificationCache,
    identityInfo: ThemeProducerIdentity,
    deps: CachedClassifyProviderDeps = { cachePath: null },
  ) {
    this.inner = inner;
    this.cache = cache;
    this.cachePath = deps.cachePath;
    this.identityInfo = identityInfo;
    this.name = inner.name;
    this.enabled = Boolean(inner.enabled);
    this.batchSize = inner.batchSize;
    this.model = inner.model;
    this.now = deps.now ?? (() => new Date());
    this.persist = deps.persist ?? persistClassifications;
    this.existsSyncFn = deps.existsSync ?? existsSync;
  }

  async evaluateBatch(
    papers: readonly Paper[],
    profile: string,
  ): Promise<(PaperEvaluation | null)[]> {
    return this.inner.evaluateBatch(papers, profile);
  }

  async chat(system: string, user: string): Promise<string | null> {
    return this.inner.chat(system, user);
  }

  async completeJson(system: string, user: string): Promise<string | null> {
    return this.inner.completeJson(system, user);
  }

  private static fresh(entry: unknown, now: Date): boolean {
    if (!isPlainObject(entry) || entry.status !== "success") return false;
    const expiresAt = entry.expires_at;
    if (typeof expiresAt !== "string") return false;
    const expires = new Date(expiresAt);
    if (Number.isNaN(expires.getTime())) return false;
    return expires.getTime() > now.getTime();
  }

  private identity(
    a: ClassifyPaperLike,
    b: ClassifyPaperLike,
  ): [string, ThemeCacheIdentity, Provenance] | null {
    const srcId = isPlainObject(a) ? a.paperId : undefined;
    const dstId = isPlainObject(b) ? b.paperId : undefined;
    if (!(typeof srcId === "string" && srcId && typeof dstId === "string" && dstId)) return null;
    const [system, user] = buildClassifyPrompt(
      a as Record<string, unknown>,
      b as Record<string, unknown>,
    );
    const evidenceSha256 = canonicalJsonSha256({ src: srcId, dst: dstId, system, user });
    const identity: ThemeCacheIdentity = {
      version: CACHE_VERSION,
      src: srcId,
      dst: dstId,
      evidence_sha256: evidenceSha256,
      producer: {
        name: this.identityInfo.producerName,
        version: this.identityInfo.producerVersion,
      },
      provider: this.name,
      model: providerModelTag(this),
      prompt_version: this.identityInfo.promptVersion,
      schema_version: this.identityInfo.classificationSchemaVersion,
    };
    const provenance = makeProvenance({
      producerName: this.identityInfo.producerName,
      producerVersion: this.identityInfo.producerVersion,
      evidenceSource: "semantic_scholar",
      evidenceKind: "relation-input",
      evidenceSha256,
      method: "llm",
      provider: this.name,
      model: providerModelTag(this),
      promptVersion: this.identityInfo.promptVersion,
      classificationSchemaVersion: this.identityInfo.classificationSchemaVersion,
    });
    return [`v2:${canonicalJsonSha256(identity)}`, identity, provenance];
  }

  async classifyRelation(
    a: ClassifyPaperLike,
    b: ClassifyPaperLike,
  ): Promise<RelationClassification | null> {
    const resolved = this.identity(a, b);
    if (resolved === null) return this.inner.classifyRelation(a, b);
    const [key, identity, provenance] = resolved;
    const cached = this.cache[key];
    const cachedClassification = isPlainObject(cached)
      ? relationClassificationFromDict(cached.classification)
      : null;
    if (
      isPlainObject(cached) &&
      ThemeCachedClassifyProvider.fresh(cached, this.now()) &&
      cachedClassification !== null &&
      jsonEqual(cached.cache_identity, identity) &&
      jsonEqual(cached.provenance, provenance)
    ) {
      return cachedClassification;
    }

    const result = await this.inner.classifyRelation(a, b);
    if (result === null) return null;
    const now = this.now();
    const classification = {
      relation: result.relation,
      confidence: result.confidence,
      rationale: result.rationale,
    };
    this.cache[key] = {
      status: "success",
      // Matches Python's `_iso_z(now + _CACHE_TTL)` exactly (this cache
      // file is shared with the Python production writer).
      expires_at: pyIsoformat(new Date(now.getTime() + CACHE_TTL_MS)).replace("+00:00", "Z"),
      cache_identity: identity,
      classification,
      provenance,
    };
    if (this.cachePath !== null && this.existsSyncFn(dirnameOf(this.cachePath))) {
      await this.persist(this.cache, this.cachePath);
    }
    return result;
  }
}

function dirnameOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "." : path.slice(0, idx);
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Bind the theme producer to cache v2; legacy (v1) endpoint keys never hit. */
export function wrapProviderWithThemeCache(
  inner: LLMProvider,
  identityInfo: ThemeProducerIdentity,
  deps: CachedClassifyProviderDeps,
): { provider: ThemeCachedClassifyProvider; cache: ClassificationCache } {
  const cache = deps.cachePath !== null ? loadClassificationCache(deps.cachePath) : {};
  return { provider: new ThemeCachedClassifyProvider(inner, cache, identityInfo, deps), cache };
}
