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
 *
 * R2-6 (design 41 D2) — cache v3, provider-agnostic. v2 keyed an entry
 * on the exact provider/model, so a pair Groq classified yesterday was
 * asked again as soon as Gemini (the fallback) or another Groq model was
 * in front, burning the free-tier quota D2 is trying to save. v3 keys on
 * what determines the answer's meaning — the endpoints, the exact prompt
 * evidence (`evidence_sha256` over system+user prompt), the producer and
 * the prompt/schema versions — and records WHO answered in the entry's
 * provenance, which a hit hands back as `producedBy` so edge provenance
 * still names the real model. Writes are v3 only; a v3 miss still
 * accepts a fresh v2 entry for the wrapper's own provider/model (the
 * entries already committed from Groq runs), so the switch costs no
 * re-classification. Entries are persisted (merge-on-write, locked) after
 * every successful call, so a run that later fails — degraded gate,
 * incomplete fetch, crash — still leaves its answers for the next run.
 *
 * R2-20 — cache v4, SEMANTIC keys. v3 hashed the exact prompt text, so
 * every wording edit (and the v4 prompt bump) re-asked every pair. v4
 * keys an answer on the pair's INPUT DATA (what the prompt shows: titles,
 * years, abstracts / context sentences) and the prompt's SEMANTIC version
 * (`CLASSIFY_SEMANTIC_VERSION` / `CONTEXT_SEMANTIC_VERSION`, bumped only
 * when the question or labels change — see their docs). A v4 hit checks
 * that the entry is an LLM answer from this producer and schema, but not
 * the prompt-text hash or provenance prompt version inside it (those
 * change with wording by design); edge provenance is rebuilt from the
 * current prompt by the caller. Writes are v4 only; a v4 miss still
 * accepts the v3 text-keyed entry (and the v2 one) for the CURRENT prompt
 * text and copies it to its v4 key, so the switch re-asks nothing.
 */

import { existsSync } from "node:fs";
import { pyIsoformat } from "@paperpilot/core";
import type {
  ClassifyPaperLike,
  CompletionOptions,
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
  CLASSIFY_SEMANTIC_VERSION,
  classifyPromptInputs,
  providerModelTag,
  relationClassificationFromDict,
} from "../llm/base.js";
import { completeJsonAttributed } from "../llm/fallback.js";

type Provenance = Record<string, unknown>;

const CACHE_VERSION_V2 = "lineage-classification-cache-v2";
export const CACHE_VERSION = "lineage-classification-cache-v3";
/** R2-20: semantic-key cache version (written since R2-20). */
export const CACHE_VERSION_V4 = "lineage-classification-cache-v4";
/**
 * 180 days, in milliseconds. The key already pins the prompt text and
 * versions, so an entry only goes stale with the model generation; v2's
 * 30 days re-asked unchanged pairs every month.
 */
const CACHE_TTL_MS = 180 * 24 * 60 * 60 * 1000;

/** v3 identity: deliberately WITHOUT provider/model (see module doc). */
export interface ThemeCacheIdentity {
  version: string;
  src: string;
  dst: string;
  evidence_sha256: string;
  producer: { name: string; version: string };
  prompt_version: string;
  schema_version: string;
}

/** v4 identity (R2-20): input data + semantic prompt version, no prompt text. */
export interface ThemeSemanticCacheIdentity {
  version: string;
  src: string;
  dst: string;
  inputs_sha256: string;
  producer: { name: string; version: string };
  semantic_version: string;
  schema_version: string;
}

/** A JSON-prompt cache request (the citation-context prompt). */
export interface JsonAnswerRequest {
  src: string;
  dst: string;
  system: string;
  user: string;
  /** Provenance prompt version (and the v3 text-key identity). */
  promptVersion: string;
  /** R2-20: semantic key parts; absent = v3 text key only. */
  semantic?: { version: string; inputs: unknown };
  opts?: CompletionOptions;
}

type Attributed<T> = { value: T; producedBy: { provider: string; model: string } };

/** Legacy v2 identity (read-only compatibility). */
interface ThemeCacheIdentityV2 extends ThemeCacheIdentity {
  provider: string;
  model: string;
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

  async completeJson(
    system: string,
    user: string,
    opts?: CompletionOptions,
  ): Promise<string | null> {
    return this.inner.completeJson(system, user, opts);
  }

  /** Uncached `completeJson` with the answering member (R2-20 batched prompts). */
  async completeJsonAttributed(
    system: string,
    user: string,
    opts?: CompletionOptions,
  ): Promise<{ text: string; producedBy: { provider: string; model: string } } | null> {
    return completeJsonAttributed(this.inner, system, user, opts);
  }

  isExhausted(): boolean {
    return this.inner.isExhausted?.() === true;
  }

  private semanticIdentity(
    src: string,
    dst: string,
    semantic: { version: string; inputs: unknown },
  ): ThemeSemanticCacheIdentity {
    return {
      version: CACHE_VERSION_V4,
      src,
      dst,
      inputs_sha256: canonicalJsonSha256({ src, dst, inputs: semantic.inputs }),
      producer: {
        name: this.identityInfo.producerName,
        version: this.identityInfo.producerVersion,
      },
      semantic_version: semantic.version,
      schema_version: this.identityInfo.classificationSchemaVersion,
    };
  }

  /** A fresh v4 entry for `identity` whose stored answer `validate` accepts. */
  private semanticHit<T>(
    identity: ThemeSemanticCacheIdentity,
    validate: (cached: unknown) => T | null,
  ): Attributed<T> | null {
    const cached = this.cache[`v4:${canonicalJsonSha256(identity)}`];
    if (!isPlainObject(cached) || !ThemeCachedClassifyProvider.fresh(cached, this.now())) {
      return null;
    }
    if (!jsonEqual(sortKeys(cached.cache_identity), sortKeys(identity))) return null;
    const producer = this.semanticProducerOf(cached.provenance);
    if (producer === null) return null;
    const value = validate(cached.classification);
    return value === null ? null : { value, producedBy: producer };
  }

  /**
   * Who produced a v4 entry: an LLM answer by this producer and schema.
   * The evidence hash / prompt version inside are NOT compared — they
   * record the wording the answer was given under (see module doc).
   */
  private semanticProducerOf(provenance: unknown): { provider: string; model: string } | null {
    if (!isPlainObject(provenance) || !isPlainObject(provenance.classification)) return null;
    const cls = provenance.classification;
    const producer = provenance.producer;
    if (cls.method !== "llm") return null;
    if (cls.schema_version !== this.identityInfo.classificationSchemaVersion) return null;
    if (
      !isPlainObject(producer) ||
      producer.name !== this.identityInfo.producerName ||
      producer.version !== this.identityInfo.producerVersion
    ) {
      return null;
    }
    const { provider, model } = cls;
    if (!(typeof provider === "string" && provider && typeof model === "string" && model)) {
      return null;
    }
    return { provider, model };
  }

  private writeSemantic(
    identity: ThemeSemanticCacheIdentity,
    classification: unknown,
    provenance: Provenance,
  ): void {
    this.cache[`v4:${canonicalJsonSha256(identity)}`] = {
      status: "success",
      expires_at: pyIsoformat(new Date(this.now().getTime() + CACHE_TTL_MS)).replace("+00:00", "Z"),
      cache_identity: identity,
      classification,
      provenance,
    };
  }

  private async persistNow(): Promise<void> {
    if (this.cachePath !== null && this.existsSyncFn(dirnameOf(this.cachePath))) {
      await this.persist(this.cache, this.cachePath);
    }
  }

  private static fresh(entry: unknown, now: Date): boolean {
    if (!isPlainObject(entry) || entry.status !== "success") return false;
    const expiresAt = entry.expires_at;
    if (typeof expiresAt !== "string") return false;
    const expires = new Date(expiresAt);
    if (Number.isNaN(expires.getTime())) return false;
    return expires.getTime() > now.getTime();
  }

  /** The pieces both cache versions share, or null without both paperIds. */
  private evidence(
    a: ClassifyPaperLike,
    b: ClassifyPaperLike,
  ): { src: string; dst: string; evidenceSha256: string } | null {
    const srcId = isPlainObject(a) ? a.paperId : undefined;
    const dstId = isPlainObject(b) ? b.paperId : undefined;
    if (!(typeof srcId === "string" && srcId && typeof dstId === "string" && dstId)) return null;
    const [system, user] = buildClassifyPrompt(
      a as Record<string, unknown>,
      b as Record<string, unknown>,
    );
    const evidenceSha256 = canonicalJsonSha256({ src: srcId, dst: dstId, system, user });
    return { src: srcId, dst: dstId, evidenceSha256 };
  }

  private identityV3(ev: { src: string; dst: string; evidenceSha256: string }): ThemeCacheIdentity {
    return {
      version: CACHE_VERSION,
      src: ev.src,
      dst: ev.dst,
      evidence_sha256: ev.evidenceSha256,
      producer: {
        name: this.identityInfo.producerName,
        version: this.identityInfo.producerVersion,
      },
      prompt_version: this.identityInfo.promptVersion,
      schema_version: this.identityInfo.classificationSchemaVersion,
    };
  }

  /** LLM provenance for one answer by `provider`/`model`. */
  private provenanceFor(
    evidenceSha256: string,
    provider: string,
    model: string,
    promptVersion: string = this.identityInfo.promptVersion,
  ): Provenance {
    return makeProvenance({
      producerName: this.identityInfo.producerName,
      producerVersion: this.identityInfo.producerVersion,
      evidenceSource: "semantic_scholar",
      evidenceKind: "relation-input",
      evidenceSha256,
      method: "llm",
      provider,
      model,
      promptVersion,
      classificationSchemaVersion: this.identityInfo.classificationSchemaVersion,
    });
  }

  /**
   * R2-10: cached answer to an arbitrary JSON prompt about one edge (the
   * citation-context prompt), with the prompt's own version in the
   * identity, so context answers never collide with abstract answers.
   * `parse` validates fresh answers, `validate` cached ones; the stored
   * `classification` is the parsed answer itself. R2-20: with
   * `req.semantic` the v4 semantic key is read first and written; the v3
   * text key is still read (and migrated).
   */
  async cachedJsonAnswer<T extends object>(
    req: JsonAnswerRequest,
    parse: (text: string | null) => T | null,
    validate: (cached: unknown) => T | null,
  ): Promise<Attributed<T> | null> {
    const hit = this.lookupJsonAnswer(req, validate);
    if (hit !== null) return hit;
    const answer = await completeJsonAttributed(this.inner, req.system, req.user, req.opts);
    const value = parse(answer?.text ?? null);
    if (answer === null || value === null) return null;
    await this.storeJsonAnswer(req, value, answer.producedBy);
    return { value, producedBy: answer.producedBy };
  }

  /** R2-20: the cached answer for `req`, without asking the model. */
  lookupJsonAnswer<T extends object>(
    req: JsonAnswerRequest,
    validate: (cached: unknown) => T | null,
  ): Attributed<T> | null {
    const semId =
      req.semantic === undefined ? null : this.semanticIdentity(req.src, req.dst, req.semantic);
    if (semId !== null) {
      const hit = this.semanticHit(semId, validate);
      if (hit !== null) return hit;
    }
    const { key, identity, template } = this.textKey(req);
    const cached = this.cache[key];
    if (
      isPlainObject(cached) &&
      ThemeCachedClassifyProvider.fresh(cached, this.now()) &&
      jsonEqual(cached.cache_identity, identity)
    ) {
      const value = validate(cached.classification);
      const producer = ThemeCachedClassifyProvider.producerOf(cached.provenance, template);
      if (value !== null && producer !== null) {
        if (semId !== null) this.writeSemantic(semId, value, cached.provenance as Provenance);
        return { value, producedBy: producer };
      }
    }
    return null;
  }

  /** R2-20: store one answer (v4 key with `req.semantic`, else v3) and persist. */
  async storeJsonAnswer<T extends object>(
    req: JsonAnswerRequest,
    value: T,
    producedBy: { provider: string; model: string },
  ): Promise<void> {
    const evidenceSha256 = canonicalJsonSha256({
      src: req.src,
      dst: req.dst,
      system: req.system,
      user: req.user,
    });
    const provenance = this.provenanceFor(
      evidenceSha256,
      producedBy.provider,
      producedBy.model,
      req.promptVersion,
    );
    if (req.semantic !== undefined) {
      this.writeSemantic(this.semanticIdentity(req.src, req.dst, req.semantic), value, provenance);
    } else {
      const { key, identity } = this.textKey(req);
      this.cache[key] = {
        status: "success",
        expires_at: pyIsoformat(new Date(this.now().getTime() + CACHE_TTL_MS)).replace(
          "+00:00",
          "Z",
        ),
        cache_identity: identity,
        classification: value,
        provenance,
      };
    }
    await this.persistNow();
  }

  /** The v3 (prompt-text) key of a JSON request. */
  private textKey(req: JsonAnswerRequest): {
    key: string;
    identity: ThemeCacheIdentity;
    template: Provenance;
  } {
    const evidenceSha256 = canonicalJsonSha256({
      src: req.src,
      dst: req.dst,
      system: req.system,
      user: req.user,
    });
    const identity: ThemeCacheIdentity = {
      ...this.identityV3({ src: req.src, dst: req.dst, evidenceSha256 }),
      prompt_version: req.promptVersion,
    };
    return {
      key: `v3:${canonicalJsonSha256(identity)}`,
      identity,
      template: this.provenanceFor(evidenceSha256, "x", "x", req.promptVersion),
    };
  }

  /** Who produced a cached entry, if its provenance is a well-formed LLM record for this evidence. */
  private static producerOf(
    provenance: unknown,
    expected: Provenance,
  ): { provider: string; model: string } | null {
    if (!isPlainObject(provenance) || !isPlainObject(provenance.classification)) return null;
    const cls = provenance.classification;
    const { provider, model } = cls;
    if (!(typeof provider === "string" && provider && typeof model === "string" && model)) {
      return null;
    }
    // Everything except the producer identity must match what this run
    // would record for the same evidence.
    const normalized = {
      ...provenance,
      classification: { ...cls, provider: null, model: null },
    };
    const want = {
      ...expected,
      classification: {
        ...(expected.classification as Record<string, unknown>),
        provider: null,
        model: null,
      },
    };
    return jsonEqual(normalized, want) ? { provider, model } : null;
  }

  async classifyRelation(
    a: ClassifyPaperLike,
    b: ClassifyPaperLike,
  ): Promise<RelationClassification | null> {
    const ev = this.evidence(a, b);
    if (ev === null) return this.inner.classifyRelation(a, b);
    // R2-20: semantic (v4) key first — survives wording-only prompt edits.
    const semId = this.semanticIdentity(ev.src, ev.dst, {
      version: CLASSIFY_SEMANTIC_VERSION,
      inputs: classifyPromptInputs(a as Record<string, unknown>, b as Record<string, unknown>),
    });
    const sem = this.semanticHit(semId, relationClassificationFromDict);
    if (sem !== null) return { ...sem.value, producedBy: sem.producedBy };

    const identity = this.identityV3(ev);
    const key = `v3:${canonicalJsonSha256(identity)}`;
    const now = this.now();
    // Template provenance (provider/model nulled out by `producerOf`).
    const template = this.provenanceFor(ev.evidenceSha256, "x", "x");

    const cached = this.cache[key];
    if (
      isPlainObject(cached) &&
      ThemeCachedClassifyProvider.fresh(cached, now) &&
      jsonEqual(cached.cache_identity, identity)
    ) {
      const cls = relationClassificationFromDict(cached.classification);
      const producer = ThemeCachedClassifyProvider.producerOf(cached.provenance, template);
      if (cls !== null && producer !== null) {
        this.writeSemantic(semId, cached.classification, cached.provenance as Provenance);
        return { ...cls, producedBy: producer };
      }
    }

    // Compatibility: a fresh v2 entry written for this wrapper's own
    // provider/model (the pre-R2-6 Groq entries) still counts as a hit.
    const legacy = this.legacyHit(ev);
    if (legacy !== null) {
      const by = legacy.producedBy as { provider: string; model: string };
      this.writeSemantic(
        semId,
        { relation: legacy.relation, confidence: legacy.confidence, rationale: legacy.rationale },
        this.provenanceFor(ev.evidenceSha256, by.provider, by.model),
      );
      return legacy;
    }

    const result = await this.inner.classifyRelation(a, b);
    if (result === null) return null;
    const producedBy = result.producedBy ?? {
      provider: this.name,
      model: providerModelTag(this),
    };
    const classification = {
      relation: result.relation,
      confidence: result.confidence,
      rationale: result.rationale,
    };
    this.writeSemantic(
      semId,
      classification,
      this.provenanceFor(ev.evidenceSha256, producedBy.provider, producedBy.model),
    );
    await this.persistNow();
    return { ...result, producedBy };
  }

  private legacyHit(ev: {
    src: string;
    dst: string;
    evidenceSha256: string;
  }): RelationClassification | null {
    const model = providerModelTag(this);
    const identity: ThemeCacheIdentityV2 = {
      ...this.identityV3(ev),
      version: CACHE_VERSION_V2,
      provider: this.name,
      model,
    };
    // v2 identity key order: version, src, dst, evidence, producer,
    // provider, model, prompt_version, schema_version (canonical JSON
    // sorts keys, so the spread order above does not matter for the hash).
    const cached = this.cache[`v2:${canonicalJsonSha256(identity)}`];
    if (!isPlainObject(cached) || !ThemeCachedClassifyProvider.fresh(cached, this.now())) {
      return null;
    }
    if (!jsonEqual(sortKeys(cached.cache_identity), sortKeys(identity))) return null;
    if (!jsonEqual(cached.provenance, this.provenanceFor(ev.evidenceSha256, this.name, model))) {
      return null;
    }
    const cls = relationClassificationFromDict(cached.classification);
    return cls === null ? null : { ...cls, producedBy: { provider: this.name, model } };
  }
}

function dirnameOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "." : path.slice(0, idx);
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Shallow key sort (identity objects are flat apart from `producer`). */
function sortKeys(x: unknown): unknown {
  if (!isPlainObject(x)) return x;
  return Object.fromEntries(
    Object.keys(x)
      .sort()
      .map((k) => [k, sortKeys(x[k])]),
  );
}

/** Bind the theme producer to cache v3 (v2 read-compatible); legacy v1 endpoint keys never hit. */
export function wrapProviderWithThemeCache(
  inner: LLMProvider,
  identityInfo: ThemeProducerIdentity,
  deps: CachedClassifyProviderDeps,
): { provider: ThemeCachedClassifyProvider; cache: ClassificationCache } {
  const cache = deps.cachePath !== null ? loadClassificationCache(deps.cachePath) : {};
  return { provider: new ThemeCachedClassifyProvider(inner, cache, identityInfo, deps), cache };
}
